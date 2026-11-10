// Demo seed — first seed only, idempotent. One Egyptian café tenant,
// 2 branches, 3 staff users, 10 demo employees. Demo figures only.
import { store } from './server.js';
import { hashPassword } from './auth.js';

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
  // 10 demo employees (names are demo data, salaries in piasters, demo only)
  const names = ['أحمد محمد', 'سارة علي', 'محمد حسن', 'فاطمة أحمد', 'عمر خالد', 'نورا سامي', 'كريم يوسف', 'منى طارق', 'حسن إبراهيم', 'ليلى عمر'];
  names.forEach((n, i) => {
    store.employees.push({ id: `emp-demo-${i + 1}`, tenantId, branchId: i % 2 === 0 ? 'branch-zamalek' : 'branch-maadi', fullNameAr: n, phone: `+2010${String(1000000 + i)}`, jobTitle: i < 3 ? 'Barista' : 'Waiter', basicSalaryPiasters: 700000 });
  });
  // Demo settings v1 — attendance + company, with NOSI employer left UNRESOLVED (no value set)
  store.saveSettings({ id: 'seed-s1', tenantId, area: 'attendance', version: 1, effectiveFrom: '2026-11-08', value: { modes: ['qr_geofence', 'passcode_photo'], graceMinutes: 10, qrRotationSeconds: 60 }, changedByUserId: 'user-owner', reason: 'demo seed', createdAt: new Date().toISOString() });
  store.saveSettings({ id: 'seed-s2', tenantId, area: 'company_branches', version: 1, effectiveFrom: '2026-11-08', value: { branches: [{ nameEn: 'Zamalek', geofenceRadiusM: 100 }, { nameEn: 'Maadi', geofenceRadiusM: 150 }], timezone: 'Africa/Cairo' }, changedByUserId: 'user-owner', reason: 'demo seed', createdAt: new Date().toISOString() });
  store.saveSettings({ id: 'seed-s3', tenantId, area: 'statutory_rates', version: 1, effectiveFrom: '2026-11-08', value: { nosiEmployeePct: 11, nosiEmployerPct: null, nosiFloorEgp: 2700, nosiCeilingEgp: 16700, status: 'UNRESOLVED — needs reviewer confirmation at M0' }, changedByUserId: 'user-owner', reason: 'demo seed — no employer default shipped', createdAt: new Date().toISOString() });
  store.seeded = true;
  return { seeded: true, tenantId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then((r) => { console.log(r.seeded ? 'seeded demo café tenant' : 'already seeded — nothing changed', r); });
}
