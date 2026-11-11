// Drizzle schema — M1 Foundation only.
// Every tenant-scoped table carries tenant_id. Payroll runs / attendance
// records do NOT exist in M1 (M2/M3). NOSI employer rate: no default — see
// statutory_rates.nosi_employer_pct (nullable) and the M0 blocker in README.
import { pgTable, text, integer, boolean, timestamp, jsonb, uuid, pgEnum } from 'drizzle-orm/pg-core';

export const tenantStatusEnum = pgEnum('tenant_status', ['trial', 'active', 'past_due', 'suspended', 'churned']);
export const planEnum = pgEnum('plan', ['free', 'starter', 'growth', 'pro']);
export const roleEnum = pgEnum('role', ['owner', 'accountant', 'branch_manager', 'employee']);
export const superadminRoleEnum = pgEnum('superadmin_role', ['operations', 'support', 'finance', 'auditor']);

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  status: tenantStatusEnum('status').notNull().default('trial'),
  plan: planEnum('plan').notNull().default('free'),
  staffCap: integer('staff_cap').notNull().default(5),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  email: text('email').notNull(),
  phone: text('phone'),
  passwordHash: text('password_hash').notNull(),
  role: roleEnum('role').notNull().default('employee'),
  branchId: uuid('branch_id'),
  // M4: link from a login account to an employee record (employee self-service).
  employeeId: uuid('employee_id').references(() => employees.id),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const branches = pgTable('branches', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  geofenceLat: text('geofence_lat'),
  geofenceLng: text('geofence_lng'),
  geofenceRadiusM: integer('geofence_radius_m').notNull().default(100),
  timezone: text('timezone').notNull().default('Africa/Cairo'),
  active: boolean('active').notNull().default(true),
});

export const employees = pgTable('employees', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  branchId: uuid('branch_id').references(() => branches.id),
  fullNameAr: text('full_name_ar').notNull(),
  fullNameEn: text('full_name_en'),
  phone: text('phone').notNull(),
  jobTitle: text('job_title'),
  // Salary is stored in piasters (integer). Demo data only in M1.
  basicSalaryPiasters: integer('basic_salary_piasters'),
  active: boolean('active').notNull().default(true),
  // M3: bank / wallet details for payment files (generated files, not disbursement).
  bankAccount: text('bank_account'),
  walletNumber: text('wallet_number'),
});

