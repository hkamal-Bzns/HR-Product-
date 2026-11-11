// Settings framework (Brief §10): versioned, effective-dated rule sets as data.
// Guardrails: locked runs immutable (no payroll runs exist in M1 — the guard
// is enforced here so M3 cannot silently rewrite history), statutory changes
// effective-dated + audit-logged + role-gated, impact preview, no silent overwrite.
import { MemoryStore } from '@hr-payroll/db';
import { canChange, nextSettingsVersion, detectDangerousChange, type Role, type SettingsArea, type SettingsVersion } from '@hr-payroll/shared';

export interface ChangeSettingsInput {
  store: MemoryStore;
  tenantId: string;
  area: SettingsArea;
  value: Record<string, unknown>;
  changedByUserId: string;
  role: Role;
  reason: string;
  effectiveFrom: string;
  lockedUntil?: string;
  affectedEmployeeIds?: string[];
  /** Guardrail 4: required when the change is dangerous (geofence widening, photo off, OT cap up, retention cut, statutory). */
  confirmDangerous?: boolean;
}

export function changeSettings(input: ChangeSettingsInput): { version: SettingsVersion; impact: { totalEmployees: number; affected: number; dangerous: string[]; publishedRosterAssignments: number } } {
  if (!canChange(input.role, input.area)) {
    throw new Error(`forbidden: role ${input.role} cannot change ${input.area}`);
  }
  const current = input.store.latestSettings(input.tenantId, input.area) ?? null;
  // Guardrail 4 — dangerous changes need explicit confirmation plus a reason.
  const dangerous = detectDangerousChange(input.area, current?.value ?? null, input.value);
  if (dangerous.length > 0 && !input.confirmDangerous) {
    throw new Error(`dangerous change requires confirmation: ${dangerous.join('; ')} — resubmit with confirmDangerous: true`);
  }
  const version = nextSettingsVersion(current, input.tenantId, input.area, input.value, input.changedByUserId, input.reason, input.effectiveFrom, input.lockedUntil);
  input.store.saveSettings({
    id: version.id, tenantId: version.tenantId, area: version.area, version: version.version,
    effectiveFrom: version.effectiveFrom, value: version.value,
    changedByUserId: version.changedByUserId, reason: version.reason, createdAt: version.createdAt,
  });
  input.store.log({
    tenantId: input.tenantId, actorUserId: input.changedByUserId, actorKind: 'tenant_user',
    action: 'settings.change', entity: `settings:${input.area}`,
    detail: { area: input.area, version: version.version, effectiveFrom: input.effectiveFrom, reason: input.reason },
  });
  const total = input.store.listUsers(input.tenantId).length;
  // Guardrail 3 — impact preview: a change touching a published roster is surfaced, never silent.
  const publishedRosterAssignments = (input.area === 'attendance' || input.area === 'shifts')
    ? input.store.publishedAssignmentCount(input.tenantId) : 0;
  return { version, impact: { totalEmployees: total, affected: input.affectedEmployeeIds?.length ?? total, dangerous, publishedRosterAssignments } };
}
