// M2 routes: attendance Modes A/B, exceptions, rosters, swaps, open shifts, leave.
// All routes are tenant-scoped via the JWT session; branch managers are scoped
// to their own branch on roster publish, exception resolution and leave approval.
// WhatsApp sends are STUBBED (see notify.ts) — never claimed as delivered.
import type { FastifyInstance } from 'fastify';
import { verifySession, hashPassword, verifyPassword, type SessionClaims } from './auth.js';
import { newId, type MemoryStore, type RosterAssignmentRecord } from '@hr-payroll/db';
import { EGYPT_PUBLIC_HOLIDAYS_2026, type LeaveType } from '@hr-payroll/shared';
import {
  attendanceSettings, shiftSettings, issueQrToken, clockIn, clockOut,
  sweepMissedClockOuts, isPasscodeFormatValid, KIOSK_MAX_ATTEMPTS, KIOSK_LOCKOUT_MINUTES,
} from './attendance.js';
import { coverageWarnings, validateAssignment, validateSwapCover, publishRoster } from './roster.js';
import { validateLeaveRequest, approveLeave, leaveSettings } from './leave.js';
import { notifyEmployee } from './notify.js';

export function registerM2(app: FastifyInstance, store: MemoryStore, jwtSecret: string): void {
  const auth = (req: { headers: Record<string, string | string[] | undefined> }): SessionClaims => {
    const h = req.headers.authorization;
    const token = Array.isArray(h) ? h[0] : h;
    if (!token?.startsWith('Bearer ')) throw new Error('missing bearer token');
    return verifySession(token.slice(7), jwtSecret);
  };
  const claims = (req: never, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): SessionClaims | null => {
    try { return auth(req as never); } catch { void reply.code(401).send({ error: 'unauthorised' }); return null; }
  };
  const tenant = (c: SessionClaims, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): string | null => {
    if (!c.tenantId) { void reply.code(403).send({ error: 'tenant session required' }); return null; }
    return c.tenantId;
  };
  /** Branch managers may only act on their own branch. */
  const branchOk = (c: SessionClaims, branchId: string | null): boolean => {
    if (c.role === 'owner' || c.role === 'accountant') return true;
    if (c.role !== 'branch_manager') return false;
    try {
      const user = store.getUser(c.tenantId ?? '', c.sub);
      return user.branchId === branchId;
    } catch { return false; }
  };
  const audit = (tenantId: string, actorUserId: string | null, action: string, entity: string, detail: unknown) =>
    store.log({ tenantId, actorUserId, actorKind: 'tenant_user', action, entity, detail });

  // --- Lookups ---------------------------------------------------------------
  app.get('/api/branches', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { branches: store.listBranches(t) };
  });
  app.get('/api/employees', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role === 'employee') return reply.code(403).send({ error: 'employees cannot list staff' });
    return { employees: store.listEmployees(t).map((e) => ({ ...e, nationalIdLast4: undefined })) };
  });

  // --- Mode A: QR + geofence --------------------------------------------------
  app.get('/api/attendance/qr-token', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const branchId = (req.query as { branchId?: string }).branchId;
    if (!branchId) return reply.code(400).send({ error: 'branchId required' });
    try { return issueQrToken(store, t, branchId); }
    catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
  });

  app.post('/api/attendance/clock-in', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const b = req.body as { employeeId?: string; branchId?: string; token?: string; lat?: number; lng?: number; wifiSsid?: string; mockLocation?: boolean; deviceAt?: string; photoRef?: string };
    if (!b?.employeeId || !b?.branchId || typeof b.lat !== 'number' || typeof b.lng !== 'number') {
      return reply.code(400).send({ error: 'employeeId, branchId, lat and lng are required' });
    }
    try {
      const result = clockIn(store, t, { employeeId: b.employeeId, branchId: b.branchId, token: b.token, lat: b.lat, lng: b.lng, wifiSsid: b.wifiSsid ?? null, mockLocation: b.mockLocation, deviceAt: b.deviceAt, photoRef: b.photoRef ?? null, method: 'qr_geofence' });
      return reply.code(201).send({ record: result.record, exceptions: result.exceptions, distanceM: result.distanceM, withinGeofence: result.withinGeofence });
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg.includes('already has an active') ? 409 : msg.includes('cross-tenant') ? 403 : 400).send({ error: msg });
    }
  });

  app.post('/api/attendance/clock-out', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const b = req.body as { employeeId?: string };
    if (!b?.employeeId) return reply.code(400).send({ error: 'employeeId required' });
    try { return clockOut(store, t, b.employeeId); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  // Offline queue: signed, timestamped records. Conflicts/duplicates go to the
  // review queue — never silently overwritten.
  app.post('/api/attendance/offline-queue', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const b = req.body as { records?: { employeeId: string; branchId: string; deviceAt: string; lat: number; lng: number; token?: string; signature: string; mockLocation?: boolean }[] };
    if (!Array.isArray(b?.records) || b.records.length === 0) return reply.code(400).send({ error: 'records[] required' });
    const settings = attendanceSettings(store, t);
    const accepted: unknown[] = []; const review: unknown[] = [];
    for (const r of b.records) {
      if (!r.signature) { review.push({ employeeId: r.employeeId, reason: 'unsigned offline record — held for review' }); continue; }
      const duplicate = store.attendance.some((a) => a.tenantId === t && a.employeeId === r.employeeId && a.deviceAt === r.deviceAt);
      if (duplicate) {
        const ex = { id: newId('exc'), tenantId: t, attendanceRecordId: null, employeeId: r.employeeId, branchId: r.branchId, kind: 'low_confidence', status: 'open' as const, reason: `duplicate offline record for device time ${r.deviceAt} — kept for review, never silently overwritten`, resolvedByUserId: null, resolutionNote: null, resolvedAt: null, createdAt: new Date().toISOString() };
        store.addException(ex); review.push({ employeeId: r.employeeId, reason: ex.reason }); continue;
      }
      const ageHours = (Date.now() - new Date(r.deviceAt).getTime()) / 3600000;
      const withinTolerance = ageHours <= settings.offlineToleranceHours;
      try {
        const result = clockIn(store, t, { employeeId: r.employeeId, branchId: r.branchId, token: r.token, lat: r.lat, lng: r.lng, mockLocation: r.mockLocation, deviceAt: r.deviceAt, method: 'offline_queue', source: 'offline_queue' }, new Date(r.deviceAt));
        if (!withinTolerance) {
          result.record.verificationStatus = 'pending_review';
          store.addException({ id: newId('exc'), tenantId: t, attendanceRecordId: result.record.id, employeeId: r.employeeId, branchId: r.branchId, kind: 'low_confidence', status: 'open', reason: `offline record synced ${ageHours.toFixed(1)}h after device time (tolerance ${settings.offlineToleranceHours}h)`, resolvedByUserId: null, resolutionNote: null, resolvedAt: null, createdAt: new Date().toISOString() });
          review.push({ recordId: result.record.id, reason: 'outside offline tolerance window' });
        } else accepted.push(result.record);
      } catch (e) { review.push({ employeeId: r.employeeId, reason: (e as Error).message }); }
    }
    audit(t, c.sub, 'attendance.offline_queue_sync', 'attendance_record', { accepted: accepted.length, review: review.length });
    return { accepted, review, note: 'Offline records are never silently overwritten; conflicts are in the review queue.' };
  });

  app.get('/api/attendance', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role === 'employee') return reply.code(403).send({ error: 'employees view their own record in-app (M2 demo: manager view only)' });
    const q = req.query as { employeeId?: string; status?: string };
    let list = store.listAttendance(t);
    if (q.employeeId) list = list.filter((a) => a.employeeId === q.employeeId);
    if (q.status) list = list.filter((a) => a.verificationStatus === q.status);
    return { records: list };
  });

  // --- Mode B: passcode + instant-photo kiosk ---------------------------------
  app.post('/api/attendance/consent', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'owner or branch manager only' });
    const b = req.body as { employeeId?: string; consented?: boolean };
    if (!b?.employeeId || typeof b.consented !== 'boolean') return reply.code(400).send({ error: 'employeeId and consented required' });
    try { store.getEmployee(t, b.employeeId); } catch { return reply.code(404).send({ error: 'employee not found' }); }
    const settings = attendanceSettings(store, t);
    const existing = store.kioskConsents.find((k) => k.tenantId === t && k.employeeId === b.employeeId);
    const rec = existing ?? { tenantId: t, employeeId: b.employeeId, consented: false, noticeShownAt: new Date().toISOString(), consentedAt: null, retentionDays: settings.photoRetentionDays };
    rec.consented = b.consented; rec.consentedAt = b.consented ? new Date().toISOString() : null;
    if (!existing) store.kioskConsents.push(rec);
    audit(t, c.sub, 'attendance.kiosk_consent', 'kiosk_consent', { employeeId: b.employeeId, consented: b.consented, retentionDays: rec.retentionDays });
    return reply.code(201).send(rec);
  });

  app.post('/api/attendance/kiosk/enrol', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'owner or branch manager only' });
    const b = req.body as { employeeId?: string; passcode?: string };
    if (!b?.employeeId || !b?.passcode) return reply.code(400).send({ error: 'employeeId and passcode required' });
    if (!isPasscodeFormatValid(b.passcode)) return reply.code(400).send({ error: 'passcode must be 4–6 digits' });
    const consent = store.kioskConsents.find((k) => k.tenantId === t && k.employeeId === b.employeeId && k.consented);
    if (!consent) return reply.code(400).send({ error: 'kiosk photo consent is required before enrolment (POST /api/attendance/consent first)' });
    const hash = await hashPassword(b.passcode);
    const existing = store.kioskPasscodes.find((k) => k.tenantId === t && k.employeeId === b.employeeId);
    if (existing) { existing.passcodeHash = hash; existing.failedAttempts = 0; existing.lockedUntil = null; }
    else store.kioskPasscodes.push({ tenantId: t, employeeId: b.employeeId, passcodeHash: hash, failedAttempts: 0, lockedUntil: null });
    audit(t, c.sub, 'attendance.kiosk_enrol', 'kiosk_passcode', { employeeId: b.employeeId, note: 'passcode stored as bcrypt hash only' });
    return reply.code(201).send({ employeeId: b.employeeId, enrolled: true });
  });

  app.post('/api/attendance/kiosk/clock-in', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const b = req.body as { employeeId?: string; branchId?: string; passcode?: string; photoRef?: string; photoMatch?: 'match' | 'mismatch'; lat?: number; lng?: number };
    if (!b?.employeeId || !b?.branchId || !b?.passcode) return reply.code(400).send({ error: 'employeeId, branchId and passcode required' });
    const settings = attendanceSettings(store, t);
    if (settings.kioskPhotoRequired && !b.photoRef) return reply.code(400).send({ error: 'a fresh kiosk photo reference (photoRef) is required' });
    const pass = store.kioskPasscodes.find((k) => k.tenantId === t && k.employeeId === b.employeeId);
    if (!pass) return reply.code(404).send({ error: 'employee is not enrolled in kiosk mode' });
    if (pass.lockedUntil && new Date(pass.lockedUntil).getTime() > Date.now()) {
      return reply.code(429).send({ error: `kiosk locked after ${KIOSK_MAX_ATTEMPTS} failed attempts — try again after ${pass.lockedUntil}` });
    }
    if (!(await verifyPassword(b.passcode, pass.passcodeHash))) {
      pass.failedAttempts += 1;
      if (pass.failedAttempts >= KIOSK_MAX_ATTEMPTS) {
        pass.lockedUntil = new Date(Date.now() + KIOSK_LOCKOUT_MINUTES * 60000).toISOString();
        audit(t, c.sub, 'attendance.kiosk_lockout', 'kiosk_passcode', { employeeId: b.employeeId, failedAttempts: pass.failedAttempts });
        return reply.code(429).send({ error: `too many wrong passcodes — kiosk locked for ${KIOSK_LOCKOUT_MINUTES} minutes` });
      }
      return reply.code(401).send({ error: `wrong passcode (${pass.failedAttempts}/${KIOSK_MAX_ATTEMPTS} attempts)` });
    }
    pass.failedAttempts = 0; pass.lockedUntil = null;
    try {
      const branch = store.getBranch(t, b.branchId);
      const lat = b.lat ?? branch.geofenceLat; const lng = b.lng ?? branch.geofenceLng;
      const result = clockIn(store, t, { employeeId: b.employeeId, branchId: b.branchId, lat, lng, photoRef: b.photoRef ?? null, method: 'passcode_photo' });
      // Photo mismatch flags for manager review — NEVER auto-rejects (Brief §5).
      if (b.photoMatch === 'mismatch') {
        result.record.verificationStatus = 'pending_review';
        store.addException({ id: newId('exc'), tenantId: t, attendanceRecordId: result.record.id, employeeId: b.employeeId, branchId: b.branchId, kind: 'photo_mismatch', status: 'open', reason: 'kiosk photo does not appear to match the enrolled employee — flagged for manager review only, not auto-rejected', resolvedByUserId: null, resolutionNote: null, resolvedAt: null, createdAt: new Date().toISOString() });
      }
      return reply.code(201).send({ record: result.record, exceptions: result.exceptions, photoMismatchFlagged: b.photoMatch === 'mismatch' });
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg.includes('already has an active') ? 409 : 400).send({ error: msg });
    }
  });

  app.post('/api/attendance/sweep-missed-clock-outs', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'manager or owner only' });
    const found = sweepMissedClockOuts(store, t);
    return { flagged: found.length, exceptions: found };
  });

  // --- Exception queue ---------------------------------------------------------
  app.get('/api/exceptions', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role === 'employee') return reply.code(403).send({ error: 'managers only' });
    const q = req.query as { status?: string; branchId?: string };
    let list = store.listExceptions(t, q.status);
    if (q.branchId) list = list.filter((e) => e.branchId === q.branchId);
    if (c.role === 'branch_manager') {
      try { const user = store.getUser(t, c.sub); list = list.filter((e) => e.branchId === user.branchId); } catch { /* fall through */ }
    }
    return { exceptions: list };
  });

  app.post('/api/exceptions/:id/resolve', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'manager or owner only' });
    const ex = store.exceptions.find((e) => e.id === (req.params as { id: string }).id && e.tenantId === t);
    if (!ex) return reply.code(404).send({ error: 'exception not found' });
    if (ex.branchId && !branchOk(c, ex.branchId)) return reply.code(403).send({ error: 'branch manager can only resolve their own branch' });
    const b = req.body as { action?: 'resolve' | 'dismiss'; note?: string; clockOutAt?: string };
    if (!b?.action || !['resolve', 'dismiss'].includes(b.action)) return reply.code(400).send({ error: 'action resolve|dismiss required' });
    if (!b.note?.trim()) return reply.code(400).send({ error: 'a resolution reason is required' });
    ex.status = b.action === 'resolve' ? 'resolved' : 'dismissed';
    ex.resolvedByUserId = c.sub; ex.resolutionNote = b.note; ex.resolvedAt = new Date().toISOString();
    if (b.clockOutAt && ex.attendanceRecordId) {
      const rec = store.attendance.find((a) => a.id === ex.attendanceRecordId);
      if (rec && !rec.clockOutAt) rec.clockOutAt = b.clockOutAt;
    }
    audit(t, c.sub, `exception.${ex.status}`, 'exception', { exceptionId: ex.id, kind: ex.kind, note: b.note });
    return { exception: ex };
  });

  // --- Shift templates & rosters ------------------------------------------------
  app.get('/api/shifts/templates', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { templates: store.shiftTemplates.filter((x) => x.tenantId === t) };
  });
  app.post('/api/shifts/templates', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'manager or owner only' });
    const b = req.body as { nameAr?: string; nameEn?: string; startTime?: string; endTime?: string; overnight?: boolean; unpaidBreakMinutes?: number; branchId?: string | null };
    if (!b?.nameAr || !b?.nameEn || !b?.startTime || !b?.endTime) return reply.code(400).send({ error: 'nameAr, nameEn, startTime and endTime required' });
    if (!/^\d{2}:\d{2}$/.test(b.startTime) || !/^\d{2}:\d{2}$/.test(b.endTime)) return reply.code(400).send({ error: 'startTime/endTime must be HH:MM' });
    const rec = { id: newId('tpl'), tenantId: t, branchId: b.branchId ?? null, nameAr: b.nameAr, nameEn: b.nameEn, startTime: b.startTime, endTime: b.endTime, overnight: !!b.overnight, unpaidBreakMinutes: b.unpaidBreakMinutes ?? 0, status: 'active' as const };
    store.shiftTemplates.push(rec);
    audit(t, c.sub, 'shifts.template_create', 'shift_template', { templateId: rec.id });
    return reply.code(201).send(rec);
  });

  app.get('/api/rosters', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const rosters = store.listRosters(t).map((r) => ({ ...r, assignments: store.rosterAssignments.filter((a) => a.rosterId === r.id) }));
    return { rosters };
  });
  app.post('/api/rosters', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'manager or owner only' });
    const b = req.body as { branchId?: string; weekStart?: string; assignments?: { employeeId: string; date: string; shiftTemplateId: string }[] };
    if (!b?.branchId || !b?.weekStart || !Array.isArray(b.assignments)) return reply.code(400).send({ error: 'branchId, weekStart and assignments[] required' });
    if (!branchOk(c, b.branchId)) return reply.code(403).send({ error: 'branch manager can only roster their own branch' });
    const roster = { id: newId('roster'), tenantId: t, branchId: b.branchId, weekStart: b.weekStart, status: 'draft' as const, publishedAt: null, publishedByUserId: null };
    store.rosters.push(roster);
    const created: RosterAssignmentRecord[] = [];
    const restProblems: { employeeId: string; date: string; problems: string[] }[] = [];
    for (const a of b.assignments) {
      try { store.getEmployee(t, a.employeeId); } catch { continue; }
      const problems = a.shiftTemplateId ? validateAssignment(store, t, a.employeeId, a.date, a.shiftTemplateId) : [];
      if (problems.length) restProblems.push({ employeeId: a.employeeId, date: a.date, problems });
      const rec: RosterAssignmentRecord = { id: newId('asg'), tenantId: t, rosterId: roster.id, employeeId: a.employeeId, date: a.date, shiftTemplateId: a.shiftTemplateId, onLeave: false };
      store.rosterAssignments.push(rec); created.push(rec);
    }
    const warnings = coverageWarnings(store, t, created);
    audit(t, c.sub, 'roster.create_draft', 'roster', { rosterId: roster.id, assignments: created.length, warnings: warnings.length, restProblems: restProblems.length });
    return reply.code(201).send({ roster, assignments: created, warnings, restProblems });
  });

  app.post('/api/rosters/:id/publish', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'manager or owner only' });
    const roster = store.rosters.find((r) => r.id === (req.params as { id: string }).id && r.tenantId === t);
    if (!roster) return reply.code(404).send({ error: 'roster not found' });
    if (roster.status === 'published') return reply.code(400).send({ error: 'roster is already published' });
    if (!branchOk(c, roster.branchId)) return reply.code(403).send({ error: 'branch manager can only publish their own branch' });
    const result = await publishRoster(store, t, roster, c.sub);
    return { ...result, note: 'WhatsApp notifications are STUBBED in M2 — queued in the outbox, not delivered.' };
  });

  // --- Swaps & open shifts -------------------------------------------------------
  app.get('/api/swaps', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { swaps: store.swapRequests.filter((s) => s.tenantId === t) };
  });
  app.post('/api/swaps', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const b = req.body as { rosterAssignmentId?: string; coverEmployeeId?: string };
    if (!b?.rosterAssignmentId || !b?.coverEmployeeId) return reply.code(400).send({ error: 'rosterAssignmentId and coverEmployeeId required' });
    const assignment = store.rosterAssignments.find((a) => a.id === b.rosterAssignmentId && a.tenantId === t);
    if (!assignment) return reply.code(404).send({ error: 'assignment not found' });
    const problems = validateSwapCover(store, t, assignment, b.coverEmployeeId);
    if (problems.length) return reply.code(400).send({ error: 'cover does not meet role/rest rules', problems });
    const swap = { id: newId('swap'), tenantId: t, rosterAssignmentId: assignment.id, requesterEmployeeId: assignment.employeeId, coverEmployeeId: b.coverEmployeeId, status: 'pending' as const, decidedByUserId: null };
    store.swapRequests.push(swap);
    audit(t, c.sub, 'swap.request', 'swap_request', { swapId: swap.id });
    return reply.code(201).send({ swap, note: 'Manager approval required (Brief §6).' });
  });
  app.post('/api/swaps/:id/approve', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'manager or owner only' });
    const swap = store.swapRequests.find((s) => s.id === (req.params as { id: string }).id && s.tenantId === t);
    if (!swap) return reply.code(404).send({ error: 'swap not found' });
    if (swap.status !== 'pending') return reply.code(400).send({ error: `swap is already ${swap.status}` });
    const assignment = store.rosterAssignments.find((a) => a.id === swap.rosterAssignmentId);
    if (!assignment) return reply.code(404).send({ error: 'assignment not found' });
    assignment.employeeId = swap.coverEmployeeId;
    swap.status = 'approved'; swap.decidedByUserId = c.sub;
    audit(t, c.sub, 'swap.approve', 'swap_request', { swapId: swap.id, newEmployeeId: swap.coverEmployeeId });
    return { swap, assignment };
  });
  app.post('/api/swaps/:id/reject', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'manager or owner only' });
    const swap = store.swapRequests.find((s) => s.id === (req.params as { id: string }).id && s.tenantId === t);
    if (!swap) return reply.code(404).send({ error: 'swap not found' });
    swap.status = 'rejected'; swap.decidedByUserId = c.sub;
    audit(t, c.sub, 'swap.reject', 'swap_request', { swapId: swap.id });
    return { swap };
  });

  app.get('/api/open-shifts', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { openShifts: store.openShifts.filter((o) => o.tenantId === t) };
  });
  app.post('/api/open-shifts', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'manager or owner only' });
    const b = req.body as { branchId?: string; date?: string; shiftTemplateId?: string };
    if (!b?.branchId || !b?.date || !b?.shiftTemplateId) return reply.code(400).send({ error: 'branchId, date and shiftTemplateId required' });
    const rec = { id: newId('open'), tenantId: t, rosterAssignmentId: null, branchId: b.branchId, date: b.date, shiftTemplateId: b.shiftTemplateId, status: 'open' as const, filledByEmployeeId: null, claimedByEmployeeId: null };
    store.openShifts.push(rec);
    audit(t, c.sub, 'open_shift.create', 'open_shift', { openShiftId: rec.id });
    return reply.code(201).send(rec);
  });
  app.post('/api/open-shifts/:id/claim', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const shift = store.openShifts.find((o) => o.id === (req.params as { id: string }).id && o.tenantId === t);
    if (!shift) return reply.code(404).send({ error: 'open shift not found' });
    if (shift.status !== 'open') return reply.code(400).send({ error: `open shift is ${shift.status}` });
    const b = req.body as { employeeId?: string };
    if (!b?.employeeId) return reply.code(400).send({ error: 'employeeId required' });
    const emp = store.employees.find((e) => e.id === b.employeeId && e.tenantId === t);
    if (!emp) return reply.code(404).send({ error: 'employee not found' });
    if (!shift.shiftTemplateId) return reply.code(400).send({ error: 'open shift has no template' });
    const problems = validateAssignment(store, t, b.employeeId, shift.date, shift.shiftTemplateId);
    if (problems.length) return reply.code(400).send({ error: 'employee does not meet role/rest rules for this shift', problems });
    const settings = shiftSettings(store, t);
    if (settings.openShiftRequiresManagerApproval) {
      shift.claimedByEmployeeId = b.employeeId;
      audit(t, c.sub, 'open_shift.claim', 'open_shift', { openShiftId: shift.id, employeeId: b.employeeId, note: 'awaiting manager approval' });
      return { openShift: shift, status: 'pending_manager_approval' };
    }
    shift.status = 'filled'; shift.filledByEmployeeId = b.employeeId;
    audit(t, c.sub, 'open_shift.fill', 'open_shift', { openShiftId: shift.id, employeeId: b.employeeId });
    return { openShift: shift, status: 'filled' };
  });
  app.post('/api/open-shifts/:id/approve', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'manager or owner only' });
    const shift = store.openShifts.find((o) => o.id === (req.params as { id: string }).id && o.tenantId === t);
    if (!shift || !shift.claimedByEmployeeId) return reply.code(404).send({ error: 'no pending claim on this open shift' });
    shift.status = 'filled'; shift.filledByEmployeeId = shift.claimedByEmployeeId; shift.claimedByEmployeeId = null;
    audit(t, c.sub, 'open_shift.approve', 'open_shift', { openShiftId: shift.id, employeeId: shift.filledByEmployeeId });
    return { openShift: shift };
  });

  // --- Leave ---------------------------------------------------------------------
  app.get('/api/leave/balances', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const q = req.query as { employeeId?: string; year?: string };
    const year = Number(q.year ?? 2026);
    let list = store.leaveBalances.filter((b) => b.tenantId === t && b.year === year);
    if (q.employeeId) list = list.filter((b) => b.employeeId === q.employeeId);
    return { balances: list.map((b) => ({ ...b, remainingDays: Math.round((b.entitlementDays + b.carriedDays - b.takenDays) * 100) / 100 })) };
  });
  app.get('/api/leave/holidays', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const settings = leaveSettings(store, t);
    return { year: 2026, holidays: settings.publicHolidays, note: 'Lunar-dated holidays are provisional until the official announcement; the owner may edit this calendar.' };
  });
  app.get('/api/leave/who-off', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const date = (req.query as { date?: string }).date ?? new Date().toISOString().slice(0, 10);
    const off = store.leaveRequests.filter((l) => l.tenantId === t && l.status === 'approved' && l.startDate <= date && l.endDate >= date);
    return { date, off: off.map((l) => ({ ...l, employee: store.employees.find((e) => e.id === l.employeeId)?.fullNameAr ?? l.employeeId })) };
  });
  app.get('/api/leave/requests', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { requests: store.listLeaveRequests(t) };
  });
  app.post('/api/leave/requests', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const b = req.body as { employeeId?: string; type?: LeaveType; startDate?: string; endDate?: string; reason?: string };
    if (!b?.employeeId || !b?.type || !b?.startDate || !b?.endDate) return reply.code(400).send({ error: 'employeeId, type, startDate and endDate required' });
    try { store.getEmployee(t, b.employeeId); } catch { return reply.code(404).send({ error: 'employee not found' }); }
    const check = validateLeaveRequest(store, t, b.employeeId, b.type, b.startDate, b.endDate);
    if (!check.ok) return reply.code(400).send({ error: 'leave request does not meet policy', reasons: check.reasons });
    const rec = { id: newId('leave'), tenantId: t, employeeId: b.employeeId, type: b.type, startDate: b.startDate, endDate: b.endDate, days: check.days, status: 'pending' as const, reason: b.reason ?? null, decidedByUserId: null, decidedAt: null };
    store.leaveRequests.push(rec);
    audit(t, c.sub, 'leave.request', 'leave_request', { requestId: rec.id, days: rec.days });
    return reply.code(201).send({ request: rec, warnings: check.warnings });
  });
  app.post('/api/leave/requests/:id/approve', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const reqRec = store.leaveRequests.find((l) => l.id === (req.params as { id: string }).id && l.tenantId === t);
    if (!reqRec) return reply.code(404).send({ error: 'leave request not found' });
    if (reqRec.status !== 'pending') return reply.code(400).send({ error: `request is already ${reqRec.status}` });
    const settings = leaveSettings(store, t);
    const typeCfg = settings.types.find((x) => x.type === reqRec.type);
    if (typeCfg?.approver === 'owner' && c.role !== 'owner') return reply.code(403).send({ error: 'this leave type requires owner approval' });
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'manager or owner only' });
    const emp = store.employees.find((e) => e.id === reqRec.employeeId);
    if (c.role === 'branch_manager' && emp && !branchOk(c, emp.branchId)) return reply.code(403).send({ error: 'branch manager can only approve their own branch' });
    const approved = await approveLeave(store, t, reqRec, c.sub);
    return { request: approved, note: 'WhatsApp decision notice is STUBBED — queued in the outbox, not delivered.' };
  });
  app.post('/api/leave/requests/:id/reject', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'owner' && c.role !== 'branch_manager') return reply.code(403).send({ error: 'manager or owner only' });
    const reqRec = store.leaveRequests.find((l) => l.id === (req.params as { id: string }).id && l.tenantId === t);
    if (!reqRec) return reply.code(404).send({ error: 'leave request not found' });
    if (reqRec.status !== 'pending') return reply.code(400).send({ error: `request is already ${reqRec.status}` });
    reqRec.status = 'rejected'; reqRec.decidedByUserId = c.sub; reqRec.decidedAt = new Date().toISOString();
    const emp = store.employees.find((e) => e.id === reqRec.employeeId);
    if (emp) await notifyEmployee(store, t, emp, 'leave_decision', `تم رفض طلب الإجازة (${reqRec.type}) من ${reqRec.startDate} إلى ${reqRec.endDate}. / Your ${reqRec.type} leave ${reqRec.startDate} to ${reqRec.endDate} was rejected.`);
    audit(t, c.sub, 'leave.reject', 'leave_request', { requestId: reqRec.id });
    return { request: reqRec };
  });

  // --- Stubbed outbox (transparency: nothing here was delivered) ------------------
  app.get('/api/outbox', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role === 'employee') return reply.code(403).send({ error: 'managers only' });
    return { messages: store.outbox.filter((m) => m.tenantId === t), stubbed: true, note: 'All messages are queued_stubbed. No real WhatsApp/SMS was sent.' };
  });
}