// Settings framework (§10): versioned, effective-dated rule sets as data.
export const settingsVersions = pgTable('settings_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  area: text('area').notNull(), // one of SETTINGS_AREAS in @hr-payroll/shared
  version: integer('version').notNull(),
  effectiveFrom: text('effective_from').notNull(), // ISO date
  value: jsonb('value').notNull(),
  changedByUserId: uuid('changed_by_user_id'),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const settingsAudit = pgTable('settings_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  area: text('area').notNull(),
  userId: uuid('user_id'),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  effectiveFrom: text('effective_from').notNull(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Statutory rates (§7): vendor-published versions. Employer NOSI is NULL
// until the M0 payroll reviewer confirms it. Never ship a default here.
export const statutoryRateVersions = pgTable('statutory_rate_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: integer('version').notNull(),
  effectiveFrom: text('effective_from').notNull(),
  nosiEmployeePct: integer('nosi_employee_pct').notNull().default(11),
  nosiEmployerPct: integer('nosi_employer_pct'), // NULL = UNRESOLVED
  nosiFloorEgp: integer('nosi_floor_egp').notNull().default(2700),
  nosiCeilingEgp: integer('nosi_ceiling_egp').notNull().default(16700),
  martyrsFundPct: text('martyrs_fund_pct').notNull().default('0.0002'),
  minimumWageEgp: integer('minimum_wage_egp').notNull().default(7000),
  reviewerSignoffRef: text('reviewer_signoff_ref'),
  status: text('status').notNull().default('draft'), // draft | staged | published | withdrawn
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id), // null = cross-tenant / superadmin
  actorUserId: uuid('actor_user_id'),
  actorKind: text('actor_kind').notNull(), // tenant_user | superadmin | system
  action: text('action').notNull(),
  entity: text('entity'),
  entityId: text('entity_id'),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  scopes: jsonb('scopes').notNull().default([]),
  revoked: boolean('revoked').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const featureFlags = pgTable('feature_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id), // null = global
  key: text('key').notNull(),
  enabled: boolean('enabled').notNull().default(false),
});

// Superadmin (§11): separate console, MFA mandatory, cross-tenant audit.
export const superadminUsers = pgTable('superadmin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: superadminRoleEnum('role').notNull(),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Break-glass: disabled by default. A row here is a *request*; entry is only
// allowed when enabled=true, time-boxed, ticket-justified, and audit-logged.
// It never grants routine access to salaries/photos/payslips.
export const breakGlassRequests = pgTable('break_glass_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  superadminUserId: uuid('superadmin_user_id').notNull().references(() => superadminUsers.id),
  ticketId: text('ticket_id').notNull(),
  reason: text('reason').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ============================================================================
// M2 — Attendance, Shifts & Leave (Brief §5, §6). All tables tenant-scoped.
// Kiosk photos: only a photoRef + retention date are stored here — never image
// bytes. No biometric templates, no face matching in M2.
// ============================================================================
export const shiftTemplateStatusEnum = pgEnum('shift_template_status', ['active', 'inactive']);

export const shiftTemplates = pgTable('shift_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  branchId: uuid('branch_id').references(() => branches.id),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  startTime: text('start_time').notNull(), // HH:MM, Africa/Cairo
  endTime: text('end_time').notNull(),
  overnight: boolean('overnight').notNull().default(false),
  unpaidBreakMinutes: integer('unpaid_break_minutes').notNull().default(0),
  status: shiftTemplateStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const rosters = pgTable('rosters', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  branchId: uuid('branch_id').references(() => branches.id),
  weekStart: text('week_start').notNull(), // ISO date (Monday)
  status: text('status').notNull().default('draft'), // draft | published
  publishedAt: timestamp('published_at'),
  publishedByUserId: uuid('published_by_user_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const rosterAssignments = pgTable('roster_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  rosterId: uuid('roster_id').notNull().references(() => rosters.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  date: text('date').notNull(), // ISO date
  shiftTemplateId: uuid('shift_template_id').references(() => shiftTemplates.id),
  onLeave: boolean('on_leave').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const attendanceRecords = pgTable('attendance_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  branchId: uuid('branch_id').references(() => branches.id),
  rosterAssignmentId: uuid('roster_assignment_id'),
  method: text('method').notNull(), // qr_geofence | passcode_photo | offline_queue
  clockInAt: timestamp('clock_in_at'),
  clockOutAt: timestamp('clock_out_at'),
  deviceAt: timestamp('device_at'),
  lat: text('lat'),
  lng: text('lng'),
  distanceFromBranchM: integer('distance_from_branch_m'),
  wifiMatched: boolean('wifi_matched'),
  mockLocationFlag: boolean('mock_location_flag').notNull().default(false),
  photoRef: text('photo_ref'), // reference only, never image bytes
  verificationStatus: text('verification_status').notNull().default('pending_review'), // auto_approved | pending_review | rejected
  source: text('source').notNull().default('live'), // live | offline_queue
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const exceptions = pgTable('exceptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  attendanceRecordId: uuid('attendance_record_id').references(() => attendanceRecords.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  branchId: uuid('branch_id').references(() => branches.id),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('open'), // open | resolved | dismissed
  reason: text('reason').notNull(),
  resolvedByUserId: uuid('resolved_by_user_id'),
  resolutionNote: text('resolution_note'),
  resolvedAt: timestamp('resolved_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const leaveRequests = pgTable('leave_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  type: text('type').notNull(), // annual | sick | casual | unpaid
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  days: text('days').notNull(), // decimal days as text, e.g. '2.5'
  status: text('status').notNull().default('pending'), // pending | approved | rejected | cancelled
  reason: text('reason'),
  decidedByUserId: uuid('decided_by_user_id'),
  decidedAt: timestamp('decided_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const leaveBalances = pgTable('leave_balances', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  year: integer('year').notNull(),
  type: text('type').notNull(),
  entitlementDays: text('entitlement_days').notNull(),
  carriedDays: text('carried_days').notNull().default('0'),
  takenDays: text('taken_days').notNull().default('0'),
});

export const kioskConsents = pgTable('kiosk_consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  consented: boolean('consented').notNull().default(false),
  noticeShownAt: timestamp('notice_shown_at'),
  consentedAt: timestamp('consented_at'),
  retentionDays: integer('retention_days').notNull().default(90),
});

export const kioskPasscodes = pgTable('kiosk_passcodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  passcodeHash: text('passcode_hash').notNull(), // bcrypt hash, never plain text
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const swapRequests = pgTable('swap_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  rosterAssignmentId: uuid('roster_assignment_id').notNull().references(() => rosterAssignments.id),
  requesterEmployeeId: uuid('requester_employee_id').notNull().references(() => employees.id),
  coverEmployeeId: uuid('cover_employee_id').notNull().references(() => employees.id),
  status: text('status').notNull().default('pending'), // pending | approved | rejected | cancelled
  decidedByUserId: uuid('decided_by_user_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const openShifts = pgTable('open_shifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  rosterAssignmentId: uuid('roster_assignment_id').references(() => rosterAssignments.id),
  branchId: uuid('branch_id').references(() => branches.id),
  date: text('date').notNull(),
  shiftTemplateId: uuid('shift_template_id').references(() => shiftTemplates.id),
  status: text('status').notNull().default('open'), // open | filled | cancelled
  filledByEmployeeId: uuid('filled_by_employee_id'),
  claimedByEmployeeId: uuid('claimed_by_employee_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** Outbox: stubbed WhatsApp messages (M2). status is 'queued_stubbed' — never
 *  'delivered'. Real delivery needs a live provider (360dialog/Gupshup) in V1. */
export const outboxMessages = pgTable('outbox_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  toPhone: text('to_phone').notNull(),
  template: text('template').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('queued_stubbed'),
  provider: text('provider').notNull().default('stub'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ============================================================================
// M3 — Payroll MVP (Brief §7, §10 Areas 6–7, Appendix A/B). All tenant-scoped.
// Locked runs immutable: payslips store their lines at calculation time;
// corrections are payroll_adjustments applied to a LATER run only.
// ============================================================================
export const salaryStructures = pgTable('salary_structures', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  templateName: text('template_name'),
  basicSalaryPiasters: integer('basic_salary_piasters').notNull(),
  allowances: jsonb('allowances').notNull().default([]),
  payPeriod: text('pay_period').notNull().default('monthly'),
  payDay: integer('pay_day').notNull().default(28),
  bankAccount: text('bank_account'),
  walletNumber: text('wallet_number'),
  advanceTotalPiasters: integer('advance_total_piasters').notNull().default(0),
  advanceInstalmentPiasters: integer('advance_instalment_piasters').notNull().default(0),
  loanTotalPiasters: integer('loan_total_piasters').notNull().default(0),
  loanInstalmentPiasters: integer('loan_instalment_piasters').notNull().default(0),
  effectiveFrom: text('effective_from').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const payrollRuns = pgTable('payroll_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  period: text('period').notNull(), // YYYY-MM
  branchIds: jsonb('branch_ids').notNull().default([]),
  status: text('status').notNull().default('draft'), // draft | prepared | calculated | approved | locked | paid
  warningsAccepted: jsonb('warnings_accepted').notNull().default([]),
  anomalies: jsonb('anomalies').notNull().default([]),
  totalGrossPiasters: integer('total_gross_piasters').notNull().default(0),
  totalNetPiasters: integer('total_net_piasters').notNull().default(0),
  totalEmployeeNosiPiasters: integer('total_employee_nosi_piasters').notNull().default(0),
  totalTaxPiasters: integer('total_tax_piasters').notNull().default(0),
  totalEmployerNosiPiasters: integer('total_employer_nosi_piasters'), // NULL = PENDING
  employerCostStatus: text('employer_cost_status').notNull().default('pending'),
  taxRuleVersion: integer('tax_rule_version').notNull().default(1),
  taxRuleStatus: text('tax_rule_status').notNull().default('REVIEWER-UNCONFIRMED'),
  overtimeRuleVersion: integer('overtime_rule_version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id'),
  approvedByUserId: uuid('approved_by_user_id'),
  approvedAt: timestamp('approved_at'),
  lockedAt: timestamp('locked_at'),
  paidAt: timestamp('paid_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const payslips = pgTable('payslips', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  runId: uuid('run_id').notNull().references(() => payrollRuns.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  period: text('period').notNull(),
  lines: jsonb('lines').notNull().default([]),
  grossPiasters: integer('gross_piasters').notNull().default(0),
  employeeNosiPiasters: integer('employee_nosi_piasters').notNull().default(0),
  incomeTaxPiasters: integer('income_tax_piasters').notNull().default(0),
  martyrsLevyPiasters: integer('martyrs_levy_piasters').notNull().default(0),
  totalDeductionsPiasters: integer('total_deductions_piasters').notNull().default(0),
  netPiasters: integer('net_piasters').notNull().default(0),
  employerNosiPiasters: integer('employer_nosi_piasters'), // NULL = PENDING
  totalEmployerCostPiasters: integer('total_employer_cost_piasters'),
  insurableWagePiasters: integer('insurable_wage_piasters').notNull().default(0),
  workedDays: integer('worked_days').notNull().default(0),
  regularHoursPiasters: integer('regular_hours_piasters').notNull().default(0),
  overtimeMinutes: jsonb('overtime_minutes').notNull().default({}),
  belowMinimumWage: boolean('below_minimum_wage').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const payrollAdjustments = pgTable('payroll_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  sourceRunId: uuid('source_run_id').references(() => payrollRuns.id),
  targetPeriod: text('target_period').notNull(),
  amountPiasters: integer('amount_piasters').notNull(), // signed
  reason: text('reason').notNull(),
  status: text('status').notNull().default('pending'), // pending | applied
  createdByUserId: uuid('created_by_user_id'),
  appliedRunId: uuid('applied_run_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const bankFiles = pgTable('bank_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  runId: uuid('run_id').notNull().references(() => payrollRuns.id),
  bank: text('bank').notNull(), // CIB | QNB | NBE | Banque Misr
  filename: text('filename').notNull(),
  content: text('content').notNull(),
  totalPiasters: integer('total_piasters').notNull().default(0),
  recordCount: integer('record_count').notNull().default(0),
  note: text('note').notNull().default('GENERATED FILE — not a disbursement. No money moved.'),
  generatedByUserId: uuid('generated_by_user_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const exportLog = pgTable('export_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  runId: uuid('run_id').references(() => payrollRuns.id),
  kind: text('kind').notNull(), // register | summary | employer_cost | tax_nosi | attendance | labour_cost | bank_file | payslip
  format: text('format').notNull(), // csv | html
  generatedByUserId: uuid('generated_by_user_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ============================================================================
// M4 — AI agents v1 (Brief §8). Agent runs are the audit trail: inputs hash,
// output, stubbed cost estimate, human decision. Provider is 'stub' — no real
// LLM key exists in M4. Schedule drafts are DRAFT ONLY until a human reviews
// and publishes them through the M2 publish flow.
// ============================================================================
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  agentId: text('agent_id').notNull(), // briefing | schedule | anomaly | qa
  month: text('month').notNull(), // YYYY-MM
  inputHash: text('input_hash').notNull(),
  output: jsonb('output').notNull().default({}),
  costPiasters: integer('cost_piasters').notNull().default(0), // STUBBED estimate in M4
  provider: text('provider').notNull().default('stub'),
  status: text('status').notNull().default('completed'), // completed | paused | failed
  humanDecision: text('human_decision'),
  decisions: jsonb('decisions').notNull().default([]),
  decidedByUserId: uuid('decided_by_user_id'),
  employeeId: uuid('employee_id').references(() => employees.id), // Agent 4: who asked
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const agentCostLedger = pgTable('agent_cost_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  agentId: text('agent_id').notNull(),
  month: text('month').notNull(),
  costPiasters: integer('cost_piasters').notNull().default(0),
  runId: uuid('run_id').notNull().references(() => agentRuns.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const scheduleDrafts = pgTable('schedule_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  branchId: uuid('branch_id').references(() => branches.id),
  weekStart: text('week_start').notNull(),
  status: text('status').notNull().default('draft'), // draft | reviewed | published | rejected
  suggestions: jsonb('suggestions').notNull().default([]),
  agentRunId: uuid('agent_run_id').references(() => agentRuns.id),
  createdByUserId: uuid('created_by_user_id'),
  decidedByUserId: uuid('decided_by_user_id'),
  publishedRosterId: uuid('published_roster_id').references(() => rosters.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const routedQuestions = pgTable('routed_questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  question: text('question').notNull(),
  intent: text('intent').notNull(),
  status: text('status').notNull().default('routed'), // routed | answered
  answer: text('answer'),
  answeredByUserId: uuid('answered_by_user_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  answeredAt: timestamp('answered_at'),
});

export const offlineSyncLog = pgTable('offline_sync_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  deviceAt: timestamp('device_at').notNull(),
  outcome: text('outcome').notNull(), // accepted | duplicate | conflict_overlap | stale | unsigned | invalid_signature
  reason: text('reason').notNull(),
  signatureStatus: text('signature_status').notNull().default('legacy'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
