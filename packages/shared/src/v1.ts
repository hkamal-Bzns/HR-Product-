// @hr-payroll/shared — V1 pure helpers (Brief §5 Mode C1/C2, §11, §12, §14, §15 V1).
// No I/O, no secrets, no biometric data. Money in piasters. The NOSI employer
// rate stays NULL here too — V1 does not resolve the M0 blocker.
import type { Plan, SuperadminRole } from './index.js';

export type V1Feature =
  | 'zkteco_sync' | 'mobile_biometrics' | 'all_ai_agents'
  | 'multi_branch_reports' | 'advanced_reports' | 'zad_integration';

export interface PlanTier {
  plan: Plan;
  pricePiastersPerMonth: number | null; // null = free
  staffCap: number;
  maxBranches: number;
  features: V1Feature[];
  nameAr: string;
  nameEn: string;
}

/** Brief §14 pricing (EGP/month, ex VAT). Pro includes ZKTeco sync; Growth
 *  can buy it as an add-on at EGP 199–299/month (test in pilot — the
 *  catalogue default here is EGP 249). */
export const PLAN_CATALOGUE: PlanTier[] = [
  { plan: 'free', pricePiastersPerMonth: 0, staffCap: 5, maxBranches: 1, features: [], nameAr: 'مجاني', nameEn: 'Free' },
  { plan: 'starter', pricePiastersPerMonth: 49900, staffCap: 20, maxBranches: 2, features: ['mobile_biometrics'], nameAr: 'أساسي', nameEn: 'Starter' },
  { plan: 'growth', pricePiastersPerMonth: 99900, staffCap: 20, maxBranches: 3, features: ['mobile_biometrics', 'zad_integration'], nameAr: 'نمو', nameEn: 'Growth' },
  { plan: 'pro', pricePiastersPerMonth: 199900, staffCap: 100, maxBranches: 10, features: ['zkteco_sync', 'mobile_biometrics', 'all_ai_agents', 'multi_branch_reports', 'advanced_reports', 'zad_integration'], nameAr: 'احترافي', nameEn: 'Pro' },
];
export const ZKTECO_ADDON_PRICE_PIASTERS_PER_MONTH = 24900; // EGP 249 — Brief §14 range EGP 199–299, test in pilot
export const ZKTECO_ADDON_PRICE_RANGE_PIASTERS = { min: 19900, max: 29900 };

export function planTier(plan: Plan): PlanTier {
  return PLAN_CATALOGUE.find((p) => p.plan === plan) ?? PLAN_CATALOGUE[0];
}
export function planHasFeature(plan: Plan, feature: V1Feature, addonFlags: string[] = []): boolean {
  if (planTier(plan).features.includes(feature)) return true;
  // ZKTeco sync is a Growth add-on (Settings Area 9 / feature flag `zkteco_addon`).
  if (feature === 'zkteco_sync' && addonFlags.includes('zkteco_addon')) return true;
  return false;
}
export function featureGateError(feature: V1Feature, plan: Plan): { error: string; code: string; feature: V1Feature; currentPlan: Plan; upgradeHint: string } {
  const needed = feature === 'zkteco_sync' ? 'Pro, or the ZKTeco add-on (EGP 249/month) on Growth' : 'Pro';
  return {
    error: `feature '${feature}' is not included in the ${plan} plan`,
    code: 'PLAN_FEATURE_GATED',
    feature,
    currentPlan: plan,
    upgradeHint: `Upgrade to ${needed} to enable ${feature}. See Settings → Integrations & billing (Area 9).`,
  };
}
export function staffCapExceeded(plan: Plan, staffCount: number): boolean {
  return staffCount > planTier(plan).staffCap;
}
export function branchCapExceeded(plan: Plan, branchCount: number): boolean {
  return branchCount >= planTier(plan).maxBranches;
}

// --- ZKTeco (Mode C1) ---------------------------------------------------------
export const ZKTECO_MODELS = ['LX15', 'K20', 'MB10-VL', 'K50 Pro', 'Face + fingerprint'] as const;
export const ZKTECO_CLOCK_DRIFT_ALERT_SECONDS = 300; // 5 minutes — Brief App. B
export const ZKTECO_SYNC_STALE_HOURS = 24; // a silent failure must be visible within a day

