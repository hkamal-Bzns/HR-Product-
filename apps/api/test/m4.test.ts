// M4 AI agents v1 + pilot hardening tests (Brief §8, §15 M4).
// Briefing numbers are checked against the underlying store data exactly;
// drafts never publish themselves; Q&A never sees another employee's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, store } from '../src/server.js';
import { seed } from '../src/seed.js';
import { signSession } from '../src/auth.js';
import { signOfflineRecord } from '../src/agentCore.js';

const SECRET = 'test-secret-only';
let app: ReturnType<typeof buildServer>;
const owner = () => signSession({ sub: 'user-owner', tenantId: 'tenant-demo-cafe', role: 'owner' }, SECRET);
const acct = () => signSession({ sub: 'user-acct', tenantId: 'tenant-demo-cafe', role: 'accountant' }, SECRET);
const mgr = () => signSession({ sub: 'user-mgr', tenantId: 'tenant-demo-cafe', role: 'branch_manager' }, SECRET);
const emp1 = () => signSession({ sub: 'user-emp1', tenantId: 'tenant-demo-cafe', role: 'employee' }, SECRET);
const unlinkedEmp = () => signSession({ sub: 'user-emp', tenantId: 'tenant-demo-cafe', role: 'employee' }, SECRET);
const sa = () => signSession({ sub: 'sa1', tenantId: null, role: 'superadmin', mfaVerified: true }, SECRET);
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const j = async (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: H(token), payload: payload as never });
  let body: Record<string, any> = {};
  try { body = r.json() as Record<string, any>; } catch { body = {}; }
  return { status: r.statusCode, body, text: r.body };
};

let demoRunId = '';
let seededDraftId = '';

test.before(async () => {
  await seed();
  app = buildServer({ jwtSecret: SECRET, breakGlassEnabled: false });
  await app.ready();
  demoRunId = store.payrollRuns.find((r) => r.period === '2026-11')!.id;
});
test.after(async () => { await app.close(); });

test('M4 seed: demo agent runs exist — briefing, draft, anomaly check, Q&A', async () => {
  assert.equal(store.agentRuns.filter((r) => r.agentId === 'briefing').length, 1);
  assert.equal(store.agentRuns.filter((r) => r.agentId === 'schedule').length, 1);
  assert.equal(store.agentRuns.filter((r) => r.agentId === 'anomaly').length, 1);
  assert.equal(store.agentRuns.filter((r) => r.agentId === 'qa').length, 3);
  assert.ok(store.agentRuns.every((r) => r.provider === 'stub'));
  assert.ok(store.agentRuns.every((r) => r.inputHash.length === 64));
  // Seeded briefing facts match the underlying 2026-11-10 data exactly.
  const latest = await j('GET', '/api/agents/briefing/latest', owner());
  assert.equal(latest.status, 200);
  const facts = latest.body.briefing.facts;
  assert.equal(facts.presentCount, 4); // emp-7, emp-8, emp-9, emp-4 clocked in
  assert.equal(facts.lateCount, 1); // emp-8, 25 min late
  assert.equal(facts.absentCount, 6); // rostered Tue 2026-11-10, never clocked in
  assert.equal(facts.missingClockOutCount, 2); // emp-9, emp-4
  assert.equal(facts.openExceptionsCount, 4);
  assert.equal(facts.labourCostToDatePiasters, 50000); // emp-7 + emp-8 × EGP 250/day
  assert.equal(facts.labourCostSamePointLastMonthPiasters, null); // no October data
  assert.match(latest.body.briefing.textAr, /500\.00 جنيه/);
  assert.match(latest.body.briefing.textAr, /لا توجد سجلات حضور من الشهر الماضي/);
  // Seeded schedule draft: Zamalek week 2026-11-16, draft only, never published.
  const drafts = await j('GET', '/api/agents/schedule/drafts', owner());
  assert.equal(drafts.body.drafts.length, 1);
  const draft = drafts.body.drafts[0];
  seededDraftId = draft.id;
  assert.equal(draft.weekStart, '2026-11-16');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.suggestions.length, 25); // 5 Zamalek staff × 5 days
  assert.ok(draft.suggestions.every((s: { reasonAr: string }) => s.reasonAr.length > 0));
  assert.ok(draft.suggestions.some((s: { violations: unknown[] }) => s.violations.length > 0)); // Evening → Morning rest violations
  assert.equal(store.rosters.filter((r) => r.weekStart === '2026-11-16' && r.branchId === 'branch-zamalek').length, 0);
  // Seeded anomaly check on the Nov run: missing clock-outs priced as full days.
  const runs = await j('GET', '/api/agents/runs?agentId=anomaly', owner());
  const anomalies = runs.body.runs[0].output.anomalies as { kind: string; amountPiasters?: number; employeeId: string }[];
  assert.ok(anomalies.some((a) => a.kind === 'missing_clock_out'));
  assert.ok(anomalies.some((a) => a.kind === 'zero_attendance_full_pay'));
  const mco = anomalies.find((a) => a.kind === 'missing_clock_out' && a.employeeId === 'emp-demo-9');
  assert.equal(mco?.amountPiasters, 25000); // EGP 7500 / 30 days × 1 missing day
});

