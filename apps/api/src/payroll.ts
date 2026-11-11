// M3 Payroll MVP routes (Brief §7, §10 Areas 6–7, Appendix A/B).
// Five steps: Prepare → Review anomalies → Calculate → Approve (locks) →
// Pay/distribute (generated bank file + stubbed WhatsApp payslips).
// Locked runs are immutable: corrections only as next-run adjustments.
// NOSI employer rate: a run REFUSES to finalise while the rate is null
// (BLOCKED error, employer cost shown as PENDING). Employee payslip lines
// are computable and correct while employer cost is pending, and employer
// contributions are never presented as an employee deduction.
import type { FastifyInstance } from 'fastify';
import { verifySession, type SessionClaims } from './auth.js';
import { newId, type MemoryStore, type PayrollRunRecord, type PayslipRecord } from '@hr-payroll/db';
import {
  calculatePayslip, detectPayrollAnomalies, daysInMonth, workedDaysInPeriod,
  isPublicHoliday, DEFAULT_STATUTORY_SETTINGS, TAX_RULES_2026, OVERTIME_RULES_2026,
  type PayslipAllowance, type OvertimeMinutes,
} from '@hr-payroll/shared';
import { notifyEmployee } from './notify.js';
import { daysBetween } from './leave.js';

export const PAYROLL_BANKS = ['CIB', 'QNB', 'NBE', 'Banque Misr'] as const;
export type PayrollBank = (typeof PAYROLL_BANKS)[number];

export function statutorySettings(store: MemoryStore, tenantId: string) {
  const latest = store.latestSettings(tenantId, 'statutory_rates');
  return { ...DEFAULT_STATUTORY_SETTINGS, ...((latest?.value ?? {}) as Record<string, unknown>) } as typeof DEFAULT_STATUTORY_SETTINGS;
}

export function periodBounds(period: string): { start: string; end: string; days: number } {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error('period must be YYYY-MM');
  const days = daysInMonth(y, m);
  return {
    start: `${period}-01`,
    end: `${period}-${String(days).padStart(2, '0')}`,
    days,
  };
}

/** Cairo wall-clock hour of a timestamp (for the night-OT split). */
function cairoHour(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false }).format(new Date(iso));
  return Number(parts.split(':')[0]);
}

export interface AttendanceSummary {
  workedDays: number;
  workedDates: string[];
  regularMinutes: number;
  overtime: OvertimeMinutes;
  missingClockOuts: number;
  lateCount: number;
}

/** Summarise verified attendance for one employee in a period.
 *  Only completed records (clock-out present) count hours; missing
 *  clock-outs are flagged and priced as zero for those days. OT split:
 *  public-holiday work → holiday OT; work on a day with no roster
 *  assignment → rest-day OT; clock-out at/after 21:00 Cairo → night OT;
 *  otherwise day OT. */
export function summariseAttendance(
  store: MemoryStore, tenantId: string, employeeId: string, periodStart: string, periodEnd: string,
): AttendanceSummary {
  const records = store.listAttendance(tenantId).filter(
    (a) => a.employeeId === employeeId && a.clockInAt && a.clockInAt.slice(0, 10) >= periodStart && a.clockInAt.slice(0, 10) <= periodEnd,
  );
  const ot: OvertimeMinutes = { dayMin: 0, nightMin: 0, restDayMin: 0, publicHolidayMin: 0 };
  const workedDates = new Set<string>();
  let regularMinutes = 0;
  let missingClockOuts = 0;
  for (const rec of records) {
    const date = rec.clockInAt!.slice(0, 10);
    if (!rec.clockOutAt) { missingClockOuts++; continue; }
    const workedMin = Math.max(0, Math.round((new Date(rec.clockOutAt).getTime() - new Date(rec.clockInAt!).getTime()) / 60000));
    workedDates.add(date);
    const assignment = store.rosterAssignments.find((a) => a.tenantId === tenantId && a.employeeId === employeeId && a.date === date && !a.onLeave);
    const template = assignment?.shiftTemplateId ? store.shiftTemplates.find((t) => t.id === assignment.shiftTemplateId) : undefined;
    if (isPublicHoliday(date)) {
      ot.publicHolidayMin += workedMin;
      continue;
    }
    if (!assignment || !template) {
      // No scheduled shift that day: rest-day work (Friday default).
      ot.restDayMin += workedMin;
      continue;
    }
    const [sh, sm] = template.startTime.split(':').map(Number);
    const [eh, em] = template.endTime.split(':').map(Number);
    let shiftMin = eh * 60 + em - (sh * 60 + sm);
    if (template.overnight) shiftMin += 1440;
    const standardMin = Math.max(0, shiftMin - template.unpaidBreakMinutes);
    const regular = Math.min(workedMin, standardMin);
    const extra = workedMin - regular;
    regularMinutes += regular;
    if (extra > 0) {
      if (cairoHour(rec.clockOutAt) >= OVERTIME_RULES_2026.nightStartHour) ot.nightMin += extra;
      else ot.dayMin += extra;
    }
  }
  const lateCount = store.exceptions.filter(
    (e) => e.tenantId === tenantId && e.employeeId === employeeId && e.kind === 'late' && e.status !== 'dismissed'
      && e.createdAt.slice(0, 10) >= periodStart && e.createdAt.slice(0, 10) <= periodEnd,
  ).length;
  return { workedDays: workedDates.size, workedDates: [...workedDates].sort(), regularMinutes, overtime: ot, missingClockOuts, lateCount };
}

