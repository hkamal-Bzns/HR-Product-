import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhone, isValidEgyptianPhone, egpToPiasters, piastersToEgp,
  canChange, canView, STATUTORY_RATES_UNRESOLVED, validateStatutoryRates,
  nextSettingsVersion,
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
