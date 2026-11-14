// Demo seed — M1 + M2, idempotent. One Egyptian café tenant, 2 branches,
// 3 staff users, 10 demo employees, shift templates, a published 2-week
// roster, sample attendance records + exceptions, leave balances.
// Demo figures only; no real people, no real salaries (piasters).
import { store } from './server.js';
import { hashPassword } from './auth.js';
import { clockIn, clockOut, sweepMissedClockOuts } from './attendance.js';
import { approveLeave } from './leave.js';
import { DEFAULT_ATTENDANCE_SETTINGS, DEFAULT_SHIFT_SETTINGS, DEFAULT_LEAVE_SETTINGS, DEFAULT_PAYROLL_STRUCTURE_SETTINGS, DEFAULT_STATUTORY_SETTINGS, DEFAULT_NOTIFICATIONS_SETTINGS, DEFAULT_INTEGRATIONS_SETTINGS, DEFAULT_AI_AGENTS_SETTINGS, PLAN_CATALOGUE, ZKTECO_ADDON_PRICE_PIASTERS_PER_MONTH, CONSENT_TEXT_VERSION } from '@hr-payroll/shared';
import { calculateRun } from './payroll.js';
import { runBriefing, runScheduleDraft, runAnomalyCheck, answerQa } from './agents.js';
import { newId } from '@hr-payroll/db';

