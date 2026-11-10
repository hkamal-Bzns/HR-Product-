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
  employees: { id: string; tenantId: string; branchId: string | null; fullNameAr: string; phone: string; jobTitle: string; basicSalaryPiasters: number }[] = [];
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
}
