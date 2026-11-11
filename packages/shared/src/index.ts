// @hr-payroll/shared — pure, dependency-free helpers.
export * from './payroll.js';
// Money is integer piasters everywhere. Phones normalise to +20….
// No payroll rates are asserted here: the NOSI employer rate is UNRESOLVED
// (Brief v2 §7/§10) and must stay null until a payroll reviewer confirms it at M0.

export type Role = 'owner' | 'accountant' | 'branch_manager' | 'employee';
export type SuperadminRole = 'operations' | 'support' | 'finance' | 'auditor';
export type TenantStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'churned';
export type Plan = 'free' | 'starter' | 'growth' | 'pro';

/** Egyptian phone normalisation: 010… / 2010… / +2010… -> +2010… */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+20')) return digits;
  if (digits.startsWith('20')) return `+${digits}`;
  if (digits.startsWith('0')) return `+20${digits.slice(1)}`;
  if (/^\d{10}$/.test(digits)) return `+20${digits}`;
  throw new Error(`invalid Egyptian phone: ${raw}`);
}

export function isValidEgyptianPhone(raw: string): boolean {
  try {
    const p = normalizePhone(raw);
    return /^\+20(10|11|12|15)\d{8}$/.test(p);
  } catch {
    return false;
  }
}

/** Money in piasters (integer). EGP 1 = 100 piasters. Never use floats for pay. */
export function egpToPiasters(egp: number): number {
  if (!Number.isFinite(egp)) throw new Error('amount must be finite');
  return Math.round(egp * 100);
}
export function piastersToEgp(piasters: number): number {
  if (!Number.isInteger(piasters)) throw new Error('piasters must be an integer');
  return piasters / 100;
}
export function formatEgp(piasters: number, locale = 'ar-EG'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(piastersToEgp(piasters));
}

// --- Roles / permission matrix (Brief §10, page 16) -----------------------
// C = can change, V = view only, - = no access. Branch managers never touch
// statutory rates. Employees see only their own data.
export type SettingsArea =
  | 'company_branches' | 'attendance' | 'shifts' | 'leave'
  | 'people_roles' | 'payroll_structure' | 'statutory_rates'
  | 'notifications' | 'integrations_billing_data';

export const SETTINGS_AREAS: SettingsArea[] = [
  'company_branches', 'attendance', 'shifts', 'leave', 'people_roles',
  'payroll_structure', 'statutory_rates', 'notifications', 'integrations_billing_data',
];

export type Permission = 'change' | 'view' | 'none';

export const PERMISSION_MATRIX: Record<Role, Record<SettingsArea, Permission>> = {
  owner: {
    company_branches: 'change', attendance: 'change', shifts: 'change', leave: 'change',
    people_roles: 'change', payroll_structure: 'change', statutory_rates: 'change',
    notifications: 'change', integrations_billing_data: 'change',
  },
  accountant: {
    company_branches: 'view', attendance: 'view', shifts: 'view', leave: 'view',
    people_roles: 'view', payroll_structure: 'change', statutory_rates: 'change',
    notifications: 'view', integrations_billing_data: 'view',
  },
  branch_manager: {
    company_branches: 'view', attendance: 'change', shifts: 'change', leave: 'change',
    people_roles: 'view', payroll_structure: 'view', statutory_rates: 'none',
    notifications: 'view', integrations_billing_data: 'none',
  },
  employee: {
    company_branches: 'none', attendance: 'view', shifts: 'view', leave: 'change',
    people_roles: 'none', payroll_structure: 'view', statutory_rates: 'none',
    notifications: 'view', integrations_billing_data: 'none',
  },
};

export function canChange(role: Role, area: SettingsArea): boolean {
  return PERMISSION_MATRIX[role][area] === 'change';
}
export function canView(role: Role, area: SettingsArea): boolean {
  return PERMISSION_MATRIX[role][area] !== 'none';
}

// --- Statutory rates (Brief §7/§10) ---------------------------------------
// NOSI insurable band 2026 (EGP 2,700–16,700) is carried from the brief's
// research and must be re-confirmed at M0. Employee NOSI 11% is the figure
// in both sources. Employer NOSI is UNRESOLVED — null by design.
export interface StatutoryRates {
  nosiEmployeePct: number; // 11
  /** null = UNRESOLVED, no default shipped. Do not invent a rate. */
  nosiEmployerPct: number | null;
  nosiFloorEgp: number; // 2700
  nosiCeilingEgp: number; // 16700
  martyrsFundPct: number; // 0.0002 (% value, i.e. 0.02 per mille) — per Brief §7, reviewer to confirm
  minimumWageEgp: number; // 7000
}