test('M4 Agent 1: briefing run via API matches the store data exactly, WhatsApp stubbed', async () => {
  const { status, body } = await j('POST', '/api/agents/briefing/run', owner(), { date: '2026-11-11' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.provider, 'stub');
  // Recompute the facts from the store and compare exactly.
  const yRecords = store.listAttendance('tenant-demo-cafe').filter((a) => a.clockInAt?.slice(0, 10) === '2026-11-10');
  assert.equal(body.briefing.facts.presentCount, new Set(yRecords.map((a) => a.employeeId)).size);
  assert.equal(body.briefing.facts.missingClockOutCount, yRecords.filter((a) => !a.clockOutAt).length);
  assert.match(body.briefing.textAr, /سارة علي/); // the late employee is named
  // Wednesday 2026-11-11: the Zamalek Split shift has only 1 of 2 Waiters, so
  // the top action is covering it (uncovered shift outranks missing clock-out).
  assert.match(body.briefing.topActionAr, /غطِّ وردية منقسم/);
  // 7 uncovered (role, shift) pairs: every shift group is short of either its
  // Barista or its 2 Waiters under the configured coverage minimums.
  assert.equal(body.briefing.facts.uncoveredShiftCount, 7);
  assert.equal(body.run.costPiasters, 25); // STUBBED estimate
  const outbox = await j('GET', '/api/outbox', owner());
  const msg = outbox.body.messages.find((m: { template: string }) => m.template === 'daily_briefing');
  assert.ok(msg);
  assert.equal(msg.status, 'queued_stubbed');
  // Branch manager may run it too; accountant may not run agents' briefing.
  assert.equal((await j('POST', '/api/agents/briefing/run', mgr(), { date: '2026-11-11' })).status, 200);
  assert.equal((await j('POST', '/api/agents/briefing/run', acct(), { date: '2026-11-11' })).status, 403);
});

test('M4 Agent 2: draft never publishes itself; review then publish is human-driven', async () => {
  const created = await j('POST', '/api/agents/schedule/draft', owner(), { branchId: 'branch-maadi', weekStart: '2026-11-23' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.draft.status, 'draft');
  assert.equal(created.body.draft.suggestions.length, 25);
  assert.match(created.body.note, /DRAFT ONLY/);
  // No roster was created by the agent.
  assert.equal(store.rosters.filter((r) => r.weekStart === '2026-11-23').length, 0);
  // Publish before review is refused.
  const early = await j('POST', `/api/agents/schedule/drafts/${created.body.draft.id}/publish`, owner(), {});
  assert.equal(early.status, 409);
  assert.match(early.body.error, /reviewed first/);
  // Manager reviews: accept all, edit one to the Split template.
  const decisions = created.body.draft.suggestions.map((s: { id: string }, i: number) =>
    (i === 0 ? { suggestionId: s.id, decision: 'edited', editedShiftTemplateId: 'tpl-split' } : { suggestionId: s.id, decision: 'accepted' }));
  const reviewed = await j('POST', `/api/agents/schedule/drafts/${created.body.draft.id}/review`, mgr(), { decisions });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.draft.status, 'reviewed');
  assert.equal(reviewed.body.draft.suggestions[0].editedShiftTemplateId, 'tpl-split');
  // Now the human publishes: a real roster appears, published, with the edit applied.
  const pub = await j('POST', `/api/agents/schedule/drafts/${created.body.draft.id}/publish`, owner(), {});
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal(pub.body.roster.status, 'published');
  assert.equal(pub.body.draft.status, 'published');
  const roster = store.rosters.find((r) => r.id === pub.body.roster.id)!;
  const asgs = store.rosterAssignments.filter((a) => a.rosterId === roster.id);
  assert.equal(asgs.length, 25);
  assert.equal(asgs[0].shiftTemplateId, 'tpl-split');
  assert.equal(pub.body.notified, 5);
  assert.equal(pub.body.stubbed, true);
});

test('M4 Agent 3: ranked anomalies with EGP amounts; decisions audit-logged; wired into run review', async () => {
  const { status, body } = await j('POST', '/api/agents/anomaly/run', owner(), { runId: demoRunId });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.provider, 'stub');
  assert.equal(body.preview, false);
  const kinds = body.anomalies.map((a: { kind: string }) => a.kind);
  assert.ok(kinds.includes('missing_clock_out'));
  assert.ok(kinds.includes('zero_attendance_full_pay'));
  const mco = body.anomalies.find((a: { kind: string; employeeId: string }) => a.kind === 'missing_clock_out' && a.employeeId === 'emp-demo-4');
  assert.equal(mco.amountPiasters, 25000);
  assert.match(mco.message, /full day/);
  // Decisions are recorded on the agent run and in the audit log.
  const dec = await j('POST', '/api/agents/anomaly/decisions', acct(), {
    runId: demoRunId,
    decisions: [{ key: 'emp-demo-9:missing_clock_out', decision: 'accepted', note: 'confirmed with employee, will clock out correctly' }],
  });
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
  assert.ok(store.audit.some((a) => a.action === 'agent.anomaly.decision'));
  // Wired into the M3 review step (step 2): same extended check, agent run recorded.
  const review = await j('POST', `/api/payroll/runs/${demoRunId}/review`, owner(), {});
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.ok(review.body.agent3.agentRunId);
  assert.equal(review.body.agent3.provider, 'stub');
  assert.ok((review.body.anomalies as { kind: string }[]).some((a) => a.kind === 'missing_clock_out'));
  assert.ok((review.body.anomalies as { amountPiasters?: number }[]).some((a) => typeof a.amountPiasters === 'number' && a.amountPiasters > 0));
});

