// M3 Payroll MVP API tests — Brief Appendix A + Appendix B golden cases,
// the 5-step run, the NOSI employer-rate BLOCKED guardrail, locked runs,
// bank files, reports and exports. All money in piasters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, store } from '../src/server.js';
import { seed } from '../src/seed.js';
import { signSession } from '../src/auth.js';
import { DEFAULT_STATUTORY_SETTINGS } from '@hr-payroll/shared';

const SECRET = 'test-secret-only';
let app: ReturnType<typeof buildServer>;
const owner = () => signSession({ sub: 'user-owner', tenantId: 'tenant-demo-cafe', role: 'owner' }, SECRET);
const acct = () => signSession({ sub: 'user-acct', tenantId: 'tenant-demo-cafe', role: 'accountant' }, SECRET);
const mgr = () => signSession({ sub: 'user-mgr', tenantId: 'tenant-demo-cafe', role: 'branch_manager' }, SECRET);
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const j = async (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: H(token), payload: payload as never });
  let body: Record<string, any> = {};
  try { body = r.json() as Record<string, any>; } catch { body = {}; } // CSV/HTML responses are not JSON
  return { status: r.statusCode, body, text: r.body };
};

let demoRunId = '';
let decRunId = '';
let janRunId = '';

test.before(async () => {
  await seed();
  app = buildServer({ jwtSecret: SECRET, breakGlassEnabled: false });
  await app.ready();
});
test.after(async () => { await app.close(); });

test('M3 seed: demo Nov 2026 run calculated, 10 payslips, totals reconcile', async () => {
  const { status, body } = await j('GET', '/api/payroll/runs', owner());
  assert.equal(status, 200);
  const run = body.runs.find((r: { period: string }) => r.period === '2026-11');
  assert.ok(run, 'seeded Nov 2026 run exists');
  assert.equal(run.status, 'calculated');
  demoRunId = run.id;
  const slips = await j('GET', `/api/payroll/runs/${run.id}/payslips`, owner());
  assert.equal(slips.body.payslips.length, 10);
  const sumNet = slips.body.payslips.reduce((s: number, p: { netPiasters: number }) => s + p.netPiasters, 0);
  const sumGross = slips.body.payslips.reduce((s: number, p: { grossPiasters: number }) => s + p.grossPiasters, 0);
  assert.equal(sumNet, run.totalNetPiasters);
  assert.equal(sumGross, run.totalGrossPiasters);
  assert.equal(run.employerCostStatus, 'pending'); // NOSI employer rate UNRESOLVED
  assert.equal(run.totalEmployerNosiPiasters, null);
  // Anomalies from the one day of M2 attendance: missing clock-outs + zero attendance.
  const kinds = (run.anomalies as { kind: string }[]).map((a) => a.kind);
  assert.ok(kinds.includes('missing_clock_out'));
  assert.ok(kinds.includes('zero_attendance_full_pay'));
});

test('Appendix A via API: emp-demo-1 gross 10,000 / NOSI 1,100 / tax 592.50 / levy 0.02 / net 8,307.48, employer PENDING', async () => {
  const slips = await j('GET', `/api/payroll/runs/${demoRunId}/payslips`, owner());
  const p = slips.body.payslips.find((x: { employeeId: string }) => x.employeeId === 'emp-demo-1');
  assert.equal(p.grossPiasters, 1000000);
  assert.equal(p.insurableWagePiasters, 1000000);
  assert.equal(p.employeeNosiPiasters, 110000);
  assert.equal(p.incomeTaxPiasters, 59250);
  assert.equal(p.martyrsLevyPiasters, 2);
  assert.equal(p.netPiasters, 830748);
  assert.equal(p.employerNosiPiasters, null);
  assert.equal(p.totalEmployerCostPiasters, null);
});