export const STATUTORY_RATES_UNRESOLVED: StatutoryRates = {
  nosiEmployeePct: 11,
  nosiEmployerPct: null,
  nosiFloorEgp: 2700,
  nosiCeilingEgp: 16700,
  martyrsFundPct: 0.0002,
  minimumWageEgp: 7000,
};

export function validateStatutoryRates(r: StatutoryRates): string[] {
  const errors: string[] = [];
  if (r.nosiEmployerPct === null) errors.push('NOSI employer rate is UNRESOLVED — needs reviewer confirmation at M0');
  if (r.nosiFloorEgp >= r.nosiCeilingEgp) errors.push('NOSI floor must be below ceiling');
  if (r.nosiEmployeePct < 0 || r.nosiEmployeePct > 100) errors.push('NOSI employee % out of range');
  return errors;
}

// --- Settings versioning ---------------------------------------------------
export interface SettingsVersion {
  id: string;
  tenantId: string;
  area: SettingsArea;
  version: number;
  effectiveFrom: string; // ISO date, no back-dating into a locked period
  value: Record<string, unknown>;
  changedByUserId: string;
  reason: string;
  createdAt: string;
}

export function nextSettingsVersion(
  current: SettingsVersion | null,
  tenantId: string,
  area: SettingsArea,
  value: Record<string, unknown>,
  changedByUserId: string,
  reason: string,
  effectiveFrom: string,
  lockedUntil?: string,
): SettingsVersion {
  if (!reason.trim()) throw new Error('a reason is required for a settings change');
  if (lockedUntil && effectiveFrom < lockedUntil) {
    throw new Error('effective date must not fall inside a locked period');
  }
  const now = new Date().toISOString();
  return {
    id: `sv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId,
    area,
    version: (current?.version ?? 0) + 1,
    effectiveFrom,
    value,
    changedByUserId,
    reason,
    createdAt: now,
  };
}

/** Impact preview: how many employees a settings change would affect. */
export function impactPreview(employeeCount: number, affectedEmployeeIds: string[]): {
  totalEmployees: number; affected: number; affectedIds: string[];
} {
  return { totalEmployees: employeeCount, affected: affectedEmployeeIds.length, affectedIds: affectedEmployeeIds };
}

// ============================================================================
// M2 — Attendance, Shifts & Leave (Brief §5, §6, §10 Areas 2–4, §15 M2)
// Pure helpers only. Money in piasters. No payroll calculation here (M3).
// ============================================================================

export type AttendanceMode = 'qr_geofence' | 'passcode_photo' | 'biometric_device';
export type RoundingMode = 'none' | '5' | '15';
export type RoundingDirection = 'nearest' | 'down' | 'up';
export type LeaveType = 'annual' | 'sick' | 'casual' | 'unpaid';
export type VerificationStatus = 'auto_approved' | 'pending_review' | 'rejected';
export type ExceptionKind =
  | 'missed_clock_out' | 'late' | 'early_leave' | 'off_location'
  | 'low_confidence' | 'overtime_over_cap' | 'missed_clock_in' | 'photo_mismatch';
export type ExceptionStatus = 'open' | 'resolved' | 'dismissed';
export type RosterStatus = 'draft' | 'published';
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type SwapStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** Geofence: haversine distance in metres between two lat/lng points. */
export function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
export function isWithinGeofence(lat: number, lng: number, centreLat: number, centreLng: number, radiusM: number): boolean {
  return haversineMetres(lat, lng, centreLat, centreLng) <= radiusM;
}

/** QR token windows: token = `<branchId>.<windowIndex>.<nonce>` (opaque, single-use per window). */
export function qrWindowIndex(atMs: number, rotationSeconds: number): number {
  return Math.floor(atMs / 1000 / rotationSeconds);
}
export function qrTokenWindow(at: Date, rotationSeconds: number): { windowIndex: number; expiresAtMs: number } {
  const windowIndex = qrWindowIndex(at.getTime(), rotationSeconds);
  return { windowIndex, expiresAtMs: (windowIndex + 1) * rotationSeconds * 1000 };
}
export function makeQrToken(branchId: string, at: Date, rotationSeconds: number, nonce: string): string {
  return `${branchId}.${qrWindowIndex(at.getTime(), rotationSeconds)}.${nonce}`;
}
/** A token is usable in its own window or the immediately previous one (clock skew / scan delay). */
export function isQrTokenWindowValid(token: string, nowMs: number, rotationSeconds: number, usedNonces: Set<string>): { valid: boolean; reason?: string } {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed token' };
  const [branchId, windowStr, nonce] = parts;
  if (!branchId || !nonce) return { valid: false, reason: 'malformed token' };
  const windowIndex = Number(windowStr);
  if (!Number.isInteger(windowIndex)) return { valid: false, reason: 'malformed token' };
  const current = qrWindowIndex(nowMs, rotationSeconds);
  if (windowIndex < current - 1 || windowIndex > current) return { valid: false, reason: 'token expired or not yet valid' };
  if (usedNonces.has(`${branchId}:${windowIndex}:${nonce}`)) return { valid: false, reason: 'token already used in this window' };
  return { valid: true };
}

/** Rounding of worked minutes. 'none' returns the value unchanged. */
export function roundMinutes(minutes: number, mode: RoundingMode, direction: RoundingDirection = 'nearest'): number {
  if (mode === 'none') return minutes;
  const step = Number(mode);
  if (direction === 'down') return Math.floor(minutes / step) * step;
  if (direction === 'up') return Math.ceil(minutes / step) * step;
  return Math.round(minutes / step) * step;
}

/** Late / early classification. Returns the flag and a human reason (kept visible, Brief §5). */
export function classifyArrival(scheduledStartMin: number, actualMin: number, graceMinutes: number, lateThresholdMinutes: number): { status: 'on_time' | 'late'; lateByMin: number; reason: string } {
  const lateBy = actualMin - scheduledStartMin;
  if (lateBy <= graceMinutes) return { status: 'on_time', lateByMin: Math.max(0, lateBy), reason: lateBy <= 0 ? 'arrived on time' : `${lateBy} minutes late, within grace of ${graceMinutes}` };
  return { status: 'late', lateByMin: lateBy, reason: `${lateBy} minutes late, grace is ${graceMinutes}, late threshold ${lateThresholdMinutes}` };
}
export function classifyDeparture(scheduledEndMin: number, actualMin: number, graceMinutes: number): { status: 'on_time' | 'early_leave'; earlyByMin: number; reason: string } {
  const earlyBy = scheduledEndMin - actualMin;
  if (earlyBy <= graceMinutes) return { status: 'on_time', earlyByMin: Math.max(0, earlyBy), reason: 'left on time' };
  return { status: 'early_leave', earlyByMin: earlyBy, reason: `left ${earlyBy} minutes early, grace is ${graceMinutes}` };
}

/** Velocity check: impossible travel between two punches (default ceiling 200 km/h — generous, flags only). */
export function impossibleTravel(distanceM: number, elapsedSeconds: number, maxKmh = 200): { impossible: boolean; kmh: number } {
  const kmh = elapsedSeconds <= 0 ? Infinity : (distanceM / 1000 / elapsedSeconds) * 3600;
  return { impossible: kmh > maxKmh, kmh };
}

/** Rest / overload guards (Brief §6, Labour Law 14 of 2025 as configured). */
export function restBetweenShiftsOk(prevEndMs: number, nextStartMs: number, minRestHours: number): { ok: boolean; restHours: number } {
  const restHours = (nextStartMs - prevEndMs) / 3600000;
  return { ok: restHours >= minRestHours, restHours };
}
export function weeklyHoursOk(minutesThisWeek: number, capHours: number): { ok: boolean; hours: number } {
  return { ok: minutesThisWeek / 60 <= capHours, hours: minutesThisWeek / 60 };
}
export function consecutiveDaysOk(consecutiveDays: number, maxConsecutiveDays: number): boolean {
  return consecutiveDays <= maxConsecutiveDays;
}
export function overtimeMinutes(workedMinutes: number, standardMinutes: number, capMinutesPerDay: number): { overtimeMin: number; overCapMin: number } {
  const overtimeMin = Math.max(0, workedMinutes - standardMinutes);
  return { overtimeMin, overCapMin: Math.max(0, overtimeMin - capMinutesPerDay) };
}

/** Leave accrual / balance math. All balances in days (half-days = 0.5). */
export function accruedDays(annualEntitlementDays: number, monthsWorked: number): number {
  return Math.round(((annualEntitlementDays / 12) * monthsWorked) * 100) / 100;
}
export function leaveBalance(entitlementDays: number, carriedDays: number, takenDays: number): number {
  return Math.round((entitlementDays + carriedDays - takenDays) * 100) / 100;
}
export function canRequestLeave(balanceDays: number, requestedDays: number, allowNegative: boolean, noticeDays: number, daysUntilStart: number, minNoticeDays: number): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (requestedDays <= 0) reasons.push('requested days must be positive');
  if (!allowNegative && requestedDays > balanceDays) reasons.push(`insufficient balance: ${balanceDays} days available, ${requestedDays} requested`);
  if (daysUntilStart < minNoticeDays) reasons.push(`minimum notice is ${minNoticeDays} days (requested ${daysUntilStart} days ahead)`);
  void noticeDays;
  return { ok: reasons.length === 0, reasons };
}

/** Egypt public holidays 2026, pre-loaded (Brief §6/§10 Area 4). Lunar dates are
 *  provisional — set by official announcement; the owner may edit this calendar.
 *  Fixed-date holidays are certain; lunar ones carry provisional: true. */
export interface PublicHoliday { date: string; nameAr: string; nameEn: string; provisional: boolean }
export const EGYPT_PUBLIC_HOLIDAYS_2026: PublicHoliday[] = [
  { date: '2026-01-01', nameAr: 'رأس السنة الميلادية', nameEn: "New Year's Day", provisional: false },
  { date: '2026-01-07', nameAr: 'عيد الميلاد المجيد', nameEn: 'Coptic Christmas', provisional: false },
  { date: '2026-01-25', nameAr: 'عيد ثورة 25 يناير وعيد الشرطة', nameEn: '25 January Revolution Day / Police Day', provisional: false },
  { date: '2026-03-20', nameAr: 'عيد الفطر', nameEn: 'Eid al-Fitr (day 1)', provisional: true },
  { date: '2026-03-21', nameAr: 'عيد الفطر', nameEn: 'Eid al-Fitr (day 2)', provisional: true },
  { date: '2026-03-22', nameAr: 'عيد الفطر', nameEn: 'Eid al-Fitr (day 3)', provisional: true },
  { date: '2026-04-13', nameAr: 'شم النسيم', nameEn: 'Sham el-Nessim', provisional: true },
  { date: '2026-04-25', nameAr: 'عيد تحرير سيناء', nameEn: 'Sinai Liberation Day', provisional: false },
  { date: '2026-05-01', nameAr: 'عيد العمال', nameEn: 'Labour Day', provisional: false },
  { date: '2026-05-27', nameAr: 'عيد الأضحى', nameEn: 'Eid al-Adha (day 1)', provisional: true },
  { date: '2026-05-28', nameAr: 'عيد الأضحى', nameEn: 'Eid al-Adha (day 2)', provisional: true },
  { date: '2026-05-29', nameAr: 'عيد الأضحى', nameEn: 'Eid al-Adha (day 3)', provisional: true },
  { date: '2026-05-30', nameAr: 'عيد الأضحى', nameEn: 'Eid al-Adha (day 4)', provisional: true },
  { date: '2026-06-16', nameAr: 'رأس السنة الهجرية', nameEn: 'Islamic New Year', provisional: true },
  { date: '2026-06-30', nameAr: 'ذكرى ثورة 30 يونيو', nameEn: '30 June Revolution Day', provisional: false },
  { date: '2026-07-23', nameAr: 'عيد ثورة 23 يوليو', nameEn: '23 July Revolution Day', provisional: false },
  { date: '2026-08-26', nameAr: 'المولد النبوي', nameEn: "Prophet Muhammad's Birthday", provisional: true },
  { date: '2026-10-06', nameAr: 'عيد القوات المسلحة', nameEn: 'Armed Forces Day', provisional: false },
];
export function isPublicHoliday(dateIso: string, holidays: PublicHoliday[] = EGYPT_PUBLIC_HOLIDAYS_2026): PublicHoliday | undefined {
  return holidays.find((h) => h.date === dateIso);
}

/** Default M2 settings values (Brief §10 Areas 2–4, guardrail 5: defaults ship correct, never blank). */
export const DEFAULT_ATTENDANCE_SETTINGS = {
  modes: ['qr_geofence', 'passcode_photo'] as AttendanceMode[],
  qrRotationSeconds: 60,
  graceMinutes: 10,
  lateThresholdMinutes: 10,
  earlyLeaveThresholdMinutes: 10,
  rounding: 'none' as RoundingMode,
  roundingDirection: 'nearest' as RoundingDirection,
  clockInWindowBeforeMin: 60,
  clockInWindowAfterMin: 30,
  missedPunchHandling: 'flag_only' as const,
  photoRequiredOnLowConfidence: true,
  kioskPhotoRequired: true,
  photoRetentionDays: 90,
  offlineToleranceHours: 24,
  geofenceRadiusM: 100,
  geofenceMaxM: 300,
  wifiSsid: null as string | null,
  reviewEscalationHours: 24,
};
export const DEFAULT_SHIFT_SETTINGS = {
  minRestHoursBetweenShifts: 11,
  maxConsecutiveDays: 6,
  weeklyHoursCap: 48,
  overtimeCapMinutesPerDay: 120,
  overtimeCapMinutesPerMonth: 1200,
  coverageMinimums: { Barista: 1, Waiter: 2 } as Record<string, number>,
  swapRequiresManagerApproval: true,
  openShiftRequiresManagerApproval: true,
  publishNotificationsOn: true,
};
export const DEFAULT_LEAVE_SETTINGS = {
  types: [
    { type: 'annual' as LeaveType, yearlyDays: 21, accrual: 'monthly' as const, carryOverCapDays: 7, negativeAllowed: false, minNoticeDays: 7, approver: 'branch_manager' as const, evidenceRequired: false },
    { type: 'sick' as LeaveType, yearlyDays: 15, accrual: 'upfront' as const, carryOverCapDays: 0, negativeAllowed: false, minNoticeDays: 0, approver: 'branch_manager' as const, evidenceRequired: true },
    { type: 'casual' as LeaveType, yearlyDays: 6, accrual: 'upfront' as const, carryOverCapDays: 0, negativeAllowed: false, minNoticeDays: 1, approver: 'branch_manager' as const, evidenceRequired: false },
    { type: 'unpaid' as LeaveType, yearlyDays: 0, accrual: 'upfront' as const, carryOverCapDays: 0, negativeAllowed: true, minNoticeDays: 3, approver: 'owner' as const, evidenceRequired: false },
  ],
  publicHolidays: EGYPT_PUBLIC_HOLIDAYS_2026,
};

/** Dangerous-change detection (Brief §10 guardrail 4). Returns human reasons; empty = not dangerous. */
export function detectDangerousChange(area: string, oldValue: Record<string, unknown> | null, newValue: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (area === 'attendance' && oldValue) {
    const oldR = Number(oldValue.geofenceRadiusM ?? 100);
    const newR = Number(newValue.geofenceRadiusM ?? oldR);
    if (newR > oldR && newR > 300) reasons.push(`widening geofence from ${oldR}m to ${newR}m (beyond 300m limit)`);
    if (oldValue.kioskPhotoRequired !== false && newValue.kioskPhotoRequired === false) reasons.push('disabling kiosk photo proof');
    if (oldValue.photoRequiredOnLowConfidence !== false && newValue.photoRequiredOnLowConfidence === false) reasons.push('disabling photo proof on low-confidence clock-in');
    if (Number(oldValue.photoRetentionDays ?? 90) > Number(newValue.photoRetentionDays ?? 90)) reasons.push('shortening kiosk photo retention');
  }
  if (area === 'shifts' && oldValue) {
    const oldCap = Number(oldValue.overtimeCapMinutesPerDay ?? 120);
    const newCap = Number(newValue.overtimeCapMinutesPerDay ?? oldCap);
    if (newCap > oldCap) reasons.push(`raising daily overtime cap from ${oldCap} to ${newCap} minutes`);
  }
  if (area === 'statutory_rates') reasons.push('statutory rate edit');
  if (area === 'payroll_structure' && oldValue) {
    const oldDay = Number(oldValue.payDay ?? 28);
    const newDay = Number(newValue.payDay ?? oldDay);
    if (newDay !== oldDay) reasons.push(`changing pay day from ${oldDay} to ${newDay} — affects every employee's pay date`);
    const oldPeriod = String(oldValue.payPeriod ?? 'monthly');
    const newPeriod = String(newValue.payPeriod ?? oldPeriod);
    if (newPeriod !== oldPeriod) reasons.push(`changing pay period from ${oldPeriod} to ${newPeriod}`);
  }
  return reasons;
}

