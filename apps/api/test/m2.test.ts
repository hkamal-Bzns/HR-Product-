import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, store } from '../src/server.js';
import { seed } from '../src/seed.js';
import { signSession } from '../src/auth.js';

const SECRET = 'test-secret-only';
let app: ReturnType<typeof buildServer>;
const owner = () => signSession({ sub: 'user-owner', tenantId: 'tenant-demo-cafe', role: 'owner' }, SECRET);
const mgr = () => signSession({ sub: 'user-mgr', tenantId: 'tenant-demo-cafe', role: 'branch_manager' }, SECRET);
const H = (t: string) => ({ authorization: `Bearer ${t}` });

test.before(async () => {
  await seed();
  app = buildServer({ jwtSecret: SECRET, breakGlassEnabled: false });
  await app.ready();
});
test.after(async () => { await app.close(); });

test('M2 seed: branches, templates, published 2-week roster, leave balances', async () => {
  assert.equal(store.branches.length, 2);
  assert.equal(store.shiftTemplates.length, 3);
  assert.equal(store.rosters.filter((r) => r.status === 'published').length, 4);
  assert.equal(store.rosterAssignments.length, 100); // 10 staff x 5 days x 2 weeks
  assert.equal(store.leaveBalances.length, 30);
  assert.equal(store.leaveRequests.find((l) => l.employeeId === 'emp-demo-6')?.status, 'approved');
  // Seeded exceptions: late (emp-8), missed clock-out (emp-9, emp-4), off-location (emp-4)
  const kinds = store.exceptions.map((e) => e.kind);
  assert.ok(kinds.includes('late') && kinds.includes('missed_clock_out') && kinds.includes('off_location'));
  assert.equal(store.latestSettings('tenant-demo-cafe', 'shifts')?.version, 1);
  assert.equal(store.latestSettings('tenant-demo-cafe', 'leave')?.version, 1);
});

test('M2 Mode A: QR token clock-in within geofence, token single-use, then clock-out', async () => {
  const qr = await app.inject({ method: 'GET', url: '/api/attendance/qr-token?branchId=branch-zamalek', headers: H(owner()) });
  assert.equal(qr.statusCode, 200);
  const token = qr.json().token as string;
  assert.match(token, /^branch-zamalek\.\d+\.[0-9a-f]+$/);
  const inRes = await app.inject({ method: 'POST', url: '/api/attendance/clock-in', headers: H(owner()), payload: { employeeId: 'emp-demo-5', branchId: 'branch-zamalek', token, lat: 30.0626, lng: 31.2197 } });
  assert.equal(inRes.statusCode, 201);
  assert.equal(inRes.json().record.verificationStatus, 'auto_approved');
  assert.equal(inRes.json().distanceM, 0);
  const reuse = await app.inject({ method: 'POST', url: '/api/attendance/clock-in', headers: H(owner()), payload: { employeeId: 'emp-demo-10', branchId: 'branch-zamalek', token, lat: 30.0626, lng: 31.2197 } });
  assert.equal(reuse.statusCode, 400); // single-use per window
  const outRes = await app.inject({ method: 'POST', url: '/api/attendance/clock-out', headers: H(owner()), payload: { employeeId: 'emp-demo-5' } });
  assert.equal(outRes.statusCode, 200);
  assert.ok(outRes.json().record.clockOutAt);
});

test('M2 Mode A: off-location clock-in is flagged, never auto-rejected', async () => {
  const qr = await app.inject({ method: 'GET', url: '/api/attendance/qr-token?branchId=branch-maadi', headers: H(owner()) });
  const inRes = await app.inject({ method: 'POST', url: '/api/attendance/clock-in', headers: H(owner()), payload: { employeeId: 'emp-demo-6', branchId: 'branch-maadi', token: qr.json().token, lat: 29.99, lng: 31.28 } });
  assert.equal(inRes.statusCode, 201);
  assert.equal(inRes.json().record.verificationStatus, 'pending_review');
  assert.ok(inRes.json().exceptions.some((e: { kind: string }) => e.kind === 'off_location'));
  await app.inject({ method: 'POST', url: '/api/attendance/clock-out', headers: H(owner()), payload: { employeeId: 'emp-demo-6' } });
});