test('M4 Agent 4 + linking: employee sees ONLY their own data; unanswered routes to manager', async () => {
  // Login as the linked employee user.
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { tenantSlug: 'demo-cafe', email: 'employee@demo-cafe.eg', password: 'DemoEmp123!' } });
  assert.equal(login.statusCode, 200);
  const empToken = login.json().token as string;
  const me = await j('GET', '/api/me/employee', empToken);
  assert.equal(me.body.linked, true);
  assert.equal(me.body.employee.id, 'emp-demo-1');
  // Next shift — from the employee's own published roster only.
  const shift = await j('POST', '/api/agents/qa/ask', empToken, { question: 'ما هي ورديتي القادمة؟' });
  assert.equal(shift.status, 200, JSON.stringify(shift.body));
  assert.equal(shift.body.intent, 'next_shift');
  assert.equal(shift.body.routed, false);
  assert.match(shift.body.answerAr, /2026-11-1[123]/);
  // Leave balance — the employee's own balance (annual 21, taken 2 → 19 left).
  const leave = await j('POST', '/api/agents/qa/ask', empToken, { question: 'كم رصيد إجازتي السنوية؟' });
  assert.equal(leave.body.intent, 'leave_balance');
  assert.match(leave.body.answerAr, /19 من 21/);
  // Deduction traced to the payslip lines — never recalculated.
  const ded = await j('POST', '/api/agents/qa/ask', empToken, { question: 'لماذا تم خصم 1100 جنيه من راتبي؟' });
  assert.equal(ded.body.intent, 'payslip_deduction');
  assert.equal(ded.body.routed, false);
  assert.match(ded.body.answerAr, /التأمينات الاجتماعية/);
  assert.match(ded.body.answerAr, /1100\.00/);
  assert.match(ded.body.answerAr, /لم يُعاد حساب الأجر/);
  // Unanswered question routes to the manager.
  const routed = await j('POST', '/api/agents/qa/ask', empToken, { question: 'ما هو لون السماء؟' });
  assert.equal(routed.body.routed, true);
  assert.ok(routed.body.routedQuestionId);
  const queue = await j('GET', '/api/agents/qa/routed?status=routed', owner());
  assert.ok(queue.body.questions.some((q: { id: string }) => q.id === routed.body.routedQuestionId));
  const answered = await j('POST', `/api/agents/qa/routed/${routed.body.routedQuestionId}/answer`, mgr(), { answer: 'السماء زرقاء اليوم.' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.question.status, 'answered');
  // Cross-employee isolation: emp-demo-1 cannot read emp-demo-2's payslip.
  const ownerSlips = await j('GET', `/api/payroll/runs/${demoRunId}/payslips`, owner());
  const otherSlip = ownerSlips.body.payslips.find((p: { employeeId: string }) => p.employeeId === 'emp-demo-2');
  const ownSlip = ownerSlips.body.payslips.find((p: { employeeId: string }) => p.employeeId === 'emp-demo-1');
  assert.equal((await j('GET', `/api/payroll/payslips/${otherSlip.id}`, empToken)).status, 403);
  assert.equal((await j('GET', `/api/payroll/payslips/${ownSlip.id}`, empToken)).status, 200);
  const mine = await j('GET', `/api/payroll/runs/${demoRunId}/payslips`, empToken);
  assert.equal(mine.body.payslips.length, 1);
  assert.equal(mine.body.payslips[0].employeeId, 'emp-demo-1');
  // Unlinked employee-role account sees nothing and cannot ask.
  assert.equal((await j('POST', '/api/agents/qa/ask', unlinkedEmp(), { question: 'ما هي ورديتي؟' })).status, 403);
  const meUnlinked = await j('GET', '/api/me/employee', unlinkedEmp());
  assert.equal(meUnlinked.body.linked, false);
  // Owner links the accountant's login to emp-demo-2; duplicate links are refused.
  const link = await j('POST', '/api/employees/link', owner(), { userId: 'user-acct', employeeId: 'emp-demo-2' });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  assert.equal(link.body.linked, true);
  assert.equal((await j('POST', '/api/employees/link', owner(), { userId: 'user-mgr', employeeId: 'emp-demo-2' })).status, 409);
  assert.equal((await j('POST', '/api/employees/link', mgr(), { userId: 'user-acct', employeeId: 'emp-demo-3' })).status, 403);
});