export type ZktecoSyncHealth = 'ok' | 'stale' | 'failing' | 'never_synced';
export function zktecoSyncHealth(lastSyncAt: string | null, lastError: string | null, nowMs = Date.now()): ZktecoSyncHealth {
  if (lastError) return 'failing';
  if (!lastSyncAt) return 'never_synced';
  return nowMs - new Date(lastSyncAt).getTime() > ZKTECO_SYNC_STALE_HOURS * 3600000 ? 'stale' : 'ok';
}
/** Dedup key for a device punch: same device + device user + device time = one punch. */
export function zktecoPunchKey(deviceId: string, deviceUserId: string, deviceAt: string): string {
  return `${deviceId}|${deviceUserId}|${deviceAt}`;
}
export function clockDriftSeconds(deviceAt: string, serverAtMs = Date.now()): number {
  return Math.round((serverAtMs - new Date(deviceAt).getTime()) / 1000);
}

// --- PDPL consent (Brief §12, Law 151/2020) -----------------------------------
export type ConsentPurpose = 'biometric_mobile' | 'biometric_device' | 'kiosk_photo' | 'face_comparison';
export const CONSENT_PURPOSES: ConsentPurpose[] = ['biometric_mobile', 'biometric_device', 'kiosk_photo', 'face_comparison'];
export const CONSENT_TEXT_VERSION = 'v1-2026-11';
export const PHOTO_RETENTION_DAYS_DEFAULT = 90;
export type ConsentStatus = 'active' | 'withdrawn' | 'expired';
export interface ConsentRecordInput {
  employeeId: string; purpose: ConsentPurpose; consented: boolean;
  consentText: string; method: 'written_signed' | 'in_app_signed' | 'whatsapp_confirmed';
  version: string;
}
export function consentIsActive(c: { consented: boolean; status: ConsentStatus; withdrawnAt: string | null }): boolean {
  return c.consented && c.status === 'active' && !c.withdrawnAt;
}
/** Fields that must NEVER exist on any stored biometric record. The product
 *  receives a yes/no assertion only; templates stay on the device OS. */
export const FORBIDDEN_BIOMETRIC_FIELDS = ['fingerprintTemplate', 'faceTemplate', 'biometricTemplate', 'template', 'privateKey', 'fingerprint', 'faceScan', 'rawBiometric'] as const;
export function findForbiddenBiometricFields(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if ((FORBIDDEN_BIOMETRIC_FIELDS as readonly string[]).includes(k)) found.push(k);
      walk(val);
    }
  };
  walk(obj);
  return [...new Set(found)];
}

// --- Statutory rule publishing (§11) ------------------------------------------
export type StatutoryRuleStatus = 'draft' | 'reviewed' | 'staged' | 'published' | 'withdrawn';
export const STATUTORY_RULE_FLOW: Record<StatutoryRuleStatus, StatutoryRuleStatus[]> = {
  draft: ['reviewed', 'withdrawn'],
  reviewed: ['staged', 'withdrawn'],
  staged: ['published', 'withdrawn'],
  published: ['withdrawn'],
  withdrawn: [],
};
export function statutoryRuleCanTransition(from: StatutoryRuleStatus, to: StatutoryRuleStatus): boolean {
  return STATUTORY_RULE_FLOW[from].includes(to);
}
export function statutoryDiff(
  oldV: Record<string, unknown> | null, newV: Record<string, unknown>,
): { field: string; oldValue: unknown; newValue: unknown }[] {
  const keys = [...new Set([...Object.keys(oldV ?? {}), ...Object.keys(newV)])];
  return keys
    .filter((k) => JSON.stringify(oldV?.[k]) !== JSON.stringify(newV[k]))
    .map((k) => ({ field: k, oldValue: oldV?.[k] ?? null, newValue: newV[k] }));
}

// --- Dunning (§11): reminders → grace → downgrade → suspension, in order -----
export type DunningStage = 'reminder_1' | 'reminder_2' | 'grace' | 'downgrade' | 'suspended';
export const DUNNING_ORDER: DunningStage[] = ['reminder_1', 'reminder_2', 'grace', 'downgrade', 'suspended'];
export function nextDunningStage(current: DunningStage | null): DunningStage | null {
  if (!current) return 'reminder_1';
  const i = DUNNING_ORDER.indexOf(current);
  return i >= 0 && i < DUNNING_ORDER.length - 1 ? DUNNING_ORDER[i + 1] : null;
}
export function dunningStageIsValidOrder(current: DunningStage | null, next: DunningStage): boolean {
  return nextDunningStage(current) === next;
}

