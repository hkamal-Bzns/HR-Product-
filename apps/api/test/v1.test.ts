// V1 tests (Brief §5 Mode C1/C2, §9 Zad stub, §11 full Superadmin, §12 PDPL,
// §14 Pro tier). M1–M4 behaviour is covered by the earlier suites; this file
// only asserts V1 additions — and that the M0 NOSI guard still holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildServer, store } from '../src/server.js';
import { seed } from '../src/seed.js';
import { signSession } from '../src/auth.js';
import { findForbiddenBiometricFields } from '@hr-payroll/shared';

const SECRET = 'test-secret-only';
let app: ReturnType<typeof buildServer>;
const owner = () => signSession({ sub: 'user-owner', tenantId: 'tenant-demo-cafe', role: 'owner' }, SECRET);
const mgr = () => signSession({ sub: 'user-mgr', tenantId: 'tenant-demo-cafe', role: 'branch_manager' }, SECRET);
const emp1 = () => signSession({ sub: 'user-emp1', tenantId: 'tenant-demo-cafe', role: 'employee' }, SECRET);
const saOps = () => signSession({ sub: 'sa-ops', tenantId: null, role: 'superadmin', superadminRole: 'operations', mfaVerified: true }, SECRET);
const saFin = () => signSession({ sub: 'sa-fin', tenantId: null, role: 'superadmin', superadminRole: 'finance', mfaVerified: true }, SECRET);
const saAud = () => signSession({ sub: 'sa-aud', tenantId: null, role: 'superadmin', superadminRole: 'auditor', mfaVerified: true }, SECRET);
const saSup = () => signSession({ sub: 'sa-sup', tenantId: null, role: 'superadmin', superadminRole: 'support', mfaVerified: true }, SECRET);
const saNoMfa = () => signSession({ sub: 'sa-x', tenantId: null, role: 'superadmin', superadminRole: 'operations', mfaVerified: false }, SECRET);
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const j = async (method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: H(token), payload: payload as never });
  let body: Record<string, any> = {};
  try { body = r.json() as Record<string, any>; } catch { body = {}; }
  return { status: r.statusCode, body };
};

let deviceId = '';
let bioDeviceId = '';
let ruleId = '';
let invoiceId = '';

test.before(async () => {
  await seed();
  app = buildServer({ jwtSecret: SECRET, breakGlassEnabled: false });
  await app.ready();
});
test.after(async () => { await app.close(); });

test('V1 plans: Growth demo tenant is gated out of ZKTeco sync, in for mobile biometrics', async () => {
  const plans = await j('GET', '/api/plans', owner());
  assert.equal(plans.status, 200);
  assert.equal(plans.body.current.plan, 'growth');
  assert.equal(plans.body.zktecoAddonPricePiastersPerMonth, 24900);
  const zk = await j('GET', '/api/plan-check?feature=zkteco_sync', owner());
  assert.equal(zk.body.allowed, false);
  assert.equal(zk.body.code, 'PLAN_FEATURE_GATED');
  assert.match(zk.body.upgradeHint, /Pro/);
  const bio = await j('GET', '/api/plan-check?feature=mobile_biometrics', owner());
  assert.equal(bio.body.allowed, true);
  // M0 guard still holds: NOSI employer rate is NULL in the seeded settings.
  const stat = await j('GET', '/api/settings/statutory_rates', owner());
  assert.equal(stat.body.latest.value.nosiEmployerPct, null);
});

test('V1 branches: Growth branch cap enforced (2 existing, 3rd ok, 4th refused)', async () => {
  const third = await j('POST', '/api/branches', owner(), { nameAr: 'التجمع', nameEn: 'New Cairo', geofenceLat: 30.05, geofenceLng: 31.45 });
  assert.equal(third.status, 201, JSON.stringify(third.body));
  const fourth = await j('POST', '/api/branches', owner(), { nameAr: 'الجيزة', nameEn: 'Giza', geofenceLat: 30.01, geofenceLng: 31.2 });
  assert.equal(fourth.status, 403);
  assert.equal(fourth.body.code, 'PLAN_FEATURE_GATED');
  const cap = await j('GET', '/api/branches/branch-zamalek/staff-cap', owner());
  assert.equal(cap.body.staffCap, 20);
  assert.equal(cap.body.staffCount, 10);
  assert.equal(cap.body.exceeded, false);
});