test('M2 Mode B: kiosk enrol needs consent, wrong passcodes lock out, correct code clocks in', async () => {
  // Enrol without consent fails
  const noConsent = await app.inject({ method: 'POST', url: '/api/attendance/kiosk/enrol', headers: H(owner()), payload: { employeeId: 'emp-demo-2', passcode: '5678' } });
  assert.equal(noConsent.statusCode, 400);
  const consent = await app.inject({ method: 'POST', url: '/api/attendance/consent', headers: H(owner()), payload: { employeeId: 'emp-demo-2', consented: true } });
  assert.equal(consent.statusCode, 201);
  const enrol = await app.inject({ method: 'POST', url: '/api/attendance/kiosk/enrol', headers: H(owner()), payload: { employeeId: 'emp-demo-2', passcode: '5678' } });
  assert.equal(enrol.statusCode, 201);
  // 5 wrong attempts -> lockout
  for (let i = 0; i < 5; i++) {
    const wrong = await app.inject({ method: 'POST', url: '/api/attendance/kiosk/clock-in', headers: H(owner()), payload: { employeeId: 'emp-demo-2', branchId: 'branch-maadi', passcode: '0000', photoRef: 'kiosk-photo-x' } });
    assert.equal(wrong.statusCode, i < 4 ? 401 : 429);
  }
  const locked = await app.inject({ method: 'POST', url: '/api/attendance/kiosk/clock-in', headers: H(owner()), payload: { employeeId: 'emp-demo-2', branchId: 'branch-maadi', passcode: '5678', photoRef: 'kiosk-photo-x' } });
  assert.equal(locked.statusCode, 429);
  // Seeded enrolment (emp-demo-1, passcode 1234) clocks in; photo mismatch flags only
  const ok = await app.inject({ method: 'POST', url: '/api/attendance/kiosk/clock-in', headers: H(owner()), payload: { employeeId: 'emp-demo-1', branchId: 'branch-zamalek', passcode: '1234', photoRef: 'kiosk-photo-emp1', photoMatch: 'mismatch' } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().photoMismatchFlagged, true);
  assert.equal(ok.json().record.verificationStatus, 'pending_review');
  await app.inject({ method: 'POST', url: '/api/attendance/clock-out', headers: H(owner()), payload: { employeeId: 'emp-demo-1' } });
});

test('M2 offline queue: signed record accepted, duplicate goes to review, never overwritten', async () => {
  const deviceAt = new Date().toISOString();
  const first = await app.inject({ method: 'POST', url: '/api/attendance/offline-queue', headers: H(owner()), payload: { records: [{ employeeId: 'emp-demo-10', branchId: 'branch-maadi', deviceAt, lat: 29.9601, lng: 31.2506, signature: 'sig-demo-1' }] } });
  assert.equal(first.json().accepted.length, 1);
  const dup = await app.inject({ method: 'POST', url: '/api/attendance/offline-queue', headers: H(owner()), payload: { records: [{ employeeId: 'emp-demo-10', branchId: 'branch-maadi', deviceAt, lat: 29.9601, lng: 31.2506, signature: 'sig-demo-1' }] } });
  assert.equal(dup.json().accepted.length, 0);
  assert.equal(dup.json().review.length, 1);
  assert.match(dup.json().review[0].reason, /never silently overwritten/);
  await app.inject({ method: 'POST', url: '/api/attendance/clock-out', headers: H(owner()), payload: { employeeId: 'emp-demo-10' } });
});

test('M2 exceptions: list seeded queue and resolve with a reason + audit', async () => {
  const list = await app.inject({ method: 'GET', url: '/api/exceptions?status=open', headers: H(mgr()) });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().exceptions.length >= 3);
  const target = list.json().exceptions.find((e: { kind: string }) => e.kind === 'missed_clock_out'); // emp-demo-9, Zamalek — the manager's own branch
  assert.ok(target);
  const noNote = await app.inject({ method: 'POST', url: `/api/exceptions/${target.id}/resolve`, headers: H(mgr()), payload: { action: 'resolve' } });
  assert.equal(noNote.statusCode, 400); // reason required
  const ok = await app.inject({ method: 'POST', url: `/api/exceptions/${target.id}/resolve`, headers: H(mgr()), payload: { action: 'resolve', note: 'confirmed with employee, traffic delay' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().exception.status, 'resolved');
  assert.ok(store.audit.some((a) => a.action === 'exception.resolved'));
});

test('M2 roster: draft with coverage warnings, publish notifies via STUBBED WhatsApp', async () => {
  const draft = await app.inject({ method: 'POST', url: '/api/rosters', headers: H(mgr()), payload: { branchId: 'branch-zamalek', weekStart: '2026-11-16', assignments: [{ employeeId: 'emp-demo-1', date: '2026-11-16', shiftTemplateId: 'tpl-morning' }] } });
  assert.equal(draft.statusCode, 201);
  assert.equal(draft.json().roster.status, 'draft');
  assert.ok(draft.json().warnings.length > 0); // only 1 Barista, coverage needs 1 Barista + 2 Waiters
  const rosterId = draft.json().roster.id as string;
  const pub = await app.inject({ method: 'POST', url: `/api/rosters/${rosterId}/publish`, headers: H(mgr()) });
  assert.equal(pub.statusCode, 200);
  assert.equal(pub.json().roster.status, 'published');
  assert.equal(pub.json().notified, 1);
  assert.equal(pub.json().stubbed, true);
  const outbox = await app.inject({ method: 'GET', url: '/api/outbox', headers: H(owner()) });
  const msg = outbox.json().messages.find((m: { template: string }) => m.template === 'roster_published');
  assert.ok(msg);
  assert.equal(msg.status, 'queued_stubbed'); // never 'delivered'
});

test('M2 swaps: role/rest validation, manager approval moves the assignment', async () => {
  const rosters = await app.inject({ method: 'GET', url: '/api/rosters', headers: H(owner()) });
  const roster = rosters.json().rosters.find((r: { weekStart: string; branchId: string }) => r.weekStart === '2026-11-16' && r.branchId === 'branch-zamalek');
  const assignment = roster.assignments[0];
  // emp-demo-4 is a Waiter — wrong role for this Barista assignment
  const wrongRole = await app.inject({ method: 'POST', url: '/api/swaps', headers: H(owner()), payload: { rosterAssignmentId: assignment.id, coverEmployeeId: 'emp-demo-4' } });
  assert.equal(wrongRole.statusCode, 400);
  const swap = await app.inject({ method: 'POST', url: '/api/swaps', headers: H(owner()), payload: { rosterAssignmentId: assignment.id, coverEmployeeId: 'emp-demo-3' } });
  assert.equal(swap.statusCode, 201);
  const approve = await app.inject({ method: 'POST', url: `/api/swaps/${swap.json().swap.id}/approve`, headers: H(mgr()) });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().assignment.employeeId, 'emp-demo-3');
});

test('M2 open shifts: claim needs manager approval, approve fills it', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/open-shifts', headers: H(mgr()), payload: { branchId: 'branch-zamalek', date: '2026-11-17', shiftTemplateId: 'tpl-morning' } });
  assert.equal(created.statusCode, 201);
  const claim = await app.inject({ method: 'POST', url: `/api/open-shifts/${created.json().id}/claim`, headers: H(owner()), payload: { employeeId: 'emp-demo-5' } });
  assert.equal(claim.json().status, 'pending_manager_approval');
  const approve = await app.inject({ method: 'POST', url: `/api/open-shifts/${created.json().id}/approve`, headers: H(mgr()) });
  assert.equal(approve.json().openShift.status, 'filled');
  assert.equal(approve.json().openShift.filledByEmployeeId, 'emp-demo-5');
});