export async function seed(): Promise<{ seeded: boolean; tenantId: string }> {
  if (store.seeded || store.tenants.size > 0) return { seeded: false, tenantId: [...store.tenants.values()][0]?.id ?? '' };
  const tenantId = 'tenant-demo-cafe';
  store.addTenant({ id: tenantId, slug: 'demo-cafe', nameAr: 'القاهرة كافيه', nameEn: 'Cairo Café', status: 'active', plan: 'growth', staffCap: 20 });
  const ownerHash = await hashPassword('DemoOwner123!');
  const acctHash = await hashPassword('DemoAcct123!');
  const mgrHash = await hashPassword('DemoMgr123!');
  store.addUser({ id: 'user-owner', tenantId, email: 'owner@demo-cafe.eg', phone: '+201012345678', passwordHash: ownerHash, role: 'owner', branchId: null });
  store.addUser({ id: 'user-acct', tenantId, email: 'accountant@demo-cafe.eg', phone: '+201112345678', passwordHash: acctHash, role: 'accountant', branchId: null });
  store.addUser({ id: 'user-mgr', tenantId, email: 'manager@demo-cafe.eg', phone: '+201212345678', passwordHash: mgrHash, role: 'branch_manager', branchId: 'branch-zamalek' });
  // M4: employee self-service login, linked to emp-demo-1 (Ahmed Mohamed).
  const empHash = await hashPassword('DemoEmp123!');
  store.addUser({ id: 'user-emp1', tenantId, email: 'employee@demo-cafe.eg', phone: '+201012345679', passwordHash: empHash, role: 'employee', branchId: 'branch-zamalek', employeeId: 'emp-demo-1' });

  // Branches with real geofence centres (Cairo).
  store.branches.push(
    { id: 'branch-zamalek', tenantId, nameAr: 'الزمالك', nameEn: 'Zamalek', geofenceLat: 30.0626, geofenceLng: 31.2197, geofenceRadiusM: 100, wifiSsid: 'CairoCafe-Zamalek', active: true },
    { id: 'branch-maadi', tenantId, nameAr: 'المعادي', nameEn: 'Maadi', geofenceLat: 29.9601, geofenceLng: 31.2506, geofenceRadiusM: 150, wifiSsid: 'CairoCafe-Maadi', active: true },
  );

  // 10 demo employees with contract + salary components (demo only, piasters).
  const names = ['أحمد محمد', 'سارة علي', 'محمد حسن', 'فاطمة أحمد', 'عمر خالد', 'نورا سامي', 'كريم يوسف', 'منى طارق', 'حسن إبراهيم', 'ليلى عمر'];
  const namesEn = ['Ahmed Mohamed', 'Sara Ali', 'Mohamed Hassan', 'Fatma Ahmed', 'Omar Khaled', 'Noura Samy', 'Karim Youssef', 'Mona Tarek', 'Hassan Ibrahim', 'Laila Omar'];
  names.forEach((n, i) => {
    store.employees.push({
      id: `emp-demo-${i + 1}`, tenantId, branchId: i % 2 === 0 ? 'branch-zamalek' : 'branch-maadi',
      fullNameAr: n, fullNameEn: namesEn[i], phone: `+2010${String(1000000 + i)}`,
      jobTitle: i < 3 ? 'Barista' : 'Waiter', basicSalaryPiasters: 700000,
      contractType: 'full_time', allowancesPiasters: 50000,
      startDate: '2026-01-05', nationalIdLast4: null,
    });
  });

  // Shift templates (Brief §6): Morning 09:00–17:00, Evening 17:00–01:00
  // (overnight), Split 09:00–21:00 with a 4h unpaid midday break.
  const tplMorning = { id: 'tpl-morning', tenantId, branchId: null, nameAr: 'صباحي', nameEn: 'Morning', startTime: '09:00', endTime: '17:00', overnight: false, unpaidBreakMinutes: 30, status: 'active' as const };
  const tplEvening = { id: 'tpl-evening', tenantId, branchId: null, nameAr: 'مسائي', nameEn: 'Evening', startTime: '17:00', endTime: '01:00', overnight: true, unpaidBreakMinutes: 30, status: 'active' as const };
  const tplSplit = { id: 'tpl-split', tenantId, branchId: null, nameAr: 'منقسم', nameEn: 'Split', startTime: '09:00', endTime: '21:00', overnight: false, unpaidBreakMinutes: 240, status: 'active' as const };
  store.shiftTemplates.push(tplMorning, tplEvening, tplSplit);

  // Published 2-week roster: weeks starting Mon 2026-11-02 and Mon 2026-11-09,
  // one roster per branch per week; each employee works 5 days (Mon–Fri),
  // alternating Morning / Evening by employee index.
  const weeks = ['2026-11-02', '2026-11-09'];
  const workDays = [0, 1, 2, 3, 4]; // offsets from Monday
  for (const weekStart of weeks) {
    for (const branchId of ['branch-zamalek', 'branch-maadi']) {
      const roster = { id: newId('roster'), tenantId, branchId, weekStart, status: 'published' as const, publishedAt: '2026-11-01T08:00:00Z', publishedByUserId: 'user-mgr' };
      store.rosters.push(roster);
      const base = new Date(`${weekStart}T00:00:00Z`).getTime();
      store.employees.filter((e) => e.branchId === branchId).forEach((emp, idx) => {
        for (const off of workDays) {
          const date = new Date(base + off * 86400000).toISOString().slice(0, 10);
          const tpl = (idx + off) % 3 === 2 ? tplSplit : ((idx + off) % 2 === 0 ? tplMorning : tplEvening);
          store.rosterAssignments.push({ id: newId('asg'), tenantId, rosterId: roster.id, employeeId: emp.id, date, shiftTemplateId: tpl.id, onLeave: false });
        }
      });
    }
  }

  // Demo settings v1 — Areas 2–4 with shipped defaults (Brief §10 guardrail 5).
  // NOSI employer left UNRESOLVED (no value set) — M0 blocker, untouched by M2.
  store.saveSettings({ id: 'seed-s1', tenantId, area: 'attendance', version: 1, effectiveFrom: '2026-11-08', value: { ...DEFAULT_ATTENDANCE_SETTINGS, modes: ['qr_geofence', 'passcode_photo'], wifiSsid: null }, changedByUserId: 'user-owner', reason: 'demo seed', createdAt: new Date().toISOString() });
  store.saveSettings({ id: 'seed-s2', tenantId, area: 'company_branches', version: 1, effectiveFrom: '2026-11-08', value: { branches: [{ nameEn: 'Zamalek', geofenceRadiusM: 100 }, { nameEn: 'Maadi', geofenceRadiusM: 150 }], timezone: 'Africa/Cairo' }, changedByUserId: 'user-owner', reason: 'demo seed', createdAt: new Date().toISOString() });
  store.saveSettings({ id: 'seed-s3', tenantId, area: 'statutory_rates', version: 1, effectiveFrom: '2026-11-08', value: { nosiEmployeePct: 11, nosiEmployerPct: null, nosiFloorEgp: 2700, nosiCeilingEgp: 16700, status: 'UNRESOLVED — needs reviewer confirmation at M0' }, changedByUserId: 'user-owner', reason: 'demo seed — no employer default shipped', createdAt: new Date().toISOString() });
  store.saveSettings({ id: 'seed-s4', tenantId, area: 'shifts', version: 1, effectiveFrom: '2026-11-08', value: { ...DEFAULT_SHIFT_SETTINGS }, changedByUserId: 'user-owner', reason: 'demo seed', createdAt: new Date().toISOString() });
  store.saveSettings({ id: 'seed-s5', tenantId, area: 'leave', version: 1, effectiveFrom: '2026-11-08', value: { ...DEFAULT_LEAVE_SETTINGS }, changedByUserId: 'user-owner', reason: 'demo seed', createdAt: new Date().toISOString() });
  // M3 — Settings Areas 6–9 v1 (Brief §10). Statutory employer rate stays null.
  store.saveSettings({ id: 'seed-s6', tenantId, area: 'payroll_structure', version: 1, effectiveFrom: '2026-11-08', value: { ...DEFAULT_PAYROLL_STRUCTURE_SETTINGS }, changedByUserId: 'user-owner', reason: 'demo seed', createdAt: new Date().toISOString() });
  store.saveSettings({ id: 'seed-s7', tenantId, area: 'notifications', version: 1, effectiveFrom: '2026-11-08', value: { ...DEFAULT_NOTIFICATIONS_SETTINGS }, changedByUserId: 'user-owner', reason: 'demo seed', createdAt: new Date().toISOString() });
  store.saveSettings({ id: 'seed-s8', tenantId, area: 'integrations_billing_data', version: 1, effectiveFrom: '2026-11-08', value: { ...DEFAULT_INTEGRATIONS_SETTINGS }, changedByUserId: 'user-owner', reason: 'demo seed', createdAt: new Date().toISOString() });
  // M4 — AI-agents Settings v1 (Area 10): STUBBED provider, EGP 500/month cap per agent, no kill switches.
  store.saveSettings({ id: 'seed-s9', tenantId, area: 'ai_agents', version: 1, effectiveFrom: '2026-11-08', value: { ...DEFAULT_AI_AGENTS_SETTINGS }, changedByUserId: 'user-owner', reason: 'demo seed', createdAt: new Date().toISOString() });

  // Kiosk: consent + passcode enrolment for emp-demo-1 (passcode 1234, demo only).
  store.kioskConsents.push({ tenantId, employeeId: 'emp-demo-1', consented: true, noticeShownAt: '2026-11-08T09:00:00Z', consentedAt: '2026-11-08T09:00:00Z', retentionDays: 90 });
  store.kioskPasscodes.push({ tenantId, employeeId: 'emp-demo-1', passcodeHash: await hashPassword('1234'), failedAttempts: 0, lockedUntil: null });

  // Leave balances 2026 for all 10 employees (annual 21, sick 15, casual 6).
  for (const emp of store.employees) {
    store.leaveBalances.push(
      { tenantId, employeeId: emp.id, year: 2026, type: 'annual', entitlementDays: 21, carriedDays: 0, takenDays: emp.id === 'emp-demo-1' ? 2 : 0 },
      { tenantId, employeeId: emp.id, year: 2026, type: 'sick', entitlementDays: 15, carriedDays: 0, takenDays: 0 },
      { tenantId, employeeId: emp.id, year: 2026, type: 'casual', entitlementDays: 6, carriedDays: 0, takenDays: 0 },
    );
  }
  // One approved annual leave (emp-demo-6, 2026-11-12 → 2026-11-13): marks the
  // roster assignments on-leave and queues a stubbed WhatsApp decision notice.
  const leaveReq = { id: newId('leave'), tenantId, employeeId: 'emp-demo-6', type: 'annual', startDate: '2026-11-12', endDate: '2026-11-13', days: 2, status: 'pending' as const, reason: 'إجازة عائلية', decidedByUserId: null, decidedAt: null };
  store.leaveRequests.push(leaveReq);
  await approveLeave(store, tenantId, leaveReq, 'user-mgr');

  // Sample attendance, Tue 2026-11-10 (Cairo wall-clock; UTC = Cairo − 2h).
  // Roster that day: emp-demo-7/emp-demo-8 are on Morning (09:00–17:00),
  // emp-demo-9/emp-demo-4 on Split (09:00–21:00).
  // emp-demo-7 (Zamalek, Morning): on time, clocked out.
  clockIn(store, tenantId, { employeeId: 'emp-demo-7', branchId: 'branch-zamalek', lat: 30.0626, lng: 31.2197, photoRef: 'seed-photo-emp7-20261110', method: 'passcode_photo' }, new Date('2026-11-10T07:02:00Z'));
  clockOut(store, tenantId, 'emp-demo-7', new Date('2026-11-10T15:05:00Z'));
  // emp-demo-8 (Maadi, Morning): 25 min late → 'late' exception (grace 10).
  clockIn(store, tenantId, { employeeId: 'emp-demo-8', branchId: 'branch-maadi', lat: 29.9601, lng: 31.2506, method: 'passcode_photo' }, new Date('2026-11-10T07:25:00Z'));
  clockOut(store, tenantId, 'emp-demo-8', new Date('2026-11-10T15:00:00Z'));
  // emp-demo-9 (Zamalek, Split): clocked in, never clocked out.
  clockIn(store, tenantId, { employeeId: 'emp-demo-9', branchId: 'branch-zamalek', lat: 30.0626, lng: 31.2197, method: 'passcode_photo' }, new Date('2026-11-10T06:58:00Z'));
  // emp-demo-4 (Maadi, Split): clocked in ~2.5 km away → off-location exception.
  clockIn(store, tenantId, { employeeId: 'emp-demo-4', branchId: 'branch-maadi', lat: 29.98, lng: 31.27, method: 'passcode_photo' }, new Date('2026-11-10T07:00:00Z'));
  // Sweep at 22:00 Cairo: Split shifts ended 21:00 → missed-clock-out flags.
  sweepMissedClockOuts(store, tenantId, new Date('2026-11-10T20:00:00Z'));

  // --- M3 demo payroll -------------------------------------------------------
  // Salary structures for all 10 employees. emp-demo-1 follows the Brief
  // Appendix A shape: basic EGP 8,000 + transport EGP 2,000 = EGP 10,000
  // gross; the others use basic EGP 7,000 + EGP 500 allowances.
  // Bank accounts are DEMO placeholders (generated files only, never real).
  store.employees.forEach((emp, i) => {
    const isAppendixA = emp.id === 'emp-demo-1';
    store.salaryStructures.push({
      id: newId('struct'), tenantId, employeeId: emp.id,
      templateName: isAppendixA ? 'Appendix A demo' : 'Full-time',
      basicPiasters: isAppendixA ? 800000 : 700000,
      allowances: isAppendixA
        ? [{ name: 'Transport', amountPiasters: 200000, taxable: true, insurable: true }]
        : [{ name: 'Transport', amountPiasters: 50000, taxable: true, insurable: true }],
      payPeriod: 'monthly', payDay: 28,
      bankAccount: `DEMO-EG-100000000${i + 1}`, walletNumber: null,
      advanceTotalPiasters: 0, advanceInstalmentPiasters: 0,
      loanTotalPiasters: 0, loanInstalmentPiasters: 0,
      effectiveFrom: '2026-11-01', version: 1,
    });
  });

  // Prepared demo run for Nov 2026, calculated from the M2 attendance data
  // above (one day of records; most staff show zero-attendance anomalies —
  // that is the demo's point). Status: 'calculated'. It cannot be approved
  // until a reviewer sets the NOSI employer rate (BLOCKED by design).
  const demoRun = {
    id: 'run-demo-2026-11', tenantId, period: '2026-11',
    branchIds: ['branch-zamalek', 'branch-maadi'], status: 'prepared' as const,
    warningsAccepted: [] as string[], anomalies: [] as unknown[],
    totalGrossPiasters: 0, totalNetPiasters: 0, totalEmployeeNosiPiasters: 0, totalTaxPiasters: 0,
    totalEmployerNosiPiasters: null as number | null, employerCostStatus: 'pending' as const,
    taxRuleVersion: 1, taxRuleStatus: 'REVIEWER-UNCONFIRMED', overtimeRuleVersion: 1,
    createdByUserId: 'user-owner', approvedByUserId: null, approvedAt: null, lockedAt: null, paidAt: null,
    createdAt: new Date().toISOString(),
  };
  store.payrollRuns.push(demoRun);
  calculateRun(store, tenantId, demoRun);

  // --- M4 demo agent runs (Brief §8; LLM STUBBED — deterministic outputs) ---
  // Briefing for 2026-11-11 (yesterday 2026-11-10: 4 clock-ins, 1 late,
  // 2 missing clock-outs; no October attendance, so the last-month labour
  // comparison is honestly reported as missing data).
  await runBriefing(store, tenantId, '2026-11-11', 'user-owner');
  // Schedule draft for week 2026-11-16 (Zamalek) — DRAFT ONLY, never published.
  await runScheduleDraft(store, tenantId, 'branch-zamalek', '2026-11-16', 'user-owner');
  // Anomaly check on the Nov 2026 run (missing clock-outs priced as full days).
  await runAnomalyCheck(store, tenantId, demoRun, 'user-owner');
  // Q&A exchanges for emp-demo-1 (linked employee user): next shift, leave
  // balance, and a deduction traced to the Nov payslip (NOSI EGP 1,100).
  await answerQa(store, tenantId, 'user-emp1', 'emp-demo-1', 'ما هي ورديتي القادمة؟');
  await answerQa(store, tenantId, 'user-emp1', 'emp-demo-1', 'كم رصيد إجازتي السنوية؟');
  await answerQa(store, tenantId, 'user-emp1', 'emp-demo-1', 'لماذا تم خصم 1100 جنيه من راتبي؟');

  // --- V1 seed: Growth subscription (no ZKTeco add-on — ZKTeco is Pro /
  // Growth add-on, so the demo tenant is gated until upgraded), plan
  // catalogue v1, biometric consent for emp-demo-1, one STUBBED ZKTeco
  // device (Zamalek, LX15) with fixture mappings 101→emp-demo-1,
  // 102→emp-demo-2, a draft statutory rule v2 (employer NOSI still NULL),
  // and a superadmin operations record (MFA enabled on the record).
  store.planCatalogue.push({ id: 'plancat-v1', version: 1, tiers: PLAN_CATALOGUE, zktecoAddonPricePiasters: ZKTECO_ADDON_PRICE_PIASTERS_PER_MONTH, status: 'published', createdByUserId: null, createdAt: new Date().toISOString() });
  store.subscriptions.push({ id: 'sub-demo', tenantId, plan: 'growth', planVersion: 1, status: 'active', trialEndsAt: null, pricePiastersPerMonth: 99900, addons: [], coupon: null, discountPct: 0, dunningStage: null, createdAt: new Date().toISOString() });
  store.consents.push({ id: 'consent-demo-1', tenantId, employeeId: 'emp-demo-1', purpose: 'biometric_mobile', consented: true, status: 'active', consentText: 'أوافق كتابياً على استخدام بصمة/وجه هاتفي لتأكيد الحضور (نعم/لا فقط، دون تخزين بصمة مركزياً). I consent in writing to on-device fingerprint/face confirmation for clock-in (yes/no assertion only, no central template storage).', method: 'in_app_signed', version: CONSENT_TEXT_VERSION, consentedAt: '2026-11-08T09:00:00Z', withdrawnAt: null, createdAt: new Date().toISOString() });
  store.zktecoDevices.push({ id: 'zk-seed-1', tenantId, branchId: 'branch-zamalek', name: 'ZKTeco LX15 — Zamalek entrance', model: 'LX15', serial: 'ZK-DEMO-0001', adapter: 'stub-adms', syncStatus: 'never_synced', lastSyncAt: null, lastError: null, lastClockDriftSeconds: null, createdAt: new Date().toISOString() });
  store.zktecoMappings.push(
    { id: 'zkmap-seed-1', tenantId, deviceId: 'zk-seed-1', deviceUserId: '101', employeeId: 'emp-demo-1', createdByUserId: 'user-owner', createdAt: new Date().toISOString() },
    { id: 'zkmap-seed-2', tenantId, deviceId: 'zk-seed-1', deviceUserId: '102', employeeId: 'emp-demo-2', createdByUserId: 'user-owner', createdAt: new Date().toISOString() },
  );
  store.statutoryRules.push({ id: 'statrule-v2-draft', version: 2, values: { nosiEmployeePct: 11, nosiEmployerPct: null, nosiFloorEgp: 2700, nosiCeilingEgp: 16700, minimumWageEgp: 7000 }, effectiveFrom: '2027-01-01', status: 'draft', reviewerSignoffRef: null, releaseNotesAr: 'مسودة — لم تُراجَع بعد', releaseNotesEn: 'Draft — not yet reviewed', stagingResult: null, publishedAt: null, createdByUserId: null, createdAt: new Date().toISOString() });
  store.superadminUsers.push({ id: 'sa-ops-1', email: 'ops@hr-payroll.example', passwordHash: 'seeded-record-only-no-login', role: 'operations', mfaEnabled: true, createdAt: new Date().toISOString() });

  store.seeded = true;
  return { seeded: true, tenantId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then((r) => { console.log(r.seeded ? 'seeded demo café tenant (M1+M2+M3+M4)' : 'already seeded — nothing changed', r); });
}