// --- M3 defaults: Settings Areas 6–9 (Brief §10) ----------------------------
// Area 6 is client-owned (payroll structure); Area 7 is the vendor/reviewer's
// versioned rule set — the client never invents statutory rates. The NOSI
// employer rate stays null here too (M0 blocker).
export const DEFAULT_PAYROLL_STRUCTURE_SETTINGS = {
  payPeriod: 'monthly' as const,
  payDay: 28,
  currency: 'EGP',
  allowances: [
    { name: 'Transport', nameAr: 'بدل انتقال', fixedPiasters: 0, percentOfBasic: null as number | null, taxable: true, insurable: true },
    { name: 'Meal', nameAr: 'بدل وجبة', fixedPiasters: 0, percentOfBasic: null as number | null, taxable: true, insurable: true },
    { name: 'Housing', nameAr: 'بدل سكن', fixedPiasters: 0, percentOfBasic: null as number | null, taxable: true, insurable: true },
  ],
  deductionTypes: ['absence', 'lateness', 'advance', 'loan', 'penalty'],
  templates: [
    { name: 'Full-time', nameAr: 'دوام كامل', contractType: 'full_time', basicPiasters: 700000, allowancesPiasters: 50000 },
    { name: 'Part-time', nameAr: 'دوام جزئي', contractType: 'part_time', basicPiasters: 400000, allowancesPiasters: 0 },
  ],
  advancePolicy: { maxAdvanceEgp: 5000, maxInstalments: 3, autoDeductPerRun: true },
  loanPolicy: { maxLoanEgp: 20000, maxInstalments: 12, autoDeductPerRun: true },
  defaultBank: null as string | null,
  payslipLanguage: 'ar' as const,
  payslipFooter: 'كشف راتب — القاهرة كافيه (تجريبي)',
};