test('V1 cross-branch labour-cost report is Pro-gated for Growth', async () => {
  const r = await j('GET', '/api/reports/labour-cost-by-branch?period=2026-11', owner());
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PLAN_FEATURE_GATED');
});

test('V1 ZKTeco: register is Pro-gated on Growth; mapping conflicts surface, never overwrite', async () => {
  const gated = await j('POST', '/api/zkteco/devices', owner(), { branchId: 'branch-zamalek', name: 'LX15 test', model: 'LX15', serial: 'ZK-TEST-1' });
  assert.equal(gated.status, 403);
  assert.equal(gated.body.code, 'PLAN_FEATURE_GATED');
  // Seeded stub device exists with fixture mappings 101→emp-demo-1, 102→emp-demo-2.
  const list = await j('GET', '/api/zkteco/devices', owner());
  assert.equal(list.status, 200);
  assert.equal(list.body.adapter, 'stub-adms');
  assert.equal(list.body.live, false);
  const seeded = list.body.devices.find((d: { id: string }) => d.id === 'zk-seed-1');
  assert.ok(seeded);
  assert.equal(seeded.health, 'never_synced');
  const health = await j('GET', '/api/zkteco/devices/zk-seed-1/health', owner());
  assert.equal(health.body.health, 'never_synced');
  assert.equal(health.body.adapter, 'stub-adms');
});

