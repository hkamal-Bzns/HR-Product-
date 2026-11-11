import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhone, isValidEgyptianPhone, egpToPiasters, piastersToEgp,
  canChange, canView, STATUTORY_RATES_UNRESOLVED, validateStatutoryRates,
  nextSettingsVersion, haversineMetres, isWithinGeofence, makeQrToken,
  qrWindowIndex, isQrTokenWindowValid, roundMinutes, classifyArrival,
  classifyDeparture, restBetweenShiftsOk, weeklyHoursOk, overtimeMinutes,
  impossibleTravel, accruedDays, leaveBalance, canRequestLeave,
  EGYPT_PUBLIC_HOLIDAYS_2026, isPublicHoliday, detectDangerousChange,
} from '../src/index.js';

test('phone normalisation to +20', () => {
  assert.equal(normalizePhone('01012345678'), '+201012345678');
  assert.equal(normalizePhone('+201012345678'), '+201012345678');
  assert.equal(normalizePhone('201012345678'), '+201012345678');
  assert.equal(isValidEgyptianPhone('01012345678'), true);
  assert.equal(isValidEgyptianPhone('0123456789'), false);
  assert.throws(() => normalizePhone('abc'));
});

test('money is integer piasters, never float EGP', () => {
  assert.equal(egpToPiasters(65.8), 6580);
  assert.equal(piastersToEgp(6580), 65.8);
  assert.throws(() => piastersToEgp(65.8));
});

test('permission matrix: branch managers never touch statutory rates', () => {
  assert.equal(canChange('branch_manager', 'statutory_rates'), false);
  assert.equal(canView('branch_manager', 'statutory_rates'), false);
  assert.equal(canChange('accountant', 'statutory_rates'), true);
  assert.equal(canChange('owner', 'statutory_rates'), true);
  assert.equal(canChange('employee', 'leave'), true);
  assert.equal(canChange('employee', 'payroll_structure'), false);
});

test('NOSI employer rate ships UNRESOLVED — no default', () => {
  assert.equal(STATUTORY_RATES_UNRESOLVED.nosiEmployerPct, null);
  assert.equal(STATUTORY_RATES_UNRESOLVED.nosiEmployeePct, 11);
  const errors = validateStatutoryRates(STATUTORY_RATES_UNRESOLVED);
  assert.ok(errors.some((e) => e.includes('UNRESOLVED')));
});

test('settings versioning: reason required, no back-dating into a locked period', () => {
  const v1 = nextSettingsVersion(null, 't1', 'attendance', { graceMinutes: 10 }, 'u1', 'initial', '2026-11-08');
  assert.equal(v1.version, 1);
  const v2 = nextSettingsVersion(v1, 't1', 'attendance', { graceMinutes: 15 }, 'u1', 'owner request', '2026-12-01');
  assert.equal(v2.version, 2);
  assert.throws(() => nextSettingsVersion(v1, 't1', 'attendance', {}, 'u1', '', '2026-12-01'));
  assert.throws(() => nextSettingsVersion(v1, 't1', 'attendance', {}, 'u1', 'x', '2026-10-01', '2026-11-01'));
});

test('M2: geofence haversine — Zamalek to Maadi is ~11km, same point is 0', () => {
  const d = haversineMetres(30.0626, 31.2197, 29.9601, 31.2506);
  assert.ok(d > 10000 && d < 13000, `expected ~11km, got ${d}`);
  assert.equal(haversineMetres(30.0626, 31.2197, 30.0626, 31.2197), 0);
  assert.equal(isWithinGeofence(30.0626, 31.2197, 30.0626, 31.2197, 100), true);
  assert.equal(isWithinGeofence(30.1, 31.3, 30.0626, 31.2197, 100), false);
});

test('M2: QR token window — valid now, expired later, single-use per window', () => {
  const now = Date.now();
  const token = makeQrToken('branch-zamalek', new Date(now), 60, 'abc123');
  assert.equal(isQrTokenWindowValid(token, now, 60, new Set()).valid, true);
  assert.equal(isQrTokenWindowValid(token, now + 180_000, 60, new Set()).valid, false);
  const used = new Set(['branch-zamalek:' + qrWindowIndex(now, 60) + ':abc123']);
  assert.equal(isQrTokenWindowValid(token, now, 60, used).valid, false);
  assert.equal(isQrTokenWindowValid('garbage', now, 60, new Set()).valid, false);
});

test('M2: rounding and late/early classification', () => {
  assert.equal(roundMinutes(53, '15'), 60);
  assert.equal(roundMinutes(53, '15', 'down'), 45);
  assert.equal(roundMinutes(53, 'none'), 53);
  assert.equal(classifyArrival(540, 565, 10, 10).status, 'late'); // 09:00 vs 09:25
  assert.equal(classifyArrival(540, 548, 10, 10).status, 'on_time');
  assert.equal(classifyDeparture(1020, 960, 10).status, 'early_leave');
});

test('M2: rest, weekly cap, overtime and velocity guards', () => {
  assert.equal(restBetweenShiftsOk(0, 8 * 3600000, 11).ok, false);
  assert.equal(restBetweenShiftsOk(0, 12 * 3600000, 11).ok, true);
  assert.equal(weeklyHoursOk(49 * 60, 48).ok, false);
  assert.deepEqual(overtimeMinutes(600, 450, 120), { overtimeMin: 150, overCapMin: 30 });
  assert.equal(impossibleTravel(100000, 600).impossible, true); // 100km in 10 min
  assert.equal(impossibleTravel(5000, 1800).impossible, false);
});

test('M2: leave accrual, balance and request rules', () => {
  assert.equal(accruedDays(21, 6), 10.5);
  assert.equal(leaveBalance(21, 0, 2), 19);
  assert.equal(canRequestLeave(19, 2, false, 0, 20, 7).ok, true);
  assert.equal(canRequestLeave(1, 2, false, 0, 20, 7).ok, false);
  assert.equal(canRequestLeave(1, 2, true, 0, 20, 7).ok, true); // unpaid allows negative
  assert.equal(canRequestLeave(19, 2, false, 0, 3, 7).ok, false); // notice too short
});

test('M2: Egypt 2026 public holidays are pre-loaded', () => {
  assert.equal(EGYPT_PUBLIC_HOLIDAYS_2026.length, 18);
  assert.equal(isPublicHoliday('2026-01-07')?.nameEn, 'Coptic Christmas');
  assert.equal(isPublicHoliday('2026-01-07')?.provisional, false);
  assert.equal(isPublicHoliday('2026-03-20')?.provisional, true); // lunar, provisional
  assert.equal(isPublicHoliday('2026-11-11'), undefined);
});

test('M2: dangerous-change detection (guardrail 4)', () => {
  assert.deepEqual(detectDangerousChange('attendance', { geofenceRadiusM: 100 }, { geofenceRadiusM: 500 }), ['widening geofence from 100m to 500m (beyond 300m limit)']);
  assert.deepEqual(detectDangerousChange('attendance', { geofenceRadiusM: 100 }, { geofenceRadiusM: 150 }), []);
  assert.ok(detectDangerousChange('attendance', { kioskPhotoRequired: true }, { kioskPhotoRequired: false }).length > 0);
  assert.ok(detectDangerousChange('shifts', { overtimeCapMinutesPerDay: 120 }, { overtimeCapMinutesPerDay: 180 }).length > 0);
});