// --- Golden-case setup: joiner/leaver/floor/ceiling/low-wage + OT records ---
test('golden setup: extra employees, structures, unpaid leave, rest-day + holiday OT records', async () => {
  const extra = [
    { id: 'emp-joiner', fullNameAr: 'موظف منضم', branchId: 'branch-zamalek', basicSalaryPiasters: 1000000, startDate: '2026-12-16', endDate: null },
    { id: 'emp-leaver', fullNameAr: 'موظف مغادر', branchId: 'branch-zamalek', basicSalaryPiasters: 1000000, startDate: '2026-01-05', endDate: '2026-12-15' },
    { id: 'emp-floor', fullNameAr: 'موظف الحد الأدنى', branchId: 'branch-maadi', basicSalaryPiasters: 200000, startDate: '2026-01-05', endDate: null },
    { id: 'emp-ceil', fullNameAr: 'موظف الحد الأقصى', branchId: 'branch-maadi', basicSalaryPiasters: 3000000, startDate: '2026-01-05', endDate: null },
    { id: 'emp-low', fullNameAr: 'موظف أقل من الحد', branchId: 'branch-zamalek', basicSalaryPiasters: 600000, startDate: '2026-01-05', endDate: null },
  ];
  for (const e of extra) {
    store.employees.push({ ...e, tenantId: 'tenant-demo-cafe', fullNameEn: e.id, phone: '+201099999999', jobTitle: 'Waiter', contractType: 'full_time', allowancesPiasters: 0, nationalIdLast4: null });
  }
  const structures: Record<string, unknown> = {
    'emp-joiner': { basicPiasters: 1000000, allowances: [], advanceTotalPiasters: 300000, advanceInstalmentPiasters: 100000 },
    'emp-leaver': { basicPiasters: 1000000, allowances: [] },
    'emp-floor': { basicPiasters: 200000, allowances: [{ name: 'Transport', amountPiasters: 50000, taxable: true, insurable: true }] },
    'emp-ceil': { basicPiasters: 3000000, allowances: [] },
    'emp-low': { basicPiasters: 600000, allowances: [] },
  };
  for (const [employeeId, s] of Object.entries(structures)) {
    const r = await j('POST', '/api/payroll/structures', owner(), { employeeId, ...(s as object), effectiveFrom: '2026-10-01' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  // Unpaid leave day for emp-demo-4 on 2026-12-10 (approved by owner — unpaid requires owner approval).
  const lr = await j('POST', '/api/leave/requests', owner(), { employeeId: 'emp-demo-4', type: 'unpaid', startDate: '2026-12-10', endDate: '2026-12-10', reason: 'golden case' });
  assert.equal(lr.status, 201, JSON.stringify(lr.body));
  const appr = await j('POST', `/api/leave/requests/${lr.body.request.id}/approve`, owner());
  assert.equal(appr.status, 200, JSON.stringify(appr.body));
  // OT records for emp-demo-3: Friday 2026-10-02 (rest day, no roster) 8h,
  // and Tue 2026-10-06 (Armed Forces Day, public holiday) 8h.
  for (const day of ['2026-10-02', '2026-10-06']) {
    store.attendance.push({
      id: `att-ot-${day}`, tenantId: 'tenant-demo-cafe', employeeId: 'emp-demo-3', branchId: 'branch-zamalek',
      rosterAssignmentId: null, method: 'passcode_photo', clockInAt: `${day}T07:00:00Z`, clockOutAt: `${day}T15:00:00Z`,
      deviceAt: `${day}T07:00:00Z`, lat: 30.0626, lng: 31.2197, distanceFromBranchM: 0, wifiMatched: null,
      mockLocationFlag: false, photoRef: null, photoRetainUntil: null, verificationStatus: 'auto_approved', source: 'live',
    });
  }
});

test('golden: overtime on rest day (480 min) and public holiday (480 min) — Oct run', async () => {
  const prep = await j('POST', '/api/payroll/runs', owner(), { period: '2026-10' });
  assert.equal(prep.status, 201, JSON.stringify(prep.body));
  const calc = await j('POST', `/api/payroll/runs/${prep.body.run.id}/calculate`, acct());
  assert.equal(calc.status, 200, JSON.stringify(calc.body));
  assert.equal(calc.body.reconciled, true);
  const p = calc.body.payslips.find((x: { employeeId: string }) => x.employeeId === 'emp-demo-3');
  assert.equal(p.overtimeMinutes.restDayMin, 480);
  assert.equal(p.overtimeMinutes.publicHolidayMin, 480);
  // basic 7,000 → hourly 3,365.38 piasters; rest 8h×2.00 = 53,846; holiday 8h×3.00 = 80,769.
  assert.equal(p.grossPiasters, 750000 + 53846 + 80769);
  assert.equal(p.netPiasters, 760440);
});

test('golden: Dec run — joiner/leaver pro-rating, NOSI floor/ceiling, minimum-wage flag, unpaid leave, advance month 1', async () => {
  const prep = await j('POST', '/api/payroll/runs', owner(), { period: '2026-12' });
  assert.equal(prep.status, 201, JSON.stringify(prep.body));
  const calc = await j('POST', `/api/payroll/runs/${prep.body.run.id}/calculate`, acct());
  assert.equal(calc.status, 200, JSON.stringify(calc.body));
  decRunId = prep.body.run.id;
  const find = (id: string) => calc.body.payslips.find((x: { employeeId: string }) => x.employeeId === id);
  // Joiner from 2026-12-16: 16 of 31 days → 516,129; advance instalment 100,000 → net 359,354.
  assert.equal(find('emp-joiner').grossPiasters, 516129);
  assert.equal(find('emp-joiner').netPiasters, 359354);
  // Leaver to 2026-12-15: 15 of 31 days → 483,871; net 430,644.
  assert.equal(find('emp-leaver').grossPiasters, 483871);
  assert.equal(find('emp-leaver').netPiasters, 430644);
  // NOSI floor: gross 250,000 → insurable 270,000, employee NOSI 29,700, net 220,299.
  const floor = find('emp-floor');
  assert.equal(floor.insurableWagePiasters, 270000);
  assert.equal(floor.employeeNosiPiasters, 29700);
  assert.equal(floor.netPiasters, 220299);
  // NOSI ceiling: gross 3,000,000 → insurable 1,670,000, employee NOSI 183,700, net 2,347,210.
  const ceil = find('emp-ceil');
  assert.equal(ceil.insurableWagePiasters, 1670000);
  assert.equal(ceil.employeeNosiPiasters, 183700);
  assert.equal(ceil.netPiasters, 2347210);
  // Below EGP 7,000 minimum wage flagged (floor + low-wage employees).
  assert.equal(find('emp-low').belowMinimumWage, true);
  assert.equal(floor.belowMinimumWage, true);
  assert.equal(find('emp-demo-1').belowMinimumWage, false);
  // Unpaid leave day: emp-demo-4 daily rate 750,000/31 = 24,194 deducted.
  const d4 = find('emp-demo-4');
  assert.equal(d4.grossPiasters, 750000 - 24194);
  const absenceLine = d4.lines.find((l: { label: string }) => l.label === 'Absence / unpaid leave');
  assert.equal(absenceLine.amountPiasters, -24194);
  // Reconciliation: payslip sums = run totals.
  const run = calc.body.run;
  assert.equal(calc.body.payslips.reduce((s: number, p: { netPiasters: number }) => s + p.netPiasters, 0), run.totalNetPiasters);
  // Branch manager cannot create a run or approve one.
  assert.equal((await j('POST', '/api/payroll/runs', mgr(), { period: '2027-03' })).status, 403);
  assert.equal((await j('POST', `/api/payroll/runs/${decRunId}/approve`, mgr(), { confirmTotalCost: true })).status, 403);
});

test('NOSI guardrail: Dec run approval is BLOCKED while the employer rate is null', async () => {
  const r = await j('POST', `/api/payroll/runs/${decRunId}/approve`, owner(), { confirmTotalCost: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EMPLOYER_NOSI_RATE_UNRESOLVED');
  assert.match(r.body.error, /BLOCKED/);
  assert.equal(r.body.totalEmployerCostPiasters, null);
  assert.equal(r.body.totalNetPiasters, 0 + (await j('GET', `/api/payroll/runs/${decRunId}`, owner())).body.run.totalNetPiasters);
});

test('Reviewer sets the employer rate ONLY through the guarded Settings flow (test-only value)', async () => {
  // Dangerous statutory edit without confirmation is refused.
  const noConfirm = await j('POST', '/api/settings/statutory_rates', owner(), {
    value: { ...DEFAULT_STATUTORY_SETTINGS, nosiEmployerPct: 18.75 },
    reason: 'test', effectiveFrom: '2027-01-01',
  });
  assert.equal(noConfirm.status, 400);
  const ok = await j('POST', '/api/settings/statutory_rates', owner(), {
    value: { ...DEFAULT_STATUTORY_SETTINGS, nosiEmployerPct: 18.75 },
    reason: 'TEST ONLY — reviewer-set value for the M3 test run, not a shipped default',
    effectiveFrom: '2027-01-01', confirmDangerous: true,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.version.version, 2);
  const get = await j('GET', '/api/settings/statutory_rates', owner());
  assert.equal(get.body.latest.value.nosiEmployerPct, 18.75);
  // The seed still ships no default: the rate exists only because this test set it.
  assert.ok(store.audit.some((a) => a.action === 'settings.change' && JSON.stringify(a.detail).includes('statutory_rates')));
});

test('Jan run: advance instalment month 2, approve with second confirmation, pay via CIB bank file', async () => {
  const prep = await j('POST', '/api/payroll/runs', owner(), { period: '2027-01' });
  assert.equal(prep.status, 201, JSON.stringify(prep.body));
  janRunId = prep.body.run.id;
  const calc = await j('POST', `/api/payroll/runs/${janRunId}/calculate`, acct());
  assert.equal(calc.status, 200, JSON.stringify(calc.body));
  assert.equal(calc.body.run.employerCostStatus, 'ready');
  const joiner = calc.body.payslips.find((x: { employeeId: string }) => x.employeeId === 'emp-joiner');
  assert.equal(joiner.netPiasters, 730748); // advance instalment deducted a second month
  const emp1 = calc.body.payslips.find((x: { employeeId: string }) => x.employeeId === 'emp-demo-1');
  assert.equal(emp1.employerNosiPiasters, 187500); // 18.75% × 10,000 (test-only rate)
  assert.equal(emp1.totalEmployerCostPiasters, 1187500);
  assert.equal(emp1.netPiasters, 830748); // employer cost never deducted from the employee
  // Second confirmation: first attempt without it returns the totals to confirm.
  const noConfirm = await j('POST', `/api/payroll/runs/${janRunId}/approve`, owner(), {});
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.confirmation.totalEmployerCostPiasters,
    noConfirm.body.confirmation.totalGrossPiasters + noConfirm.body.confirmation.totalEmployerNosiPiasters);
  const appr = await j('POST', `/api/payroll/runs/${janRunId}/approve`, owner(), { confirmTotalCost: true });
  assert.equal(appr.status, 200, JSON.stringify(appr.body));
  assert.equal(appr.body.run.status, 'locked');
  assert.ok(appr.body.run.lockedAt);
  // Pay: CIB bank file reconciles to the run net total; payslips queued (stubbed).
  const pay = await j('POST', `/api/payroll/runs/${janRunId}/pay`, owner(), { bank: 'CIB' });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.run.status, 'paid');
  assert.equal(pay.body.bankFile.totalPiasters, pay.body.run.totalNetPiasters);
  assert.equal(pay.body.bankFile.recordCount, calc.body.payslips.length);
  assert.match(pay.body.bankFile.content, /GENERATED FILE, not a disbursement/);
  assert.match(pay.body.bankFile.content, /Account Number,Beneficiary Name/);
  assert.equal(pay.body.payslipsQueuedStubbed, calc.body.payslips.length);
  assert.equal(store.outbox.filter((m) => m.template === 'payslip_sent').length, calc.body.payslips.length);
  assert.ok(store.outbox.every((m) => m.status === 'queued_stubbed'));
});

test('Locked run is immutable; correction only via next-run adjustment', async () => {
  const recalc = await j('POST', `/api/payroll/runs/${janRunId}/calculate`, acct());
  assert.equal(recalc.status, 409);
  assert.match(recalc.body.error, /immutable/);
  const adj = await j('POST', '/api/payroll/adjustments', acct(), {
    employeeId: 'emp-demo-1', sourceRunId: janRunId, targetPeriod: '2027-02',
    amountPiasters: -50000, reason: 'January overtime overpaid by EGP 500 — corrected in February',
  });
  assert.equal(adj.status, 201, JSON.stringify(adj.body));
  const feb = await j('POST', '/api/payroll/runs', owner(), { period: '2027-02' });
  assert.equal(feb.status, 201);
  const calc = await j('POST', `/api/payroll/runs/${feb.body.run.id}/calculate`, acct());
  assert.equal(calc.status, 200, JSON.stringify(calc.body));
  const emp1 = calc.body.payslips.find((x: { employeeId: string }) => x.employeeId === 'emp-demo-1');
  assert.equal(emp1.netPiasters, 830748 - 50000); // adjustment applied in Feb
  // The locked January payslip is untouched.
  const janSlips = await j('GET', `/api/payroll/runs/${janRunId}/payslips`, owner());
  assert.equal(janSlips.body.payslips.find((x: { employeeId: string }) => x.employeeId === 'emp-demo-1').netPiasters, 830748);
  const adjs = await j('GET', '/api/payroll/adjustments?period=2027-02', owner());
  assert.equal(adjs.body.adjustments[0].status, 'applied');
  // Statutory change may not back-date into the locked January period.
  const backdate = await j('POST', '/api/settings/statutory_rates', owner(), {
    value: { ...DEFAULT_STATUTORY_SETTINGS, nosiEmployerPct: 18.75 },
    reason: 'back-date attempt', effectiveFrom: '2027-01-15', confirmDangerous: true,
  });
  assert.equal(backdate.status, 400);
  assert.match(backdate.body.error, /locked period/);
});

test('Reports, exports (logged) and printable payslip HTML', async () => {
  const summary = await j('GET', '/api/payroll/reports/summary?period=2026-11', owner());
  assert.equal(summary.status, 200);
  assert.equal(summary.body.payslips, 10);
  assert.equal(summary.body.totalEmployerNosiPiasters, null); // Nov predates the test rate
  assert.equal(summary.body.employerCostStatus, 'pending');
  const ec = await j('GET', '/api/payroll/reports/employer-cost?period=2027-01', owner());
  assert.equal(ec.body.employerCostStatus, 'ready');
  assert.ok(ec.body.totalEmployerCostPiasters > ec.body.grossPiasters);
  const tn = await j('GET', '/api/payroll/reports/tax-nosi?period=2027-01', owner());
  assert.ok(tn.body.incomeTaxPiasters > 0 && tn.body.employeeNosiPiasters > 0);
  assert.equal(tn.body.taxRuleStatus, 'REVIEWER-UNCONFIRMED');
  const att = await j('GET', '/api/payroll/reports/attendance?period=2026-11', owner());
  assert.equal(att.body.rows.length, 15);
  const labour = await j('GET', '/api/payroll/reports/labour-cost?period=2026-11', owner());
  assert.ok(Object.keys(labour.body.perBranchPerDay).length > 0);
  const csv = await j('GET', `/api/payroll/runs/${demoRunId}/export?kind=register`, owner());
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Employee,Branch,Gross/);
  assert.match(csv.text, /TOTAL/);
  assert.match(csv.text, /PENDING/); // Nov employer cost pending
  const exps = await j('GET', '/api/payroll/exports', owner());
  assert.ok(exps.body.exports.some((e: { kind: string }) => e.kind === 'register'));
  assert.ok(exps.body.exports.some((e: { kind: string }) => e.kind === 'bank_file'));
  // Printable payslip HTML (Arabic, employer cost shown as pending, not a deduction).
  const slips = await j('GET', `/api/payroll/runs/${demoRunId}/payslips`, owner());
  const slipId = slips.body.payslips.find((x: { employeeId: string }) => x.employeeId === 'emp-demo-1').id;
  const html = await j('GET', `/api/payroll/payslips/${slipId}/html`, owner());
  assert.equal(html.status, 200);
  assert.match(html.text, /صافي الأجر/);
  assert.match(html.text, /8307\.48/);
  assert.match(html.text, /قيد الانتظار/);
  // Other bank layouts generate too.
  for (const bank of ['QNB', 'NBE', 'Banque Misr']) {
    const bf = await j('POST', `/api/payroll/runs/${janRunId}/bank-file`, acct(), { bank });
    assert.equal(bf.status, 201, JSON.stringify(bf.body));
    assert.equal(bf.body.bankFile.bank, bank);
  }
  const bfs = await j('GET', `/api/payroll/bank-files?runId=${janRunId}`, owner());
  assert.equal(bfs.body.bankFiles.length, 4); // CIB from pay + 3 above
});

test('Payroll tenancy + employee self-service boundary', async () => {
  const other = signSession({ sub: 'u-other', tenantId: 'tenant-other', role: 'owner' }, SECRET);
  const runs = await j('GET', '/api/payroll/runs', other);
  assert.equal(runs.status, 200);
  assert.equal(runs.body.runs.length, 0); // other tenant sees nothing of demo-cafe
  const emp = signSession({ sub: 'user-emp', tenantId: 'tenant-demo-cafe', role: 'employee' }, SECRET);
  const slips = await j('GET', `/api/payroll/runs/${demoRunId}/payslips`, emp);
  assert.equal(slips.status, 200);
  // M4: an unlinked employee-role account sees NO payslips at all (own data
  // only, and only when linked — see the M4 link test in m4.test.ts).
  assert.equal(slips.body.payslips.length, 0);
  const ownerSlips = await j('GET', `/api/payroll/runs/${demoRunId}/payslips`, owner());
  const one = await j('GET', `/api/payroll/payslips/${ownerSlips.body.payslips[0].id}`, emp);
  assert.equal(one.status, 403);
});
