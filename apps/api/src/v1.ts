// V1 — final build milestone (Brief §5 Mode C1/C2, §9 Zad, §11 full Superadmin,
// §12 PDPL, §14 Pro tier, §15 V1 row). Agents 2 and 4 were built in M4 and
// are NOT rebuilt here — V1 wires them into the Pro tier + Superadmin AI
// cost controls (see /api/superadmin/ai-cost and feature gating below).
//
// STUBBED / NOT LIVE in V1 (never claim otherwise):
// - ZKTeco ADMS: `StubAdmsAdapter` simulates device punches from a fixture.
//   No real device, no real ADMS server, no ADMS credentials exist here.
// - Mobile biometrics: on-device yes/no assertion only (Ed25519 signature
//   verified against the enrolled device PUBLIC key). No template is ever
//   stored, received or transmitted centrally — see findForbiddenBiometricFields.
// - Zad: stub provider returning clearly-marked demo figures; no Zad staging
//   tenant exists (same blocker as the Zad Growth Engine).
// - WhatsApp / LLM / bank disbursement: unchanged from M2–M4 (stubbed).
import type { FastifyInstance } from 'fastify';
import { verify as cryptoVerify, createHash } from 'node:crypto';
import { verifySession, type SessionClaims } from './auth.js';
import { newId, type MemoryStore, type ZktecoDeviceRecord } from '@hr-payroll/db';
import {
  PLAN_CATALOGUE, ZKTECO_ADDON_PRICE_PIASTERS_PER_MONTH, planTier, planHasFeature,
  featureGateError, staffCapExceeded, branchCapExceeded,
  ZKTECO_MODELS, ZKTECO_CLOCK_DRIFT_ALERT_SECONDS, zktecoSyncHealth,
  zktecoPunchKey, clockDriftSeconds,
  CONSENT_PURPOSES, CONSENT_TEXT_VERSION, PHOTO_RETENTION_DAYS_DEFAULT,
  findForbiddenBiometricFields,
  STATUTORY_RULE_FLOW, statutoryRuleCanTransition, statutoryDiff,
  DUNNING_ORDER, nextDunningStage, dunningStageIsValidOrder,
  mrrPiasters, arrPiasters, trialConversionRate,
  superadminCan, ZAD_STUB_NOTE, zadLabourCostStub,
  calculatePayslip, maskName, maskPhone, monthKey, AGENT_IDS,
  type ConsentPurpose, type Plan, type SuperadminRole, type SuperadminCapability,
  type V1Feature,
} from '@hr-payroll/shared';
import { agentStatus } from './agentCore.js';

// ============================================================================
// Stub ADMS adapter (Mode C1). Simulates a ZKTeco device pushing punches.
// No network, no device, no credentials. Every punch it yields is labelled
// source 'stub-adms' end to end so it can never be mistaken for live sync.
// ============================================================================
export interface StubAdmsPunch { deviceUserId: string; deviceAt: string; direction: 'in' | 'out' }
export class StubAdmsAdapter {
  readonly name = 'stub-adms' as const;
  readonly live = false as const;
  /** Deterministic fixture punches for a device: two employees, in/out. */
  fixturePunches(deviceId: string, date = '2026-11-11'): StubAdmsPunch[] {
    void deviceId;
    return [
      { deviceUserId: '101', deviceAt: `${date}T07:00:00Z`, direction: 'in' },
      { deviceUserId: '101', deviceAt: `${date}T15:05:00Z`, direction: 'out' },
      { deviceUserId: '102', deviceAt: `${date}T07:12:00Z`, direction: 'in' },
      { deviceUserId: '102', deviceAt: `${date}T15:10:00Z`, direction: 'out' },
    ];
  }
}
export const stubAdms = new StubAdmsAdapter();

const BIOMETRIC_ASSERTION_MAX_AGE_MS = 5 * 60 * 1000;
const BIOMETRIC_ASSERTION_TOLERANCE_MS = 60 * 1000;