export function unpaidLeaveDays(store: MemoryStore, tenantId: string, employeeId: string, periodStart: string, periodEnd: string): number {
  let days = 0;
  for (const req of store.listLeaveRequests(tenantId)) {
    if (req.employeeId !== employeeId || req.type !== 'unpaid' || req.status !== 'approved') continue;
    const s = req.startDate < periodStart ? periodStart : req.startDate;
    const e = req.endDate > periodEnd ? periodEnd : req.endDate;
    if (e >= s) days += daysBetween(s, e);
  }
  return days;
}

/** Calculate (or re-calculate) every payslip for a run. Only allowed while
 *  the run is prepared/draft; a locked run is never recalculated. */
export function calculateRun(store: MemoryStore, tenantId: string, run: PayrollRunRecord): PayslipRecord[] {
  if (run.status === 'locked' || run.status === 'paid' || run.status === 'approved') {
    throw new Error('locked run is immutable — corrections only as next-run adjustments');
  }
  const { start, end, days } = periodBounds(run.period);
  const statutory = statutorySettings(store, tenantId);
  const employees = store.listEmployees(tenantId).filter((e) => e.active !== false && (run.branchIds.length === 0 || (e.branchId && run.branchIds.includes(e.branchId))));
  // Previous run (for sharp-net-move anomalies).
  const prevRun = store.listPayrollRuns(tenantId)
    .filter((r) => r.period < run.period && r.status !== 'draft')
    .sort((a, b) => (a.period < b.period ? 1 : -1))[0];
  const prevNet = new Map<string, number>();
  if (prevRun) for (const p of store.listPayslips(tenantId, prevRun.id)) prevNet.set(p.employeeId, p.netPiasters);

  // Drop any payslips from an earlier calculation of this (still unlocked) run.
  store.payslips = store.payslips.filter((p) => p.runId !== run.id);
  const payslips: PayslipRecord[] = [];
  const anomalyInputs: Parameters<typeof detectPayrollAnomalies>[0] = [];
  for (const emp of employees) {
    const structure = store.structureFor(tenantId, emp.id);
    const basic = structure?.basicPiasters ?? emp.basicSalaryPiasters;
    const allowances: PayslipAllowance[] = structure?.allowances
      ?? (emp.allowancesPiasters ? [{ name: 'Fixed allowances', amountPiasters: emp.allowancesPiasters, taxable: true, insurable: true }] : []);
    const daysWorked = workedDaysInPeriod(start, end, emp.startDate ?? null, emp.endDate ?? null);
    const att = summariseAttendance(store, tenantId, emp.id, start, end);
    const unpaidDays = unpaidLeaveDays(store, tenantId, emp.id, start, end);
    const adjustment = store.pendingAdjustments(tenantId, emp.id, run.period)
      .reduce((s, a) => s + a.amountPiasters, 0);
    const result = calculatePayslip({
      basicPiasters: basic,
      allowances,
      overtime: att.overtime,
      unpaidLeaveDays: unpaidDays,
      advanceInstalmentPiasters: structure?.advanceInstalmentPiasters ?? 0,
      loanInstalmentPiasters: structure?.loanInstalmentPiasters ?? 0,
      adjustmentPiasters: adjustment,
      daysWorked,
      daysInMonthCount: days,
      contractType: (emp.contractType as 'full_time' | 'part_time') ?? 'full_time',
      nosiEmployeePct: Number(statutory.nosiEmployeePct ?? 11),
      nosiEmployerPct: (statutory.nosiEmployerPct as number | null) ?? null,
      nosiFloorEgp: Number(statutory.nosiFloorEgp ?? 2700),
      nosiCeilingEgp: Number(statutory.nosiCeilingEgp ?? 16700),
      minimumWageEgp: Number(statutory.minimumWageEgp ?? 7000),
      taxRules: TAX_RULES_2026,
      overtimeRules: OVERTIME_RULES_2026,
    });
    const slip: PayslipRecord = {
      id: newId('payslip'), tenantId, runId: run.id, employeeId: emp.id, period: run.period,
      lines: result.lines, grossPiasters: result.grossPiasters,
      employeeNosiPiasters: result.employeeNosiPiasters, incomeTaxPiasters: result.incomeTaxPiasters,
      martyrsLevyPiasters: result.martyrsLevyPiasters, totalDeductionsPiasters: result.totalDeductionsPiasters,
      netPiasters: result.netPiasters, employerNosiPiasters: result.employerNosiPiasters,
      totalEmployerCostPiasters: result.totalEmployerCostPiasters,
      insurableWagePiasters: result.insurableWagePiasters, workedDays: att.workedDays,
      regularHoursPiasters: att.regularMinutes, overtimeMinutes: att.overtime,
      belowMinimumWage: result.belowMinimumWage,
    };
    payslips.push(slip);
    anomalyInputs.push({
      employeeId: emp.id, netPiasters: result.netPiasters, grossPiasters: result.grossPiasters,
      overtimePayPiasters: result.overtimePayPiasters, basicPiasters: basic,
      workedDays: att.workedDays, missingClockOuts: att.missingClockOuts,
      previousNetPiasters: prevNet.get(emp.id) ?? null,
      hasApprovedLeave: store.listLeaveRequests(tenantId).some(
        (l) => l.employeeId === emp.id && l.status === 'approved' && l.startDate <= end && l.endDate >= start),
    });
  }
  store.payslips.push(...payslips);
  run.anomalies = detectPayrollAnomalies(anomalyInputs);
  run.totalGrossPiasters = payslips.reduce((s, p) => s + p.grossPiasters, 0);
  run.totalNetPiasters = payslips.reduce((s, p) => s + p.netPiasters, 0);
  run.totalEmployeeNosiPiasters = payslips.reduce((s, p) => s + p.employeeNosiPiasters, 0);
  run.totalTaxPiasters = payslips.reduce((s, p) => s + p.incomeTaxPiasters, 0);
  const employerTotal = payslips.reduce<number | null>((s, p) => (s === null || p.employerNosiPiasters === null ? null : s + p.employerNosiPiasters), 0);
  run.totalEmployerNosiPiasters = employerTotal;
  run.employerCostStatus = employerTotal === null ? 'pending' : 'ready';
  run.taxRuleVersion = TAX_RULES_2026.version;
  run.taxRuleStatus = TAX_RULES_2026.status;
  run.overtimeRuleVersion = OVERTIME_RULES_2026.version;
  run.status = 'calculated';
  // Mark pending adjustments for this period as applied by this run.
  for (const emp of employees) {
    for (const a of store.pendingAdjustments(tenantId, emp.id, run.period)) {
      a.status = 'applied'; a.appliedRunId = run.id;
    }
  }
  return payslips;
}