test('M4 guardrails: kill switch + cost cap pause the agent, never payroll', async () => {
  // Tenant kill switch on the briefing agent.
  const kill = await j('POST', '/api/agents/kill-switch', owner(), { agentId: 'briefing', scope: 'tenant', killed: true });
  assert.equal(kill.status, 200);
  const paused = await j('POST', '/api/agents/briefing/run', owner(), { date: '2026-11-11' });
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /paused/);
  const status = await j('GET', '/api/agents/status', owner());
  assert.equal(status.body.agents.find((a: { agentId: string }) => a.agentId === 'briefing').paused, true);
  // Payroll review still works while the ANOMALY agent is paused — with the base check only.
  assert.equal((await j('POST', '/api/agents/kill-switch', owner(), { agentId: 'anomaly', scope: 'tenant', killed: true })).status, 200);
  const review = await j('POST', `/api/payroll/runs/${demoRunId}/review`, owner(), {});
  assert.equal(review.status, 200);
  assert.equal(review.body.agent3.paused, true);
  assert.ok(Array.isArray(review.body.anomalies));
  assert.equal((await j('POST', '/api/agents/kill-switch', owner(), { agentId: 'anomaly', scope: 'tenant', killed: false })).status, 200);
  // Switch it back off.
  assert.equal((await j('POST', '/api/agents/kill-switch', owner(), { agentId: 'briefing', scope: 'tenant', killed: false })).status, 200);
  assert.equal((await j('POST', '/api/agents/briefing/run', owner(), { date: '2026-11-11' })).status, 200);
  // Global kill switch (superadmin) on the schedule agent.
  assert.equal((await j('POST', '/api/agents/kill-switch', sa(), { agentId: 'schedule', scope: 'global', killed: true })).status, 200);
  assert.equal((await j('POST', '/api/agents/schedule/draft', owner(), { branchId: 'branch-zamalek', weekStart: '2026-11-30' })).status, 409);
  assert.equal((await j('POST', '/api/agents/kill-switch', sa(), { agentId: 'schedule', scope: 'global', killed: false })).status, 200);
  // Cost cap: set the QA cap to exactly what has been spent this month, then Q&A pauses.
  const cost = await j('GET', '/api/agents/cost', owner());
  const qa = cost.body.perAgent.find((a: { agentId: string }) => a.agentId === 'qa');
  assert.ok(qa.monthCostPiasters > 0);
  assert.equal((await j('POST', '/api/agents/cost/cap', owner(), { agentId: 'qa', capPiasters: qa.monthCostPiasters })).status, 200);
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { tenantSlug: 'demo-cafe', email: 'employee@demo-cafe.eg', password: 'DemoEmp123!' } });
  const capped = await j('POST', '/api/agents/qa/ask', login.json().token as string, { question: 'ما هي ورديتي القادمة؟' });
  assert.equal(capped.status, 409);
  assert.match(capped.body.error, /cap/);
  // Restore the cap; Q&A works again.
  assert.equal((await j('POST', '/api/agents/cost/cap', owner(), { agentId: 'qa', capPiasters: 50000 })).status, 200);
  assert.equal((await j('POST', '/api/agents/qa/ask', login.json().token as string, { question: 'ما هي ورديتي القادمة؟' })).status, 200);
  // Cost ledger is visible per agent.
  const cost2 = await j('GET', '/api/agents/cost', owner());
  assert.equal(cost2.body.perAgent.length, 4);
  assert.ok(cost2.body.totalPiasters > 0);
  assert.match(cost2.body.note, /STUBBED/);
});