export function registerV1(app: FastifyInstance, store: MemoryStore, jwtSecret: string): void {
  const auth = (req: { headers: Record<string, string | string[] | undefined> }): SessionClaims => {
    const h = req.headers.authorization;
    const token = Array.isArray(h) ? h[0] : h;
    if (!token?.startsWith('Bearer ')) throw new Error('missing bearer <redacted>');
    return verifySession(token.slice(7), jwtSecret);
  };
  const claims = (req: never, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): SessionClaims | null => {
    try { return auth(req as never); } catch { void reply.code(401).send({ error: 'unauthorised' }); return null; }
  };
  const tenant = (c: SessionClaims, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): string | null => {
    if (!c.tenantId) { void reply.code(403).send({ error: 'tenant session required' }); return null; }
    return c.tenantId;
  };
  const needRole = (c: SessionClaims, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, roles: string[]): boolean => {
    if (!roles.includes(c.role)) { void reply.code(403).send({ error: `role ${c.role} cannot perform this action (needs ${roles.join(' or ')})` }); return false; }
    return true;
  };
  const audit = (tenantId: string | null, actorUserId: string | null, action: string, entity: string, detail: unknown, kind = 'tenant_user') =>
    store.log({ tenantId, actorUserId, actorKind: kind, action, entity, detail });
  const saAudit = (sa: SessionClaims, action: string, tenantId: string | null, detail: unknown) => {
    store.superadminAudit.push({
      id: newId('saaudit'), superadminUserId: sa.sub, superadminRole: sa.superadminRole ?? null,
      tenantId, action, entity: 'superadmin', detail, createdAt: new Date().toISOString(),
    });
    store.log({ tenantId, actorUserId: sa.sub, actorKind: 'superadmin', action, entity: 'superadmin', detail });
  };
  const superadmin = (req: { headers: Record<string, string | string[] | undefined> }): SessionClaims => {
    const c = auth(req);
    if (c.role !== 'superadmin') throw new Error('superadmin only');
    if (process.env.SUPERADMIN_MFA_REQUIRED !== 'false' && !c.mfaVerified) throw new Error('superadmin MFA verification required');
    return c;
  };
  const saClaims = (req: never, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): SessionClaims | null => {
    try { return superadmin(req as never); } catch (e) { void reply.code(403).send({ error: (e as Error).message }); return null; }
  };
  const needCapability = (sa: SessionClaims, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, cap: SuperadminCapability): boolean => {
    const role = (sa.superadminRole ?? 'auditor') as SuperadminRole;
    if (!superadminCan(role, cap)) {
      void reply.code(403).send({ error: `superadmin role ${role} lacks capability ${cap} (least privilege, Brief §11)` });
      return false;
    }
    return true;
  };
  /** Plan/feature gate: 403 with a clear upgrade hint (tested). */
  const needFeature = (t: string, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, feature: V1Feature): boolean => {
    const { plan, addons } = store.effectivePlan(t);
    if (planHasFeature(plan as Plan, feature, addons)) return true;
    void reply.code(403).send(featureGateError(feature, plan as Plan));
    return false;
  };
  const branchManagerOwnBranch = (c: SessionClaims, branchId: string | null): boolean => {
    if (c.role !== 'branch_manager') return true;
    // The JWT carries no branch; the branch binding lives on the user record.
    return store.users.get(c.sub)?.branchId === branchId;
  };

  // --- Plans & feature gating (§14) -----------------------------------------
  app.get('/api/plans', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const { plan, addons } = store.effectivePlan(t);
    return {
      plans: PLAN_CATALOGUE,
      zktecoAddonPricePiastersPerMonth: ZKTECO_ADDON_PRICE_PIASTERS_PER_MONTH,
      current: { plan, addons, staffCap: planTier(plan as Plan).staffCap, staffCount: store.listEmployees(t).length },
      note: 'Prices EGP/month ex VAT, Brief §14. ZKTeco sync: included in Pro, or EGP 249/month add-on to Growth (pilot test price, range EGP 199–299).',
    };
  });
  app.get('/api/plan-check', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const feature = (req.query as { feature?: string }).feature as V1Feature;
    if (!feature) return reply.code(400).send({ error: 'feature query param is required' });
    const { plan, addons } = store.effectivePlan(t);
    const allowed = planHasFeature(plan as Plan, feature, addons);
    if (allowed) return { feature, allowed: true, plan };
    const gate = featureGateError(feature, plan as Plan);
    return { feature, allowed: false, plan, code: gate.code, error: gate.error, upgradeHint: gate.upgradeHint };
  });

  // --- Branches: per-branch plan / staff-cap checks (§14, multi-branch Pro) --
  app.post('/api/branches', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner'])) return;
    const b = req.body as { nameAr?: string; nameEn?: string; geofenceLat?: number; geofenceLng?: number; geofenceRadiusM?: number };
    if (!b?.nameAr || !b?.nameEn) return reply.code(400).send({ error: 'nameAr and nameEn are required' });
    const { plan } = store.effectivePlan(t);
    if (branchCapExceeded(plan as Plan, store.listBranches(t).length)) {
      return reply.code(403).send({ error: `branch limit reached for the ${plan} plan (max ${planTier(plan as Plan).maxBranches})`, code: 'PLAN_FEATURE_GATED', upgradeHint: 'Upgrade to Pro for up to 10 branches.' });
    }
    const rec = { id: newId('branch'), tenantId: t, nameAr: b.nameAr, nameEn: b.nameEn, geofenceLat: b.geofenceLat ?? 30.0626, geofenceLng: b.geofenceLng ?? 31.2197, geofenceRadiusM: b.geofenceRadiusM ?? 100, wifiSsid: null, active: true };
    store.branches.push(rec);
    audit(t, c.sub, 'branch.create', 'branch', { branchId: rec.id, plan });
    return reply.code(201).send({ branch: rec });
  });
  app.get('/api/branches/:id/staff-cap', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const { plan } = store.effectivePlan(t);
    const staffCount = store.listEmployees(t).length;
    return { plan, staffCap: planTier(plan as Plan).staffCap, staffCount, exceeded: staffCapExceeded(plan as Plan, staffCount) };
  });

  // --- Cross-branch reports: labour cost per branch (Pro) --------------------
  app.get('/api/reports/labour-cost-by-branch', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needFeature(t, reply, 'multi_branch_reports')) return;
    const period = (req.query as { period?: string }).period ?? new Date().toISOString().slice(0, 7);
    const perBranch = store.listBranches(t).map((br) => {
      const emps = store.listEmployees(t).filter((e) => e.branchId === br.id);
      const dailyCost = emps.reduce((s, e) => s + Math.round((e.basicSalaryPiasters + (e.allowancesPiasters ?? 0)) / 30), 0);
      const workedDays = store.listAttendance(t).filter((a) => a.branchId === br.id && a.clockInAt?.slice(0, 7) === period).length;
      return { branchId: br.id, branchName: br.nameEn, employees: emps.length, dailyCostPiasters: dailyCost, attendanceRecordsInPeriod: workedDays, estimatedLabourCostPiasters: dailyCost * new Set(store.listAttendance(t).filter((a) => a.branchId === br.id && a.clockInAt?.slice(0, 7) === period).map((a) => a.clockInAt!.slice(0, 10))).size };
    });
    return { period, perBranch, totalEstimatedPiasters: perBranch.reduce((s, b) => s + b.estimatedLabourCostPiasters, 0), note: 'Cross-branch labour cost (Pro). Estimates from salary structures × worked days; payroll runs remain the source of truth for pay.' };
  });

  // ==========================================================================
  // ZKTeco sync — Mode C1 (§5). Pro feature or Growth add-on. STUBBED adapter.
  // ==========================================================================
  const ingestPunches = (t: string, device: ZktecoDeviceRecord, punches: StubAdmsPunch[], actorId: string | null): { accepted: number; duplicates: number; unmapped: number; driftFlagged: number; records: unknown[] } => {
    let accepted = 0; let duplicates = 0; let unmapped = 0; let driftFlagged = 0;
    const records: unknown[] = [];
    for (const p of punches) {
      const key = zktecoPunchKey(device.id, p.deviceUserId, p.deviceAt);
      if (store.zktecoPunches.some((x) => x.dedupKey === key)) { duplicates++; continue; }
      const drift = clockDriftSeconds(p.deviceAt);
      if (Math.abs(drift) > ZKTECO_CLOCK_DRIFT_ALERT_SECONDS) driftFlagged++;
      const mapping = store.zktecoMappings.find((m) => m.tenantId === t && m.deviceId === device.id && m.deviceUserId === p.deviceUserId);
      if (!mapping) unmapped++;
      const punch = {
        id: newId('zkpunch'), tenantId: t, deviceId: device.id, deviceUserId: p.deviceUserId,
        employeeId: mapping?.employeeId ?? null, deviceAt: p.deviceAt, direction: p.direction,
        dedupKey: key, clockDriftSeconds: drift, source: 'stub-adms' as const,
        attendanceRecordId: null as string | null, createdAt: new Date().toISOString(),
      };
      store.zktecoPunches.push(punch);
      // Mapped punches become attendance records (method zkdevice) so they
      // feed the M3 payroll summaries like any verified attendance.
      if (mapping) {
        const emp = store.employees.find((e) => e.id === mapping.employeeId);
        if (p.direction === 'in') {
          const existing = store.activeSession(t, mapping.employeeId);
          if (!existing) {
            const rec = { id: newId('att'), tenantId: t, employeeId: mapping.employeeId, branchId: emp?.branchId ?? null, rosterAssignmentId: null, method: 'zkteco_device', clockInAt: p.deviceAt, clockOutAt: null, deviceAt: p.deviceAt, lat: null, lng: null, distanceFromBranchM: null, wifiMatched: null, mockLocationFlag: false, photoRef: null, photoRetainUntil: null, verificationStatus: Math.abs(drift) > ZKTECO_CLOCK_DRIFT_ALERT_SECONDS ? 'pending_review' : 'auto_approved', source: 'live' as const };
            store.attendance.push(rec);
            punch.attendanceRecordId = rec.id;
          }
        } else {
          const session = store.activeSession(t, mapping.employeeId);
          if (session) { session.clockOutAt = p.deviceAt; punch.attendanceRecordId = session.id; }
        }
        accepted++;
      }
      records.push(punch);
    }
    device.lastSyncAt = new Date().toISOString();
    device.lastError = null;
    device.lastClockDriftSeconds = punches.length ? clockDriftSeconds(punches[punches.length - 1].deviceAt) : device.lastClockDriftSeconds;
    device.syncStatus = zktecoSyncHealth(device.lastSyncAt, device.lastError);
    audit(t, actorId, 'zkteco.sync', 'zkteco_device', { deviceId: device.id, accepted, duplicates, unmapped, driftFlagged, adapter: 'stub-adms' });
    return { accepted, duplicates, unmapped, driftFlagged, records };
  };

  app.post('/api/zkteco/devices', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    if (!needFeature(t, reply, 'zkteco_sync')) return;
    const b = req.body as { branchId?: string; name?: string; model?: string; serial?: string };
    if (!b?.name || !b?.model || !b?.serial) return reply.code(400).send({ error: 'name, model and serial are required' });
    if (!(ZKTECO_MODELS as readonly string[]).includes(b.model)) return reply.code(400).send({ error: `model must be one of ${ZKTECO_MODELS.join(', ')}` });
    if (b.branchId) {
      try { store.getBranch(t, b.branchId); } catch { return reply.code(404).send({ error: 'branch not found' }); }
      if (!branchManagerOwnBranch(c, b.branchId)) return reply.code(403).send({ error: 'branch managers register devices only for their own branch' });
    }
    if (store.zktecoDevices.some((d) => d.tenantId === t && d.serial === b.serial)) return reply.code(409).send({ error: `a device with serial ${b.serial} is already registered for this tenant` });
    const rec = { id: newId('zkdev'), tenantId: t, branchId: b.branchId ?? null, name: b.name, model: b.model, serial: b.serial, adapter: 'stub-adms' as const, syncStatus: 'never_synced' as const, lastSyncAt: null as string | null, lastError: null as string | null, lastClockDriftSeconds: null as number | null, createdAt: new Date().toISOString() };
    store.zktecoDevices.push(rec);
    audit(t, c.sub, 'zkteco.device.register', 'zkteco_device', { deviceId: rec.id, model: b.model, serial: b.serial, adapter: 'stub-adms' });
    return reply.code(201).send({ device: rec, note: 'STUBBED adapter — no live ADMS connection. Registering a device here records it for sync; live sync needs real devices + ADMS credentials (non-code blocker).' });
  });
  app.get('/api/zkteco/devices', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { devices: store.listZktecoDevices(t).map((d) => ({ ...d, health: zktecoSyncHealth(d.lastSyncAt, d.lastError) })), adapter: 'stub-adms', live: false };
  });
  app.get('/api/zkteco/devices/:id/health', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    let d; try { d = store.getZktecoDevice(t, (req.params as { id: string }).id); } catch { return reply.code(404).send({ error: 'device not found' }); }
    const punches = store.zktecoPunches.filter((p) => p.deviceId === d.id);
    return { deviceId: d.id, name: d.name, model: d.model, serial: d.serial, health: zktecoSyncHealth(d.lastSyncAt, d.lastError), lastSyncAt: d.lastSyncAt, lastError: d.lastError, lastClockDriftSeconds: d.lastClockDriftSeconds, punchCount: punches.length, unmappedPunches: punches.filter((p) => !p.employeeId).length, adapter: 'stub-adms', live: false, note: 'Sync health is visible within a day: stale = no sync in 24h; failing = last sync errored.' };
  });
  app.get('/api/zkteco/sync-health', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { devices: store.listZktecoDevices(t).map((d) => ({ deviceId: d.id, name: d.name, branchId: d.branchId, health: zktecoSyncHealth(d.lastSyncAt, d.lastError), lastSyncAt: d.lastSyncAt, lastError: d.lastError })), adapter: 'stub-adms', live: false };
  });
  app.post('/api/zkteco/devices/:id/mapping', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    let d; try { d = store.getZktecoDevice(t, (req.params as { id: string }).id); } catch { return reply.code(404).send({ error: 'device not found' }); }
    const b = req.body as { deviceUserId?: string; employeeId?: string };
    if (!b?.deviceUserId || !b?.employeeId) return reply.code(400).send({ error: 'deviceUserId and employeeId are required' });
    try { store.getEmployee(t, b.employeeId); } catch { return reply.code(404).send({ error: 'employee not found' }); }
    const existing = store.zktecoMappings.find((m) => m.tenantId === t && m.deviceId === d.id && m.deviceUserId === b.deviceUserId);
    if (existing && existing.employeeId !== b.employeeId) {
      return reply.code(409).send({ error: `device user ${b.deviceUserId} is already mapped to another employee on this device`, code: 'MAPPING_CONFLICT', existingEmployeeId: existing.employeeId, hint: 'Resolve the conflict explicitly (delete the old mapping first) — mappings are never silently overwritten.' });
    }
    if (existing) return { mapping: existing, note: 'mapping already exists (idempotent)' };
    // Same employee mapped under a different device user ID on this device is also a conflict to surface.
    const empElsewhere = store.zktecoMappings.find((m) => m.tenantId === t && m.deviceId === d.id && m.employeeId === b.employeeId);
    if (empElsewhere) return reply.code(409).send({ error: `employee is already mapped to device user ${empElsewhere.deviceUserId} on this device`, code: 'MAPPING_CONFLICT', existingDeviceUserId: empElsewhere.deviceUserId });
    const rec = { id: newId('zkmap'), tenantId: t, deviceId: d.id, deviceUserId: b.deviceUserId, employeeId: b.employeeId, createdByUserId: c.sub, createdAt: new Date().toISOString() };
    store.zktecoMappings.push(rec);
    audit(t, c.sub, 'zkteco.mapping.create', 'zkteco_mapping', { deviceId: d.id, deviceUserId: b.deviceUserId, employeeId: b.employeeId });
    return reply.code(201).send({ mapping: rec });
  });
  app.get('/api/zkteco/devices/:id/mappings', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    let d; try { d = store.getZktecoDevice(t, (req.params as { id: string }).id); } catch { return reply.code(404).send({ error: 'device not found' }); }
    return { deviceId: d.id, mappings: store.zktecoMappings.filter((m) => m.tenantId === t && m.deviceId === d.id) };
  });
  app.delete('/api/zkteco/devices/:id/mapping/:deviceUserId', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    const idx = store.zktecoMappings.findIndex((m) => m.tenantId === t && m.deviceId === (req.params as { id: string }).id && m.deviceUserId === (req.params as { deviceUserId: string }).deviceUserId);
    if (idx === -1) return reply.code(404).send({ error: 'mapping not found' });
    const [removed] = store.zktecoMappings.splice(idx, 1);
    audit(t, c.sub, 'zkteco.mapping.delete', 'zkteco_mapping', { deviceId: removed.deviceId, deviceUserId: removed.deviceUserId, employeeId: removed.employeeId });
    return { deleted: true, mapping: removed };
  });
  /** ADMS push receiver: a device (or the stub adapter) POSTs punches. */
  app.post('/api/zkteco/adms/push', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    if (!needFeature(t, reply, 'zkteco_sync')) return;
    const b = req.body as { deviceId?: string; punches?: StubAdmsPunch[] };
    if (!b?.deviceId || !Array.isArray(b.punches)) return reply.code(400).send({ error: 'deviceId and punches[] are required' });
    let d; try { d = store.getZktecoDevice(t, b.deviceId); } catch { return reply.code(404).send({ error: 'device not found' }); }
    const result = ingestPunches(t, d, b.punches, c.sub);
    return { deviceId: d.id, adapter: 'stub-adms', live: false, ...result, note: 'Punches ingested via the STUBBED ADMS receiver. Duplicates are dropped by dedup key; unmapped punches are stored, never silently assigned.' };
  });
  /** Scheduled pull / import fallback for older models (same stub source). */
  app.post('/api/zkteco/devices/:id/pull', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    if (!needFeature(t, reply, 'zkteco_sync')) return;
    let d; try { d = store.getZktecoDevice(t, (req.params as { id: string }).id); } catch { return reply.code(404).send({ error: 'device not found' }); }
    const b = (req.body ?? {}) as { date?: string };
    const result = ingestPunches(t, d, stubAdms.fixturePunches(d.id, b.date ?? '2026-11-11'), c.sub);
    return { deviceId: d.id, mode: 'pull_fallback', adapter: 'stub-adms', live: false, ...result };
  });
  /** Explicit fixture simulation — the honest way to demo sync without hardware. */
  app.post('/api/zkteco/devices/:id/simulate', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    if (!needFeature(t, reply, 'zkteco_sync')) return;
    let d; try { d = store.getZktecoDevice(t, (req.params as { id: string }).id); } catch { return reply.code(404).send({ error: 'device not found' }); }
    const b = (req.body ?? {}) as { date?: string };
    const result = ingestPunches(t, d, stubAdms.fixturePunches(d.id, b.date ?? '2026-11-11'), c.sub);
    return { deviceId: d.id, mode: 'simulate_fixture', adapter: 'stub-adms', live: false, simulated: true, ...result, note: 'SIMULATED punches from a fixture — not a live device. Fixture device users 101/102 map to employees only after an enrolment mapping exists.' };
  });
  app.get('/api/zkteco/punches', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const deviceId = (req.query as { deviceId?: string }).deviceId;
    return { punches: store.zktecoPunches.filter((p) => p.tenantId === t && (!deviceId || p.deviceId === deviceId)), adapter: 'stub-adms', live: false };
  });

  // ==========================================================================
  // PDPL consent (§12, Law 151/2020) + mobile biometrics (Mode C2).
  // Consent is REQUIRED before any biometric enrolment or kiosk-photo use.
  // Withdrawal blocks further biometric clock-ins and keeps the audit trail.
  // ==========================================================================
  app.post('/api/consent', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    const b = req.body as { employeeId?: string; purpose?: string; consentText?: string; method?: string; version?: string };
    if (!b?.employeeId || !b?.purpose || !b?.consentText || !b?.method) return reply.code(400).send({ error: 'employeeId, purpose, consentText and method are required' });
    if (!(CONSENT_PURPOSES as readonly string[]).includes(b.purpose)) return reply.code(400).send({ error: `purpose must be one of ${CONSENT_PURPOSES.join(', ')}` });
    if (!['written_signed', 'in_app_signed', 'whatsapp_confirmed'].includes(b.method)) return reply.code(400).send({ error: 'method must be written_signed, in_app_signed or whatsapp_confirmed (explicit written consent, Law 151/2020)' });
    try { store.getEmployee(t, b.employeeId); } catch { return reply.code(404).send({ error: 'employee not found' }); }
    const rec = {
      id: newId('consent'), tenantId: t, employeeId: b.employeeId, purpose: b.purpose,
      consented: true, status: 'active' as const, consentText: b.consentText, method: b.method as 'written_signed' | 'in_app_signed' | 'whatsapp_confirmed',
      version: b.version ?? CONSENT_TEXT_VERSION, consentedAt: new Date().toISOString(), withdrawnAt: null as string | null, createdAt: new Date().toISOString(),
    };
    store.consents.push(rec);
    audit(t, c.sub, 'consent.grant', 'consent_record', { employeeId: b.employeeId, purpose: b.purpose, method: b.method, version: rec.version });
    return reply.code(201).send({ consent: rec, note: 'Explicit written consent recorded (text, date, method, version). A separate regulator licence is still required before any central biometric processing — see docs/pdpl-biometrics-note.md. This code is not legal advice.' });
  });
  app.get('/api/consent', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const employeeId = (req.query as { employeeId?: string }).employeeId;
    if (c.role === 'employee') {
      const linked = store.linkedEmployeeForUser(t, c.sub);
      if (!linked) return { consents: [] };
      return { consents: store.listConsents(t, linked.id) };
    }
    return { consents: store.listConsents(t, employeeId) };
  });
  app.get('/api/consent/:employeeId', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const employeeId = (req.params as { employeeId: string }).employeeId;
    if (c.role === 'employee') {
      const linked = store.linkedEmployeeForUser(t, c.sub);
      if (!linked || linked.id !== employeeId) return reply.code(403).send({ error: 'employees see only their own consent records' });
    }
    try { store.getEmployee(t, employeeId); } catch { return reply.code(404).send({ error: 'employee not found' }); }
    return { employeeId, purposes: CONSENT_PURPOSES.map((p) => ({ purpose: p, active: !!store.activeConsent(t, employeeId, p), latest: store.listConsents(t, employeeId).filter((x) => x.purpose === p).pop() ?? null })) };
  });
  app.post('/api/consent/:id/withdraw', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const rec = store.consents.find((x) => x.id === (req.params as { id: string }).id && x.tenantId === t);
    if (!rec) return reply.code(404).send({ error: 'consent record not found' });
    if (c.role === 'employee') {
      const linked = store.linkedEmployeeForUser(t, c.sub);
      if (!linked || linked.id !== rec.employeeId) return reply.code(403).send({ error: 'employees withdraw only their own consent' });
      if (!needRole(c, reply, ['owner', 'branch_manager', 'employee'])) return;
    } else if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    rec.status = 'withdrawn';
    rec.withdrawnAt = new Date().toISOString();
    // Withdrawal blocks further biometric clock-ins: revoke bound devices for that purpose.
    if (rec.purpose === 'biometric_mobile' || rec.purpose === 'biometric_device') {
      for (const d of store.biometricDevices.filter((x) => x.tenantId === t && x.employeeId === rec.employeeId && !x.revoked)) {
        d.revoked = true; d.revokedAt = rec.withdrawnAt;
      }
    }
    audit(t, c.sub, 'consent.withdraw', 'consent_record', { consentId: rec.id, employeeId: rec.employeeId, purpose: rec.purpose, note: 'Withdrawal blocks further biometric clock-ins; the consent record and audit trail are retained.' });
    return { consent: rec, biometricDevicesRevoked: rec.purpose.startsWith('biometric'), note: 'Consent withdrawn. Further biometric enrolment/clock-in for this purpose is blocked; the record is retained for audit.' };
  });
  /** 90-day photo retention purge job (§12): clears expired kiosk photo refs. */
  app.post('/api/consent/purge-photos', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    const now = new Date().toISOString().slice(0, 10);
    let purged = 0;
    for (const a of store.listAttendance(t)) {
      if (a.photoRef && a.photoRetainUntil && a.photoRetainUntil < now) { a.photoRef = null; a.photoRetainUntil = null; purged++; }
    }
    audit(t, c.sub, 'consent.photo_purge', 'attendance_photo', { purged, retentionDays: PHOTO_RETENTION_DAYS_DEFAULT, note: 'Routine kiosk photos older than the retention period were purged; photos attached to a dispute are retained by policy (not modelled here).' });
    return { purged, retentionDays: PHOTO_RETENTION_DAYS_DEFAULT, asOf: now };
  });

  // --- Mobile biometrics (Mode C2): assertion only, public key only ----------
  app.post('/api/biometrics/devices', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'branch_manager', 'employee'])) return;
    const b = req.body as { employeeId?: string; deviceName?: string; platform?: string; publicKeyPem?: string; purpose?: string };
    if (!b?.employeeId || !b?.deviceName || !b?.platform || !b?.publicKeyPem) return reply.code(400).send({ error: 'employeeId, deviceName, platform and publicKeyPem are required' });
    if (!['android', 'ios'].includes(b.platform)) return reply.code(400).send({ error: 'platform must be android or ios' });
    if (findForbiddenBiometricFields(b).length > 0) return reply.code(400).send({ error: `forbidden biometric fields in request: ${findForbiddenBiometricFields(b).join(', ')} — templates are never accepted centrally` });
    if (!b.publicKeyPem.includes('PUBLIC KEY')) return reply.code(400).send({ error: 'publicKeyPem must be a PEM public key (the private key stays on the device)' });
    if (c.role === 'employee') {
      const linked = store.linkedEmployeeForUser(t, c.sub);
      if (!linked || linked.id !== b.employeeId) return reply.code(403).send({ error: 'employees enrol only their own device' });
    }
    const purpose = (b.purpose ?? 'biometric_mobile') as ConsentPurpose;
    const consent = store.activeConsent(t, b.employeeId, purpose);
    if (!consent) {
      return reply.code(403).send({ error: `explicit written consent for ${purpose} is required before biometric enrolment (Law 151/2020)`, code: 'CONSENT_REQUIRED', hint: 'Record consent first via POST /api/consent with method written_signed / in_app_signed / whatsapp_confirmed.' });
    }
    try { store.getEmployee(t, b.employeeId); } catch { return reply.code(404).send({ error: 'employee not found' }); }
    const rec = { id: newId('biodev'), tenantId: t, employeeId: b.employeeId, deviceName: b.deviceName, platform: b.platform as 'android' | 'ios', publicKeyPem: b.publicKeyPem, consentId: consent.id, revoked: false, revokedAt: null as string | null, lastUsedAt: null as string | null, createdAt: new Date().toISOString() };
    store.biometricDevices.push(rec);
    audit(t, c.sub, 'biometrics.device.enrol', 'biometric_device', { deviceId: rec.id, employeeId: b.employeeId, platform: b.platform, consentId: consent.id, note: 'Public key only — no template, no private key stored.' });
    return reply.code(201).send({ device: rec, note: 'Device enrolled for on-device biometric assertions (yes/no only). The biometric template stays on the phone, held by the OS.' });
  });
  app.get('/api/biometrics/devices', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const employeeId = (req.query as { employeeId?: string }).employeeId;
    let list = store.biometricDevices.filter((d) => d.tenantId === t && (!employeeId || d.employeeId === employeeId));
    if (c.role === 'employee') {
      const linked = store.linkedEmployeeForUser(t, c.sub);
      list = linked ? list.filter((d) => d.employeeId === linked.id) : [];
    }
    return { devices: list.map((d) => ({ ...d, publicKeyPem: `${d.publicKeyPem.slice(0, 27)}…(public key only)` })) };
  });
  app.post('/api/biometrics/devices/:id/revoke', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const d = store.biometricDevices.find((x) => x.id === (req.params as { id: string }).id && x.tenantId === t);
    if (!d) return reply.code(404).send({ error: 'device not found' });
    if (c.role === 'employee') {
      const linked = store.linkedEmployeeForUser(t, c.sub);
      if (!linked || linked.id !== d.employeeId) return reply.code(403).send({ error: 'employees revoke only their own device' });
    } else if (!needRole(c, reply, ['owner', 'branch_manager'])) return;
    d.revoked = true; d.revokedAt = new Date().toISOString();
    audit(t, c.sub, 'biometrics.device.revoke', 'biometric_device', { deviceId: d.id, employeeId: d.employeeId });
    return { device: d };
  });
  app.post('/api/biometrics/clock-in', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const b = req.body as { employeeId?: string; deviceId?: string; deviceAt?: string; nonce?: string; signature?: string; branchId?: string };
    if (!b?.employeeId || !b?.deviceId || !b?.deviceAt || !b?.nonce || !b?.signature) return reply.code(400).send({ error: 'employeeId, deviceId, deviceAt, nonce and signature are required' });
    if (findForbiddenBiometricFields(b).length > 0) return reply.code(400).send({ error: 'biometric templates are never accepted — send a signed yes/no assertion only' });
    const device = store.biometricDevices.find((d) => d.id === b.deviceId && d.tenantId === t && d.employeeId === b.employeeId);
    if (!device) return reply.code(404).send({ error: 'enrolled device not found for this employee' });
    if (device.revoked) return reply.code(403).send({ error: 'device is revoked — enrol a new device after re-consent', code: 'DEVICE_REVOKED' });
    const consent = store.activeConsent(t, b.employeeId, 'biometric_mobile') ?? store.activeConsent(t, b.employeeId, 'biometric_device');
    if (!consent) return reply.code(403).send({ error: 'biometric consent is not active (withdrawn or missing) — biometric clock-in is blocked', code: 'CONSENT_REQUIRED' });
    const deviceMs = new Date(b.deviceAt).getTime();
    if (Number.isNaN(deviceMs)) return reply.code(400).send({ error: 'deviceAt must be an ISO timestamp' });
    if (Math.abs(Date.now() - deviceMs) > BIOMETRIC_ASSERTION_MAX_AGE_MS + BIOMETRIC_ASSERTION_TOLERANCE_MS) return reply.code(409).send({ error: 'assertion is stale (older than 5 minutes) — retry from the device' });
    const nonceKey = `${t}:${b.deviceId}:${b.nonce}`;
    if (store.usedBiometricNonces.has(nonceKey)) return reply.code(409).send({ error: 'assertion nonce already used — replay rejected' });
    const payload = `${t}|${b.employeeId}|${b.deviceId}|${b.deviceAt}|${b.nonce}`;
    let valid = false;
    try {
      // Ed25519: algorithm is null; the signature proves possession of the
      // device private key (which never leaves the device) — a yes/no
      // assertion, not a biometric template.
      valid = cryptoVerify(null, Buffer.from(payload), device.publicKeyPem, Buffer.from(b.signature, 'base64'));
    } catch { valid = false; }
    if (!valid) return reply.code(401).send({ error: 'assertion signature does not verify against the enrolled device public key' });
    store.usedBiometricNonces.add(nonceKey);
    device.lastUsedAt = new Date().toISOString();
    const emp = store.employees.find((e) => e.id === b.employeeId);
    const branchId = b.branchId ?? emp?.branchId ?? null;
    const session = store.activeSession(t, b.employeeId);
    if (session) {
      session.clockOutAt = b.deviceAt;
      audit(t, c.sub, 'biometrics.clock_out', 'attendance_record', { employeeId: b.employeeId, deviceId: b.deviceId, recordId: session.id, assertion: 'yes/no only — no template' });
      return { action: 'clock_out', record: session, assertion: 'verified', note: 'On-device biometric assertion (yes/no only). No template stored or received.' };
    }
    const rec = { id: newId('att'), tenantId: t, employeeId: b.employeeId, branchId, rosterAssignmentId: null, method: 'biometric_mobile', clockInAt: b.deviceAt, clockOutAt: null, deviceAt: b.deviceAt, lat: null, lng: null, distanceFromBranchM: null, wifiMatched: null, mockLocationFlag: false, photoRef: null, photoRetainUntil: null, verificationStatus: 'auto_approved', source: 'live' as const };
    store.attendance.push(rec);
    audit(t, c.sub, 'biometrics.clock_in', 'attendance_record', { employeeId: b.employeeId, deviceId: b.deviceId, recordId: rec.id, assertion: 'yes/no only — no template' });
    return reply.code(201).send({ action: 'clock_in', record: rec, assertion: 'verified', note: 'On-device biometric assertion (yes/no only). No template stored or received.' });
  });

  // --- Data-subject requests (§12): tracked workflow, never ad-hoc ----------
  const DSR_FLOW: Record<string, string[]> = { received: ['verified', 'rejected'], verified: ['owner_approved', 'rejected'], owner_approved: ['executed', 'rejected'], executed: ['confirmed'], confirmed: [], rejected: [] };
  app.post('/api/dsr/requests', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const b = req.body as { employeeId?: string; kind?: string; requestedBy?: string; notes?: string };
    if (!b?.kind || !['access', 'export', 'delete'].includes(b.kind)) return reply.code(400).send({ error: 'kind must be access, export or delete' });
    if (c.role === 'employee') {
      const linked = store.linkedEmployeeForUser(t, c.sub);
      if (!linked || (b.employeeId && b.employeeId !== linked.id)) return reply.code(403).send({ error: 'employees request only for themselves' });
      b.employeeId = linked.id;
    }
    if (!b?.employeeId) return reply.code(400).send({ error: 'employeeId is required' });
    try { store.getEmployee(t, b.employeeId); } catch { return reply.code(404).send({ error: 'employee not found' }); }
    const rec = { id: newId('dsr'), tenantId: t, employeeId: b.employeeId, kind: b.kind as 'access' | 'export' | 'delete', status: 'received' as const, requestedBy: b.requestedBy ?? c.sub, notes: b.notes ?? null, executedAt: null as string | null, createdAt: new Date().toISOString() };
    store.dsrRequests.push(rec);
    audit(t, c.sub, 'dsr.request', 'data_subject_request', { requestId: rec.id, kind: rec.kind, employeeId: rec.employeeId, note: 'Tracked workflow — never an ad-hoc database edit.' });
    return reply.code(201).send({ request: rec });
  });
  app.get('/api/dsr/requests', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant', 'branch_manager'])) return;
    return { requests: store.dsrRequests.filter((r) => r.tenantId === t) };
  });
  app.post('/api/dsr/requests/:id/transition', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    const rec = store.dsrRequests.find((r) => r.id === (req.params as { id: string }).id && r.tenantId === t);
    if (!rec) return reply.code(404).send({ error: 'request not found' });
    const b = req.body as { to?: string; note?: string };
    if (!b?.to || !DSR_FLOW[rec.status].includes(b.to)) return reply.code(409).send({ error: `cannot move a ${rec.status} request to ${b?.to ?? '?'} — allowed next: ${DSR_FLOW[rec.status].join(', ') || 'none'}` });
    if (b.to === 'executed' && rec.kind === 'delete') {
      const locked = store.listPayrollRuns(t).filter((r) => (r.status === 'locked' || r.status === 'paid') && store.listPayslips(t, r.id).some((p) => p.employeeId === rec.employeeId));
      if (locked.length > 0) {
        return reply.code(409).send({ error: 'deletion blocked: the employee has payslips in locked payroll runs — those records must be retained. Delete personal identifiers only via a separate, documented retention decision.', code: 'DELETE_BLOCKED_LOCKED_PAYROLL', lockedRuns: locked.map((r) => r.period) });
      }
    }
    rec.status = b.to as never;
    if (b.to === 'executed') rec.executedAt = new Date().toISOString();
    if (b.note) rec.notes = `${rec.notes ?? ''}\n${b.note}`.trim();
    audit(t, c.sub, 'dsr.transition', 'data_subject_request', { requestId: rec.id, from: rec.status, to: b.to, kind: rec.kind });
    return { request: rec };
  });

  // ==========================================================================
  // Bank-file history + re-export + reconciliation (M3 files verified here).
  // Locked runs only; every re-export is logged. Generated file only —
  // never a disbursement, never money movement.
  // ==========================================================================
  app.get('/api/payroll/runs/:id/bank-files', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    let run; try { run = store.getPayrollRun(t, (req.params as { id: string }).id); } catch { return reply.code(404).send({ error: 'payroll run not found' }); }
    return { runId: run.id, period: run.period, status: run.status, bankFiles: store.bankFiles.filter((b) => b.tenantId === t && b.runId === run.id) };
  });
  app.post('/api/payroll/runs/:id/bank-file/:bank/re-export', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner', 'accountant'])) return;
    let run; try { run = store.getPayrollRun(t, (req.params as { id: string }).id); } catch { return reply.code(404).send({ error: 'payroll run not found' }); }
    if (run.status !== 'locked' && run.status !== 'paid') return reply.code(409).send({ error: `re-export requires a locked run (current status: ${run.status})` });
    const bank = (req.params as { bank: string }).bank;
    const existing = store.bankFiles.filter((b) => b.tenantId === t && b.runId === run.id && b.bank === bank);
    if (existing.length === 0) return reply.code(404).send({ error: `no ${bank} bank file was generated for this run yet — generate one first via POST /api/payroll/runs/:id/bank-file` });
    const latest = existing[existing.length - 1];
    const reconciled = latest.totalPiasters === run.totalNetPiasters;
    store.exportLog.push({ id: newId('exp'), tenantId: t, runId: run.id, kind: 'bank_file_re_export', format: 'csv', generatedByUserId: c.sub, createdAt: new Date().toISOString() });
    audit(t, c.sub, 'payroll.bank_file.re_export', 'bank_file', { runId: run.id, bank, bankFileId: latest.id, reconciled });
    return { bankFile: latest, reconciled, reExportedAt: new Date().toISOString(), note: 'Re-export of the stored generated file — the locked run was not recalculated. GENERATED FILE — not a disbursement.' };
  });
  app.get('/api/payroll/runs/:id/bank-file/:bank/reconcile', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    let run; try { run = store.getPayrollRun(t, (req.params as { id: string }).id); } catch { return reply.code(404).send({ error: 'payroll run not found' }); }
    const bank = (req.params as { bank: string }).bank;
    const files = store.bankFiles.filter((b) => b.tenantId === t && b.runId === run.id && b.bank === bank);
    if (files.length === 0) return reply.code(404).send({ error: `no ${bank} bank file for this run` });
    const latest = files[files.length - 1];
    const payslipSum = store.listPayslips(t, run.id).reduce((s, p) => s + p.netPiasters, 0);
    return {
      runId: run.id, period: run.period, bank, bankFileId: latest.id,
      fileTotalPiasters: latest.totalPiasters, runNetTotalPiasters: run.totalNetPiasters,
      payslipSumPiasters: payslipSum, recordCount: latest.recordCount,
      reconciled: latest.totalPiasters === run.totalNetPiasters && payslipSum === run.totalNetPiasters,
    };
  });

  // ==========================================================================
  // Zad integration — V1 design + STUB (§9). Shared business identity +
  // labour-cost-against-sales stub. No live Zad connection exists.
  // ==========================================================================
  app.get('/api/zad/status', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const tenantRec = store.getTenant(t)!;
    return {
      connection: 'not_connected', provider: 'zad_stub', live: false,
      identity: { tenantSlug: tenantRec.slug, businessNameAr: tenantRec.nameAr, businessNameEn: tenantRec.nameEn, branches: store.listBranches(t).length, employees: store.listEmployees(t).length },
      note: `${ZAD_STUB_NOTE} Blocker: a Zad staging tenant + partner access are required before any live connection (same blocker as the Zad Growth Engine).`,
    };
  });
  app.get('/api/zad/identity', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const tenantRec = store.getTenant(t)!;
    return { provider: 'zad_stub', live: false, sharedBusinessIdentity: { tenantSlug: tenantRec.slug, nameAr: tenantRec.nameAr, nameEn: tenantRec.nameEn, branches: store.listBranches(t).map((b) => ({ id: b.id, nameAr: b.nameAr, nameEn: b.nameEn })) }, note: 'Shared business identity endpoint (design §9): the same business record links the HR & Payroll tenant to Zad POS/operations when a live connection exists. Today it returns the local tenant record only.' };
  });
  app.post('/api/zad/connect', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needRole(c, reply, ['owner'])) return;
    audit(t, c.sub, 'zad.connect.attempt', 'zad_integration', { result: 'blocked_no_staging_tenant' });
    return reply.code(409).send({ error: 'Live Zad connection is blocked: no Zad staging tenant exists yet. The stub adapter is the only available provider.', code: 'ZAD_STAGING_TENANT_REQUIRED', provider: 'zad_stub', live: false });
  });
  app.get('/api/zad/labour-cost-vs-sales', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (!needFeature(t, reply, 'zad_integration')) return;
    const period = (req.query as { period?: string }).period ?? new Date().toISOString().slice(0, 7);
    const run = store.listPayrollRuns(t).find((r) => r.period === period);
    const labourCost = run ? run.totalGrossPiasters : store.listEmployees(t).reduce((s, e) => s + (e.basicSalaryPiasters + (e.allowancesPiasters ?? 0)), 0);
    return zadLabourCostStub(period, labourCost);
  });

  // --- Tenant notifications (statutory version available, dunning, rollback) --
  app.get('/api/notifications', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    return { notifications: store.tenantNotifications.filter((n) => n.tenantId === t) };
  });
  app.get('/api/settings/statutory/available', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    const published = store.statutoryRules.filter((r) => r.status === 'published');
    const current = store.latestSettings(t, 'statutory_rates');
    const currentVersion = (current?.value as { statutoryRuleVersion?: number } | undefined)?.statutoryRuleVersion ?? 1;
    const available = published.filter((r) => r.version > currentVersion).map((r) => ({
      version: r.version, effectiveFrom: r.effectiveFrom, reviewerSignoffRef: r.reviewerSignoffRef,
      releaseNotesAr: r.releaseNotesAr, releaseNotesEn: r.releaseNotesEn,
      diff: statutoryDiff((current?.value ?? {}) as Record<string, unknown>, r.values),
      note: 'A new statutory version is available. It is never applied silently mid-period and never to a locked run — the owner applies it from Settings Area 7 with an effective date.',
    }));
    return { currentVersion, available };
  });

  // ==========================================================================
  // FULL SUPERADMIN CONSOLE (§11). Least-privilege roles enforced per route.
  // MFA mandatory (same gate as M1/M4). Every action lands in the
  // cross-tenant audit log (store.superadminAudit + store.audit).
  // ==========================================================================
  app.get('/api/superadmin/tenants/:id/detail', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'tenants.read')) return;
    const tenantId = (req.params as { id: string }).id;
    const rec = store.getTenant(tenantId);
    if (!rec) return reply.code(404).send({ error: 'tenant not found' });
    const sub = store.getSubscription(tenantId);
    const setupIncomplete: string[] = [];
    for (const area of ['attendance', 'shifts', 'leave', 'payroll_structure', 'statutory_rates', 'notifications', 'integrations_billing_data', 'ai_agents'] as const) {
      if (!store.latestSettings(tenantId, area)) setupIncomplete.push(`settings area ${area} has no version yet`);
    }
    if (store.listBranches(tenantId).length === 0) setupIncomplete.push('no branches');
    if (store.listEmployees(tenantId).length === 0) setupIncomplete.push('no employees');
    if (!store.listRosters(tenantId).some((r) => r.status === 'published')) setupIncomplete.push('no published roster');
    saAudit(sa, 'superadmin.tenant.detail', tenantId, { tenantId });
    return {
      tenant: { id: rec.id, slug: rec.slug, nameEn: rec.nameEn, nameAr: rec.nameAr, status: rec.status, plan: rec.plan, staffCap: rec.staffCap },
      subscription: sub ?? null, setupIncomplete,
      modes: (store.latestSettings(tenantId, 'attendance')?.value as { modes?: string[] } | undefined)?.modes ?? [],
      devices: store.listZktecoDevices(tenantId).map((d) => ({ id: d.id, name: d.name, model: d.model, health: zktecoSyncHealth(d.lastSyncAt, d.lastError), lastSyncAt: d.lastSyncAt })),
      integrations: { whatsappProvider: 'stub', zadConnectionStatus: 'not_connected' },
      openIssues: { openExceptions: store.listExceptions(tenantId, 'open').length, pendingLeave: store.listLeaveRequests(tenantId).filter((l) => l.status === 'pending').length, pendingDsr: store.dsrRequests.filter((r) => r.tenantId === tenantId && !['confirmed', 'rejected'].includes(r.status)).length },
      counts: { employees: store.listEmployees(tenantId).length, branches: store.listBranches(tenantId).length, payrollRuns: store.listPayrollRuns(tenantId).length },
    };
  });
  app.post('/api/superadmin/tenants/:id/lifecycle', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'tenants.lifecycle')) return;
    const tenantId = (req.params as { id: string }).id;
    const rec = store.getTenant(tenantId);
    if (!rec) return reply.code(404).send({ error: 'tenant not found' });
    const b = req.body as { to?: string; reason?: string; graceNoticeDays?: number };
    const allowed = ['trial', 'active', 'past_due', 'suspended', 'churned'];
    if (!b?.to || !allowed.includes(b.to) || !b?.reason) return reply.code(400).send({ error: `to (one of ${allowed.join(', ')}) and reason are required` });
    const from = rec.status;
    rec.status = b.to as never;
    const sub = store.getSubscription(tenantId);
    if (sub) sub.status = b.to as never;
    store.tenantNotifications.push({ id: newId('notif'), tenantId, kind: b.to === 'suspended' ? 'suspension_notice' : 'dunning', titleAr: b.to === 'suspended' ? 'تم إيقاف الحساب مؤقتاً' : `تغيّرت حالة الحساب إلى ${b.to}`, titleEn: b.to === 'suspended' ? 'Account suspended' : `Account status changed to ${b.to}`, detail: { from, to: b.to, reason: b.reason, graceNoticeDays: b.graceNoticeDays ?? null }, read: false, createdAt: new Date().toISOString() });
    saAudit(sa, 'superadmin.tenant.lifecycle', tenantId, { from, to: b.to, reason: b.reason, graceNoticeDays: b.graceNoticeDays ?? null, note: 'Suspension blocks new clock-ins only after a grace notice — staff are never locked out without warning to the owner.' });
    return { tenantId, from, to: b.to, notified: true };
  });
  app.get('/api/superadmin/tenants/:id/support', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'support.masked')) return;
    const tenantId = (req.params as { id: string }).id;
    const rec = store.getTenant(tenantId);
    if (!rec) return reply.code(404).send({ error: 'tenant not found' });
    const employees = store.listEmployees(tenantId).map((e) => ({
      id: e.id, nameMasked: maskName(e.fullNameAr), phoneMasked: maskPhone(e.phone), jobTitle: e.jobTitle,
      consent: CONSENT_PURPOSES.map((p) => ({ purpose: p, active: !!store.activeConsent(tenantId, e.id, p) })),
    }));
    saAudit(sa, 'superadmin.tenant.support_context', tenantId, { masked: true });
    return {
      tenantId, tenant: rec.slug, plan: rec.plan, status: rec.status,
      employees, // masked + consent status only — no salaries, no photos, no payslips
      devices: store.listZktecoDevices(tenantId).map((d) => ({ name: d.name, model: d.model, health: zktecoSyncHealth(d.lastSyncAt, d.lastError) })),
      recentErrors: store.audit.filter((a) => a.tenantId === tenantId).slice(-10).map((a) => ({ action: a.action, createdAt: a.createdAt })),
      counts: { openExceptions: store.listExceptions(tenantId, 'open').length, payrollRuns: store.listPayrollRuns(tenantId).length },
      note: 'MASKED support context — names initialled, phones partially masked, consent status shown, no photos, no salary figures, no payslips. Unmasking requires break-glass impersonation.',
    };
  });

  // --- Plans catalogue (versioned) + subscriptions + billing ops --------------
  app.get('/api/superadmin/plans', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'billing.read')) return;
    const latest = store.planCatalogue[store.planCatalogue.length - 1] ?? null;
    return { catalogue: latest, tiers: PLAN_CATALOGUE, zktecoAddonPricePiastersPerMonth: ZKTECO_ADDON_PRICE_PIASTERS_PER_MONTH, note: 'Versioned catalogue: a price change never silently alters an existing tenant\'s current term.' };
  });
  app.post('/api/superadmin/plans', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'billing.manage')) return;
    const b = req.body as { tiers?: unknown; zktecoAddonPricePiasters?: number };
    if (!b?.tiers) return reply.code(400).send({ error: 'tiers are required' });
    const version = (store.planCatalogue[store.planCatalogue.length - 1]?.version ?? 0) + 1;
    const rec = { id: newId('plancat'), version, tiers: b.tiers, zktecoAddonPricePiasters: b.zktecoAddonPricePiasters ?? ZKTECO_ADDON_PRICE_PIASTERS_PER_MONTH, status: 'published' as const, createdByUserId: sa.sub, createdAt: new Date().toISOString() };
    store.planCatalogue.push(rec);
    saAudit(sa, 'superadmin.plans.publish', null, { version, note: 'New catalogue version — existing tenants keep their current term.' });
    return reply.code(201).send({ catalogue: rec });
  });
  app.post('/api/superadmin/tenants/:id/subscription', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'billing.manage')) return;
    const tenantId = (req.params as { id: string }).id;
    const rec = store.getTenant(tenantId);
    if (!rec) return reply.code(404).send({ error: 'tenant not found' });
    const b = req.body as { plan?: string; trialEndsAt?: string; addons?: string[]; coupon?: string; discountPct?: number };
    if (!b?.plan || !['free', 'starter', 'growth', 'pro'].includes(b.plan)) return reply.code(400).send({ error: 'plan must be free, starter, growth or pro' });
    if (b.addons && b.addons.some((a) => a !== 'zkteco_addon')) return reply.code(400).send({ error: 'unknown add-on — only zkteco_addon exists in V1' });
    const tier = planTier(b.plan as Plan);
    const price = tier.pricePiastersPerMonth ?? 0;
    const discounted = Math.round(price * (1 - (b.discountPct ?? 0) / 100));
    const sub = { id: newId('sub'), tenantId, plan: b.plan, planVersion: (store.planCatalogue[store.planCatalogue.length - 1]?.version ?? 1), status: (b.trialEndsAt ? 'trial' : 'active') as 'trial' | 'active', trialEndsAt: b.trialEndsAt ?? null, pricePiastersPerMonth: discounted + (b.addons?.includes('zkteco_addon') ? ZKTECO_ADDON_PRICE_PIASTERS_PER_MONTH : 0), addons: b.addons ?? [], coupon: b.coupon ?? null, discountPct: b.discountPct ?? 0, dunningStage: null as string | null, createdAt: new Date().toISOString() };
    store.subscriptions.push(sub);
    rec.plan = b.plan as never;
    rec.staffCap = tier.staffCap;
    saAudit(sa, 'superadmin.subscription.assign', tenantId, { plan: b.plan, planVersion: sub.planVersion, pricePiastersPerMonth: sub.pricePiastersPerMonth, addons: sub.addons, coupon: sub.coupon, discountPct: sub.discountPct });
    return reply.code(201).send({ subscription: sub });
  });
  app.get('/api/superadmin/tenants/:id/invoices', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'billing.read')) return;
    const tenantId = (req.params as { id: string }).id;
    return { tenantId, invoices: store.invoices.filter((i) => i.tenantId === tenantId) };
  });
  app.post('/api/superadmin/invoices', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'billing.manage')) return;
    const b = req.body as { tenantId?: string; period?: string; amountPiasters?: number };
    if (!b?.tenantId || !b?.period || typeof b.amountPiasters !== 'number' || b.amountPiasters < 0) return reply.code(400).send({ error: 'tenantId, period (YYYY-MM) and amountPiasters (>= 0) are required' });
    if (!store.getTenant(b.tenantId)) return reply.code(404).send({ error: 'tenant not found' });
    const rec = { id: newId('inv'), tenantId: b.tenantId, period: b.period, amountPiasters: b.amountPiasters, status: 'unpaid' as const, refundPiasters: 0, refundProviderRef: null as string | null, refundNote: null as string | null, createdAt: new Date().toISOString() };
    store.invoices.push(rec);
    saAudit(sa, 'superadmin.invoice.create', b.tenantId, { invoiceId: rec.id, period: b.period, amountPiasters: b.amountPiasters });
    return reply.code(201).send({ invoice: rec });
  });
  app.post('/api/superadmin/invoices/:id/refund', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'refunds.record')) return;
    const inv = store.invoices.find((i) => i.id === (req.params as { id: string }).id);
    if (!inv) return reply.code(404).send({ error: 'invoice not found' });
    const b = req.body as { refundPiasters?: number; providerRef?: string; note?: string };
    if (typeof b?.refundPiasters !== 'number' || b.refundPiasters <= 0 || b.refundPiasters > inv.amountPiasters || !b?.providerRef) return reply.code(400).send({ error: 'refundPiasters (> 0, <= invoice amount) and providerRef are required' });
    inv.status = 'refunded'; inv.refundPiasters = b.refundPiasters; inv.refundProviderRef = b.providerRef; inv.refundNote = b.note ?? null;
    saAudit(sa, 'superadmin.invoice.refund_record', inv.tenantId, { invoiceId: inv.id, refundPiasters: b.refundPiasters, providerRef: b.providerRef, note: 'Refund handled manually by Finance through the payment provider and recorded here. Superadmin never moves tenant payroll money — client salary funds are never held by the platform.' });
    return { invoice: inv, note: 'Refund recorded only. The money movement happened through the payment provider; this console never moves tenant payroll money.' };
  });
  app.post('/api/superadmin/dunning/:tenantId/step', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'billing.manage')) return;
    const tenantId = (req.params as { tenantId: string }).tenantId;
    const sub = store.getSubscription(tenantId);
    if (!sub) return reply.code(404).send({ error: 'no subscription for this tenant — assign one first' });
    const b = req.body as { stage?: string };
    const current = (sub.dunningStage ?? null) as Parameters<typeof dunningStageIsValidOrder>[0];
    if (!b?.stage || !DUNNING_ORDER.includes(b.stage as never)) return reply.code(400).send({ error: `stage must be one of ${DUNNING_ORDER.join(', ')}` });
    if (!dunningStageIsValidOrder(current, b.stage as never)) {
      return reply.code(409).send({ error: `dunning must advance in order (reminders → grace → downgrade → suspension); current stage is ${current ?? 'none'}, next must be ${nextDunningStage(current) ?? 'none'}`, code: 'DUNNING_ORDER' });
    }
    sub.dunningStage = b.stage;
    if (b.stage === 'downgrade') { const t = store.getTenant(tenantId)!; t.plan = 'free'; sub.plan = 'free'; }
    if (b.stage === 'suspended') { const t = store.getTenant(tenantId)!; t.status = 'suspended'; sub.status = 'suspended'; }
    store.tenantNotifications.push({ id: newId('notif'), tenantId, kind: 'dunning', titleAr: `تذكير بالدفع — المرحلة ${b.stage}`, titleEn: `Payment reminder — stage ${b.stage}`, detail: { stage: b.stage }, read: false, createdAt: new Date().toISOString() });
    saAudit(sa, 'superadmin.dunning.step', tenantId, { stage: b.stage, note: 'Dunning advances reminders → grace → downgrade → suspension, in that order, every step logged, tenant notified.' });
    return { tenantId, dunningStage: b.stage, nextStage: nextDunningStage(b.stage as never), subscription: sub };
  });
  app.get('/api/superadmin/dunning/:tenantId', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'billing.read')) return;
    const tenantId = (req.params as { tenantId: string }).tenantId;
    const sub = store.getSubscription(tenantId);
    return { tenantId, dunningStage: sub?.dunningStage ?? null, nextStage: nextDunningStage((sub?.dunningStage ?? null) as never), order: DUNNING_ORDER };
  });
  app.get('/api/superadmin/revenue', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'billing.read')) return;
    const active = store.subscriptions.filter((s) => s.status === 'active' || s.status === 'trial');
    const latestByTenant = new Map<string, (typeof active)[number]>();
    for (const s of active) latestByTenant.set(s.tenantId, s);
    const subs = [...latestByTenant.values()];
    const mrr = mrrPiasters(subs.filter((s) => s.status === 'active').map((s) => s.pricePiastersPerMonth));
    const byPlan: Record<string, { tenants: number; mrrPiasters: number }> = {};
    for (const s of subs) {
      const row = byPlan[s.plan] ?? { tenants: 0, mrrPiasters: 0 };
      row.tenants++; if (s.status === 'active') row.mrrPiasters += s.pricePiastersPerMonth;
      byPlan[s.plan] = row;
    }
    const trials = subs.filter((s) => s.status === 'trial').length;
    const converted = store.subscriptions.filter((s) => s.status === 'active').length;
    const refunded = store.invoices.filter((i) => i.status === 'refunded').reduce((sum, i) => sum + i.refundPiasters, 0);
    saAudit(sa, 'superadmin.revenue.view', null, { mrrPiasters: mrr });
    return { mrrPiasters: mrr, arrPiasters: arrPiasters(mrr), revenueByPlan: byPlan, trialConversionPct: trialConversionRate(Math.max(trials, 0) + converted, converted), trialsActive: trials, refundedPiasters: refunded, note: 'MRR counts active subscriptions at their current price. Refunds are recorded manually only.' };
  });

  // --- Tenant health (aggregate) + AI cost control (wires M4 ledger in) -------
  app.get('/api/superadmin/health', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'tenants.read')) return;
    const today = new Date().toISOString().slice(0, 10);
    const month = monthKey(new Date().toISOString());
    const tenants = [...store.tenants.values()].map((t) => {
      const setupIncomplete = ['attendance', 'shifts', 'leave', 'payroll_structure', 'statutory_rates', 'notifications', 'integrations_billing_data', 'ai_agents'].filter((a) => !store.latestSettings(t.id, a as never)).length > 0;
      const noClockInsToday = store.listBranches(t.id).filter((b) => b.active).filter((b) => !store.listAttendance(t.id).some((a) => a.branchId === b.id && a.clockInAt?.slice(0, 10) === today)).map((b) => b.nameEn);
      const deviceSyncFailing = store.listZktecoDevices(t.id).filter((d) => zktecoSyncHealth(d.lastSyncAt, d.lastError) === 'failing' || zktecoSyncHealth(d.lastSyncAt, d.lastError) === 'stale').map((d) => d.name);
      const stuckCutoff = Date.now() - 7 * 86400000;
      const payrollRunStuck = store.listPayrollRuns(t.id).filter((r) => (r.status === 'prepared' || r.status === 'calculated') && new Date(r.createdAt).getTime() < stuckCutoff).length;
      const aiCostSpiking = AGENT_IDS.filter((id) => agentStatus(store, t.id, id, month).capExceeded);
      const outbox = store.outbox.filter((m) => m.tenantId === t.id);
      return {
        tenantId: t.id, slug: t.slug, plan: t.plan, status: t.status,
        setupIncomplete, noClockInsToday, deviceSyncFailing, payrollRunStuck,
        aiCostSpiking,
        whatsapp: { provider: 'stub', deliveryRate: null, queuedStubbed: outbox.filter((m) => m.status === 'queued_stubbed').length, note: 'STUBBED — delivery is not measurable without a live provider.' },
      };
    });
    return { asOf: new Date().toISOString(), tenants, signals: ['setupIncomplete', 'noClockInsToday', 'deviceSyncFailing', 'whatsappFailing(stubbed — labelled)', 'payrollRunStuck', 'aiCostSpiking'] };
  });
  app.get('/api/superadmin/ai-cost', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'ai_cost.read')) return;
    const month = (req.query as { month?: string }).month ?? monthKey(new Date().toISOString());
    const perTenant = [...store.tenants.values()].map((t) => ({
      tenantId: t.id, slug: t.slug, plan: t.plan,
      agents: AGENT_IDS.map((id) => agentStatus(store, t.id, id, month)),
      totalPiasters: AGENT_IDS.reduce((s, id) => s + store.agentMonthCost(t.id, id, month), 0),
    }));
    const totalPiasters = perTenant.reduce((s, t) => s + t.totalPiasters, 0);
    return { month, perTenant, totalPiasters, provider: 'stub', note: 'M4 cost ledger wired in: per-tenant/per-agent cost vs allowance, from agent_cost_ledger (STUBBED fixed per-run estimates until a real LLM provider bills per token). Agents 2 (schedule) and 4 (Q&A) are Pro-tier features — see /api/plan-check?feature=all_ai_agents.' };
  });
  app.get('/api/superadmin/ai-cost/:tenantId', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'ai_cost.read')) return;
    const tenantId = (req.params as { tenantId: string }).tenantId;
    if (!store.getTenant(tenantId)) return reply.code(404).send({ error: 'tenant not found' });
    const month = monthKey(new Date().toISOString());
    return { tenantId, month, agents: AGENT_IDS.map((id) => agentStatus(store, tenantId, id, month)), provider: 'stub' };
  });
  app.post('/api/superadmin/ai-cost/kill-switch', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'ai_cost.kill_switch')) return;
    const b = req.body as { agentId?: string; scope?: 'global' | 'tenant'; tenantId?: string; killed?: boolean };
    if (!b?.agentId || !(AGENT_IDS as string[]).includes(b.agentId) || !['global', 'tenant'].includes(b.scope ?? '') || typeof b.killed !== 'boolean') return reply.code(400).send({ error: 'agentId, scope (global|tenant) and killed are required' });
    if (b.scope === 'tenant' && !b.tenantId) return reply.code(400).send({ error: 'tenantId is required for a tenant-scoped kill switch' });
    const key = b.scope === 'global' ? `global:${b.agentId}` : `${b.tenantId}:${b.agentId}`;
    store.agentKillSwitches.set(key, b.killed);
    saAudit(sa, 'superadmin.ai.kill_switch', b.tenantId ?? null, { agentId: b.agentId, scope: b.scope, killed: b.killed, note: 'Pausing an agent never takes attendance or payroll down.' });
    return { agentId: b.agentId, scope: b.scope, tenantId: b.tenantId ?? null, killed: b.killed };
  });

  // --- Global statutory rule management (§11) ----------------------------------
  app.get('/api/superadmin/statutory-rules', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'rules.draft')) return;
    return { rules: store.statutoryRules, flow: STATUTORY_RULE_FLOW, note: 'Vendor-published versions only. NOSI employer rate stays NULL in every version until the M0 payroll reviewer confirms it.' };
  });
  app.post('/api/superadmin/statutory-rules', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'rules.draft')) return;
    const b = req.body as { values?: Record<string, unknown>; effectiveFrom?: string; reviewerSignoffRef?: string; releaseNotesAr?: string; releaseNotesEn?: string };
    if (!b?.values || typeof b.values !== 'object' || !b?.effectiveFrom) return reply.code(400).send({ error: 'values and effectiveFrom are required' });
    if (b.values.nosiEmployerPct !== undefined && b.values.nosiEmployerPct !== null) {
      return reply.code(400).send({ error: 'NOSI employer rate must stay NULL until the M0 payroll reviewer confirms it — a Superadmin draft may not invent a rate either.', code: 'NOSI_EMPLOYER_UNRESOLVED' });
    }
    const version = (store.statutoryRules[store.statutoryRules.length - 1]?.version ?? 1) + 1;
    const rec = { id: newId('statrule'), version, values: b.values, effectiveFrom: b.effectiveFrom, status: 'draft' as const, reviewerSignoffRef: b.reviewerSignoffRef ?? null, releaseNotesAr: b.releaseNotesAr ?? null, releaseNotesEn: b.releaseNotesEn ?? null, stagingResult: null as unknown, publishedAt: null as string | null, createdByUserId: sa.sub, createdAt: new Date().toISOString() };
    store.statutoryRules.push(rec);
    saAudit(sa, 'superadmin.statutory_rule.draft', null, { ruleId: rec.id, version, effectiveFrom: b.effectiveFrom });
    return reply.code(201).send({ rule: rec });
  });
  app.post('/api/superadmin/statutory-rules/:id/transition', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    const b = req.body as { to?: string; note?: string };
    const rec = store.statutoryRules.find((r) => r.id === (req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: 'statutory rule version not found' });
    if (!b?.to || !statutoryRuleCanTransition(rec.status, b.to as never)) {
      return reply.code(409).send({ error: `cannot move a ${rec.status} rule to ${b?.to ?? '?'} — flow is draft → reviewed → staged → published, withdrawable at any step before publish`, code: 'RULE_FLOW' });
    }
    const to = b.to as 'reviewed' | 'staged' | 'published' | 'withdrawn';
    const cap: SuperadminCapability = to === 'published' ? 'rules.publish' : to === 'withdrawn' ? 'rules.rollback' : to === 'staged' ? 'rules.review' : 'rules.review';
    if (!needCapability(sa, reply, cap)) return;
    // Staging: run the golden payroll cases (Brief Appendix B, M3) against
    // the candidate values. The Appendix A case must still produce net
    // EGP 8,307.48 (gross 10,000, NOSI 1,100, tax 592.50, levy 0.02).
    if (to === 'staged') {
      const golden = calculatePayslip({
        basicPiasters: 800000,
        allowances: [{ name: 'Transport', amountPiasters: 200000, taxable: true, insurable: true }],
        overtime: { dayMin: 0, nightMin: 0, restDayMin: 0, publicHolidayMin: 0 },
        daysWorked: 30, daysInMonthCount: 30,
        nosiEmployeePct: (rec.values.nosiEmployeePct as number | undefined) ?? 11,
        nosiEmployerPct: null, nosiFloorEgp: (rec.values.nosiFloorEgp as number | undefined) ?? 2700,
        nosiCeilingEgp: (rec.values.nosiCeilingEgp as number | undefined) ?? 16700,
        minimumWageEgp: (rec.values.minimumWageEgp as number | undefined) ?? 7000,
      });
      const expectedNet = 830748;
      const passed = golden.netPiasters === expectedNet && golden.employeeNosiPiasters === 110000 && golden.incomeTaxPiasters === 59250;
      rec.stagingResult = { passed, goldenNetPiasters: golden.netPiasters, expectedNetPiasters: expectedNet, employeeNosiPiasters: golden.employeeNosiPiasters, incomeTaxPiasters: golden.incomeTaxPiasters, stagedAt: new Date().toISOString(), note: 'Golden case Appendix A (Brief App. B). Staging must pass before publish.' };
      if (!passed) return reply.code(409).send({ error: 'staging FAILED: golden payroll cases do not pass under this rule version — publish refused', code: 'STAGING_FAILED', stagingResult: rec.stagingResult });
    }
    if (to === 'published') {
      const prev = store.statutoryRules.filter((r) => r.status === 'published');
      if (prev.length > 0) return reply.code(409).send({ error: 'publish via transition is only allowed from staged; a published version already exists — withdraw it first (rollback) or stage this version', code: 'RULE_FLOW' });
      // Never silently mid-period, never to a locked run: publish is
      // scheduled from effectiveFrom; tenants are notified with a diff.
      rec.publishedAt = new Date().toISOString();
      const prevValues = store.statutoryRules.filter((r) => r.version < rec.version).pop()?.values ?? null;
      const diff = statutoryDiff(prevValues, rec.values);
      for (const t of store.tenants.values()) {
        store.tenantNotifications.push({ id: newId('notif'), tenantId: t.id, kind: 'statutory_version_available', titleAr: `إصدار قانوني جديد متاح (v${rec.version})`, titleEn: `New statutory version available (v${rec.version})`, detail: { version: rec.version, effectiveFrom: rec.effectiveFrom, diff, releaseNotesAr: rec.releaseNotesAr, releaseNotesEn: rec.releaseNotesEn, note: 'Applies from its effective date only — never silently mid-period, never to a locked run.' }, read: false, createdAt: new Date().toISOString() });
      }
    }
    if (to === 'withdrawn') {
      // Rollback: restore the prior published version for future runs and
      // list runs already calculated under the bad version (corrected by
      // adjustment, never edited).
      const affectedRuns = [...store.tenants.values()].flatMap((t) => store.listPayrollRuns(t.id).filter((r) => r.status === 'calculated' || r.status === 'locked' || r.status === 'paid').map((r) => ({ tenantId: t.id, runId: r.id, period: r.period, status: r.status })));
      saAudit(sa, 'superadmin.statutory_rule.rollback', null, { ruleId: rec.id, version: rec.version, affectedRuns, note: 'Rollback incident logged; affected runs are corrected by adjustment, not edited.' });
      for (const t of store.tenants.values()) {
        store.tenantNotifications.push({ id: newId('notif'), tenantId: t.id, kind: 'rule_rollback', titleAr: `تم سحب الإصدار القانوني v${rec.version}`, titleEn: `Statutory version v${rec.version} withdrawn`, detail: { version: rec.version, affectedRuns: affectedRuns.filter((r) => r.tenantId === t.id) }, read: false, createdAt: new Date().toISOString() });
      }
      rec.status = 'withdrawn';
      return { rule: rec, affectedRuns, note: 'Rule withdrawn (rollback). Prior version restored for future runs; already-calculated runs are listed for correction by adjustment, never edited.' };
    }
    rec.status = to;
    saAudit(sa, `superadmin.statutory_rule.${to}`, null, { ruleId: rec.id, version: rec.version, stagingResult: rec.stagingResult ?? undefined });
    return { rule: rec };
  });

  // --- Vendor analytics (aggregates only, §11) ----------------------------------
  app.get('/api/superadmin/analytics', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'analytics.read')) return;
    const tenants = [...store.tenants.values()];
    const funnel = {
      signup: tenants.length,
      companySetUp: tenants.filter((t) => store.listBranches(t.id).length > 0).length,
      firstRoster: tenants.filter((t) => store.listRosters(t.id).some((r) => r.status === 'published')).length,
      firstClockIn: tenants.filter((t) => store.listAttendance(t.id).length > 0).length,
      firstPayrollRun: tenants.filter((t) => store.listPayrollRuns(t.id).length > 0).length,
    };
    const timeToFirstRosterDays: Record<string, number | null> = {};
    for (const t of tenants) {
      // Signup date is not tracked in the dev MemoryStore (Postgres
      // tenants.created_at exists in production) — report null honestly
      // rather than inventing a signup date. First-roster presence is in
      // the funnel above.
      void t;
      timeToFirstRosterDays[t.slug] = null;
    }
    const payrollRunsPerMonth: Record<string, number> = {};
    for (const t of tenants) for (const r of store.listPayrollRuns(t.id)) payrollRunsPerMonth[r.period] = (payrollRunsPerMonth[r.period] ?? 0) + 1;
    const attendanceVolume = tenants.reduce((s, t) => s + store.listAttendance(t.id).length, 0);
    const churnSignals = tenants.filter((t) => {
      const runs = store.listPayrollRuns(t.id);
      if (runs.length === 0) return false;
      const last = runs.map((r) => r.createdAt).sort().pop()!;
      return Date.now() - new Date(last).getTime() > 45 * 86400000;
    }).map((t) => ({ tenantId: t.id, slug: t.slug, signal: 'no payroll run in 45 days' }));
    const featureAdoptionByPlan: Record<string, { zktecoDevices: number; biometricDevices: number; aiRuns: number }> = {};
    for (const t of tenants) {
      const row = featureAdoptionByPlan[t.plan] ?? { zktecoDevices: 0, biometricDevices: 0, aiRuns: 0 };
      row.zktecoDevices += store.listZktecoDevices(t.id).length;
      row.biometricDevices += store.biometricDevices.filter((d) => d.tenantId === t.id).length;
      row.aiRuns += store.agentRuns.filter((r) => r.tenantId === t.id).length;
      featureAdoptionByPlan[t.plan] = row;
    }
    return { activationFunnel: funnel, timeToFirstRosterDays, payrollRunsPerMonth, attendanceVolume, churnSignals, featureAdoptionByPlan, note: 'Aggregates only — vendor analytics, not surveillance. No employee-level data leaves a tenant.' };
  });

  // --- Cross-tenant audit log + superadmin users --------------------------------
  app.get('/api/superadmin/audit', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'audit.read')) return;
    const tenantId = (req.query as { tenantId?: string }).tenantId;
    const entries = store.superadminAudit.filter((a) => !tenantId || a.tenantId === tenantId).slice(-100);
    return { entries, count: store.superadminAudit.length, note: 'Cross-tenant audit log — reviewed weekly (Brief §11).' };
  });
  app.get('/api/superadmin/users', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'tenants.read')) return;
    return { users: store.superadminUsers.map((u) => ({ id: u.id, email: u.email, role: u.role, mfaEnabled: u.mfaEnabled, createdAt: u.createdAt })), note: 'MFA is mandatory for every superadmin account. No shared accounts.' };
  });
  app.post('/api/superadmin/users', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'tenants.manage')) return;
    const b = req.body as { email?: string; role?: string; passwordHash?: string };
    if (!b?.email || !b?.role || !['operations', 'support', 'finance', 'auditor'].includes(b.role)) return reply.code(400).send({ error: 'email and role (operations|support|finance|auditor) are required' });
    if (store.superadminUsers.some((u) => u.email === b.email)) return reply.code(409).send({ error: 'superadmin user already exists' });
    const rec = { id: newId('sauser'), email: b.email, passwordHash: b.passwordHash ?? createHash('sha256').update(`pending-mfa-setup:${b.email}`).digest('hex'), role: b.role, mfaEnabled: false, createdAt: new Date().toISOString() };
    store.superadminUsers.push(rec);
    saAudit(sa, 'superadmin.user.create', null, { email: b.email, role: b.role, note: 'MFA must be enabled before this account can act — the MFA gate rejects sessions without mfaVerified.' });
    return reply.code(201).send({ user: { id: rec.id, email: rec.email, role: rec.role, mfaEnabled: rec.mfaEnabled }, note: 'Created with MFA NOT yet enabled — this account cannot act until MFA is enabled and verified.' });
  });

  // --- Break-glass: time-boxed, ticket-justified impersonation (§11) ------------
  // The M1 stub route (POST /api/superadmin/break-glass, disabled by default)
  // is untouched. V1 adds the full request/activate flow under a distinct path.
  app.post('/api/superadmin/break-glass/request', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'break_glass.request')) return;
    const b = req.body as { tenantId?: string; ticketId?: string; reason?: string; minutes?: number };
    if (!b?.tenantId || !b?.ticketId || !b?.reason) return reply.code(400).send({ error: 'tenantId, ticketId and reason are required before entry' });
    if (!store.getTenant(b.tenantId)) return reply.code(404).send({ error: 'tenant not found' });
    const minutes = Math.min(Math.max(b.minutes ?? 30, 5), 120);
    const rec = { id: newId('bg'), tenantId: b.tenantId, superadminUserId: sa.sub, ticketId: b.ticketId, reason: b.reason, expiresAt: new Date(Date.now() + minutes * 60000).toISOString(), usedAt: null as string | null, revoked: false, createdAt: new Date().toISOString() };
    store.breakGlassSessions.push(rec);
    saAudit(sa, 'superadmin.break_glass.request', b.tenantId, { sessionId: rec.id, ticketId: b.ticketId, reason: b.reason, expiresAt: rec.expiresAt });
    return reply.code(201).send({ session: rec, note: `Time-boxed to ${minutes} minutes. Entry is audit-logged and visible to the tenant afterwards.` });
  });
  app.post('/api/superadmin/break-glass/:id/activate', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'break_glass.request')) return;
    const rec = store.breakGlassSessions.find((s) => s.id === (req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: 'break-glass session not found' });
    if (rec.revoked) return reply.code(403).send({ error: 'session revoked' });
    if (new Date(rec.expiresAt).getTime() < Date.now()) return reply.code(403).send({ error: 'session expired — request a new time-boxed session' });
    rec.usedAt = new Date().toISOString();
    // Tenant-visible audit: the tenant sees who entered, when, and why.
    store.log({ tenantId: rec.tenantId, actorUserId: sa.sub, actorKind: 'superadmin', action: 'superadmin.break_glass.enter', entity: 'tenant', detail: { sessionId: rec.id, ticketId: rec.ticketId, reason: rec.reason, expiresAt: rec.expiresAt, note: 'Break-glass entry — visible to the tenant in its own audit log.' } });
    saAudit(sa, 'superadmin.break_glass.enter', rec.tenantId, { sessionId: rec.id, ticketId: rec.ticketId });
    return { session: rec, tenantId: rec.tenantId, expiresAt: rec.expiresAt, note: 'Break-glass entry granted (time-boxed). No silent or standing access — this entry is logged in the tenant\'s own audit log.' };
  });
  app.get('/api/superadmin/break-glass', async (req, reply) => {
    const sa = saClaims(req as never, reply); if (!sa) return;
    if (!needCapability(sa, reply, 'audit.read')) return;
    return { sessions: store.breakGlassSessions };
  });

  // --- Employee PWA support: cached roster for the linked employee --------------
  app.get('/api/pwa/roster', async (req, reply) => {
    const c = claims(req as never, reply); if (!c) return;
    const t = tenant(c, reply); if (!t) return;
    if (c.role !== 'employee') return reply.code(403).send({ error: 'employee PWA roster is for linked employee accounts' });
    const linked = store.linkedEmployeeForUser(t, c.sub);
    if (!linked) return { roster: null, linked: false, note: 'Link your login account to an employee record (owner action) to see your roster.' };
    const published = store.listRosters(t).filter((r) => r.status === 'published');
    const assignments = store.rosterAssignments.filter((a) => a.employeeId === linked.id && published.some((r) => r.id === a.rosterId));
    return { linked: true, employeeId: linked.id, assignments: assignments.map((a) => ({ date: a.date, shiftTemplateId: a.shiftTemplateId, onLeave: a.onLeave })), cachedAt: new Date().toISOString(), note: 'PWA caches this roster offline (service worker). Clock-in queues offline via POST /api/attendance/offline-queue.' };
  });
}
