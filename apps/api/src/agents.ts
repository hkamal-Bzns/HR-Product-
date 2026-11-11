// M4 AI agents v1 (Brief §8, §15 M4) — API routes.
// Four agents, one job each. Agents propose; owners and managers dispose.
// No agent changes pay, approves leave, publishes a roster, or disciplines
// anyone on its own. Every agent run is recorded (inputs hash, output,
// STUBBED cost estimate, human decision) and audit-logged. The LLM provider
// is STUBBED (see agentCore.ts): outputs are composed deterministically from
// structured data by @hr-payroll/shared — no real LLM key, no real API calls.
// Cost caps and kill switches pause an agent only — never attendance/payroll.
import type { FastifyInstance } from 'fastify';
import { verifySession, type SessionClaims } from './auth.js';
import { newId, type MemoryStore, type ScheduleDraftRecord, type ScheduleSuggestion, type PayrollRunRecord } from '@hr-payroll/db';
import {
  AGENT_IDS, composeBriefing, scoreDraftSuggestion, detectAgent3Anomalies,
  matchQaIntent, extractEgpAmountPiasters, composeQaAnswer, maskName, maskPhone,
  aggregateSyncStatus, monthKey,
  type AgentId, type BriefingInput,
} from '@hr-payroll/shared';
import { createLlmProvider, recordAgentRun, agentStatus, ensureAgentAllowed, type LlmProvider } from './agentCore.js';
import { summariseAttendance, periodBounds, buildAgent3Inputs } from './payroll.js';
import { publishRoster, templateMinutes } from './roster.js';
import { shiftSettings } from './attendance.js';
import { notifyEmployee } from './notify.js';

const llm: LlmProvider = createLlmProvider();

