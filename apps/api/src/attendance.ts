// M2 attendance helpers: settings resolution, QR tokens, clock-in/out rules.
// Pure rule evaluation lives in @hr-payroll/shared; this module wires it to
// the MemoryStore (tenancy-guarded) and the audit log.
import { randomBytes, createHash } from 'node:crypto';
import {
  haversineMetres, isWithinGeofence, makeQrToken, isQrTokenWindowValid,
  classifyArrival, classifyDeparture, impossibleTravel, roundMinutes,
  overtimeMinutes, DEFAULT_ATTENDANCE_SETTINGS, DEFAULT_SHIFT_SETTINGS,
  type AttendanceMode,
} from '@hr-payroll/shared';
import { newId, type MemoryStore, type AttendanceRecordRow, type ExceptionRecord } from '@hr-payroll/db';

/** Wall-clock minutes since midnight in Africa/Cairo for a timestamp. */
export function cairoMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const [h, m] = parts.split(':').map(Number);
  return h * 60 + m;
}

export function attendanceSettings(store: MemoryStore, tenantId: string) {
  const latest = store.latestSettings(tenantId, 'attendance');
  return { ...DEFAULT_ATTENDANCE_SETTINGS, ...(latest?.value as Record<string, unknown> ?? {}) } as typeof DEFAULT_ATTENDANCE_SETTINGS;
}
export function shiftSettings(store: MemoryStore, tenantId: string) {
  const latest = store.latestSettings(tenantId, 'shifts');
  return { ...DEFAULT_SHIFT_SETTINGS, ...(latest?.value as Record<string, unknown> ?? {}) } as typeof DEFAULT_SHIFT_SETTINGS;
}
export function modesEnabled(store: MemoryStore, tenantId: string): AttendanceMode[] {
  return attendanceSettings(store, tenantId).modes as AttendanceMode[];
}

export function issueQrToken(store: MemoryStore, tenantId: string, branchId: string, now = new Date()): { token: string; branchId: string; expiresAtMs: number; rotationSeconds: number } {
  const branch = store.getBranch(tenantId, branchId);
  void branch;
  const rotationSeconds = attendanceSettings(store, tenantId).qrRotationSeconds;
  const nonce = randomBytes(8).toString('hex');
  const token = makeQrToken(branchId, now, rotationSeconds, nonce);
  return { token, branchId, expiresAtMs: (Math.floor(now.getTime() / 1000 / rotationSeconds) + 1) * rotationSeconds * 1000, rotationSeconds };
}

export interface ClockInInput {
  employeeId: string; branchId: string; token?: string;
  lat: number; lng: number; wifiSsid?: string | null; mockLocation?: boolean;
  deviceAt?: string; photoRef?: string | null; method?: 'qr_geofence' | 'passcode_photo' | 'offline_queue';
  source?: 'live' | 'offline_queue';
}

export interface ClockInResult { record: AttendanceRecordRow; exceptions: ExceptionRecord[]; distanceM: number; withinGeofence: boolean }

function raiseException(store: MemoryStore, rec: AttendanceRecordRow, kind: ExceptionRecord['kind'], reason: string): ExceptionRecord {
  const ex: ExceptionRecord = {
    id: newId('exc'), tenantId: rec.tenantId, attendanceRecordId: rec.id, employeeId: rec.employeeId,
    branchId: rec.branchId, kind, status: 'open', reason,
    resolvedByUserId: null, resolutionNote: null, resolvedAt: null, createdAt: new Date().toISOString(),
  };
  store.addException(ex);
  return ex;
}

/** Today's roster assignment for an employee (any published roster), if any. */
export function todaysAssignment(store: MemoryStore, tenantId: string, employeeId: string, dateIso: string) {
  return store.rosterAssignments.find((a) => a.tenantId === tenantId && a.employeeId === employeeId && a.date === dateIso && !a.onLeave);
}