test('M2 leave: request, approve marks roster on-leave and deducts balance; over-balance rejected', async () => {
  const over = await app.inject({ method: 'POST', url: '/api/leave/requests', headers: H(owner()), payload: { employeeId: 'emp-demo-2', type: 'annual', startDate: '2026-12-01', endDate: '2026-12-30', reason: 'too long' } });
  assert.equal(over.statusCode, 400);
  const req = await app.inject({ method: 'POST', url: '/api/leave/requests', headers: H(owner()), payload: { employeeId: 'emp-demo-2', type: 'annual', startDate: '2026-12-01', endDate: '2026-12-02', reason: 'عطلة' } });
  assert.equal(req.statusCode, 201);
  assert.equal(req.json().request.days, 2);
  const approve = await app.inject({ method: 'POST', url: `/api/leave/requests/${req.json().request.id}/approve`, headers: H(owner()) }); // emp-demo-2 is Maadi; the Zamalek manager cannot approve it
  assert.equal(approve.statusCode, 200);
  const balances = await app.inject({ method: 'GET', url: '/api/leave/balances?employeeId=emp-demo-2&year=2026', headers: H(owner()) });
  const annual = balances.json().balances.find((b: { type: string }) => b.type === 'annual');
  assert.equal(annual.takenDays, 2);
  assert.equal(annual.remainingDays, 19);
  const whoOff = await app.inject({ method: 'GET', url: '/api/leave/who-off?date=2026-12-01', headers: H(owner()) });
  assert.ok(whoOff.json().off.some((o: { employeeId: string }) => o.employeeId === 'emp-demo-2'));
  const holidays = await app.inject({ method: 'GET', url: '/api/leave/holidays', headers: H(owner()) });
  assert.equal(holidays.json().holidays.length, 18);
});

test('M2 settings guardrail: widening geofence beyond 300m needs confirmation', async () => {
  const denied = await app.inject({ method: 'POST', url: '/api/settings/attendance', headers: H(owner()), payload: { value: { geofenceRadiusM: 500 }, reason: 'test widening', effectiveFrom: '2026-12-01' } });
  assert.equal(denied.statusCode, 400);
  assert.match(denied.json().error, /dangerous change requires confirmation/);
  const ok = await app.inject({ method: 'POST', url: '/api/settings/attendance', headers: H(owner()), payload: { value: { geofenceRadiusM: 500 }, reason: 'test widening with confirmation', effectiveFrom: '2026-12-01', confirmDangerous: true } });
  assert.equal(ok.statusCode, 201);
  assert.ok(ok.json().impact.dangerous.length > 0);
  assert.ok(ok.json().impact.publishedRosterAssignments >= 100);
});