function addDays(dateIso: string, days: number): string {
  return new Date(new Date(`${dateIso}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}
function daysInMonthOf(period: string): number {
  return periodBounds(period).days;
}
function templateStartMs(date: string, startTime: string): number {
  const [h, m] = startTime.split(':').map(Number);
  return new Date(`${date}T00:00:00+02:00`).getTime() + (h * 60 + m) * 60000;
}

// ============================================================================
// Agent 1 — Daily owner briefing
// ============================================================================
export function buildBriefingInput(store: MemoryStore, tenantId: string, date: string): BriefingInput {
  const yesterday = addDays(date, -1);
  const employees = store.listEmployees(tenantId);
  const nameOf = (id: string) => employees.find((e) => e.id === id)?.fullNameAr ?? id;
  const branchNameOf = (id: string | null) => (id ? store.branches.find((b) => b.id === id)?.nameAr ?? id : '—');

  const yRecords = store.listAttendance(tenantId).filter((a) => a.clockInAt?.slice(0, 10) === yesterday);
  const presentIds = [...new Set(yRecords.map((a) => a.employeeId))];
  const lateIds = [...new Set(store.exceptions
    .filter((e) => e.kind === 'late' && e.attendanceRecordId && yRecords.some((r) => r.id === e.attendanceRecordId))
    .map((e) => e.employeeId))];
  const missingClockOutIds = yRecords.filter((a) => !a.clockOutAt).map((a) => a.employeeId);
  const publishedRosterIds = new Set(store.listRosters(tenantId).filter((r) => r.status === 'published').map((r) => r.id));
  const yAssignments = store.rosterAssignments.filter((a) => a.rosterId && publishedRosterIds.has(a.rosterId) && a.date === yesterday && !a.onLeave);
  const absentIds = yAssignments.filter((a) => !presentIds.includes(a.employeeId)).map((a) => a.employeeId);

  // Today's uncovered shifts: coverage minimums vs published assignments.
  const settings = shiftSettings(store, tenantId);
  const todayAssignments = store.rosterAssignments.filter((a) => publishedRosterIds.has(a.rosterId) && a.date === date && !a.onLeave);
  const uncovered: BriefingInput['uncoveredShifts'] = [];
  const byShift = new Map<string, { rosterId: string; templateId: string | null; employeeIds: string[] }>();
  for (const a of todayAssignments) {
    const key = `${a.rosterId}|${a.shiftTemplateId ?? ''}`;
    const g = byShift.get(key) ?? { rosterId: a.rosterId, templateId: a.shiftTemplateId, employeeIds: [] };
    g.employeeIds.push(a.employeeId);
    byShift.set(key, g);
  }
  for (const g of byShift.values()) {
    const roster = store.rosters.find((r) => r.id === g.rosterId);
    const template = g.templateId ? store.shiftTemplates.find((t) => t.id === g.templateId) : undefined;
    const counts = new Map<string, number>();
    for (const eid of g.employeeIds) {
      const emp = employees.find((e) => e.id === eid);
      if (emp) counts.set(emp.jobTitle, (counts.get(emp.jobTitle) ?? 0) + 1);
    }
    for (const [role, required] of Object.entries(settings.coverageMinimums)) {
      const assigned = counts.get(role) ?? 0;
      if (assigned < required) {
        uncovered.push({ date, branchName: branchNameOf(roster?.branchId ?? null), shiftName: template?.nameAr ?? 'وردية', role, required, assigned });
      }
    }
  }

  const onLeaveToday = store.rosterAssignments
    .filter((a) => publishedRosterIds.has(a.rosterId) && a.date === date && a.onLeave)
    .map((a) => ({ employeeName: nameOf(a.employeeId), type: 'annual' }));
  // Approved leave requests covering today (dedupe with roster-marked ones).
  for (const req of store.listLeaveRequests(tenantId)) {
    if (req.status === 'approved' && req.startDate <= date && req.endDate >= date
      && !onLeaveToday.some((l) => l.employeeName === nameOf(req.employeeId))) {
      onLeaveToday.push({ employeeName: nameOf(req.employeeId), type: req.type });
    }
  }

  // Labour cost: daily rate × worked days, month-to-date vs same point last month.
  const labourCost = (period: string, upTo: string): number | null => {
    const { start } = periodBounds(period);
    const days = daysInMonthOf(period);
    let total = 0;
    let anyRecords = false;
    for (const emp of employees) {
      const att = summariseAttendance(store, tenantId, emp.id, start, upTo);
      if (att.workedDays > 0) anyRecords = true;
      const struct = store.structureFor(tenantId, emp.id);
      const basic = struct?.basicPiasters ?? emp.basicSalaryPiasters;
      const allowances = struct ? struct.allowances.reduce((s, a) => s + a.amountPiasters, 0) : (emp.allowancesPiasters ?? 0);
      total += Math.round(((basic + allowances) / days) * att.workedDays);
    }
    return anyRecords ? total : null;
  };
  const period = date.slice(0, 7);
  const costToDate = labourCost(period, yesterday);
  const prevPeriod = (() => {
    const [y, m] = period.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  })();
  const dayNum = Math.min(Number(date.slice(8, 10)) - 1, daysInMonthOf(prevPeriod));
  const prevUpTo = `${prevPeriod}-${String(Math.max(dayNum, 1)).padStart(2, '0')}`;
  const costLastMonth = labourCost(prevPeriod, prevUpTo);
  const missingData: string[] = [];
  if (costToDate === null) missingData.push('لا توجد سجلات حضور لهذا الشهر بعد — تكلفة العمل غير متاحة');
  if (costLastMonth === null) missingData.push('لا توجد سجلات حضور من الشهر الماضي للمقارنة');

  return {
    date, yesterdayDate: yesterday,
    presentCount: presentIds.length, lateCount: lateIds.length,
    absentCount: [...new Set(absentIds)].length, missingClockOutCount: missingClockOutIds.length,
    lateNames: lateIds.map(nameOf), absentNames: [...new Set(absentIds)].map(nameOf),
    missingClockOutNames: missingClockOutIds.map(nameOf),
    uncoveredShifts: uncovered, onLeaveToday,
    openExceptionsCount: store.listExceptions(tenantId, 'open').length,
    labourCostToDatePiasters: costToDate, labourCostSamePointLastMonthPiasters: costLastMonth,
    missingData,
  };
}

export async function runBriefing(store: MemoryStore, tenantId: string, date: string, userId: string | null): Promise<{ briefing: ReturnType<typeof composeBriefing>; run: ReturnType<typeof recordAgentRun> }> {
  ensureAgentAllowed(store, tenantId, 'briefing');
  const input = buildBriefingInput(store, tenantId, date);
  const briefing = composeBriefing(input);
  const generated = await llm.generateStructured({
    agentId: 'briefing',
    prompt: 'Compose the daily owner briefing in Arabic from the structured data.',
    schema: { textAr: 'string', textEn: 'string', topActionAr: 'string', topActionEn: 'string' },
    structuredContext: briefing,
  });
  const run = recordAgentRun(store, tenantId, 'briefing', input, generated.output, { costPiasters: generated.costPiasters, provider: generated.provider });
  // Deliver via STUBBED WhatsApp to every owner + in-app (the run record).
  for (const owner of store.listUsers(tenantId).filter((u) => u.role === 'owner' && u.phone)) {
    await notifyEmployee(store, tenantId, { phone: owner.phone! }, 'daily_briefing', `${briefing.textAr}\n(STUBBED — queued only, not sent)`);
  }
  void userId;
  return { briefing, run };
}

// ============================================================================
// Agent 2 — Schedule builder (draft only)
// ============================================================================
export function buildScheduleDraftSuggestions(
  store: MemoryStore, tenantId: string, branchId: string, weekStart: string,
): { suggestions: ScheduleSuggestion[]; skippedOnLeave: { employeeId: string; date: string }[] } {
  const settings = shiftSettings(store, tenantId);
  const employees = store.listEmployees(tenantId).filter((e) => e.branchId === branchId && e.active !== false);
  const publishedRosterIds = new Set(store.listRosters(tenantId).filter((r) => r.status === 'published').map((r) => r.id));
  const historyStart = addDays(weekStart, -56);
  const history = store.rosterAssignments.filter((a) => publishedRosterIds.has(a.rosterId)
    && a.date >= historyStart && a.date < weekStart && !a.onLeave);
  const historyWeeks = new Set(history.map((a) => {
    const d = new Date(`${a.date}T00:00:00Z`);
    const dow = (d.getUTCDay() + 6) % 7;
    return addDays(a.date, -dow);
  })).size;
  const weeksTotal = Math.max(historyWeeks, 1);
  // (employee, weekday 0=Mon) -> template counts; (employee) -> template counts.
  const byWeekday = new Map<string, Map<string, number>>();
  const byEmployee = new Map<string, Map<string, number>>();
  for (const a of history) {
    if (!a.shiftTemplateId) continue;
    const dow = (new Date(`${a.date}T00:00:00Z`).getUTCDay() + 6) % 7;
    const k1 = `${a.employeeId}|${dow}`;
    const m1 = byWeekday.get(k1) ?? new Map();
    m1.set(a.shiftTemplateId, (m1.get(a.shiftTemplateId) ?? 0) + 1);
    byWeekday.set(k1, m1);
    const m2 = byEmployee.get(a.employeeId) ?? new Map();
    m2.set(a.shiftTemplateId, (m2.get(a.shiftTemplateId) ?? 0) + 1);
    byEmployee.set(a.employeeId, m2);
  }
  const pickTemplate = (employeeId: string, dow: number): { templateId: string; weeksWorked: number } => {
    const m = byWeekday.get(`${employeeId}|${dow}`);
    if (m && m.size > 0) {
      const [templateId, weeksWorked] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      return { templateId, weeksWorked };
    }
    const overall = byEmployee.get(employeeId);
    if (overall && overall.size > 0) {
      const [templateId] = [...overall.entries()].sort((a, b) => b[1] - a[1])[0];
      return { templateId, weeksWorked: 0 };
    }
    const fallback = store.shiftTemplates.find((t) => t.id === 'tpl-morning') ?? store.shiftTemplates[0];
    return { templateId: fallback?.id ?? '', weeksWorked: 0 };
  };
  const existingAssignments = store.rosterAssignments.filter((a) => a.tenantId === tenantId && !a.onLeave);
  const templateById = (id: string | null) => (id ? store.shiftTemplates.find((t) => t.id === id) : undefined);
  const minutesFor = (assignment: { date: string; shiftTemplateId: string | null }): number => {
    const t = templateById(assignment.shiftTemplateId);
    return t ? templateMinutes(t) : 0;
  };
  const endMsFor = (assignment: { date: string; shiftTemplateId: string | null }): number | null => {
    const t = templateById(assignment.shiftTemplateId);
    if (!t) return null;
    return templateStartMs(assignment.date, t.startTime) + templateMinutes(t) * 60000;
  };

  // First pass: raw suggestions (template choice + leave skip).
  const raw: { employeeId: string; date: string; shiftTemplateId: string; weeksWorked: number }[] = [];
  const skippedOnLeave: { employeeId: string; date: string }[] = [];
  for (const emp of employees) {
    for (let dow = 0; dow < 5; dow++) { // Monday–Friday
      const date = addDays(weekStart, dow);
      const onLeave = store.listLeaveRequests(tenantId).some(
        (l) => l.employeeId === emp.id && l.status === 'approved' && l.startDate <= date && l.endDate >= date);
      if (onLeave) { skippedOnLeave.push({ employeeId: emp.id, date }); continue; }
      const { templateId, weeksWorked } = pickTemplate(emp.id, dow);
      if (!templateId) continue;
      raw.push({ employeeId: emp.id, date, shiftTemplateId: templateId, weeksWorked });
    }
  }
  // Coverage counts per (date, template, role).
  const coverageCount = new Map<string, number>();
  for (const r of raw) {
    const emp = employees.find((e) => e.id === r.employeeId)!;
    const key = `${r.date}|${r.shiftTemplateId}|${emp.jobTitle}`;
    coverageCount.set(key, (coverageCount.get(key) ?? 0) + 1);
  }
  // Second pass: score each suggestion against rest / caps / consecutive days.
  const suggestions: ScheduleSuggestion[] = [];
  const draftSoFar: { employeeId: string; date: string; shiftTemplateId: string }[] = [];
  for (const r of raw) {
    const emp = employees.find((e) => e.id === r.employeeId)!;
    const template = templateById(r.shiftTemplateId)!;
    const startMs = templateStartMs(r.date, template.startTime);
    const prior = [...existingAssignments.filter((a) => a.employeeId === r.employeeId), ...draftSoFar.filter((a) => a.employeeId === r.employeeId)]
      .map((a) => ({ end: endMsFor(a), date: a.date }))
      .filter((x): x is { end: number; date: string } => x.end !== null && x.end <= startMs)
      .sort((a, b) => b.end - a.end)[0];
    const restHoursBefore = prior ? (startMs - prior.end) / 3600000 : null;
    const weekStartMs = new Date(`${addDays(r.date, -((new Date(`${r.date}T00:00:00Z`).getUTCDay() + 6) % 7))}T00:00:00Z`).getTime();
    const weekEndMs = weekStartMs + 7 * 86400000;
    const weekMinutes = [...existingAssignments.filter((a) => a.employeeId === r.employeeId), ...draftSoFar.filter((a) => a.employeeId === r.employeeId)]
      .filter((a) => { const t = new Date(`${a.date}T00:00:00Z`).getTime(); return t >= weekStartMs && t < weekEndMs; })
      .reduce((s, a) => s + minutesFor(a), 0) + templateMinutes(template);
    let consecutiveDays = 1;
    const dates = new Set([...existingAssignments.filter((a) => a.employeeId === r.employeeId), ...draftSoFar.filter((a) => a.employeeId === r.employeeId)].map((a) => a.date));
    let cursor = new Date(`${r.date}T00:00:00Z`);
    for (let i = 0; i < 30; i++) {
      cursor = new Date(cursor.getTime() - 86400000);
      if (dates.has(cursor.toISOString().slice(0, 10))) consecutiveDays++;
      else break;
    }
    const coverageRequired = settings.coverageMinimums[emp.jobTitle] ?? 0;
    const coverageAssigned = coverageCount.get(`${r.date}|${r.shiftTemplateId}|${emp.jobTitle}`) ?? 0;
    const scored = scoreDraftSuggestion({
      employeeId: emp.id, employeeName: emp.fullNameAr, jobTitle: emp.jobTitle,
      date: r.date, shiftTemplateId: r.shiftTemplateId, shiftName: template.nameAr,
      historyWeeksWorked: r.weeksWorked, historyWeeksTotal: weeksTotal,
      onLeave: false, restHoursBefore, weeklyHoursAfter: weekMinutes / 60,
      weeklyHoursCap: settings.weeklyHoursCap, consecutiveDays,
      maxConsecutiveDays: settings.maxConsecutiveDays, minRestHours: settings.minRestHoursBetweenShifts,
      coverageRequired, coverageAssigned,
    });
    suggestions.push({
      id: newId('sug'), employeeId: emp.id, date: r.date, shiftTemplateId: r.shiftTemplateId,
      reasonAr: scored.reasonAr, reasonEn: scored.reasonEn,
      violations: scored.violations, warnings: scored.warnings, score: scored.score,
      decision: 'pending', editedShiftTemplateId: null, decidedByUserId: null,
    });
    draftSoFar.push(r);
  }
  return { suggestions, skippedOnLeave };
}

export async function runScheduleDraft(
  store: MemoryStore, tenantId: string, branchId: string, weekStart: string, userId: string,
): Promise<ScheduleDraftRecord> {
  ensureAgentAllowed(store, tenantId, 'schedule');
  const { suggestions, skippedOnLeave } = buildScheduleDraftSuggestions(store, tenantId, branchId, weekStart);
  const generated = await llm.generateStructured({
    agentId: 'schedule',
    prompt: 'Build a draft roster for next week from roster/attendance history, coverage rules and leave.',
    schema: { suggestions: 'array', skippedOnLeave: 'array' },
    structuredContext: { weekStart, branchId, suggestions, skippedOnLeave },
  });
  const run = recordAgentRun(store, tenantId, 'schedule', { weekStart, branchId }, generated.output, { costPiasters: generated.costPiasters, provider: generated.provider });
  const draft: ScheduleDraftRecord = {
    id: newId('draft'), tenantId, branchId, weekStart, status: 'draft',
    suggestions, agentRunId: run.id, createdByUserId: userId, decidedByUserId: null,
    publishedRosterId: null, createdAt: new Date().toISOString(),
  };
  store.scheduleDrafts.push(draft);
  store.log({ tenantId, actorUserId: userId, actorKind: 'tenant_user', action: 'agent.schedule.draft', entity: 'schedule_draft', detail: { draftId: draft.id, weekStart, branchId, suggestions: suggestions.length, violations: suggestions.filter((s) => s.violations.length > 0).length, note: 'DRAFT ONLY — never auto-published' } });
  return draft;
}

// ============================================================================
// Agent 3 — Pre-payroll anomaly checker
// ============================================================================
export async function runAnomalyCheck(
  store: MemoryStore, tenantId: string, run: PayrollRunRecord, userId: string | null,
): Promise<{ anomalies: ReturnType<typeof detectAgent3Anomalies>; run: ReturnType<typeof recordAgentRun>; preview: boolean }> {
  ensureAgentAllowed(store, tenantId, 'anomaly');
  const { inputs, preview } = buildAgent3Inputs(store, tenantId, run);
  let anomalies = detectAgent3Anomalies(inputs);
  if (preview) anomalies = anomalies.filter((a) => a.kind === 'missing_clock_out');
  const generated = await llm.generateStructured({
    agentId: 'anomaly',
    prompt: 'Rank the pre-payroll anomalies for this run with amounts in EGP.',
    schema: { anomalies: 'array' },
    structuredContext: { runId: run.id, period: run.period, preview, anomalies },
  });
  const agentRun = recordAgentRun(store, tenantId, 'anomaly', { runId: run.id, period: run.period }, generated.output, { costPiasters: generated.costPiasters, provider: generated.provider });
  store.log({ tenantId, actorUserId: userId, actorKind: 'tenant_user', action: 'agent.anomaly.run', entity: 'payroll_run', detail: { runId: run.id, period: run.period, preview, anomalies: anomalies.length, kinds: anomalies.map((a) => a.kind), note: 'Flags and explanations only — the owner decides' } });
  return { anomalies, run: agentRun, preview };
}

// ============================================================================
// Agent 4 — Employee Q&A (own data only)
// ============================================================================
export async function answerQa(
  store: MemoryStore, tenantId: string, userId: string, employeeId: string, question: string,
): Promise<{ answerAr: string; answerEn: string; intent: string; confidence: number; routed: boolean; routedQuestionId: string | null; run: ReturnType<typeof recordAgentRun> }> {
  ensureAgentAllowed(store, tenantId, 'qa');
  const emp = store.getEmployee(tenantId, employeeId);
  const matched = matchQaIntent(question);
  const today = new Date().toISOString().slice(0, 10);
  const publishedRosterIds = new Set(store.listRosters(tenantId).filter((r) => r.status === 'published').map((r) => r.id));
  const next = store.rosterAssignments
    .filter((a) => publishedRosterIds.has(a.rosterId) && a.employeeId === employeeId && a.date >= today && !a.onLeave)
    .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  const nextShift = next ? (() => {
    const template = next.shiftTemplateId ? store.shiftTemplates.find((t) => t.id === next.shiftTemplateId) : undefined;
    const roster = store.rosters.find((r) => r.id === next.rosterId);
    const branch = roster?.branchId ? store.branches.find((b) => b.id === roster.branchId) : undefined;
    return { date: next.date, shiftName: template?.nameAr ?? 'وردية', startTime: template?.startTime ?? '', endTime: template?.endTime ?? '', branchName: branch?.nameAr ?? '' };
  })() : null;
  const year = Number(today.slice(0, 4));
  const leaveBalances = store.leaveBalances
    .filter((b) => b.tenantId === tenantId && b.employeeId === employeeId && b.year === year)
    .map((b) => ({ type: b.type, remainingDays: Math.round((b.entitlementDays + b.carriedDays - b.takenDays) * 100) / 100, entitlementDays: b.entitlementDays }));
  const slips = store.listPayslips(tenantId).filter((p) => p.employeeId === employeeId).sort((a, b) => (a.period < b.period ? 1 : -1));
  const latest = slips[0];
  const answer = composeQaAnswer(matched.intent, {
    employeeName: emp.fullNameAr, nextShift, leaveBalances,
    latestPayslip: latest ? { period: latest.period, netPiasters: latest.netPiasters, lines: latest.lines } : null,
    questionAmountPiasters: extractEgpAmountPiasters(question),
  });
  let routedQuestionId: string | null = null;
  if (answer.routed) {
    const rec = {
      id: newId('routedq'), tenantId, employeeId, question, intent: matched.intent,
      status: 'routed' as const, answer: null, answeredByUserId: null,
      createdAt: new Date().toISOString(), answeredAt: null,
    };
    store.routedQuestions.push(rec);
    routedQuestionId = rec.id;
  }
  const generated = await llm.generateStructured({
    agentId: 'qa',
    prompt: 'Answer the employee question in Arabic from their own data only.',
    schema: { answerAr: 'string', answerEn: 'string', routed: 'boolean' },
    structuredContext: { employeeId, intent: matched.intent, answerAr: answer.answerAr, answerEn: answer.answerEn, sources: answer.sources, routed: answer.routed },
  });
  const run = recordAgentRun(store, tenantId, 'qa', { employeeId, question }, generated.output, { costPiasters: generated.costPiasters, provider: generated.provider, employeeId });
  return { answerAr: answer.answerAr, answerEn: answer.answerEn, intent: matched.intent, confidence: matched.confidence, routed: answer.routed, routedQuestionId, run };
}

// ============================================================================
// Routes
// ============================================================================
export function registerM4(app: FastifyInstance, store: MemoryStore, jwtSecret: string): void {
  const auth = (req: { headers: Record<string, string | string[] | undefined> }): SessionClaims => {
    const h = req.headers.authorization;
    const token = Array.isArray(h) ? h[0] : h;
    if (!token?.startsWith('Bearer ')) throw new Error('missing bearer token');
    return verifySession(token.slice(7), jwtSecret);
  };
  const claims = (req: never, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): SessionClaims | null => {
    try { return auth(req as never); } catch { void reply.code(401).send({ error: 'unauthorised' }); return null; }
  };
  const tenant = (c: SessionClaims, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): string | null => {
    if (!c.tenantId) { void reply.code(403).send({ error: 'tenant session required' }); return null; }
    return c.tenantId;
  };
  const needRole = (c: SessionClaims, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, roles: string[]): boolean => {
    if (!roles.includes(c.role)) { void reply.code(403).send({ error: `role ${c.role} cannot perform this action (needs ${roles.join(' or ')})` }); return false; }
    return true;
  };
  const audit = (tenantId: string, actorUserId: string | null, action: string, entity: string, detail: unknown) =>
    store.log({ tenantId, actorUserId, actorKind: 'tenant_user', action, entity, detail });
  const superadmin = (req: { headers: Record<string, string | string[] | undefined> }): SessionClaims => {
    const c = auth(req);
    if (c.role !== 'superadmin') throw new Error('superadmin only');
    if (process.env.SUPERADMIN_MFA_REQUIRED !== 'false' && !c.mfaVerified) throw new Error('superadmin MFA verification required');
    return c;
  };
  const month = monthKey(new Date().toISOString());

  // --- Agent status / runs / cost --------------------------------------------
  app.get('/api/agents/status', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { provider: 'stub', agents: AGENT_IDS.map((id) => agentStatus(store, t, id, month)), note: 'STUBBED LLM provider — costs are fixed estimates, not real token billing.' };
  });
  app.get('/api/agents/runs', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const q = req.query as { agentId?: string; month?: string };
    if (c.role === 'employee') return reply.code(403).send({ error: 'managers only — employees use /api/agents/qa/mine' });
    return { runs: store.listAgentRuns(t, q.agentId, q.month) };
  });
  app.get('/api/agents/cost', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const m = (req.query as { month?: string }).month ?? month;
    const perAgent = AGENT_IDS.map((id) => {
      const s = agentStatus(store, t, id, m);
      return { agentId: id, monthCostPiasters: s.monthCostPiasters, capPiasters: s.capPiasters, capExceeded: s.capExceeded, paused: s.paused, remainingPiasters: s.remainingPiasters };
    });
    return {
      month: m, perAgent,
      totalPiasters: perAgent.reduce((s, a) => s + a.monthCostPiasters, 0),
      note: 'STUBBED cost estimates (fixed per-run piasters) — a real provider bills per token; real usage accounting ships in V1.',
    };
  });
  app.post('/api/agents/cost/cap', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner'])) return;
    const b = req.body as { agentId?: string; capPiasters?: number };
    if (typeof b?.capPiasters !== 'number' || b.capPiasters < 0) return reply.code(400).send({ error: 'capPiasters (>= 0) is required' });
    if (b.agentId && !(AGENT_IDS as string[]).includes(b.agentId)) return reply.code(400).send({ error: `agentId must be one of ${AGENT_IDS.join(', ')} or omitted (all agents)` });
    const key = b.agentId ? `${t}:${b.agentId}` : `${t}:all`;
    store.agentCostCaps.set(key, b.capPiasters);
    audit(t, c.sub, 'agent.cost_cap_set', 'agent_cost_cap', { agentId: b.agentId ?? 'all', capPiasters: b.capPiasters });
    return { agentId: b.agentId ?? 'all', capPiasters: b.capPiasters, monthCostPiasters: b.agentId ? store.agentMonthCost(t, b.agentId, month) : undefined };
  });
  app.post('/api/agents/kill-switch', async (req, reply) => {
    const b = req.body as { agentId?: string; scope?: 'tenant' | 'global'; killed?: boolean };
    if (!b?.agentId || !(AGENT_IDS as string[]).includes(b.agentId) || !['tenant', 'global'].includes(b.scope ?? '') || typeof b.killed !== 'boolean') {
      return reply.code(400).send({ error: 'agentId (briefing|schedule|anomaly|qa), scope (tenant|global) and killed (boolean) are required' });
    }
    if (b.scope === 'global') {
      let sa: SessionClaims;
      try { sa = superadmin(req); } catch (e) { return reply.code(403).send({ error: (e as Error).message }); }
      store.agentKillSwitches.set(`global:${b.agentId}`, b.killed);
      store.log({ tenantId: null, actorUserId: sa.sub, actorKind: 'superadmin', action: 'agent.kill_switch_global', entity: 'agent', detail: { agentId: b.agentId, killed: b.killed } });
      return { agentId: b.agentId, scope: 'global', killed: b.killed };
    }
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner'])) return;
    store.agentKillSwitches.set(`${t}:${b.agentId}`, b.killed);
    audit(t, c.sub, 'agent.kill_switch_tenant', 'agent', { agentId: b.agentId, killed: b.killed, note: 'Pauses the agent only — attendance and payroll keep working' });
    return { agentId: b.agentId, scope: 'tenant', killed: b.killed };
  });

  // --- Agent 1: briefing -------------------------------------------------------
  app.post('/api/agents/briefing/run', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    const b = req.body as { date?: string };
    const date = b?.date ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
    try {
      const { briefing, run } = await runBriefing(store, t, date, c.sub);
      return { briefing, run, provider: 'stub', note: 'WhatsApp delivery is STUBBED — queued in the outbox, not sent.' };
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg.includes('paused') ? 409 : 400).send({ error: msg });
    }
  });
  app.get('/api/agents/briefing/latest', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const runs = store.listAgentRuns(t, 'briefing').filter((r) => r.status === 'completed');
    const latest = runs[runs.length - 1];
    return { briefing: latest?.output ?? null, runId: latest?.id ?? null, provider: 'stub' };
  });

  // --- Agent 2: schedule drafts -------------------------------------------------
  app.post('/api/agents/schedule/draft', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    const b = req.body as { branchId?: string; weekStart?: string };
    if (!b?.branchId || !b?.weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(b.weekStart)) return reply.code(400).send({ error: 'branchId and weekStart (YYYY-MM-DD, Monday) are required' });
    try { store.getBranch(t, b.branchId); } catch { return reply.code(404).send({ error: 'branch not found' }); }
    if (c.role === 'branch_manager') {
      try { const user = store.getUser(t, c.sub); if (user.branchId !== b.branchId) return reply.code(403).send({ error: 'branch manager can only draft their own branch' }); } catch { return reply.code(403).send({ error: 'branch manager can only draft their own branch' }); }
    }
    try {
      const draft = await runScheduleDraft(store, t, b.branchId, b.weekStart, c.sub);
      return reply.code(201).send({ draft, note: 'DRAFT ONLY — this draft never publishes itself. Review it, then publish through the manager flow.' });
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg.includes('paused') ? 409 : 400).send({ error: msg });
    }
  });
  app.get('/api/agents/schedule/drafts', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { drafts: store.listScheduleDrafts(t) };
  });
  app.get('/api/agents/schedule/drafts/:id', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    try { return { draft: store.getScheduleDraft(t, (req.params as { id: string }).id) }; }
    catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
  });
  app.post('/api/agents/schedule/drafts/:id/review', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    let draft: ScheduleDraftRecord;
    try { draft = store.getScheduleDraft(t, (req.params as { id: string }).id); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
    if (draft.status === 'published') return reply.code(409).send({ error: 'draft is already published' });
    const b = req.body as { decisions?: { suggestionId?: string; decision?: 'accepted' | 'edited' | 'rejected'; editedShiftTemplateId?: string }[] };
    if (!Array.isArray(b?.decisions) || b.decisions.length === 0) return reply.code(400).send({ error: 'decisions[] is required' });
    for (const d of b.decisions) {
      const s = draft.suggestions.find((x) => x.id === d.suggestionId);
      if (!s) return reply.code(404).send({ error: `suggestion ${d.suggestionId} not found in this draft` });
      if (!['accepted', 'edited', 'rejected'].includes(d.decision ?? '')) return reply.code(400).send({ error: 'decision must be accepted|edited|rejected' });
      const decision = d.decision as 'accepted' | 'edited' | 'rejected';
      if (d.decision === 'edited') {
        if (!d.editedShiftTemplateId || !store.shiftTemplates.some((x) => x.id === d.editedShiftTemplateId && x.tenantId === t)) {
          return reply.code(400).send({ error: 'edited decision needs a valid editedShiftTemplateId' });
        }
        s.editedShiftTemplateId = d.editedShiftTemplateId;
      }
      s.decision = decision;
      s.decidedByUserId = c.sub;
    }
    draft.decidedByUserId = c.sub;
    if (draft.suggestions.every((s) => s.decision !== 'pending')) draft.status = 'reviewed';
    if (draft.agentRunId) {
      const run = store.agentRuns.find((r) => r.id === draft.agentRunId);
      if (run) { run.decisions = b.decisions; run.humanDecision = `reviewed by ${c.sub}: ${b.decisions.length} decision(s)`; run.decidedByUserId = c.sub; }
    }
    audit(t, c.sub, 'agent.schedule.review', 'schedule_draft', { draftId: draft.id, decisions: b.decisions.length, status: draft.status });
    return { draft };
  });
  app.post('/api/agents/schedule/drafts/:id/publish', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    let draft: ScheduleDraftRecord;
    try { draft = store.getScheduleDraft(t, (req.params as { id: string }).id); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
    if (draft.status !== 'reviewed') return reply.code(409).send({ error: `draft must be reviewed first (current status: ${draft.status}) — a human reviews every suggestion before anything publishes` });
    const accepted = draft.suggestions.filter((s) => s.decision === 'accepted' || s.decision === 'edited');
    if (accepted.length === 0) return reply.code(400).send({ error: 'no accepted suggestions to publish' });
    const roster = { id: newId('roster'), tenantId: t, branchId: draft.branchId, weekStart: draft.weekStart, status: 'draft' as const, publishedAt: null, publishedByUserId: null };
    store.rosters.push(roster);
    for (const s of accepted) {
      store.rosterAssignments.push({
        id: newId('asg'), tenantId: t, rosterId: roster.id, employeeId: s.employeeId,
        date: s.date, shiftTemplateId: s.decision === 'edited' ? s.editedShiftTemplateId : s.shiftTemplateId, onLeave: false,
      });
    }
    const result = await publishRoster(store, t, roster, c.sub);
    draft.status = 'published';
    draft.publishedRosterId = roster.id;
    audit(t, c.sub, 'agent.schedule.publish', 'roster', { draftId: draft.id, rosterId: roster.id, assignments: accepted.length, rejected: draft.suggestions.length - accepted.length });
    return { roster: result.roster, warnings: result.warnings, notified: result.notified, stubbed: true, draft };
  });

  // --- Agent 3: anomaly checker ---------------------------------------------------
  app.post('/api/agents/anomaly/run', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    const b = req.body as { runId?: string };
    if (!b?.runId) return reply.code(400).send({ error: 'runId is required' });
    let run: PayrollRunRecord;
    try { run = store.getPayrollRun(t, b.runId); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
    try {
      const { anomalies, run: agentRun, preview } = await runAnomalyCheck(store, t, run, c.sub);
      return { runId: run.id, period: run.period, preview, anomalies, agentRunId: agentRun.id, provider: 'stub', note: 'Flags and explanations only — the owner decides. All flags and decisions are audit-logged.' };
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg.includes('paused') ? 409 : 400).send({ error: msg });
    }
  });
  app.post('/api/agents/anomaly/decisions', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    const b = req.body as { runId?: string; decisions?: { key?: string; decision?: 'accepted' | 'dismissed'; note?: string }[] };
    if (!b?.runId || !Array.isArray(b.decisions) || b.decisions.length === 0) return reply.code(400).send({ error: 'runId and decisions[] are required' });
    let run: PayrollRunRecord;
    try { run = store.getPayrollRun(t, b.runId); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
    for (const d of b.decisions) {
      if (!d.key || !['accepted', 'dismissed'].includes(d.decision ?? '') || !d.note?.trim()) {
        return reply.code(400).send({ error: 'each decision needs key, decision (accepted|dismissed) and a note' });
      }
      audit(t, c.sub, 'agent.anomaly.decision', 'payroll_run', { runId: run.id, period: run.period, key: d.key, decision: d.decision, note: d.note });
    }
    const agentRun = [...store.listAgentRuns(t, 'anomaly')].reverse()
      .find((r) => (r.output as { runId?: string } | null)?.runId === run.id);
    if (agentRun) {
      agentRun.decisions = b.decisions;
      agentRun.humanDecision = b.decisions.map((d) => `${d.key}:${d.decision}`).join('; ');
      agentRun.decidedByUserId = c.sub;
    }
    return { runId: run.id, decisions: b.decisions, recorded: true };
  });

  // --- Agent 4: employee Q&A -------------------------------------------------------
  app.post('/api/agents/qa/ask', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'employee') return reply.code(403).send({ error: 'employee self-service only — managers use the roster, leave and payroll screens' });
    const linked = store.linkedEmployeeForUser(t, c.sub);
    if (!linked) {
      return reply.code(403).send({ error: 'your user account is not linked to an employee record yet — ask the owner to link it (POST /api/employees/link). No employee data is shown until then.' });
    }
    const b = req.body as { question?: string };
    if (!b?.question?.trim()) return reply.code(400).send({ error: 'question is required' });
    try {
      const result = await answerQa(store, t, c.sub, linked.id, b.question.trim());
      const { run, ...rest } = result;
      return { ...rest, agentRunId: run.id, provider: 'stub', employeeId: linked.id };
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg.includes('paused') ? 409 : 400).send({ error: msg });
    }
  });
  app.get('/api/agents/qa/mine', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'employee') return reply.code(403).send({ error: 'employee self-service only' });
    const linked = store.linkedEmployeeForUser(t, c.sub);
    if (!linked) return { employee: null, questions: [], runs: [] };
    return {
      employee: { id: linked.id, fullNameAr: linked.fullNameAr, jobTitle: linked.jobTitle },
      questions: store.listRoutedQuestions(t, linked.id),
      runs: store.agentRuns.filter((r) => r.tenantId === t && r.agentId === 'qa' && r.employeeId === linked.id),
    };
  });
  app.get('/api/agents/qa/routed', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    const q = req.query as { status?: string };
    let list = store.listRoutedQuestions(t);
    if (q.status) list = list.filter((x) => x.status === q.status);
    return { questions: list.map((x) => ({ ...x, employeeName: store.employees.find((e) => e.id === x.employeeId)?.fullNameAr ?? x.employeeId })) };
  });
  app.post('/api/agents/qa/routed/:id/answer', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    const rec = store.routedQuestions.find((x) => x.id === (req.params as { id: string }).id && x.tenantId === t);
    if (!rec) return reply.code(404).send({ error: 'routed question not found' });
    const b = req.body as { answer?: string };
    if (!b?.answer?.trim()) return reply.code(400).send({ error: 'answer is required' });
    rec.status = 'answered';
    rec.answer = b.answer.trim();
    rec.answeredByUserId = c.sub;
    rec.answeredAt = new Date().toISOString();
    audit(t, c.sub, 'agent.qa.routed_answer', 'routed_question', { questionId: rec.id, employeeId: rec.employeeId });
    return { question: rec };
  });

  // --- Employee linking (M3-flagged gap fix) --------------------------------------
  app.post('/api/employees/link', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner'])) return;
    const b = req.body as { userId?: string; employeeId?: string };
    if (!b?.userId || !b?.employeeId) return reply.code(400).send({ error: 'userId and employeeId are required' });
    let user;
    try { user = store.getUser(t, b.userId); } catch { return reply.code(404).send({ error: 'user not found' }); }
    try { store.getEmployee(t, b.employeeId); } catch { return reply.code(404).send({ error: 'employee not found' }); }
    const already = [...store.users.values()].find((u) => u.tenantId === t && u.employeeId === b.employeeId && u.id !== b.userId);
    if (already) return reply.code(409).send({ error: 'this employee record is already linked to another user account' });
    user.employeeId = b.employeeId;
    audit(t, c.sub, 'employee.link_user', 'user', { userId: b.userId, employeeId: b.employeeId });
    return reply.code(201).send({ userId: b.userId, employeeId: b.employeeId, linked: true });
  });
  app.get('/api/me/employee', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const linked = store.linkedEmployeeForUser(t, c.sub);
    return { linked: !!linked, employee: linked ? { id: linked.id, fullNameAr: linked.fullNameAr, fullNameEn: linked.fullNameEn ?? null, jobTitle: linked.jobTitle, branchId: linked.branchId } : null };
  });

  // --- Offline sync status ----------------------------------------------------------
  app.get('/api/attendance/offline-sync/status', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager', 'accountant'])) return;
    const records = store.offlineSyncLog.filter((r) => r.tenantId === t);
    const pendingReview = store.listAttendance(t).filter((a) => a.source === 'offline_queue' && a.verificationStatus === 'pending_review').length;
    return {
      ...aggregateSyncStatus(records, pendingReview),
      signatureVerification: process.env.OFFLINE_SIGNING_SECRET ? 'strict (HMAC-SHA256)' : 'legacy (any non-empty signature accepted, flagged) — set OFFLINE_SIGNING_SECRET to enforce',
      recent: records.slice(-20),
    };
  });

  // --- Support tooling (Superadmin Lite + M4) ---------------------------------------
  app.get('/api/superadmin/tenants/:id/health', async (req, reply) => {
    let sa: SessionClaims;
    try { sa = superadmin(req); } catch (e) { return reply.code(403).send({ error: (e as Error).message }); }
    const tenantId = (req.params as { id: string }).id;
    const tenantRec = store.getTenant(tenantId);
    if (!tenantRec) return reply.code(404).send({ error: 'tenant not found' });
    const setupIncomplete: string[] = [];
    for (const area of ['attendance', 'shifts', 'leave', 'payroll_structure', 'statutory_rates', 'notifications', 'integrations_billing_data', 'ai_agents'] as const) {
      if (!store.latestSettings(tenantId, area)) setupIncomplete.push(`settings area ${area} has no version yet`);
    }
    if (store.listBranches(tenantId).length === 0) setupIncomplete.push('no branches');
    if (store.listEmployees(tenantId).length === 0) setupIncomplete.push('no employees');
    if (!store.listRosters(tenantId).some((r) => r.status === 'published')) setupIncomplete.push('no published roster');
    const statutory = store.latestSettings(tenantId, 'statutory_rates');
    if ((statutory?.value as { nosiEmployerPct?: unknown } | undefined)?.nosiEmployerPct == null) setupIncomplete.push('NOSI employer rate unresolved (M0)');
    const today = new Date().toISOString().slice(0, 10);
    const noClockInsToday = store.listBranches(tenantId)
      .filter((b) => b.active)
      .filter((b) => !store.listAttendance(tenantId).some((a) => a.branchId === b.id && a.clockInAt?.slice(0, 10) === today))
      .map((b) => ({ branchId: b.id, branchName: b.nameEn }));
    const stuckCutoff = Date.now() - 7 * 86400000;
    const payrollRunStuck = store.listPayrollRuns(tenantId)
      .filter((r) => (r.status === 'prepared' || r.status === 'calculated') && new Date(r.createdAt).getTime() < stuckCutoff)
      .map((r) => ({ runId: r.id, period: r.period, status: r.status, ageDays: Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86400000) }));
    const outbox = store.outbox.filter((m) => m.tenantId === tenantId);
    store.log({ tenantId, actorUserId: sa.sub, actorKind: 'superadmin', action: 'superadmin.tenant.health', entity: 'tenant', detail: { tenantId } });
    return {
      tenantId, tenant: tenantRec.slug, status: tenantRec.status, plan: tenantRec.plan,
      setupIncomplete,
      noClockInsToday,
      payrollRunStuck,
      whatsapp: {
        provider: 'stub', deliveryRate: null,
        queuedStubbed: outbox.filter((m) => m.status === 'queued_stubbed').length,
        note: 'STUBBED — delivery is not measurable; messages are queued only, never sent. A delivery-failing signal needs a live provider (V1).',
      },
      agents: AGENT_IDS.map((id) => agentStatus(store, tenantId, id, month)),
      counts: {
        employees: store.listEmployees(tenantId).length,
        branches: store.listBranches(tenantId).length,
        openExceptions: store.listExceptions(tenantId, 'open').length,
        payrollRuns: store.listPayrollRuns(tenantId).length,
      },
    };
  });
  app.get('/api/superadmin/tenants/:id/ticket-context', async (req, reply) => {
    let sa: SessionClaims;
    try { sa = superadmin(req); } catch (e) { return reply.code(403).send({ error: (e as Error).message }); }
    const tenantId = (req.params as { id: string }).id;
    const tenantRec = store.getTenant(tenantId);
    if (!tenantRec) return reply.code(404).send({ error: 'tenant not found' });
    const employees = store.listEmployees(tenantId).map((e) => ({
      id: e.id,
      nameMasked: maskName(e.fullNameAr),
      phoneMasked: maskPhone(e.phone),
      jobTitle: e.jobTitle,
      branchName: e.branchId ? store.branches.find((b) => b.id === e.branchId)?.nameEn ?? '' : '',
    }));
    const recentExceptions = store.listExceptions(tenantId)
      .slice(-10)
      .map((x) => ({
        kind: x.kind, status: x.status, date: x.createdAt.slice(0, 10),
        employeeMasked: maskName(store.employees.find((e) => e.id === x.employeeId)?.fullNameAr ?? x.employeeId),
      }));
    store.log({ tenantId, actorUserId: sa.sub, actorKind: 'superadmin', action: 'superadmin.tenant.ticket_context', entity: 'tenant', detail: { tenantId, masked: true } });
    return {
      tenantId, tenant: tenantRec.slug,
      employees, recentExceptions,
      counts: {
        employees: employees.length,
        openExceptions: store.listExceptions(tenantId, 'open').length,
        openLeaveRequests: store.listLeaveRequests(tenantId).filter((l) => l.status === 'pending').length,
        payrollRuns: store.listPayrollRuns(tenantId).length,
      },
      note: 'MASKED ticket context — names initialled, phones partially masked, no photos, no salary figures, no payslips.',
    };
  });
}