// --- Bank files (generated CSV layouts — NOT disbursement) ------------------
const BANK_COLUMNS: Record<PayrollBank, string[]> = {
  CIB: ['Account Number', 'Beneficiary Name', 'Amount (EGP)', 'Currency', 'Reference'],
  QNB: ['Beneficiary Account', 'Beneficiary Name', 'Amount', 'Value Date', 'Remarks'],
  NBE: ['Account No', 'Name', 'Amount EGP', 'Branch', 'Payment Reference'],
  'Banque Misr': ['Account', 'Customer Name', 'Amount', 'Currency', 'Reference'],
};

export function generateBankFile(
  bank: PayrollBank, run: PayrollRunRecord,
  rows: { employeeName: string; bankAccount: string | null; netPiasters: number; branchName: string }[],
): { filename: string; content: string; totalPiasters: number } {
  const cols = BANK_COLUMNS[bank];
  const lines = [
    `# ${bank} salary file — GENERATED FILE, not a disbursement. No money moved. Period ${run.period}.`,
    cols.join(','),
  ];
  let total = 0;
  for (const r of rows) {
    total += r.netPiasters;
    const amount = (r.netPiasters / 100).toFixed(2);
    const account = r.bankAccount ?? 'CASH';
    const name = `"${r.employeeName.replace(/"/g, '')}"`;
    if (bank === 'CIB') lines.push([account, name, amount, 'EGP', `SAL-${run.period}`].join(','));
    else if (bank === 'QNB') lines.push([account, name, amount, `${run.period}-28`, `Salary ${run.period}`].join(','));
    else if (bank === 'NBE') lines.push([account, name, amount, r.branchName, `SAL-${run.period}`].join(','));
    else lines.push([account, name, amount, 'EGP', `SAL-${run.period}`].join(','));
  }
  return { filename: `${bank.toLowerCase().replace(' ', '-')}-salary-${run.period}.csv`, content: lines.join('\n') + '\n', totalPiasters: total };
}

