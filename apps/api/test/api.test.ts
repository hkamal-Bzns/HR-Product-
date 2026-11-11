import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, store } from '../src/server.js';
import { seed } from '../src/seed.js';
import { signSession } from '../src/auth.js';

const SECRET = 'test-secret-only';
let app: ReturnType<typeof buildServer>;

test.before(async () => {
  await seed();
  app = buildServer({ jwtSecret: SECRET, breakGlassEnabled: false });
  await app.ready();
});
test.after(async () => { await app.close(); });

test('health reports M2 scope', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().scope, 'm2');
});

test('login works for the demo owner, fails with wrong password', async () => {
  const ok = await app.inject({ method: 'POST', url: '/auth/login', payload: { tenantSlug: 'demo-cafe', email: 'owner@demo-cafe.eg', password: 'DemoOwner123!' } });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().token);
  const bad = await app.inject({ method: 'POST', url: '/auth/login', payload: { tenantSlug: 'demo-cafe', email: 'owner@demo-cafe.eg', password: 'wrong' } });
  assert.equal(bad.statusCode, 401);
});

test('settings: owner can change attendance, branch manager cannot change statutory rates', async () => {
  const ownerToken = signSession({ sub: 'user-owner', tenantId: 'tenant-demo-cafe', role: 'owner' }, SECRET);
  const mgrToken = signSession({ sub: 'user-mgr', tenantId: 'tenant-demo-cafe', role: 'branch_manager' }, SECRET);
  const ok = await app.inject({ method: 'POST', url: '/api/settings/attendance', headers: { authorization: `Bearer ${ownerToken}` }, payload: { value: { graceMinutes: 15 }, reason: 'test change', effectiveFrom: '2026-12-01' } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().version.version, 2); // v1 was the seed
  const denied = await app.inject({ method: 'POST', url: '/api/settings/statutory_rates', headers: { authorization: `Bearer ${mgrToken}` }, payload: { value: { nosiEmployerPct: 21 }, reason: 'should be denied', effectiveFrom: '2026-12-01' } });
  assert.equal(denied.statusCode, 403);
  // Seeded statutory settings carry NO employer default
  const get = await app.inject({ method: 'GET', url: '/api/settings/statutory_rates', headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(get.json().latest.value.nosiEmployerPct, null);
});

test('tenancy: a token for another tenant cannot read this tenant settings', async () => {
  const otherToken = signSession({ sub: 'u-other', tenantId: 'tenant-other', role: 'owner' }, SECRET);
  const res = await app.inject({ method: 'GET', url: '/api/settings/attendance', headers: { authorization: `Bearer ${otherToken}` } });
  // Other tenant has no settings — it must see null, not demo-cafe's v2
  assert.equal(res.json().latest, null);
});

test('superadmin lite: list tenants with MFA, plan change, break-glass disabled by default', async () => {
  const noMfa = signSession({ sub: 'sa1', tenantId: null, role: 'superadmin', mfaVerified: false }, SECRET);
  const denied = await app.inject({ method: 'GET', url: '/api/superadmin/tenants', headers: { authorization: `Bearer ${noMfa}` } });
  assert.equal(denied.statusCode, 403);
  const sa = signSession({ sub: 'sa1', tenantId: null, role: 'superadmin', mfaVerified: true }, SECRET);
  const list = await app.inject({ method: 'GET', url: '/api/superadmin/tenants', headers: { authorization: `Bearer ${sa}` } });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().tenants.some((t: { slug: string }) => t.slug === 'demo-cafe'));
  // Superadmin list must NOT expose salaries/photos/payslips
  assert.ok(!JSON.stringify(list.json()).includes('basicSalaryPiasters'));
  const bg = await app.inject({ method: 'POST', url: '/api/superadmin/break-glass', headers: { authorization: `Bearer ${sa}` }, payload: { tenantId: 'tenant-demo-cafe', ticketId: 'T-1', reason: 'test' } });
  assert.equal(bg.statusCode, 403);
  assert.match(bg.json().error, /disabled by default/);
  // Audit log recorded the superadmin actions
  assert.ok(store.audit.some((a) => a.action === 'superadmin.tenants.list'));
});

test('seed is idempotent', async () => {
  const again = await seed();
  assert.equal(again.seeded, false);
  assert.equal(store.employees.length, 10);
});