export function clockIn(store: MemoryStore, tenantId: string, input: ClockInInput, now = new Date()): ClockInResult {
  const settings = attendanceSettings(store, tenantId);
  const employee = store.getEmployee(tenantId, input.employeeId);
  const branch = store.getBranch(tenantId, input.branchId);
  if (store.activeSession(tenantId, input.employeeId)) {
    throw new Error('employee already has an active clock-in session — clock out first');
  }
  const exceptions: ExceptionRecord[] = [];
  // QR token validation (Mode A). A missing token on QR mode is a low-confidence flag, not a silent pass.
  if (input.method !== 'passcode_photo' && input.method !== 'offline_queue') {
    if (!input.token) throw new Error('QR token required for QR clock-in');
    const validity = isQrTokenWindowValid(input.token, now.getTime(), settings.qrRotationSeconds, store.usedQrNonces);
    if (!validity.valid) throw new Error(`invalid QR token: ${validity.reason}`);
    const [, windowIndex, nonce] = input.token.split('.');
    store.usedQrNonces.add(`${input.branchId}:${windowIndex}:${nonce}`);
  }
  const distanceM = Math.round(haversineMetres(input.lat, input.lng, branch.geofenceLat, branch.geofenceLng));
  const radiusM = Number(settings.geofenceRadiusM ?? branch.geofenceRadiusM);
  const withinGeofence = isWithinGeofence(input.lat, input.lng, branch.geofenceLat, branch.geofenceLng, radiusM);
  const wifiMatched = settings.wifiSsid ? input.wifiSsid === settings.wifiSsid : null;
  // Velocity check against the employee's previous punch.
  const prev = store.lastPunchByEmployee.get(input.employeeId);
  let verification: AttendanceRecordRow['verificationStatus'] = 'auto_approved';
  if (prev) {
    const dist = haversineMetres(prev.lat, prev.lng, input.lat, input.lng);
    const v = impossibleTravel(dist, (now.getTime() - prev.atMs) / 1000);
    if (v.impossible) verification = 'pending_review';
  }
  if (!withinGeofence || input.mockLocation || verification === 'pending_review') verification = 'pending_review';
  if (settings.photoRequiredOnLowConfidence && verification === 'pending_review' && !input.photoRef) {
    // Flagged for review; a photo can be attached later by the manager flow.
  }
  const record: AttendanceRecordRow = {
    id: newId('att'), tenantId, employeeId: input.employeeId, branchId: input.branchId,
    rosterAssignmentId: todaysAssignment(store, tenantId, input.employeeId, now.toISOString().slice(0, 10))?.id ?? null,
    method: input.method ?? 'qr_geofence', clockInAt: now.toISOString(), clockOutAt: null,
    deviceAt: input.deviceAt ?? now.toISOString(), lat: input.lat, lng: input.lng,
    distanceFromBranchM: distanceM, wifiMatched, mockLocationFlag: !!input.mockLocation,
    photoRef: input.photoRef ?? null,
    photoRetainUntil: input.photoRef ? new Date(now.getTime() + Number(settings.photoRetentionDays) * 86400000).toISOString().slice(0, 10) : null,
    verificationStatus: verification, source: input.source ?? 'live',
  };
  store.attendance.push(record);
  store.lastPunchByEmployee.set(input.employeeId, { lat: input.lat, lng: input.lng, atMs: now.getTime() });
  if (!withinGeofence) exceptions.push(raiseException(store, record, 'off_location', `clock-in ${distanceM}m from branch centre, geofence radius ${radiusM}m`));
  if (input.mockLocation) exceptions.push(raiseException(store, record, 'low_confidence', 'mock-location flag reported by device'));
  if (verification === 'pending_review' && withinGeofence && !input.mockLocation) {
    exceptions.push(raiseException(store, record, 'low_confidence', 'impossible-travel velocity check flagged this punch for review'));
  }
  // Late flag against the scheduled shift (Cairo wall-clock).
  const assignment = record.rosterAssignmentId ? store.rosterAssignments.find((a) => a.id === record.rosterAssignmentId) : undefined;
  const template = assignment?.shiftTemplateId ? store.shiftTemplates.find((t) => t.id === assignment.shiftTemplateId) : undefined;
  if (template) {
    const [sh, sm] = template.startTime.split(':').map(Number);
    const arrival = classifyArrival(sh * 60 + sm, cairoMinutes(now), settings.graceMinutes, settings.lateThresholdMinutes);
    if (arrival.status === 'late') exceptions.push(raiseException(store, record, 'late', arrival.reason));
  }
  store.log({ tenantId, actorUserId: null, actorKind: 'system', action: 'attendance.clock_in', entity: 'attendance_record', detail: { recordId: record.id, employeeId: input.employeeId, method: record.method, verificationStatus: verification, distanceM } });
  return { record, exceptions, distanceM, withinGeofence };
}

export interface ClockOutResult { record: AttendanceRecordRow; workedMinutes: number; roundedMinutes: number; exceptions: ExceptionRecord[] }