export const DEFAULT_STATUTORY_SETTINGS = {
  nosiEmployeePct: 11,
  nosiEmployerPct: null as number | null, // UNRESOLVED — reviewer confirms at M0
  nosiFloorEgp: 2700,
  nosiCeilingEgp: 16700,
  martyrsFundPct: 0.0002,
  martyrsFundBasis: 'gross', // REVIEWER-UNCONFIRMED — see docs/tax-2024-research-note.md
  minimumWageEgp: 7000,
  taxRuleVersion: 1,
  taxRuleStatus: 'REVIEWER-UNCONFIRMED',
  overtimeRuleVersion: 1,
  overtimeRuleStatus: 'REVIEWER-UNCONFIRMED',
};

export const DEFAULT_NOTIFICATIONS_SETTINGS = {
  templates: [
    { event: 'clock_in_exception', template: 'payslip_exception', enabled: true, language: 'ar' },
    { event: 'roster_published', template: 'roster_published', enabled: true, language: 'ar' },
    { event: 'swap_request', template: 'swap_request', enabled: true, language: 'ar' },
    { event: 'leave_decision', template: 'leave_decision', enabled: true, language: 'ar' },
    { event: 'payslip_sent', template: 'payslip_sent', enabled: true, language: 'ar' },
    { event: 'payroll_approved', template: 'payroll_approved', enabled: true, language: 'ar' },
  ],
  dailyBriefing: { enabled: false, sendTime: '08:00', language: 'ar', recipients: ['owner'] as string[] },
  ownerLanguage: 'ar' as const,
  employeeLanguage: 'ar' as const,
};

export const DEFAULT_INTEGRATIONS_SETTINGS = {
  zktecoDevices: [] as { branchId: string; name: string; model: string; syncStatus: string }[],
  kioskTablets: [] as { name: string; branchId: string; bound: boolean; revoked: boolean }[],
  whatsappBusinessNumber: null as string | null,
  whatsappProvider: 'stub' as const, // STUBBED — live provider (360dialog/Gupshup) in V1
  zadConnectionStatus: 'not_connected' as const,
  plan: 'growth' as const,
  staffCap: 20,
  billing: { paymentMethod: null as string | null, invoices: [] as unknown[] },
  dataExport: { photoRetentionDays: 90 },
};