// --- Payslip printable HTML (Arabic-first, RTL) -----------------------------
export function payslipHtml(payslip: PayslipRecord, employeeName: string, tenantName: string, period: string): string {
  const egp = (p: number) => (p / 100).toFixed(2);
  const rows = payslip.lines.filter((l) => l.amountPiasters !== 0)
    .map((l) => `<tr><td>${l.labelAr} (${l.label})</td><td style="text-align:left">${egp(l.amountPiasters)}</td></tr>`).join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>كشف راتب ${period}</title></head><body style="font-family:system-ui;max-width:640px;margin:2rem auto">
<h1>كشف راتب — ${tenantName}</h1><p>الفترة: ${period} | الموظف: ${employeeName}</p>
<table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse"><tr><th>البند</th><th>المبلغ (جنيه)</th></tr>${rows}</table>
<p>إجمالي الأجر: ${egp(payslip.grossPiasters)} جنيه</p>
<h2>صافي الأجر: ${egp(payslip.netPiasters)} جنيه</h2>
<p>التأمينات — حصة صاحب العمل: ${payslip.employerNosiPiasters === null ? 'قيد الانتظار (معدل صاحب العمل غير مؤكد بعد)' : `${egp(payslip.employerNosiPiasters)} جنيه`} — هذه تكلفة على صاحب العمل وليست خصماً من الموظف.</p>
<p><small>قواعد الضريبة (قانون 7 لسنة 2024) والعمل الإضافي (قانون 14 لسنة 2025) — REVIEWER-UNCONFIRMED. أجر التأمين: ${egp(payslip.insurableWagePiasters)} جنيه.</small></p>
</body></html>`;
}

export function registerM3(app: FastifyInstance, store: MemoryStore, jwtSecret: string): void {
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
    if (!roles.includes(c.role)) { void reply.code(403).send({ error: `role ${c.role} cannot perform payroll action (needs ${roles.join(' or ')})` }); return false; }
    return true;
  };
  const audit = (tenantId: string, actorUserId: string | null, action: string, entity: string, detail: unknown) =>
    store.log({ tenantId, actorUserId, actorKind: 'tenant_user', action, entity, detail });
  const logExport = (tenantId: string, runId: string | null, kind: string, format: string, userId: string | null) => {
    store.exportLog.push({ id: newId('exp'), tenantId, runId, kind, format, generatedByUserId: userId, createdAt: new Date().toISOString() });
    audit(tenantId, userId, 'payroll.export', `export:${kind}`, { runId, kind, format });
  };

  // --- Salary structures (Area 6) -------------------------------------------
  app.post('/api/payroll/structures', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    const b = req.body as { employeeId?: string; basicPiasters?: number; allowances?: PayslipAllowance[]; templateName?: string; payPeriod?: string; payDay?: number; bankAccount?: string; walletNumber?: string; advanceTotalPiasters?: number; advanceInstalmentPiasters?: number; loanTotalPiasters?: number; loanInstalmentPiasters?: number; effectiveFrom?: string };
    if (!b?.employeeId || typeof b.basicPiasters !== 'number' || b.basicPiasters < 0) return reply.code(400).send({ error: 'employeeId and basicPiasters (>= 0) are required' });
    try { store.getEmployee(t, b.employeeId); } catch { return reply.code(404).send({ error: 'employee not found' }); }
    const prev = store.structureFor(t, b.employeeId);
    const rec = {
      id: newId('struct'), tenantId: t, employeeId: b.employeeId, templateName: b.templateName ?? null,
      basicPiasters: b.basicPiasters, allowances: b.allowances ?? [],
      payPeriod: b.payPeriod ?? 'monthly', payDay: b.payDay ?? 28,
      bankAccount: b.bankAccount ?? null, walletNumber: b.walletNumber ?? null,
      advanceTotalPiasters: b.advanceTotalPiasters ?? 0, advanceInstalmentPiasters: b.advanceInstalmentPiasters ?? 0,
      loanTotalPiasters: b.loanTotalPiasters ?? 0, loanInstalmentPiasters: b.loanInstalmentPiasters ?? 0,
      effectiveFrom: b.effectiveFrom ?? new Date().toISOString().slice(0, 10), version: (prev?.version ?? 0) + 1,
    };
    store.salaryStructures.push(rec);
    audit(t, c.sub, 'payroll.structure.upsert', 'salary_structure', { employeeId: b.employeeId, version: rec.version });
    return reply.code(201).send({ structure: rec });
  });
  app.get('/api/payroll/structures', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const employeeId = (req.query as { employeeId?: string }).employeeId;
    return { structures: employeeId ? store.listSalaryStructures(t).filter((s) => s.employeeId === employeeId) : store.listSalaryStructures(t) };
  });

  // --- Step 1: Prepare --------------------------------------------------------
  app.post('/api/payroll/runs', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    const b = req.body as { period?: string; branchIds?: string[]; acceptWarnings?: string[] };
    if (!b?.period || !/^\d{4}-\d{2}$/.test(b.period)) return reply.code(400).send({ error: 'period YYYY-MM is required' });
    if (store.listPayrollRuns(t).some((r) => r.period === b.period)) return reply.code(409).send({ error: `a payroll run already exists for ${b.period}` });
    const { start, end } = periodBounds(b.period);
    const branchIds = b.branchIds ?? store.listBranches(t).map((x) => x.id);
    const openExceptions = store.listExceptions(t, 'open').filter((e) => e.createdAt.slice(0, 10) >= start && e.createdAt.slice(0, 10) <= end);
    const accepted = new Set(b.acceptWarnings ?? []);
    const unresolved = openExceptions.filter((e) => !accepted.has(e.id));
    const employees = store.listEmployees(t).filter((e) => branchIds.includes(e.branchId ?? ''));
    const missingStructures = employees.filter((e) => !store.structureFor(t, e.id) && !e.basicSalaryPiasters).map((e) => e.id);
    const run: PayrollRunRecord = {
      id: newId('run'), tenantId: t, period: b.period, branchIds, status: 'prepared',
      warningsAccepted: [...accepted], anomalies: [],
      totalGrossPiasters: 0, totalNetPiasters: 0, totalEmployeeNosiPiasters: 0, totalTaxPiasters: 0,
      totalEmployerNosiPiasters: null, employerCostStatus: 'pending',
      taxRuleVersion: TAX_RULES_2026.version, taxRuleStatus: TAX_RULES_2026.status,
      overtimeRuleVersion: OVERTIME_RULES_2026.version,
      createdByUserId: c.sub, approvedByUserId: null, approvedAt: null, lockedAt: null, paidAt: null,
      createdAt: new Date().toISOString(),
    };
    store.payrollRuns.push(run);
    audit(t, c.sub, 'payroll.run.prepare', 'payroll_run', { runId: run.id, period: b.period, openExceptions: openExceptions.length, unresolved: unresolved.length, acceptedWarnings: accepted.size, missingStructures });
    return reply.code(201).send({
      run,
      warnings: {
        unresolvedExceptions: unresolved.map((e) => ({ id: e.id, kind: e.kind, employeeId: e.employeeId, reason: e.reason })),
        missingStructures,
        note: 'Unresolved exceptions block calculation until accepted by the owner (recorded here) or resolved in the exception queue.',
      },
    });
  });
  app.get('/api/payroll/runs', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { runs: store.listPayrollRuns(t) };
  });
  app.get('/api/payroll/runs/:id', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    try { return { run: store.getPayrollRun(t, (req.params as { id: string }).id) }; }
    catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
  });

  // --- Step 2: Review anomalies ----------------------------------------------
  app.post('/api/payroll/runs/:id/review', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    let run: PayrollRunRecord;
    try { run = store.getPayrollRun(t, (req.params as { id: string }).id); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
    if (run.status === 'calculated' || run.status === 'locked' || run.status === 'paid' || run.status === 'approved') {
      return { runId: run.id, period: run.period, anomalies: run.anomalies, note: 'anomalies from the calculated run' };
    }
    // Not yet calculated: run the anomaly check on attendance alone.
    const { start, end } = periodBounds(run.period);
    const inputs = store.listEmployees(t).filter((e) => run.branchIds.includes(e.branchId ?? '')).map((e) => {
      const att = summariseAttendance(store, t, e.id, start, end);
      return { employeeId: e.id, netPiasters: 0, grossPiasters: 0, overtimePayPiasters: 0, basicPiasters: e.basicSalaryPiasters, workedDays: att.workedDays, missingClockOuts: att.missingClockOuts, previousNetPiasters: null, hasApprovedLeave: false };
    });
    return { runId: run.id, period: run.period, anomalies: detectPayrollAnomalies(inputs), note: 'pre-calculation anomaly preview (no pay figures yet)' };
  });

  // --- Step 3: Calculate -------------------------------------------------------
  app.post('/api/payroll/runs/:id/calculate', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    let run: PayrollRunRecord;
    try { run = store.getPayrollRun(t, (req.params as { id: string }).id); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
    if (run.status === 'locked' || run.status === 'paid' || run.status === 'approved') {
      return reply.code(409).send({ error: 'locked run is immutable — corrections only as next-run adjustments' });
    }
    const { start, end } = periodBounds(run.period);
    const accepted = new Set(run.warningsAccepted);
    const unresolved = store.listExceptions(t, 'open').filter((e) => e.createdAt.slice(0, 10) >= start && e.createdAt.slice(0, 10) <= end && !accepted.has(e.id));
    if (unresolved.length > 0) {
      return reply.code(409).send({ error: 'unresolved exceptions block calculation', unresolvedExceptions: unresolved.map((e) => ({ id: e.id, kind: e.kind, employeeId: e.employeeId, reason: e.reason })), hint: 'resolve them in the exception queue, or accept them explicitly when preparing the run' });
    }
    try {
      const payslips = calculateRun(store, t, run);
      // Reconciliation: sum of payslips = run total (checked here, always true by construction — and re-checked on export).
      const sumNet = payslips.reduce((s, p) => s + p.netPiasters, 0);
      const sumGross = payslips.reduce((s, p) => s + p.grossPiasters, 0);
      if (sumNet !== run.totalNetPiasters || sumGross !== run.totalGrossPiasters) {
        return reply.code(500).send({ error: 'reconciliation failed: payslip sums do not match run totals' });
      }
      audit(t, c.sub, 'payroll.run.calculate', 'payroll_run', { runId: run.id, period: run.period, payslips: payslips.length, totalGrossPiasters: run.totalGrossPiasters, totalNetPiasters: run.totalNetPiasters, employerCostStatus: run.employerCostStatus });
      return { run, payslips, reconciled: true, employerCostStatus: run.employerCostStatus };
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  // --- Step 4: Approve (owner one-tap + second confirmation; locks the run) --
  app.post('/api/payroll/runs/:id/approve', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner'])) return;
    let run: PayrollRunRecord;
    try { run = store.getPayrollRun(t, (req.params as { id: string }).id); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
    if (run.status !== 'calculated') return reply.code(409).send({ error: `run must be calculated before approval (current status: ${run.status})` });
    const b = req.body as { confirmTotalCost?: boolean };
    const totalCost = run.employerCostStatus === 'ready' && run.totalEmployerNosiPiasters !== null
      ? run.totalGrossPiasters + run.totalEmployerNosiPiasters : null;
    if (run.employerCostStatus === 'pending' || run.totalEmployerNosiPiasters === null) {
      // BLOCKED — the M0 guardrail. Employee payslips stay valid; only
      // finalisation is refused until a reviewer sets the employer rate
      // through the guarded versioned Settings change (statutory_rates).
      audit(t, c.sub, 'payroll.run.approve_blocked', 'payroll_run', { runId: run.id, period: run.period, reason: 'NOSI employer rate UNRESOLVED' });
      return reply.code(409).send({
        error: 'BLOCKED: NOSI employer rate is UNRESOLVED — the run cannot be finalised until a payroll reviewer sets the employer rate through Settings (statutory_rates: owner/accountant, effective date, reason, impact preview, audit log). Employee payslip lines are already calculated and correct; employer cost is PENDING.',
        code: 'EMPLOYER_NOSI_RATE_UNRESOLVED',
        employerCostStatus: 'pending',
        totalGrossPiasters: run.totalGrossPiasters,
        totalNetPiasters: run.totalNetPiasters,
        totalEmployerCostPiasters: null,
      });
    }
    if (b?.confirmTotalCost !== true) {
      return reply.code(400).send({
        error: 'second confirmation required: confirmTotalCost must be true',
        confirmation: {
          period: run.period, totalGrossPiasters: run.totalGrossPiasters,
          totalNetPiasters: run.totalNetPiasters,
          totalEmployerNosiPiasters: run.totalEmployerNosiPiasters,
          totalEmployerCostPiasters: totalCost,
          payslipCount: store.listPayslips(t, run.id).length,
          note: 'Approving LOCKS the run. Corrections after this point go only to a later run as adjustments.',
        },
      });
    }
    run.status = 'locked';
    run.approvedByUserId = c.sub;
    run.approvedAt = new Date().toISOString();
    run.lockedAt = run.approvedAt;
    audit(t, c.sub, 'payroll.run.approve', 'payroll_run', { runId: run.id, period: run.period, totalGrossPiasters: run.totalGrossPiasters, totalNetPiasters: run.totalNetPiasters, totalEmployerCostPiasters: totalCost });
    return { run, totalEmployerCostPiasters: totalCost, locked: true };
  });

  // --- Step 5: Pay / distribute ----------------------------------------------
  app.post('/api/payroll/runs/:id/bank-file', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    let run: PayrollRunRecord;
    try { run = store.getPayrollRun(t, (req.params as { id: string }).id); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
    if (run.status !== 'locked' && run.status !== 'paid') return reply.code(409).send({ error: `bank file requires a locked (approved) run (current status: ${run.status})` });
    const b = req.body as { bank?: string };
    if (!b?.bank || !(PAYROLL_BANKS as readonly string[]).includes(b.bank)) return reply.code(400).send({ error: `bank must be one of ${PAYROLL_BANKS.join(', ')}` });
    const payslips = store.listPayslips(t, run.id);
    const rows = payslips.map((p) => {
      const emp = store.employees.find((e) => e.id === p.employeeId);
      const struct = store.structureFor(t, p.employeeId);
      const branch = emp?.branchId ? store.branches.find((x) => x.id === emp.branchId) : undefined;
      return { employeeName: emp?.fullNameAr ?? p.employeeId, bankAccount: struct?.bankAccount ?? emp?.bankAccount ?? null, netPiasters: p.netPiasters, branchName: branch?.nameEn ?? '' };
    });
    const file = generateBankFile(b.bank as PayrollBank, run, rows);
    if (file.totalPiasters !== run.totalNetPiasters) {
      return reply.code(500).send({ error: 'reconciliation failed: bank file total does not equal run net total' });
    }
    const rec = { id: newId('bankfile'), tenantId: t, runId: run.id, bank: b.bank, filename: file.filename, content: file.content, totalPiasters: file.totalPiasters, recordCount: rows.length, note: 'GENERATED FILE — not a disbursement. No money moved.', generatedByUserId: c.sub, createdAt: new Date().toISOString() };
    store.bankFiles.push(rec);
    logExport(t, run.id, 'bank_file', 'csv', c.sub);
    return reply.code(201).send({ bankFile: rec, reconciled: true });
  });

  app.post('/api/payroll/runs/:id/pay', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    let run: PayrollRunRecord;
    try { run = store.getPayrollRun(t, (req.params as { id: string }).id); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
    if (run.status !== 'locked') return reply.code(409).send({ error: `only a locked run can be paid/distributed (current status: ${run.status})` });
    const b = req.body as { bank?: string };
    const bank = (b?.bank ?? 'CIB') as PayrollBank;
    if (!(PAYROLL_BANKS as readonly string[]).includes(bank)) return reply.code(400).send({ error: `bank must be one of ${PAYROLL_BANKS.join(', ')}` });
    const payslips = store.listPayslips(t, run.id);
    const rows = payslips.map((p) => {
      const emp = store.employees.find((e) => e.id === p.employeeId);
      const struct = store.structureFor(t, p.employeeId);
      const branch = emp?.branchId ? store.branches.find((x) => x.id === emp.branchId) : undefined;
      return { employeeName: emp?.fullNameAr ?? p.employeeId, bankAccount: struct?.bankAccount ?? emp?.bankAccount ?? null, netPiasters: p.netPiasters, branchName: branch?.nameEn ?? '' };
    });
    const file = generateBankFile(bank, run, rows);
    const rec = { id: newId('bankfile'), tenantId: t, runId: run.id, bank, filename: file.filename, content: file.content, totalPiasters: file.totalPiasters, recordCount: rows.length, note: 'GENERATED FILE — not a disbursement. No money moved.', generatedByUserId: c.sub, createdAt: new Date().toISOString() };
    store.bankFiles.push(rec);
    // Payslips to employees: STUBBED WhatsApp + in-app (outbox only).
    let queued = 0;
    for (const p of payslips) {
      const emp = store.employees.find((e) => e.id === p.employeeId);
      if (!emp) continue;
      await notifyEmployee(store, t, emp, 'payslip_sent',
        `كشف راتب ${run.period}: صافي الأجر ${(p.netPiasters / 100).toFixed(2)} جنيه. / Payslip ${run.period}: net pay EGP ${(p.netPiasters / 100).toFixed(2)}. (STUBBED — queued only, not sent)`);
      queued++;
    }
    run.status = 'paid';
    run.paidAt = new Date().toISOString();
    logExport(t, run.id, 'bank_file', 'csv', c.sub);
    audit(t, c.sub, 'payroll.run.pay', 'payroll_run', { runId: run.id, period: run.period, bank, bankFileId: rec.id, payslipsQueuedStubbed: queued, note: 'bank file generated, not disbursed; payslips queued via stubbed WhatsApp' });
    return { run, bankFile: rec, payslipsQueuedStubbed: queued, note: 'Bank file generated (not a disbursement). Payslips queued via STUBBED WhatsApp — nothing was actually sent.' };
  });

  // --- Payslips ----------------------------------------------------------------
  app.get('/api/payroll/runs/:id/payslips', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    try { store.getPayrollRun(t, (req.params as { id: string }).id); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
    return { payslips: store.listPayslips(t, (req.params as { id: string }).id) };
  });
  app.get('/api/payroll/payslips/:id', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role === 'employee') return reply.code(403).send({ error: 'employee self-service payslip view needs a linked employee account (M4/V1) — managers and accountants only in M3' });
    try { return { payslip: store.getPayslip(t, (req.params as { id: string }).id) }; }
    catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
  });
  app.get('/api/payroll/payslips/:id/html', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    try {
      const p = store.getPayslip(t, (req.params as { id: string }).id);
      const emp = store.employees.find((e) => e.id === p.employeeId);
      const tenantRec = store.getTenant(t);
      logExport(t, p.runId, 'payslip', 'html', c.sub);
      void reply.header('content-type', 'text/html; charset=utf-8');
      return reply.send(payslipHtml(p, emp?.fullNameAr ?? p.employeeId, tenantRec?.nameAr ?? '', p.period));
    } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
  });

  // --- Adjustments (next-run corrections to locked runs) -----------------------
  app.post('/api/payroll/adjustments', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    const b = req.body as { employeeId?: string; sourceRunId?: string; targetPeriod?: string; amountPiasters?: number; reason?: string };
    if (!b?.employeeId || typeof b.amountPiasters !== 'number' || b.amountPiasters === 0 || !b.targetPeriod || !b.reason) {
      return reply.code(400).send({ error: 'employeeId, targetPeriod, amountPiasters (non-zero, signed) and reason are required' });
    }
    try { store.getEmployee(t, b.employeeId); } catch { return reply.code(404).send({ error: 'employee not found' }); }
    if (b.sourceRunId) {
      const src = store.payrollRuns.find((r) => r.id === b.sourceRunId);
      if (!src) return reply.code(404).send({ error: 'source run not found' });
      if (src.tenantId !== t) return reply.code(403).send({ error: 'cross-tenant access denied' });
    }
    const rec = { id: newId('adj'), tenantId: t, employeeId: b.employeeId, sourceRunId: b.sourceRunId ?? null, targetPeriod: b.targetPeriod, amountPiasters: b.amountPiasters, reason: b.reason, status: 'pending' as const, createdByUserId: c.sub, appliedRunId: null };
    store.payrollAdjustments.push(rec);
    audit(t, c.sub, 'payroll.adjustment.create', 'payroll_adjustment', { adjustmentId: rec.id, employeeId: b.employeeId, sourceRunId: b.sourceRunId ?? null, targetPeriod: b.targetPeriod, amountPiasters: b.amountPiasters, reason: b.reason });
    return reply.code(201).send({ adjustment: rec, note: 'Applied automatically when the target period is calculated; the locked source run is never rewritten.' });
  });
  app.get('/api/payroll/adjustments', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const period = (req.query as { period?: string }).period;
    return { adjustments: store.payrollAdjustments.filter((a) => a.tenantId === t && (!period || a.targetPeriod === period)) };
  });

  // --- Reports ------------------------------------------------------------------
  app.get('/api/payroll/reports/summary', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const period = (req.query as { period?: string }).period;
    const runs = store.listPayrollRuns(t).filter((r) => !period || r.period === period);
    const payslips = runs.flatMap((r) => store.listPayslips(t, r.id));
    const byBranch: Record<string, { grossPiasters: number; netPiasters: number; employees: number }> = {};
    for (const p of payslips) {
      const emp = store.employees.find((e) => e.id === p.employeeId);
      const key = emp?.branchId ?? 'unassigned';
      byBranch[key] = byBranch[key] ?? { grossPiasters: 0, netPiasters: 0, employees: 0 };
      byBranch[key].grossPiasters += p.grossPiasters;
      byBranch[key].netPiasters += p.netPiasters;
      byBranch[key].employees++;
    }
    return {
      period: period ?? null, runs: runs.length, payslips: payslips.length,
      totalGrossPiasters: payslips.reduce((s, p) => s + p.grossPiasters, 0),
      totalNetPiasters: payslips.reduce((s, p) => s + p.netPiasters, 0),
      totalEmployeeNosiPiasters: payslips.reduce((s, p) => s + p.employeeNosiPiasters, 0),
      totalTaxPiasters: payslips.reduce((s, p) => s + p.incomeTaxPiasters, 0),
      totalEmployerNosiPiasters: payslips.some((p) => p.employerNosiPiasters === null) ? null : payslips.reduce((s, p) => s + (p.employerNosiPiasters ?? 0), 0),
      employerCostStatus: payslips.some((p) => p.employerNosiPiasters === null) ? 'pending' : 'ready',
      byBranch,
    };
  });
  app.get('/api/payroll/reports/employer-cost', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const period = (req.query as { period?: string }).period;
    const runs = store.listPayrollRuns(t).filter((r) => !period || r.period === period);
    const payslips = runs.flatMap((r) => store.listPayslips(t, r.id));
    return {
      period: period ?? null,
      grossPiasters: payslips.reduce((s, p) => s + p.grossPiasters, 0),
      employerNosiPiasters: payslips.some((p) => p.employerNosiPiasters === null) ? null : payslips.reduce((s, p) => s + (p.employerNosiPiasters ?? 0), 0),
      totalEmployerCostPiasters: payslips.some((p) => p.totalEmployerCostPiasters === null) ? null : payslips.reduce((s, p) => s + (p.totalEmployerCostPiasters ?? 0), 0),
      employerCostStatus: payslips.some((p) => p.employerNosiPiasters === null) ? 'pending' : 'ready',
      note: 'Employer social insurance is a cost to the employer, never a deduction from the employee.',
    };
  });
  app.get('/api/payroll/reports/tax-nosi', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const period = (req.query as { period?: string }).period;
    const runs = store.listPayrollRuns(t).filter((r) => !period || r.period === period);
    const payslips = runs.flatMap((r) => store.listPayslips(t, r.id));
    return {
      period: period ?? null,
      employeeNosiPiasters: payslips.reduce((s, p) => s + p.employeeNosiPiasters, 0),
      incomeTaxPiasters: payslips.reduce((s, p) => s + p.incomeTaxPiasters, 0),
      martyrsLevyPiasters: payslips.reduce((s, p) => s + p.martyrsLevyPiasters, 0),
      insurableWagePiasters: payslips.reduce((s, p) => s + p.insurableWagePiasters, 0),
      taxRuleVersion: TAX_RULES_2026.version, taxRuleStatus: TAX_RULES_2026.status,
    };
  });
  app.get('/api/payroll/reports/attendance', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const period = (req.query as { period?: string }).period ?? new Date().toISOString().slice(0, 7);
    const { start, end } = periodBounds(period);
    const rows = store.listEmployees(t).map((e) => {
      const att = summariseAttendance(store, t, e.id, start, end);
      return { employeeId: e.id, fullNameAr: e.fullNameAr, workedDays: att.workedDays, regularMinutes: att.regularMinutes, overtimeMinutes: att.overtime, missingClockOuts: att.missingClockOuts, lateCount: att.lateCount };
    });
    return { period, rows };
  });
  app.get('/api/payroll/reports/labour-cost', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const period = (req.query as { period?: string }).period;
    const runs = store.listPayrollRuns(t).filter((r) => !period || r.period === period);
    const perBranchPerDay: Record<string, number> = {};
    for (const r of runs) {
      const { start, end } = periodBounds(r.period);
      for (const p of store.listPayslips(t, r.id)) {
        const emp = store.employees.find((e) => e.id === p.employeeId);
        const branch = emp?.branchId ?? 'unassigned';
        const att = summariseAttendance(store, t, p.employeeId, start, end);
        const daily = att.workedDays > 0 ? Math.round(p.grossPiasters / att.workedDays) : 0;
        for (const d of att.workedDates) {
          const key = `${branch}|${d}`;
          perBranchPerDay[key] = (perBranchPerDay[key] ?? 0) + daily;
        }
      }
    }
    return { period: period ?? null, perBranchPerDay, note: 'Daily labour cost apportions each payslip gross evenly over the days the employee worked (estimate from verified attendance).' };
  });

  // --- Exports (CSV + printable; every export logged) ----------------------------
  app.get('/api/payroll/runs/:id/export', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    let run: PayrollRunRecord;
    try { run = store.getPayrollRun(t, (req.params as { id: string }).id); } catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
    const kind = (req.query as { kind?: string }).kind ?? 'register';
    if (!['register', 'summary'].includes(kind)) return reply.code(400).send({ error: 'kind must be register or summary' });
    const payslips = store.listPayslips(t, run.id);
    let csv: string;
    if (kind === 'register') {
      const lines = ['Employee,Branch,Gross (EGP),Employee NOSI (EGP),Income Tax (EGP),Martyrs Levy (EGP),Total Deductions (EGP),Net (EGP),Employer NOSI (EGP),Below Minimum Wage'];
      for (const p of payslips) {
        const emp = store.employees.find((e) => e.id === p.employeeId);
        const branch = emp?.branchId ? store.branches.find((x) => x.id === emp.branchId)?.nameEn ?? '' : '';
        lines.push([`"${emp?.fullNameAr ?? p.employeeId}"`, branch, (p.grossPiasters / 100).toFixed(2), (p.employeeNosiPiasters / 100).toFixed(2), (p.incomeTaxPiasters / 100).toFixed(2), (p.martyrsLevyPiasters / 100).toFixed(2), (p.totalDeductionsPiasters / 100).toFixed(2), (p.netPiasters / 100).toFixed(2), p.employerNosiPiasters === null ? 'PENDING' : (p.employerNosiPiasters / 100).toFixed(2), p.belowMinimumWage ? 'YES' : 'no'].join(','));
      }
      lines.push(`TOTAL,,${(run.totalGrossPiasters / 100).toFixed(2)},${(run.totalEmployeeNosiPiasters / 100).toFixed(2)},${(run.totalTaxPiasters / 100).toFixed(2)},,,${(run.totalNetPiasters / 100).toFixed(2)},${run.totalEmployerNosiPiasters === null ? 'PENDING' : (run.totalEmployerNosiPiasters / 100).toFixed(2)},`);
      csv = lines.join('\n') + '\n';
    } else {
      csv = `Payroll summary,${run.period}\nStatus,${run.status}\nPayslips,${payslips.length}\nTotal gross (EGP),${(run.totalGrossPiasters / 100).toFixed(2)}\nTotal net (EGP),${(run.totalNetPiasters / 100).toFixed(2)}\nTotal employee NOSI (EGP),${(run.totalEmployeeNosiPiasters / 100).toFixed(2)}\nTotal income tax (EGP),${(run.totalTaxPiasters / 100).toFixed(2)}\nTotal employer NOSI (EGP),${run.totalEmployerNosiPiasters === null ? 'PENDING' : (run.totalEmployerNosiPiasters / 100).toFixed(2)}\nEmployer cost status,${run.employerCostStatus}\nTax rule, Law 7/2024 v${run.taxRuleVersion} (${run.taxRuleStatus})\n`;
    }
    logExport(t, run.id, kind, 'csv', c.sub);
    void reply.header('content-type', 'text/csv; charset=utf-8');
    void reply.header('content-disposition', `attachment; filename="payroll-${kind}-${run.period}.csv"`);
    return reply.send(csv);
  });
  app.get('/api/payroll/exports', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { exports: store.exportLog.filter((e) => e.tenantId === t) };
  });
  app.get('/api/payroll/bank-files', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const runId = (req.query as { runId?: string }).runId;
    return { bankFiles: store.bankFiles.filter((b) => b.tenantId === t && (!runId || b.runId === runId)) };
  });
}
