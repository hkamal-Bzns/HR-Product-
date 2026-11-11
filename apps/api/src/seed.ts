// Demo seed — M1 + M2, idempotent. One Egyptian café tenant, 2 branches,
// 3 staff users, 10 demo employees, shift templates, a published 2-week
// roster, sample attendance records + exceptions, leave balances.
// Demo figures only; no real people, no real salaries (piasters).
import { store } from './server.js';
import { hashPassword } from './auth.js';
import { clockIn, clockOut, sweepMissedClockOuts } from './attendance.js';
import { approveLeave } from './leave.js';
import { DEFAULT_ATTENDANCE_SETTINGS, DEFAULT_SHIFT_SETTINGS, DEFAULT_LEAVE_SETTINGS } from '@hr-payroll/shared';
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

  store.seeded = true;
  return { seeded: true, tenantId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then((r) => { console.log(r.seeded ? 'seeded demo café tenant (M1+M2)' : 'already seeded — nothing changed', r); });
}
