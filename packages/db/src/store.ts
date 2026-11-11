// In-memory store for M1 dev/tests + the tenancy guard.
// Production uses Postgres via Drizzle (schema.ts / migrations). The guard
// logic is identical in both paths: every read/write is scoped by tenant_id,
// and a cross-tenant access throws TenantIsolationError.
import type { Role, TenantStatus, Plan, SettingsArea } from '@hr-payroll/shared';

export class TenantIsolationError extends Error {
  constructor() { super('cross-tenant access denied'); this.name = 'TenantIsolationError'; }
}

export interface TenantRecord {
  id: string; slug: string; nameAr: string; nameEn: string;
  status: TenantStatus; plan: Plan; staffCap: number;
}
export interface UserRecord {
  id: string; tenantId: string; email: string; phone: string | null;
  passwordHash: string; role: Role; branchId: string | null;
}
export interface SettingsRecord {
  id: string; tenantId: string; area: SettingsArea; version: number;
  effectiveFrom: string; value: Record<string, unknown>;
  changedByUserId: string; reason: string; createdAt: string;
}
export interface AuditRecord {
  id: string; tenantId: string | null; actorUserId: string | null;
  actorKind: string; action: string; entity: string | null; detail: unknown; createdAt: string;
}

export function assertSameTenant(requestedTenantId: string, recordTenantId: string): void {
  if (requestedTenantId !== recordTenantId) throw new TenantIsolationError();
}

export class MemoryStore {
  tenants = new Map<string, TenantRecord>();
  users = new Map<string, UserRecord>();
  employees: EmployeeRecord[] = [];
  branches: BranchRecord[] = [];
  shiftTemplates: ShiftTemplateRecord[] = [];
  rosters: RosterRecord[] = [];
  rosterAssignments: RosterAssignmentRecord[] = [];
  attendance: AttendanceRecordRow[] = [];
  exceptions: ExceptionRecord[] = [];
  leaveRequests: LeaveRequestRecord[] = [];
  leaveBalances: LeaveBalanceRecord[] = [];
  kioskConsents: KioskConsentRecord[] = [];
  kioskPasscodes: KioskPasscodeRecord[] = [];
  swapRequests: SwapRequestRecord[] = [];
  openShifts: OpenShiftRecord[] = [];
  outbox: OutboxRecord[] = [];
  usedQrNonces = new Set<string>();
  lastPunchByEmployee = new Map<string, { lat: number; lng: number; atMs: number }>();
  settings = new Map<string, SettingsRecord[]>(); // key: tenantId:area
  audit: AuditRecord[] = [];
  featureFlags = new Map<string, boolean>(); // key: tenantId:key or global:key
  seeded = false;

  addTenant(t: TenantRecord): void { this.tenants.set(t.id, t); }
  getTenant(id: string): TenantRecord | undefined { return this.tenants.get(id); }

  addUser(u: UserRecord): void { this.users.set(u.id, u); }
  findUserByEmail(tenantId: string, email: string): UserRecord | undefined {
    return [...this.users.values()].find((u) => u.tenantId === tenantId && u.email === email);
  }
  /** Tenancy-guarded read: throws if the user belongs to another tenant. */
  getUser(tenantId: string, userId: string): UserRecord {
    const u = this.users.get(userId);
    if (!u) throw new Error('user not found');
    assertSameTenant(tenantId, u.tenantId);
    return u;
  }
  listUsers(tenantId: string): UserRecord[] {
    return [...this.users.values()].filter((u) => u.tenantId === tenantId);
  }

  saveSettings(s: SettingsRecord): void {
    const key = `${s.tenantId}:${s.area}`;
    const list = this.settings.get(key) ?? [];
    list.push(s);
    this.settings.set(key, list);
  }
  latestSettings(tenantId: string, area: SettingsArea): SettingsRecord | undefined {
    const list = this.settings.get(`${tenantId}:${area}`) ?? [];
    return list[list.length - 1];
  }
  listSettings(tenantId: string, area: SettingsArea): SettingsRecord[] {
    return this.settings.get(`${tenantId}:${area}`) ?? [];
  }