test('V1 Superadmin: least privilege — auditor reads, cannot write billing; finance can', async () => {
  assert.equal((await j('GET', '/api/superadmin/plans', saAud())).status, 200);
  const denied = await j('POST', '/api/superadmin/plans', saAud(), { tiers: [] });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /lacks capability/);
  const noMfa = await j('GET', '/api/superadmin/plans', saNoMfa());
  assert.equal(noMfa.status, 403);
  const ok = await j('POST', '/api/superadmin/plans', saFin(), { tiers: [{ plan: 'growth', pricePiastersPerMonth: 99900 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.catalogue.version, 2);
  const users = await j('GET', '/api/superadmin/users', saOps());
  assert.equal(users.status, 200);
  assert.ok(users.body.users.some((u: { email: string }) => u.email === 'ops@hr-payroll.example'));
});

test('V1 Superadmin: Pro subscription assignment ungates ZKTeco + cross-branch reports', async () => {
  const sub = await j('POST', '/api/superadmin/tenants/tenant-demo-cafe/subscription', saFin(), { plan: 'pro', addons: [] });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.subscription.pricePiastersPerMonth, 199900);
  const zk = await j('GET', '/api/plan-check?feature=zkteco_sync', owner());
  assert.equal(zk.body.allowed, true);
  const report = await j('GET', '/api/reports/labour-cost-by-branch?period=2026-11', owner());
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.ok(report.body.perBranch.length >= 2);
  assert.ok(report.body.perBranch.every((b: { branchName: string }) => typeof b.branchName === 'string'));
  const created = await j('POST', '/api/zkteco/devices', owner(), { branchId: 'branch-zamalek', name: 'K20 test', model: 'K20', serial: 'ZK-TEST-2' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.device.adapter, 'stub-adms');
  deviceId = created.body.device.id;
  const dup = await j('POST', '/api/zkteco/devices', owner(), { branchId: 'branch-zamalek', name: 'dup', model: 'K20', serial: 'ZK-TEST-2' });
  assert.equal(dup.status, 409);
  const badModel = await j('POST', '/api/zkteco/devices', owner(), { branchId: 'branch-zamalek', name: 'x', model: 'Unknown 9', serial: 'ZK-TEST-9' });
  assert.equal(badModel.status, 400);
});

test('V1 ZKTeco: mapping, fixture simulate (dedup), ADMS push, sync health', async () => {
  const m1 = await j('POST', `/api/zkteco/devices/${deviceId}/mapping`, owner(), { deviceUserId: '201', employeeId: 'emp-demo-3' });
  assert.equal(m1.status, 201, JSON.stringify(m1.body));
  const conflict = await j('POST', `/api/zkteco/devices/${deviceId}/mapping`, owner(), { deviceUserId: '201', employeeId: 'emp-demo-4' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'MAPPING_CONFLICT');
  const conflict2 = await j('POST', `/api/zkteco/devices/${deviceId}/mapping`, owner(), { deviceUserId: '202', employeeId: 'emp-demo-3' });
  assert.equal(conflict2.status, 409);
  // Fixture punches are for device users 101/102 — unmapped on THIS device.
  const sim = await j('POST', `/api/zkteco/devices/${deviceId}/simulate`, owner(), { date: '2026-11-11' });
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  assert.equal(sim.body.simulated, true);
  assert.equal(sim.body.live, false);
  assert.equal(sim.body.accepted, 0);
  assert.equal(sim.body.unmapped, 4);
  const sim2 = await j('POST', `/api/zkteco/devices/${deviceId}/simulate`, owner(), { date: '2026-11-11' });
  assert.equal(sim2.body.duplicates, 4);
  assert.equal(sim2.body.accepted, 0);
  // Seeded device: fixture users ARE mapped → punches become attendance.
  const seededSim = await j('POST', '/api/zkteco/devices/zk-seed-1/simulate', owner(), { date: '2026-11-11' });
  assert.equal(seededSim.body.accepted, 4);
  assert.equal(seededSim.body.duplicates, 0);
  const health = await j('GET', '/api/zkteco/devices/zk-seed-1/health', owner());
  assert.equal(health.body.health, 'ok');
  assert.ok(store.listAttendance('tenant-demo-cafe').some((a) => a.method === 'zkteco_device'));
  // ADMS push receiver: fresh punch for mapped user 201 (clock-in now).
  const now = new Date().toISOString();
  const push = await j('POST', '/api/zkteco/adms/push', owner(), { deviceId, punches: [{ deviceUserId: '201', deviceAt: now, direction: 'in' }] });
  assert.equal(push.status, 200, JSON.stringify(push.body));
  assert.equal(push.body.accepted, 1);
  const pushDup = await j('POST', '/api/zkteco/adms/push', owner(), { deviceId, punches: [{ deviceUserId: '201', deviceAt: now, direction: 'in' }] });
  assert.equal(pushDup.body.duplicates, 1);
  const all = await j('GET', '/api/zkteco/sync-health', owner());
  assert.ok(all.body.devices.some((d: { health: string }) => d.health === 'ok'));
});

test('V1 biometrics: consent gates enrolment; assertion-only clock-in; no template anywhere', async () => {
  // emp-demo-2 has no biometric consent → enrolment refused.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const noConsent = await j('POST', '/api/biometrics/devices', owner(), { employeeId: 'emp-demo-2', deviceName: 'Sara phone', platform: 'android', publicKeyPem: pubPem });
  assert.equal(noConsent.status, 403);
  assert.equal(noConsent.body.code, 'CONSENT_REQUIRED');
  // Template-looking payloads are rejected outright.
  const tpl = await j('POST', '/api/biometrics/devices', owner(), { employeeId: 'emp-demo-1', deviceName: 'x', platform: 'android', publicKeyPem: pubPem, fingerprintTemplate: 'deadbeef' });
  assert.equal(tpl.status, 400);
  // emp-demo-1 has seeded in-app consent → enrolment succeeds, public key only.
  const enrolled = await j('POST', '/api/biometrics/devices', owner(), { employeeId: 'emp-demo-1', deviceName: 'Ahmed Pixel', platform: 'android', publicKeyPem: pubPem });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  bioDeviceId = enrolled.body.device.id;
  assert.equal(findForbiddenBiometricFields(store.biometricDevices).length, 0);
  assert.equal(findForbiddenBiometricFields(store.consents).length, 0);
  // Valid assertion → clock-in.
  const deviceAt = new Date().toISOString();
  const nonce = `n-${Date.now()}`;
  const payload = `tenant-demo-cafe|emp-demo-1|${bioDeviceId}|${deviceAt}|${nonce}`;
  const sig = sign(null, Buffer.from(payload), privateKey).toString('base64');
  const ok = await j('POST', '/api/biometrics/clock-in', emp1(), { employeeId: 'emp-demo-1', deviceId: bioDeviceId, deviceAt, nonce, signature: sig });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.action, 'clock_in');
  assert.equal(ok.body.assertion, 'verified');
  assert.equal(ok.body.record.method, 'biometric_mobile');
  // Replay the same nonce → rejected.
  const replay = await j('POST', '/api/biometrics/clock-in', emp1(), { employeeId: 'emp-demo-1', deviceId: bioDeviceId, deviceAt, nonce, signature: sig });
  assert.equal(replay.status, 409);
  // Bad signature → 401 (fresh nonce so the replay guard does not mask it).
  const nonce2 = `n2-${Date.now()}`;
  const payload2 = `tenant-demo-cafe|emp-demo-1|${bioDeviceId}|${deviceAt}|${nonce2}`;
  const badSig = sign(null, Buffer.from(`${payload2}-tampered`), privateKey).toString('base64');
  const bad = await j('POST', '/api/biometrics/clock-in', emp1(), { employeeId: 'emp-demo-1', deviceId: bioDeviceId, deviceAt, nonce: nonce2, signature: badSig });
  assert.equal(bad.status, 401);
  // Withdraw consent → device revoked, further clock-ins blocked.
  const consentId = store.consents.find((c) => c.employeeId === 'emp-demo-1' && c.purpose === 'biometric_mobile')!.id;
  const wd = await j('POST', `/api/consent/${consentId}/withdraw`, owner(), {});
  assert.equal(wd.status, 200);
  assert.equal(wd.body.consent.status, 'withdrawn');
  const nonce3 = `n3-${Date.now()}`;
  const deviceAt3 = new Date().toISOString();
  const payload3 = `tenant-demo-cafe|emp-demo-1|${bioDeviceId}|${deviceAt3}|${nonce3}`;
  const sig3 = sign(null, Buffer.from(payload3), privateKey).toString('base64');
  const blocked = await j('POST', '/api/biometrics/clock-in', emp1(), { employeeId: 'emp-demo-1', deviceId: bioDeviceId, deviceAt: deviceAt3, nonce: nonce3, signature: sig3 });
  assert.equal(blocked.status, 403);
  assert.ok(blocked.body.code === 'DEVICE_REVOKED' || blocked.body.code === 'CONSENT_REQUIRED');
  // Re-enrolment after withdrawal is also refused.
  const reEnrol = await j('POST', '/api/biometrics/devices', owner(), { employeeId: 'emp-demo-1', deviceName: 'again', platform: 'android', publicKeyPem: pubPem });
  assert.equal(reEnrol.status, 403);
});

test('V1 consent: grant + per-employee view; photo purge honours the 90-day retention', async () => {
  const grant = await j('POST', '/api/consent', owner(), { employeeId: 'emp-demo-2', purpose: 'kiosk_photo', consentText: 'أوافق على التقاط صورة عند الحضور والاحتفاظ بها 90 يوماً.', method: 'written_signed' });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  assert.equal(grant.body.consent.version, 'v1-2026-11');
  const view = await j('GET', '/api/consent/emp-demo-2', owner());
  assert.ok(view.body.purposes.find((p: { purpose: string; active: boolean }) => p.purpose === 'kiosk_photo').active);
  // Expired photo (retainUntil in the past) is purged; fresh ones are kept.
  store.attendance.push({ id: 'att-purge-test', tenantId: 'tenant-demo-cafe', employeeId: 'emp-demo-2', branchId: 'branch-zamalek', rosterAssignmentId: null, method: 'passcode_photo', clockInAt: '2026-08-01T07:00:00Z', clockOutAt: '2026-08-01T15:00:00Z', deviceAt: null, lat: null, lng: null, distanceFromBranchM: null, wifiMatched: null, mockLocationFlag: false, photoRef: 'old-photo', photoRetainUntil: '2026-08-30', verificationStatus: 'auto_approved', source: 'live' });
  const purge = await j('POST', '/api/consent/purge-photos', owner(), {});
  assert.equal(purge.status, 200);
  assert.equal(purge.body.purged, 1);
  assert.equal(purge.body.retentionDays, 90);
  assert.equal(store.attendance.find((a) => a.id === 'att-purge-test')!.photoRef, null);
});

test('V1 bank files: history, re-export (locked only) and reconciliation', async () => {
  const runId = store.payrollRuns.find((r) => r.period === '2026-11')!.id;
  // Demo run is calculated; lock it in the store (approve is blocked by the
  // M0 NOSI guard by design) so the locked-only bank-file flow can be tested.
  const run = store.getPayrollRun('tenant-demo-cafe', runId);
  run.status = 'locked';
  const gen = await j('POST', `/api/payroll/runs/${runId}/bank-file`, owner(), { bank: 'CIB' });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.equal(gen.body.reconciled, true);
  const hist = await j('GET', `/api/payroll/runs/${runId}/bank-files`, owner());
  assert.equal(hist.body.bankFiles.length, 1);
  assert.equal(hist.body.bankFiles[0].bank, 'CIB');
  const re = await j('POST', `/api/payroll/runs/${runId}/bank-file/CIB/re-export`, owner(), {});
  assert.equal(re.status, 200);
  assert.equal(re.body.reconciled, true);
  assert.match(re.body.note, /not a disbursement/);
  const rec = await j('GET', `/api/payroll/runs/${runId}/bank-file/CIB/reconcile`, owner());
  assert.equal(rec.body.reconciled, true);
  assert.equal(rec.body.fileTotalPiasters, rec.body.runNetTotalPiasters);
  assert.equal(rec.body.payslipSumPiasters, rec.body.runNetTotalPiasters);
  const missing = await j('GET', `/api/payroll/runs/${runId}/bank-file/QNB/reconcile`, owner());
  assert.equal(missing.status, 404);
});

test('V1 DSR: tracked workflow with ordered transitions; delete blocked by locked payroll', async () => {
  const created = await j('POST', '/api/dsr/requests', owner(), { employeeId: 'emp-demo-1', kind: 'access', requestedBy: 'emp-demo-1' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.request.id;
  const skip = await j('POST', `/api/dsr/requests/${id}/transition`, owner(), { to: 'executed' });
  assert.equal(skip.status, 409); // received → executed skips verification + approval
  assert.equal((await j('POST', `/api/dsr/requests/${id}/transition`, owner(), { to: 'verified' })).status, 200);
  assert.equal((await j('POST', `/api/dsr/requests/${id}/transition`, owner(), { to: 'owner_approved' })).status, 200);
  assert.equal((await j('POST', `/api/dsr/requests/${id}/transition`, owner(), { to: 'executed' })).status, 200);
  assert.equal((await j('POST', `/api/dsr/requests/${id}/transition`, owner(), { to: 'confirmed' })).status, 200);
  // Delete for emp-demo-1 is blocked: the Nov run is locked and holds payslips.
  const del = await j('POST', '/api/dsr/requests', owner(), { employeeId: 'emp-demo-1', kind: 'delete', requestedBy: 'emp-demo-1' });
  const delId = del.body.request.id;
  await j('POST', `/api/dsr/requests/${delId}/transition`, owner(), { to: 'verified' });
  await j('POST', `/api/dsr/requests/${delId}/transition`, owner(), { to: 'owner_approved' });
  const blocked = await j('POST', `/api/dsr/requests/${delId}/transition`, owner(), { to: 'executed' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'DELETE_BLOCKED_LOCKED_PAYROLL');
});

test('V1 Zad: stub identity + labour-cost demo figures; live connect blocked', async () => {
  const status = await j('GET', '/api/zad/status', owner());
  assert.equal(status.body.connection, 'not_connected');
  assert.equal(status.body.live, false);
  assert.equal(status.body.identity.tenantSlug, 'demo-cafe');
  const connect = await j('POST', '/api/zad/connect', owner(), {});
  assert.equal(connect.status, 409);
  assert.equal(connect.body.code, 'ZAD_STAGING_TENANT_REQUIRED');
  const lc = await j('GET', '/api/zad/labour-cost-vs-sales?period=2026-11', owner());
  assert.equal(lc.status, 200);
  assert.equal(lc.body.provider, 'zad_stub');
  assert.equal(lc.body.live, false);
  assert.match(lc.body.note, /STUBBED/);
  assert.equal(typeof lc.body.labourCostPctOfSales, 'number');
});

test('V1 Superadmin billing: invoices, manual-only refunds, ordered dunning, revenue', async () => {
  const inv = await j('POST', '/api/superadmin/invoices', saFin(), { tenantId: 'tenant-demo-cafe', period: '2026-11', amountPiasters: 199900 });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  invoiceId = inv.body.invoice.id;
  const refundByOps = await j('POST', `/api/superadmin/invoices/${invoiceId}/refund`, saOps(), { refundPiasters: 199900, providerRef: 'psp-ref-1' });
  assert.equal(refundByOps.status, 403); // refunds are Finance-only
  const overRefund = await j('POST', `/api/superadmin/invoices/${invoiceId}/refund`, saFin(), { refundPiasters: 999999, providerRef: 'psp-ref-1' });
  assert.equal(overRefund.status, 400);
  const refund = await j('POST', `/api/superadmin/invoices/${invoiceId}/refund`, saFin(), { refundPiasters: 199900, providerRef: 'psp-ref-1', note: 'duplicate charge' });
  assert.equal(refund.status, 200);
  assert.equal(refund.body.invoice.status, 'refunded');
  assert.match(refund.body.note, /never moves tenant payroll money/);
  // Dunning must advance in order.
  const skip = await j('POST', '/api/superadmin/dunning/tenant-demo-cafe/step', saFin(), { stage: 'grace' });
  assert.equal(skip.status, 409);
  assert.equal(skip.body.code, 'DUNNING_ORDER');
  assert.equal((await j('POST', '/api/superadmin/dunning/tenant-demo-cafe/step', saFin(), { stage: 'reminder_1' })).status, 200);
  assert.equal((await j('POST', '/api/superadmin/dunning/tenant-demo-cafe/step', saFin(), { stage: 'reminder_2' })).status, 200);
  const dunning = await j('GET', '/api/superadmin/dunning/tenant-demo-cafe', saFin());
  assert.equal(dunning.body.dunningStage, 'reminder_2');
  assert.equal(dunning.body.nextStage, 'grace');
  // Revenue: latest subscription per tenant is the Pro one (EGP 1,999).
  const rev = await j('GET', '/api/superadmin/revenue', saFin());
  assert.equal(rev.status, 200);
  assert.equal(rev.body.mrrPiasters, 199900);
  assert.equal(rev.body.arrPiasters, 199900 * 12);
  assert.equal(rev.body.revenueByPlan.pro.mrrPiasters, 199900);
  assert.equal(rev.body.refundedPiasters, 199900);
});

test('V1 Superadmin statutory rules: no invented NOSI rate; draft→review→stage (golden cases)→publish→rollback', async () => {
  const invented = await j('POST', '/api/superadmin/statutory-rules', saOps(), { values: { nosiEmployeePct: 11, nosiEmployerPct: 18.75, nosiFloorEgp: 2700, nosiCeilingEgp: 16700 }, effectiveFrom: '2027-01-01' });
  assert.equal(invented.status, 400);
  assert.equal(invented.body.code, 'NOSI_EMPLOYER_UNRESOLVED');
  const created = await j('POST', '/api/superadmin/statutory-rules', saOps(), { values: { nosiEmployeePct: 11, nosiEmployerPct: null, nosiFloorEgp: 2700, nosiCeilingEgp: 16700, minimumWageEgp: 7000 }, effectiveFrom: '2027-01-01', reviewerSignoffRef: 'M0-pending', releaseNotesAr: 'تحديث يناير 2027', releaseNotesEn: 'January 2027 update' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ruleId = created.body.rule.id;
  assert.equal(created.body.rule.version, 3);
  const skip = await j('POST', `/api/superadmin/statutory-rules/${ruleId}/transition`, saOps(), { to: 'published' });
  assert.equal(skip.status, 409);
  assert.equal((await j('POST', `/api/superadmin/statutory-rules/${ruleId}/transition`, saOps(), { to: 'reviewed' })).status, 200);
  const staged = await j('POST', `/api/superadmin/statutory-rules/${ruleId}/transition`, saOps(), { to: 'staged' });
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  assert.equal(staged.body.rule.stagingResult.passed, true);
  assert.equal(staged.body.rule.stagingResult.goldenNetPiasters, 830748); // Appendix A net EGP 8,307.48
  const published = await j('POST', `/api/superadmin/statutory-rules/${ruleId}/transition`, saOps(), { to: 'published' });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  // Tenants are notified with a diff, never silently.
  const avail = await j('GET', '/api/settings/statutory/available', owner());
  assert.equal(avail.status, 200);
  assert.ok(avail.body.available.some((r: { version: number }) => r.version === 3));
  const notifs = await j('GET', '/api/notifications', owner());
  assert.ok(notifs.body.notifications.some((n: { kind: string }) => n.kind === 'statutory_version_available'));
  // Rollback: withdraw the published version; affected runs are listed.
  const rolled = await j('POST', `/api/superadmin/statutory-rules/${ruleId}/transition`, saOps(), { to: 'withdrawn' });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.body.rule.status, 'withdrawn');
  assert.ok(Array.isArray(rolled.body.affectedRuns));
});

test('V1 Superadmin: AI cost wiring (M4 ledger), kill switches, health, analytics, audit, break-glass', async () => {
  const ai = await j('GET', '/api/superadmin/ai-cost', saOps());
  assert.equal(ai.status, 200);
  assert.equal(ai.body.provider, 'stub');
  const demo = ai.body.perTenant.find((t: { slug: string }) => t.slug === 'demo-cafe');
  assert.ok(demo);
  assert.ok(demo.totalPiasters > 0); // seeded M4 agent runs
  assert.ok(demo.agents.some((a: { agentId: string }) => a.agentId === 'schedule')); // Agent 2 wired in
  assert.ok(demo.agents.some((a: { agentId: string }) => a.agentId === 'qa')); // Agent 4 wired in
  const ksBySupport = await j('POST', '/api/superadmin/ai-cost/kill-switch', saSup(), { agentId: 'qa', scope: 'global', killed: true });
  assert.equal(ksBySupport.status, 403); // support lacks ai_cost.kill_switch
  const ks = await j('POST', '/api/superadmin/ai-cost/kill-switch', saOps(), { agentId: 'qa', scope: 'global', killed: true });
  assert.equal(ks.status, 200);
  const ksOff = await j('POST', '/api/superadmin/ai-cost/kill-switch', saOps(), { agentId: 'qa', scope: 'global', killed: false });
  assert.equal(ksOff.status, 200);
  const health = await j('GET', '/api/superadmin/health', saOps());
  assert.equal(health.status, 200);
  const demoHealth = health.body.tenants.find((t: { slug: string }) => t.slug === 'demo-cafe');
  assert.ok(demoHealth);
  assert.equal(demoHealth.whatsapp.provider, 'stub');
  assert.equal(demoHealth.whatsapp.deliveryRate, null);
  const support = await j('GET', '/api/superadmin/tenants/tenant-demo-cafe/support', saSup());
  assert.equal(support.status, 200);
  assert.ok(!JSON.stringify(support.body).includes('basicSalaryPiasters'));
  assert.ok(support.body.employees[0].nameMasked.includes('.'));
  assert.ok(Array.isArray(support.body.employees[0].consent));
  const detail = await j('GET', '/api/superadmin/tenants/tenant-demo-cafe/detail', saOps());
  assert.equal(detail.status, 200);
  assert.equal(detail.body.tenant.slug, 'demo-cafe');
  const analytics = await j('GET', '/api/superadmin/analytics', saAud());
  assert.equal(analytics.status, 200);
  assert.equal(analytics.body.activationFunnel.firstPayrollRun, 1);
  assert.ok(analytics.body.attendanceVolume > 0);
  assert.ok(analytics.body.featureAdoptionByPlan.pro);
  const auditLog = await j('GET', '/api/superadmin/audit', saAud());
  assert.equal(auditLog.status, 200);
  assert.ok(auditLog.body.entries.length > 0);
  // Break-glass: request then activate (time-boxed, ticket-justified).
  const bg = await j('POST', '/api/superadmin/break-glass/request', saSup(), { tenantId: 'tenant-demo-cafe', ticketId: 'TKT-1001', reason: 'payroll run stuck — investigate', minutes: 30 });
  assert.equal(bg.status, 201, JSON.stringify(bg.body));
  const act = await j('POST', `/api/superadmin/break-glass/${bg.body.session.id}/activate`, saSup(), {});
  assert.equal(act.status, 200);
  assert.ok(store.audit.some((a) => a.action === 'superadmin.break_glass.enter' && a.tenantId === 'tenant-demo-cafe'));
  // Lifecycle transition is logged + tenant notified.
  const lc = await j('POST', '/api/superadmin/tenants/tenant-demo-cafe/lifecycle', saOps(), { to: 'active', reason: 'back to active after dunning test' });
  assert.equal(lc.status, 200);
  assert.equal(lc.body.notified, true);
});

test('V1 employee PWA: roster endpoint for the linked employee; PWA files exist', async () => {
  const roster = await j('GET', '/api/pwa/roster', emp1());
  assert.equal(roster.status, 200);
  assert.equal(roster.body.linked, true);
  assert.ok(roster.body.assignments.length > 0);
  const manifest = await readFile(new URL('../../../web/public/manifest.webmanifest', import.meta.url), 'utf8');
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.display, 'standalone');
  assert.ok(parsed.name.includes('HR'));
  const sw = await readFile(new URL('../../../web/public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /roster/i);
});