// --- Revenue / vendor analytics (§11, §14) ------------------------------------
export function mrrPiasters(monthlyPrices: number[]): number {
  return monthlyPrices.reduce((s, p) => s + p, 0);
}
export function arrPiasters(mrr: number): number { return mrr * 12; }
export function trialConversionRate(trials: number, converted: number): number | null {
  if (trials === 0) return null;
  return Math.round((converted / trials) * 10000) / 100; // percent, 2dp
}
export function daysBetweenDates(aIso: string, bIso: string): number {
  return Math.round((new Date(bIso).getTime() - new Date(aIso).getTime()) / 86400000);
}

// --- Superadmin roles (§11): least privilege ----------------------------------
// SuperadminRole is defined in index.ts; capabilities per role live here.
export type SuperadminCapability =
  | 'tenants.read' | 'tenants.manage' | 'tenants.lifecycle'
  | 'billing.read' | 'billing.manage' | 'refunds.record'
  | 'rules.draft' | 'rules.review' | 'rules.publish' | 'rules.rollback'
  | 'support.masked' | 'break_glass.request'
  | 'ai_cost.read' | 'ai_cost.kill_switch'
  | 'analytics.read' | 'audit.read';
export const SUPERADMIN_CAPABILITIES: Record<SuperadminRole, SuperadminCapability[]> = {
  operations: ['tenants.read', 'tenants.manage', 'tenants.lifecycle', 'billing.read', 'rules.draft', 'rules.review', 'rules.publish', 'rules.rollback', 'support.masked', 'break_glass.request', 'ai_cost.read', 'ai_cost.kill_switch', 'analytics.read', 'audit.read'],
  support: ['tenants.read', 'support.masked', 'break_glass.request', 'analytics.read', 'audit.read'],
  finance: ['tenants.read', 'billing.read', 'billing.manage', 'refunds.record', 'analytics.read', 'audit.read'],
  auditor: ['tenants.read', 'billing.read', 'analytics.read', 'audit.read'],
};
export function superadminCan(role: SuperadminRole, capability: SuperadminCapability): boolean {
  return SUPERADMIN_CAPABILITIES[role].includes(capability);
}

// --- Zad integration (V1 stub, §9) ---------------------------------------------
export const ZAD_STUB_NOTE = 'STUBBED — no Zad staging tenant exists, so no live Zad connection is possible yet. Figures below are clearly-marked demo figures, never real Zad sales data.';
export interface ZadLabourCostStub {
  provider: 'zad_stub';
  live: false;
  period: string;
  demoSalesEgp: number;
  demoLabourCostEgp: number;
  labourCostPctOfSales: number;
  note: string;
}
export function zadLabourCostStub(period: string, labourCostPiasters: number): ZadLabourCostStub {
  // Demo sales figure only — the stub has no Zad data source.
  const demoSalesEgp = 420000;
  const labourEgp = labourCostPiasters / 100;
  return {
    provider: 'zad_stub', live: false, period,
    demoSalesEgp, demoLabourCostEgp: labourEgp,
    labourCostPctOfSales: Math.round((labourEgp / demoSalesEgp) * 10000) / 100,
    note: ZAD_STUB_NOTE,
  };
}

// --- V2 (decided from pilot/churn data — NOT built in V1, Brief §15) -----------
export const V2_NOT_BUILT = [
  'Policy and hiring helpers',
  'Advanced analytics beyond the V1 vendor aggregates',
  'Disbursement partnerships (actual money movement — bank files stay generated files only)',
  'Expansion segments beyond the 5–30 staff beachhead',
  'Native iOS app (non-code blocker: Apple Developer account + Xcode build; the V1 employee surface is a PWA)',
  'Live WhatsApp via 360dialog/Gupshup (needs a real provider account + approved templates)',
  'Real LLM provider with per-token cost accounting (needs LLM_API_KEY; M4 stub estimates remain)',
  'Live ZKTeco ADMS server connection (needs real devices + ADMS credentials; V1 ships a STUBBED adapter + fixture)',
  'Live Zad connection (needs a Zad staging tenant)',
  'PDPL biometric regulator licence (non-code legal blocker — see docs/pdpl-biometrics-note.md)',
] as const;