  log(audit: Omit<AuditRecord, 'id' | 'createdAt'>): AuditRecord {
    const rec: AuditRecord = {
      ...audit, id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
    };
    this.audit.push(rec);
    return rec;
  }
  // --- M2 tenant-scoped helpers -------------------------------------------
  listEmployees(tenantId: string): EmployeeRecord[] { return this.employees.filter((e) => e.tenantId === tenantId); }
  getEmployee(tenantId: string, id: string): EmployeeRecord {
    const e = this.employees.find((x) => x.id === id);
    if (!e) throw new Error('employee not found');
    assertSameTenant(tenantId, e.tenantId);
    return e;
  }
  listBranches(tenantId: string): BranchRecord[] { return this.branches.filter((b) => b.tenantId === tenantId); }
  getBranch(tenantId: string, id: string): BranchRecord {
    const b = this.branches.find((x) => x.id === id);
    if (!b) throw new Error('branch not found');
    assertSameTenant(tenantId, b.tenantId);
    return b;
  }
  listAttendance(tenantId: string): AttendanceRecordRow[] { return this.attendance.filter((a) => a.tenantId === tenantId); }
  activeSession(tenantId: string, employeeId: string): AttendanceRecordRow | undefined {
    return this.attendance.find((a) => a.tenantId === tenantId && a.employeeId === employeeId && a.clockInAt && !a.clockOutAt);
  }
  listExceptions(tenantId: string, status?: string): ExceptionRecord[] {
    return this.exceptions.filter((e) => e.tenantId === tenantId && (!status || e.status === status));
  }
  addException(e: ExceptionRecord): void { this.exceptions.push(e); }
  listRosters(tenantId: string): RosterRecord[] { return this.rosters.filter((r) => r.tenantId === tenantId); }
  publishedAssignmentCount(tenantId: string): number {
    const published = new Set(this.rosters.filter((r) => r.tenantId === tenantId && r.status === 'published').map((r) => r.id));
    return this.rosterAssignments.filter((a) => published.has(a.rosterId)).length;
  }
  listLeaveRequests(tenantId: string): LeaveRequestRecord[] { return this.leaveRequests.filter((l) => l.tenantId === tenantId); }
  leaveBalanceFor(tenantId: string, employeeId: string, year: number, type: string): LeaveBalanceRecord | undefined {
    return this.leaveBalances.find((b) => b.tenantId === tenantId && b.employeeId === employeeId && b.year === year && b.type === type);
  }
}
// ============================================================================
// M2 — MemoryStore extensions (dev/test). Same tenancy rule: every record
// carries tenantId and every list is filtered by it.
// ============================================================================
export interface BranchRecord {
  id: string; tenantId: string; nameAr: string; nameEn: string;
  geofenceLat: number; geofenceLng: number; geofenceRadiusM: number;
  wifiSsid: string | null; active: boolean;
}
export interface EmployeeRecord {
  id: string; tenantId: string; branchId: string | null; fullNameAr: string;
  fullNameEn?: string | null; phone: string; jobTitle: string;
  basicSalaryPiasters: number;
  contractType?: string; allowancesPiasters?: number; startDate?: string;
  nationalIdLast4?: string | null;
}
export interface ShiftTemplateRecord {
  id: string; tenantId: string; branchId: string | null;
  nameAr: string; nameEn: string; startTime: string; endTime: string;
  overnight: boolean; unpaidBreakMinutes: number; status: 'active' | 'inactive';
}
export interface RosterRecord {
  id: string; tenantId: string; branchId: string | null; weekStart: string;
  status: 'draft' | 'published'; publishedAt: string | null; publishedByUserId: string | null;
}
export interface RosterAssignmentRecord {
  id: string; tenantId: string; rosterId: string; employeeId: string;
  date: string; shiftTemplateId: string | null; onLeave: boolean;
}
export interface AttendanceRecordRow {
  id: string; tenantId: string; employeeId: string; branchId: string | null;
  rosterAssignmentId: string | null; method: string;
  clockInAt: string | null; clockOutAt: string | null; deviceAt: string | null;
  lat: number | null; lng: number | null; distanceFromBranchM: number | null;
  wifiMatched: boolean | null; mockLocationFlag: boolean;
  photoRef: string | null; photoRetainUntil: string | null;
  verificationStatus: string; source: 'live' | 'offline_queue';
}
export interface ExceptionRecord {
  id: string; tenantId: string; attendanceRecordId: string | null;
  employeeId: string; branchId: string | null; kind: string;
  status: 'open' | 'resolved' | 'dismissed'; reason: string;
  resolvedByUserId: string | null; resolutionNote: string | null; resolvedAt: string | null;
  createdAt: string;
}
export interface LeaveRequestRecord {
  id: string; tenantId: string; employeeId: string; type: string;
  startDate: string; endDate: string; days: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  reason: string | null; decidedByUserId: string | null; decidedAt: string | null;
}
export interface LeaveBalanceRecord {
  tenantId: string; employeeId: string; year: number; type: string;
  entitlementDays: number; carriedDays: number; takenDays: number;
}
export interface KioskConsentRecord {
  tenantId: string; employeeId: string; consented: boolean;
  noticeShownAt: string | null; consentedAt: string | null; retentionDays: number;
}
export interface KioskPasscodeRecord {
  tenantId: string; employeeId: string; passcodeHash: string;
  failedAttempts: number; lockedUntil: string | null;
}
export interface SwapRequestRecord {
  id: string; tenantId: string; rosterAssignmentId: string;
  requesterEmployeeId: string; coverEmployeeId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'; decidedByUserId: string | null;
}
export interface OpenShiftRecord {
  id: string; tenantId: string; rosterAssignmentId: string | null;
  branchId: string | null; date: string; shiftTemplateId: string | null;
  status: 'open' | 'filled' | 'cancelled'; filledByEmployeeId: string | null;
  claimedByEmployeeId: string | null;
}
export interface OutboxRecord {
  id: string; tenantId: string; toPhone: string; template: string; body: string;
  status: 'queued_stubbed'; provider: 'stub'; createdAt: string;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
