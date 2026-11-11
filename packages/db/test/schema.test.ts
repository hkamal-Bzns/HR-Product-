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

test('M2: store holds branches, templates, rosters, attendance, exceptions, leave', () => {
  const store = new MemoryStore();
  store.addTenant({ id: 'ta', slug: 'a', nameAr: 'أ', nameEn: 'A', status: 'active', plan: 'growth', staffCap: 20 });
  store.branches.push({ id: 'b1', tenantId: 'ta', nameAr: 'ز', nameEn: 'Z', geofenceLat: 30.06, geofenceLng: 31.21, geofenceRadiusM: 100, wifiSsid: null, active: true });
  store.shiftTemplates.push({ id: 't1', tenantId: 'ta', branchId: 'b1', nameAr: 'ص', nameEn: 'M', startTime: '09:00', endTime: '17:00', overnight: false, unpaidBreakMinutes: 30, status: 'active' });
  store.rosters.push({ id: 'r1', tenantId: 'ta', branchId: 'b1', weekStart: '2026-11-09', status: 'published', publishedAt: null, publishedByUserId: null });
  store.rosterAssignments.push({ id: 'a1', tenantId: 'ta', rosterId: 'r1', employeeId: 'e1', date: '2026-11-10', shiftTemplateId: 't1', onLeave: false });
  assert.equal(store.publishedAssignmentCount('ta'), 1);
  assert.equal(store.publishedAssignmentCount('tb'), 0);
  assert.equal(store.getBranch('ta', 'b1').nameEn, 'Z');
  assert.throws(() => store.getBranch('tb', 'b1'), TenantIsolationError);
  store.addException({ id: 'x1', tenantId: 'ta', attendanceRecordId: null, employeeId: 'e1', branchId: 'b1', kind: 'late', status: 'open', reason: 'late', resolvedByUserId: null, resolutionNote: null, resolvedAt: null, createdAt: '2026-11-10' });
  assert.equal(store.listExceptions('ta', 'open').length, 1);
  assert.equal(store.listExceptions('tb', 'open').length, 0);
});