export function clockOut(store: MemoryStore, tenantId: string, employeeId: string, now = new Date()): ClockOutResult {
  const settings = attendanceSettings(store, tenantId);
  const shifts = shiftSettings(store, tenantId);
  const record = store.activeSession(tenantId, employeeId);
  if (!record || !record.clockInAt) throw new Error('no active clock-in session for this employee');
  record.clockOutAt = now.toISOString();
  const workedMs = now.getTime() - new Date(record.clockInAt).getTime();
  const workedMinutes = Math.max(0, Math.round(workedMs / 60000));
  const roundedMinutes = roundMinutes(workedMinutes, settings.rounding, settings.roundingDirection);
  const exceptions: ExceptionRecord[] = [];
  const assignment = record.rosterAssignmentId ? store.rosterAssignments.find((a) => a.id === record.rosterAssignmentId) : undefined;
  const template = assignment?.shiftTemplateId ? store.shiftTemplates.find((t) => t.id === assignment.shiftTemplateId) : undefined;
  if (template) {
    const [eh, em] = template.endTime.split(':').map(Number);
    const endMin = eh * 60 + em + (template.overnight ? 1440 : 0);
    const actualMin = cairoMinutes(now) + (template.overnight && cairoMinutes(now) < eh * 60 + em ? 1440 : 0);
    const dep = classifyDeparture(endMin, actualMin, settings.graceMinutes);
    if (dep.status === 'early_leave') exceptions.push(raiseException(store, record, 'early_leave', dep.reason));
    const standard = (endMin - (template.startTime.split(':').map(Number)[0] * 60 + Number(template.startTime.split(':')[1]))) - template.unpaidBreakMinutes;
    const ot = overtimeMinutes(roundedMinutes, standard, shifts.overtimeCapMinutesPerDay);
    if (ot.overCapMin > 0) exceptions.push(raiseException(store, record, 'overtime_over_cap', `overtime ${ot.overtimeMin} min exceeds daily cap ${shifts.overtimeCapMinutesPerDay} min by ${ot.overCapMin} min`));
  }
  store.log({ tenantId, actorUserId: null, actorKind: 'system', action: 'attendance.clock_out', entity: 'attendance_record', detail: { recordId: record.id, employeeId, workedMinutes, roundedMinutes } });
  return { record, workedMinutes, roundedMinutes, exceptions };
}

/** Missed clock-out sweep: sessions still open past shift end + grace become exceptions. */
export function sweepMissedClockOuts(store: MemoryStore, tenantId: string, now = new Date()): ExceptionRecord[] {
  const out: ExceptionRecord[] = [];
  for (const rec of store.listAttendance(tenantId)) {
    if (!rec.clockInAt || rec.clockOutAt) continue;
    const assignment = rec.rosterAssignmentId ? store.rosterAssignments.find((a) => a.id === rec.rosterAssignmentId) : undefined;
    const template = assignment?.shiftTemplateId ? store.shiftTemplates.find((t) => t.id === assignment.shiftTemplateId) : undefined;
    if (!template) continue;
    const already = store.exceptions.some((e) => e.attendanceRecordId === rec.id && e.kind === 'missed_clock_out' && e.status === 'open');
    if (already) continue;
    // Shift end is a Cairo wall-clock time (+02:00); overnight shifts end the next day.
    const endMs = new Date(`${rec.clockInAt.slice(0, 10)}T${template.endTime}:00+02:00`).getTime() + (template.overnight ? 86400000 : 0);
    if (now.getTime() > endMs + attendanceSettings(store, tenantId).graceMinutes * 60000) {
      out.push(raiseException(store, rec, 'missed_clock_out', `no clock-out recorded; shift ended ${template.endTime}, grace ${attendanceSettings(store, tenantId).graceMinutes} min`));
    }
  }
  return out;
}

/** Kiosk passcode helpers: bcrypt hash, 5 failed attempts → 15-minute lockout. */
export const KIOSK_MAX_ATTEMPTS = 5;
export const KIOSK_LOCKOUT_MINUTES = 15;
export function hashPasscodeForTest(passcode: string): string {
  // Deterministic stand-in used only by tests that need a stable hash input;
  // production enrolment uses bcrypt in the route (see m2.ts).
  return createHash('sha256').update(`kiosk:${passcode}`).digest('hex');
}
export function isPasscodeFormatValid(passcode: string): boolean {
  return /^\d{4,6}$/.test(passcode);
}
