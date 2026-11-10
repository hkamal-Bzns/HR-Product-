// @hr-payroll/shared — pure, dependency-free helpers.
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
