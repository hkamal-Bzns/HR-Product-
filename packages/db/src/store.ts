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
  /** M4: link from a login account to an employee record (employee
   *  self-service). Null = not linked; an unlinked employee-role user sees
   *  no employee data at all. */
  employeeId?: string | null;
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
  // --- M3 payroll ------------------------------------------------------------
  salaryStructures: SalaryStructureRecord[] = [];
  payrollRuns: PayrollRunRecord[] = [];
  payslips: PayslipRecord[] = [];
  payrollAdjustments: PayrollAdjustmentRecord[] = [];
  bankFiles: BankFileRecord[] = [];
  exportLog: ExportLogRecord[] = [];
  // --- M4 agents ---------------------------------------------------------------
  agentRuns: AgentRunRecord[] = [];
  agentCosts: AgentCostRecord[] = [];
  /** Monthly cost cap overrides, piasters. Key: `${tenantId}:${agentId}` or `${tenantId}:all`. */
  agentCostCaps = new Map<string, number>();
  /** Kill switches: true = agent paused. Key: `global:${agentId}` or `${tenantId}:${agentId}`. */
  agentKillSwitches = new Map<string, boolean>();
  scheduleDrafts: ScheduleDraftRecord[] = [];
  routedQuestions: RoutedQuestionRecord[] = [];
  offlineSyncLog: OfflineSyncRecord[] = [];
  usedQrNonces = new Set<string>();
  usedBiometricNonces = new Set<string>();
  // --- V1 ---------------------------------------------------------------
  zktecoDevices: ZktecoDeviceRecord[] = [];
  zktecoMappings: ZktecoMappingRecord[] = [];
  zktecoPunches: ZktecoPunchRecord[] = [];
  biometricDevices: BiometricDeviceRecord[] = [];
  consents: ConsentRecord[] = [];
  dsrRequests: DsrRequestRecord[] = [];
  planCatalogue: PlanCatalogueRecord[] = [];
  subscriptions: SubscriptionRecord[] = [];
  invoices: InvoiceRecord[] = [];
  statutoryRules: StatutoryRuleRecord[] = [];
  tenantNotifications: TenantNotificationRecord[] = [];
  superadminUsers: SuperadminUserRecord[] = [];
  superadminAudit: SuperadminAuditRecord[] = [];
  breakGlassSessions: BreakGlassSessionRecord[] = [];
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
  // --- M3 tenant-scoped helpers -------------------------------------------
  listSalaryStructures(tenantId: string): SalaryStructureRecord[] { return this.salaryStructures.filter((s) => s.tenantId === tenantId); }
  structureFor(tenantId: string, employeeId: string): SalaryStructureRecord | undefined {
    const list = this.salaryStructures.filter((s) => s.tenantId === tenantId && s.employeeId === employeeId);
    return list[list.length - 1];
  }
  listPayrollRuns(tenantId: string): PayrollRunRecord[] { return this.payrollRuns.filter((r) => r.tenantId === tenantId); }
  getPayrollRun(tenantId: string, id: string): PayrollRunRecord {
    const r = this.payrollRuns.find((x) => x.id === id);
    if (!r) throw new Error('payroll run not found');
    assertSameTenant(tenantId, r.tenantId);
    return r;
  }
  listPayslips(tenantId: string, runId?: string): PayslipRecord[] {
    return this.payslips.filter((p) => p.tenantId === tenantId && (!runId || p.runId === runId));
  }
  getPayslip(tenantId: string, id: string): PayslipRecord {
    const p = this.payslips.find((x) => x.id === id);
    if (!p) throw new Error('payslip not found');
    assertSameTenant(tenantId, p.tenantId);
    return p;
  }
  /** Latest locked run's period end (YYYY-MM-DD) — statutory changes may not
   *  back-date into it (Brief §10 guardrail 2). */
  lockedUntil(tenantId: string): string | null {
    const locked = this.payrollRuns.filter((r) => r.tenantId === tenantId && (r.status === 'locked' || r.status === 'paid' || r.status === 'approved'));
    if (locked.length === 0) return null;
    const last = locked.map((r) => r.period).sort().pop()!;
    const [y, m] = last.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  pendingAdjustments(tenantId: string, employeeId: string, targetPeriod: string): PayrollAdjustmentRecord[] {
    return this.payrollAdjustments.filter((a) => a.tenantId === tenantId && a.employeeId === employeeId && a.targetPeriod === targetPeriod && a.status === 'pending');
  }
  // --- M4 tenant-scoped helpers -------------------------------------------
  /** The employee record linked to a login account, or null when unlinked.
   *  An employee-role user with no link sees no employee data (M4 gap fix). */
  linkedEmployeeForUser(tenantId: string, userId: string): EmployeeRecord | null {
    const u = this.users.get(userId);
    if (!u || u.tenantId !== tenantId || !u.employeeId) return null;
    return this.employees.find((e) => e.id === u.employeeId && e.tenantId === tenantId) ?? null;
  }
  listAgentRuns(tenantId: string, agentId?: string, month?: string): AgentRunRecord[] {
    return this.agentRuns.filter((r) => r.tenantId === tenantId && (!agentId || r.agentId === agentId) && (!month || r.month === month));
  }
  agentMonthCost(tenantId: string, agentId: string, month: string): number {
    return this.agentCosts
      .filter((c) => c.tenantId === tenantId && c.agentId === agentId && c.month === month)
      .reduce((s, c) => s + c.costPiasters, 0);
  }
  listScheduleDrafts(tenantId: string): ScheduleDraftRecord[] { return this.scheduleDrafts.filter((d) => d.tenantId === tenantId); }
  getScheduleDraft(tenantId: string, id: string): ScheduleDraftRecord {
    const d = this.scheduleDrafts.find((x) => x.id === id);
    if (!d) throw new Error('schedule draft not found');
    assertSameTenant(tenantId, d.tenantId);
    return d;
  }
  listRoutedQuestions(tenantId: string, employeeId?: string): RoutedQuestionRecord[] {
    return this.routedQuestions.filter((q) => q.tenantId === tenantId && (!employeeId || q.employeeId === employeeId));
  }
  // --- V1 tenant-scoped helpers -------------------------------------------
  listZktecoDevices(tenantId: string): ZktecoDeviceRecord[] { return this.zktecoDevices.filter((d) => d.tenantId === tenantId); }
  getZktecoDevice(tenantId: string, id: string): ZktecoDeviceRecord {
    const d = this.zktecoDevices.find((x) => x.id === id);
    if (!d) throw new Error('device not found');
    assertSameTenant(tenantId, d.tenantId);
    return d;
  }
  activeConsent(tenantId: string, employeeId: string, purpose: string): ConsentRecord | undefined {
    const list = this.consents.filter((c) => c.tenantId === tenantId && c.employeeId === employeeId && c.purpose === purpose && c.consented && c.status === 'active' && !c.withdrawnAt);
    return list[list.length - 1];
  }
  listConsents(tenantId: string, employeeId?: string): ConsentRecord[] {
    return this.consents.filter((c) => c.tenantId === tenantId && (!employeeId || c.employeeId === employeeId));
  }
  getSubscription(tenantId: string): SubscriptionRecord | undefined {
    const list = this.subscriptions.filter((s) => s.tenantId === tenantId);
    return list[list.length - 1];
  }
  /** Effective plan: subscription plan wins; falls back to the tenant record. */
  effectivePlan(tenantId: string): { plan: string; addons: string[] } {
    const sub = this.getSubscription(tenantId);
    const t = this.tenants.get(tenantId);
    return { plan: sub?.plan ?? t?.plan ?? 'free', addons: sub?.addons ?? [] };
  }
  listStatutoryRules(): StatutoryRuleRecord[] { return this.statutoryRules; }
  getStatutoryRule(id: string): StatutoryRuleRecord {
    const r = this.statutoryRules.find((x) => x.id === id);
    if (!r) throw new Error('statutory rule version not found');
    return r;
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
  endDate?: string | null; active?: boolean;
  bankAccount?: string | null; walletNumber?: string | null;
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

// ============================================================================
// M3 — Payroll (Brief §7, Appendix A/B). Locked runs immutable; corrections
// only as payroll_adjustments on a later run.
// ============================================================================
export interface SalaryStructureRecord {
  id: string; tenantId: string; employeeId: string; templateName: string | null;
  basicPiasters: number;
  allowances: { name: string; amountPiasters: number; taxable: boolean; insurable: boolean }[];
  payPeriod: string; payDay: number;
  bankAccount: string | null; walletNumber: string | null;
  advanceTotalPiasters: number; advanceInstalmentPiasters: number;
  loanTotalPiasters: number; loanInstalmentPiasters: number;
  effectiveFrom: string; version: number;
}
export type PayrollRunStatus = 'draft' | 'prepared' | 'calculated' | 'approved' | 'locked' | 'paid';
export interface PayrollRunRecord {
  id: string; tenantId: string; period: string; branchIds: string[];
  status: PayrollRunStatus;
  warningsAccepted: string[]; anomalies: unknown[];
  totalGrossPiasters: number; totalNetPiasters: number;
  totalEmployeeNosiPiasters: number; totalTaxPiasters: number;
  totalEmployerNosiPiasters: number | null;
  employerCostStatus: 'pending' | 'ready';
  taxRuleVersion: number; taxRuleStatus: string; overtimeRuleVersion: number;
  createdByUserId: string | null; approvedByUserId: string | null;
  approvedAt: string | null; lockedAt: string | null; paidAt: string | null;
  createdAt: string;
}
export interface PayslipRecord {
  id: string; tenantId: string; runId: string; employeeId: string; period: string;
  lines: { label: string; labelAr: string; amountPiasters: number; kind: string }[];
  grossPiasters: number; employeeNosiPiasters: number; incomeTaxPiasters: number;
  martyrsLevyPiasters: number; totalDeductionsPiasters: number; netPiasters: number;
  employerNosiPiasters: number | null; totalEmployerCostPiasters: number | null;
  insurableWagePiasters: number; workedDays: number; regularHoursPiasters: number;
  overtimeMinutes: { dayMin: number; nightMin: number; restDayMin: number; publicHolidayMin: number };
  belowMinimumWage: boolean;
}
export interface PayrollAdjustmentRecord {
  id: string; tenantId: string; employeeId: string; sourceRunId: string | null;
  targetPeriod: string; amountPiasters: number; reason: string;
  status: 'pending' | 'applied'; createdByUserId: string | null; appliedRunId: string | null;
}
export interface BankFileRecord {
  id: string; tenantId: string; runId: string; bank: string; filename: string;
  content: string; totalPiasters: number; recordCount: number;
  note: string; generatedByUserId: string | null; createdAt: string;
}
export interface ExportLogRecord {
  id: string; tenantId: string; runId: string | null; kind: string; format: string;
  generatedByUserId: string | null; createdAt: string;
}

// ============================================================================
// M4 — AI agents v1 (Brief §8). Agent runs are the audit trail: every run
// records its inputs hash, output, stubbed cost estimate and the human
// decision. Agents never mutate pay, leave, rosters or discipline directly.
// ============================================================================
export type AgentRunStatus = 'completed' | 'paused' | 'failed';
export interface AgentRunRecord {
  id: string; tenantId: string; agentId: string; month: string;
  inputHash: string; output: unknown; costPiasters: number; provider: 'stub' | 'http';
  status: AgentRunStatus;
  /** Human decision recorded after the run (e.g. briefing action taken,
   *  anomaly accept/dismiss, draft review). Null = undecided. */
  humanDecision: string | null;
  decisions: unknown[];
  decidedByUserId: string | null;
  employeeId: string | null; // Agent 4: which employee asked
  createdAt: string;
}
export interface AgentCostRecord {
  id: string; tenantId: string; agentId: string; month: string;
  costPiasters: number; runId: string; createdAt: string;
}
export type ScheduleDraftStatus = 'draft' | 'reviewed' | 'published' | 'rejected';
export interface ScheduleSuggestion {
  id: string; employeeId: string; date: string; shiftTemplateId: string;
  reasonAr: string; reasonEn: string;
  violations: { code: string; reasonAr: string; reasonEn: string }[];
  warnings: { code: string; reasonAr: string; reasonEn: string }[];
  score: number;
  decision: 'pending' | 'accepted' | 'edited' | 'rejected';
  editedShiftTemplateId: string | null;
  decidedByUserId: string | null;
}
export interface ScheduleDraftRecord {
  id: string; tenantId: string; branchId: string; weekStart: string;
  status: ScheduleDraftStatus;
  suggestions: ScheduleSuggestion[];
  agentRunId: string | null;
  createdByUserId: string | null; decidedByUserId: string | null;
  publishedRosterId: string | null;
  createdAt: string;
}
export interface RoutedQuestionRecord {
  id: string; tenantId: string; employeeId: string; question: string; intent: string;
  status: 'routed' | 'answered';
  answer: string | null; answeredByUserId: string | null;
  createdAt: string; answeredAt: string | null;
}
export interface OfflineSyncRecord {
  id: string; tenantId: string; employeeId: string; deviceAt: string;
  outcome: 'accepted' | 'duplicate' | 'conflict_overlap' | 'stale' | 'unsigned' | 'invalid_signature';
  reason: string; signatureStatus: string; createdAt: string;
}

// ============================================================================
// V1 — ZKTeco (C1), mobile biometrics (C2), PDPL consent (§12), Superadmin
// full console (§11), Zad stub (§9). BiometricDeviceRecord stores a PUBLIC
// KEY ONLY — no template, no private key, ever.
// ============================================================================
export interface ZktecoDeviceRecord {
  id: string; tenantId: string; branchId: string | null; name: string; model: string;
  serial: string; adapter: 'stub-adms'; syncStatus: 'ok' | 'stale' | 'failing' | 'never_synced';
  lastSyncAt: string | null; lastError: string | null; lastClockDriftSeconds: number | null;
  createdAt: string;
}
export interface ZktecoMappingRecord {
  id: string; tenantId: string; deviceId: string; deviceUserId: string;
  employeeId: string; createdByUserId: string | null; createdAt: string;
}
export interface ZktecoPunchRecord {
  id: string; tenantId: string; deviceId: string; deviceUserId: string;
  employeeId: string | null; deviceAt: string; direction: 'in' | 'out';
  dedupKey: string; clockDriftSeconds: number | null; source: 'stub-adms';
  attendanceRecordId: string | null; createdAt: string;
}
export interface BiometricDeviceRecord {
  id: string; tenantId: string; employeeId: string; deviceName: string;
  platform: 'android' | 'ios';
  /** Ed25519 public key (PEM) only. Private key + biometric template stay on the device OS. */
  publicKeyPem: string;
  consentId: string | null; revoked: boolean; revokedAt: string | null;
  lastUsedAt: string | null; createdAt: string;
}
export interface ConsentRecord {
  id: string; tenantId: string; employeeId: string; purpose: string;
  consented: boolean; status: 'active' | 'withdrawn' | 'expired';
  consentText: string; method: 'written_signed' | 'in_app_signed' | 'whatsapp_confirmed';
  version: string; consentedAt: string | null; withdrawnAt: string | null; createdAt: string;
}
export interface DsrRequestRecord {
  id: string; tenantId: string; employeeId: string | null; kind: 'access' | 'export' | 'delete';
  status: 'received' | 'verified' | 'owner_approved' | 'executed' | 'confirmed' | 'rejected';
  requestedBy: string; notes: string | null; executedAt: string | null; createdAt: string;
}
export interface PlanCatalogueRecord {
  id: string; version: number; tiers: unknown; zktecoAddonPricePiasters: number;
  status: 'draft' | 'published'; createdByUserId: string | null; createdAt: string;
}
export interface SubscriptionRecord {
  id: string; tenantId: string; plan: string; planVersion: number;
  status: 'trial' | 'active' | 'past_due' | 'suspended' | 'churned';
  trialEndsAt: string | null; pricePiastersPerMonth: number; addons: string[];
  coupon: string | null; discountPct: number; dunningStage: string | null; createdAt: string;
}
export interface InvoiceRecord {
  id: string; tenantId: string; period: string; amountPiasters: number;
  status: 'unpaid' | 'paid' | 'refunded' | 'void';
  refundPiasters: number; refundProviderRef: string | null; refundNote: string | null;
  createdAt: string;
}
export interface StatutoryRuleRecord {
  id: string; version: number; values: Record<string, unknown>; effectiveFrom: string;
  status: 'draft' | 'reviewed' | 'staged' | 'published' | 'withdrawn';
  reviewerSignoffRef: string | null; releaseNotesAr: string | null; releaseNotesEn: string | null;
  stagingResult: unknown; publishedAt: string | null; createdByUserId: string | null; createdAt: string;
}
export interface TenantNotificationRecord {
  id: string; tenantId: string; kind: string; titleAr: string; titleEn: string;
  detail: unknown; read: boolean; createdAt: string;
}
export interface SuperadminUserRecord {
  id: string; email: string; passwordHash: string; role: string; mfaEnabled: boolean; createdAt: string;
}
export interface SuperadminAuditRecord {
  id: string; superadminUserId: string | null; superadminRole: string | null;
  tenantId: string | null; action: string; entity: string | null; detail: unknown; createdAt: string;
}
export interface BreakGlassSessionRecord {
  id: string; tenantId: string; superadminUserId: string; ticketId: string; reason: string;
  expiresAt: string; usedAt: string | null; revoked: boolean; createdAt: string;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