test('M4 offline hardening: signed-timestamp verification + sync-status endpoint', async () => {
  process.env.OFFLINE_SIGNING_SECRET = 'test-offline-secret';
  const tenantId = 'tenant-demo-cafe';
  const sign = (employeeId: string, deviceAt: string, branchId: string) => signOfflineRecord('test-offline-secret', tenantId, employeeId, deviceAt, branchId);
  const nowIso = new Date().toISOString();
  // Valid signature → accepted.
  const ok = await j('POST', '/api/attendance/offline-queue', owner(), { records: [{ employeeId: 'emp-demo-10', branchId: 'branch-maadi', deviceAt: nowIso, lat: 29.9601, lng: 31.2506, signature: sign('emp-demo-10', nowIso, 'branch-maadi') }] });
  assert.equal(ok.body.accepted.length, 1, JSON.stringify(ok.body));
  assert.equal(ok.body.review.length, 0);
  await j('POST', '/api/attendance/clock-out', owner(), { employeeId: 'emp-demo-10' });
  // Bad signature under strict mode → held for review, no record created.
  const bad = await j('POST', '/api/attendance/offline-queue', owner(), { records: [{ employeeId: 'emp-demo-5', branchId: 'branch-zamalek', deviceAt: new Date().toISOString(), lat: 30.0626, lng: 31.2197, signature: 'bad-signature' }] });
  assert.equal(bad.body.accepted.length, 0);
  assert.equal(bad.body.review.length, 1);
  assert.match(bad.body.review[0].reason, /signature verification failed/);
  // Duplicate device time → held for review, never overwritten.
  const dup = await j('POST', '/api/attendance/offline-queue', owner(), { records: [{ employeeId: 'emp-demo-10', branchId: 'branch-maadi', deviceAt: nowIso, lat: 29.9601, lng: 31.2506, signature: sign('emp-demo-10', nowIso, 'branch-maadi') }] });
  assert.equal(dup.body.accepted.length, 0);
  assert.equal(dup.body.review.length, 1);
  assert.match(dup.body.review[0].reason, /duplicate/);
  // Stale record (30h old) → created but flagged pending_review.
  const staleAt = new Date(Date.now() - 30 * 3600000).toISOString();
  const stale = await j('POST', '/api/attendance/offline-queue', owner(), { records: [{ employeeId: 'emp-demo-5', branchId: 'branch-zamalek', deviceAt: staleAt, lat: 30.0626, lng: 31.2197, signature: sign('emp-demo-5', staleAt, 'branch-zamalek') }] });
  assert.equal(stale.body.accepted.length, 0);
  assert.equal(stale.body.review.length, 1);
  assert.match(stale.body.review[0].reason, /tolerance/);
  const staleRec = store.attendance.find((a) => a.employeeId === 'emp-demo-5' && a.deviceAt === staleAt);
  assert.equal(staleRec?.verificationStatus, 'pending_review');
  await j('POST', '/api/attendance/clock-out', owner(), { employeeId: 'emp-demo-5' });
  // Sync status aggregates the log.
  const sync = await j('GET', '/api/attendance/offline-sync/status', owner());
  assert.equal(sync.status, 200);
  assert.ok(sync.body.accepted >= 1);
  assert.ok(sync.body.conflicted >= 3); // invalid signature + duplicate + stale
  assert.match(sync.body.signatureVerification, /strict/);
  delete process.env.OFFLINE_SIGNING_SECRET;
});

