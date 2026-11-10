import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, TenantIsolationError } from '../src/store.js';

test('tenancy guard: tenant A cannot read tenant B users', () => {
  const store = new MemoryStore();
  store.addTenant({ id: 'ta', slug: 'a', nameAr: 'أ', nameEn: 'A', status: 'active', plan: 'growth', staffCap: 20 });
  store.addTenant({ id: 'tb', slug: 'b', nameAr: 'ب', nameEn: 'B', status: 'active', plan: 'growth', staffCap: 20 });
  store.addUser({ id: 'u1', tenantId: 'ta', email: 'a@a.eg', phone: null, passwordHash: 'x', role: 'owner', branchId: null });
  assert.equal(store.getUser('ta', 'u1').email, 'a@a.eg');
  assert.throws(() => store.getUser('tb', 'u1'), TenantIsolationError);
  assert.deepEqual(store.listUsers('tb'), []);
});

test('settings are stored per tenant and per area', () => {
  const store = new MemoryStore();
  store.saveSettings({ id: 's1', tenantId: 'ta', area: 'attendance', version: 1, effectiveFrom: '2026-11-08', value: { graceMinutes: 10 }, changedByUserId: 'u1', reason: 'initial', createdAt: '2026-11-08' });
  assert.equal(store.latestSettings('ta', 'attendance')?.version, 1);
  assert.equal(store.latestSettings('tb', 'attendance'), undefined);
});