test('M4 support tooling: tenant health snapshot + masked ticket context', async () => {
  const health = await j('GET', '/api/superadmin/tenants/tenant-demo-cafe/health', sa());
  assert.equal(health.status, 200, JSON.stringify(health.body));
  assert.ok(health.body.setupIncomplete.includes('NOSI employer rate unresolved (M0)'));
  assert.ok(!health.body.setupIncomplete.some((s: string) => s.includes('ai_agents')));
  assert.equal(health.body.whatsapp.provider, 'stub');
  assert.equal(health.body.whatsapp.deliveryRate, null);
  assert.match(health.body.whatsapp.note, /STUBBED/);
  assert.equal(health.body.agents.length, 4);
  assert.equal(health.body.counts.employees, 10);
  assert.ok(!JSON.stringify(health.body).includes('basicSalaryPiasters'));
  const ctx = await j('GET', '/api/superadmin/tenants/tenant-demo-cafe/ticket-context', sa());
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.employees.length, 10);
  assert.ok(ctx.body.employees.every((e: { nameMasked: string; phoneMasked: string }) => e.nameMasked.includes('.') && e.phoneMasked.includes('•••')));
  assert.ok(!JSON.stringify(ctx.body).includes('photoRef'));
  assert.ok(!JSON.stringify(ctx.body).includes('700000')); // no salary figures
  assert.match(ctx.body.note, /MASKED/);
  // Superadmin without MFA is refused.
  const noMfa = signSession({ sub: 'sa1', tenantId: null, role: 'superadmin', mfaVerified: false }, SECRET);
  assert.equal((await j('GET', '/api/superadmin/tenants/tenant-demo-cafe/health', noMfa)).status, 403);
  assert.equal((await j('GET', '/api/superadmin/tenants/tenant-demo-cafe/ticket-context', owner())).status, 403);
});

test('M4 AI-agents settings area: owner changes, branch manager cannot', async () => {
  const get = await j('GET', '/api/settings/ai_agents', owner());
  assert.equal(get.status, 200);
  assert.equal(get.body.latest.value.provider, 'stub');
  assert.equal(get.body.latest.value.monthlyCapPiastersPerAgent, 50000);
  const denied = await j('POST', '/api/settings/ai_agents', mgr(), { value: { provider: 'stub', monthlyCapPiastersPerAgent: 1000 }, reason: 'manager tries', effectiveFrom: '2026-12-01' });
  assert.equal(denied.status, 403);
});
