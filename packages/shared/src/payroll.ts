// ============================================================================
// M3 — Payroll engine (Brief §7, §10 Areas 6–7, Appendix A/B).
// Pure functions only. Money is integer piasters everywhere. Never float EGP.
//
// REVIEWER STATUS — read before relying on any figure here:
// * Income-tax brackets (Law 7 of 2024) and overtime multipliers (Labour Law
//   14 of 2025) are encoded from secondary sources — see
//   docs/tax-2024-research-note.md — and are flagged REVIEWER-UNCONFIRMED.
//   A payroll reviewer must confirm them; the brief says the brackets apply
//   "as the reviewer confirms". The rule sets are VERSIONED data
//   (TAX_RULES_2026 / OVERTIME_RULES_2026) so a confirmed version replaces
//   them without a code change to the arithmetic.
// * NOSI EMPLOYER rate: deliberately NOT encoded here at all. It stays NULL
//   (see STATUTORY_RATES_UNRESOLVED in index.ts). employerNosiPiasters()
//   returns null while the rate is null, and a run must refuse to finalise.
// * Martyrs' Fund levy 0.0002% is applied on GROSS pay as the working basis
//   until the reviewer confirms the basis — flagged in the research note.
// ============================================================================

export const PAYROLL_REVIEW_STATUS = 'REVIEWER-UNCONFIRMED' as const;

/** One progressive tax slice: everything up to `upToEgp` (annual, EGP) is
 *  taxed at `ratePct` percent. `upToEgp: null` = open-ended top slice. */
export interface TaxBracket { upToEgp: number | null; ratePct: number }

export interface TaxRuleSet {
  version: number;
  effectiveFrom: string; // ISO date
  law: string;
  personalExemptionEgpAnnual: number;
  /** Brackets for annual taxable income (after exemption) up to EGP 600,000. */
  brackets: TaxBracket[];
  /** Law 7/2024 withdraws the lower bands step by step above EGP 600,000.
   *  Each entry replaces the bracket set once annual taxable income exceeds
   *  `aboveEgp`. Ordered ascending. */
  phaseOut: { aboveEgp: number; brackets: TaxBracket[] }[];
  status: typeof PAYROLL_REVIEW_STATUS;
}

/** Law 7 of 2024, in force for salaries from 1 March 2024.
 *  Personal exemption EGP 20,000/year (Art. 13(1) as replaced by Law 7/2024).
 *  Sources: Dawmly, Wanas Payroll, NNRoad, TopSource, Legal500 — all agree on
 *  the slices below; see docs/tax-2024-research-note.md. REVIEWER-UNCONFIRMED. */
export const TAX_RULES_2026: TaxRuleSet = {
  version: 1,
  effectiveFrom: '2026-01-01',
  law: 'Income Tax Law 91 of 2005 as amended by Law 7 of 2024',
  personalExemptionEgpAnnual: 20000,
  brackets: [
    { upToEgp: 40000, ratePct: 0 },
    { upToEgp: 55000, ratePct: 10 },
    { upToEgp: 70000, ratePct: 15 },
    { upToEgp: 200000, ratePct: 20 },
    { upToEgp: 400000, ratePct: 22.5 },
    { upToEgp: null, ratePct: 25 },
  ],
  phaseOut: [
    { aboveEgp: 600000, brackets: [
      { upToEgp: 55000, ratePct: 10 }, { upToEgp: 70000, ratePct: 15 },
      { upToEgp: 200000, ratePct: 20 }, { upToEgp: 400000, ratePct: 22.5 },
      { upToEgp: null, ratePct: 25 } ] },
    { aboveEgp: 700000, brackets: [
      { upToEgp: 70000, ratePct: 15 }, { upToEgp: 200000, ratePct: 20 },
      { upToEgp: 400000, ratePct: 22.5 }, { upToEgp: null, ratePct: 25 } ] },
    { aboveEgp: 800000, brackets: [
      { upToEgp: 200000, ratePct: 20 }, { upToEgp: 400000, ratePct: 22.5 },
      { upToEgp: null, ratePct: 25 } ] },
    { aboveEgp: 900000, brackets: [
      { upToEgp: 400000, ratePct: 22.5 }, { upToEgp: null, ratePct: 25 } ] },
    { aboveEgp: 1200000, brackets: [
      { upToEgp: 1200000, ratePct: 25 }, { upToEgp: null, ratePct: 27.5 } ] },
  ],
  status: PAYROLL_REVIEW_STATUS,
};

/** Overtime multipliers (Labour Law 14 of 2025, Arts. 121 & 129, as summarised
 *  by Dawmly / Wuzzuf / Playroll — see docs/tax-2024-research-note.md).
 *  Multipliers are TOTAL pay for the overtime hour (1.35 = normal + 35%).
 *  REVIEWER-UNCONFIRMED. Night = 21:00–06:00. Rest day = weekly rest day
 *  (Friday by default) worked, paid double plus a substitute rest day.
 *  Public holiday worked = 300% of the day's pay (or a substitute day off
 *  on the employee's written request, Art. 129). */
export interface OvertimeRuleSet {
  version: number;
  effectiveFrom: string;
  law: string;
  dayMultiplier: number; // 1.35
  nightMultiplier: number; // 1.70
  restDayMultiplier: number; // 2.00
  publicHolidayMultiplier: number; // 3.00
  nightStartHour: number; // 21
  nightEndHour: number; // 6
  standardHoursPerMonth: number; // 208 = 26 days x 8h
  restDayWeekday: number; // 5 = Friday (0=Sunday)
  status: typeof PAYROLL_REVIEW_STATUS;
}

export const OVERTIME_RULES_2026: OvertimeRuleSet = {
  version: 1,
  effectiveFrom: '2025-09-01',
  law: 'Labour Law 14 of 2025',
  dayMultiplier: 1.35,
  nightMultiplier: 1.7,
  restDayMultiplier: 2.0,
  publicHolidayMultiplier: 3.0,
  nightStartHour: 21,
  nightEndHour: 6,
  standardHoursPerMonth: 208,
  restDayWeekday: 5,
  status: PAYROLL_REVIEW_STATUS,
};

// --- NOSI (Law 148 of 2019) -------------------------------------------------
// Insurable-wage band 2026: EGP 2,700–16,700 (NOSI announcement 2025-11-30).
// Employee 11%. EMPLOYER: null until the reviewer confirms it (M0 blocker).

export function clampInsurableWagePiasters(insurablePiasters: number, floorEgp = 2700, ceilingEgp = 16700): number {
  return Math.min(Math.max(insurablePiasters, floorEgp * 100), ceilingEgp * 100);
}

/** Employee NOSI, piasters. `insurablePiasters` must already be clamped. */
export function employeeNosiPiasters(insurablePiasters: number, employeePct = 11): number {
  return Math.round((insurablePiasters * employeePct) / 100);
}

/** Employer NOSI, piasters — or NULL while the reviewer has not set a rate.
 *  Never returns a figure invented from a default. Callers must treat null
 *  as "employer cost PENDING" and refuse to finalise the run. */
export function employerNosiPiasters(insurablePiasters: number, employerPct: number | null): number | null {
  if (employerPct === null || employerPct === undefined) return null;
  return Math.round((insurablePiasters * employerPct) / 100);
}

// --- Income tax (Law 7/2024) ------------------------------------------------

/** Annual income tax in piasters for an annual taxable base (piasters, AFTER
 *  the personal exemption has been subtracted). Applies the Law 7/2024
 *  phase-out above EGP 600,000. Pure integer arithmetic per slice. */
export function annualIncomeTaxPiasters(annualTaxablePiasters: number, rules: TaxRuleSet = TAX_RULES_2026): number {
  if (annualTaxablePiasters <= 0) return 0;
  let brackets = rules.brackets;
  for (const step of rules.phaseOut) {
    if (annualTaxablePiasters > step.aboveEgp * 100) brackets = step.brackets;
  }
  let tax = 0;
  let lower = 0; // piasters
  for (const b of brackets) {
    const upper = b.upToEgp === null ? Infinity : b.upToEgp * 100;
    const slice = Math.max(0, Math.min(annualTaxablePiasters, upper) - lower);
    if (slice > 0) tax += Math.round((slice * b.ratePct) / 100);
    lower = upper;
    if (annualTaxablePiasters <= upper) break;
  }
  return tax;
}

/** Monthly income tax in piasters: annualise the month (gross − employee
 *  NOSI) × 12, subtract the EGP 20,000 personal exemption, tax annually,
 *  divide by 12. This is the standard Egyptian monthly withholding method
 *  (Dawmly / Wanas, 2026). */
export function monthlyIncomeTaxPiasters(monthlyTaxablePiasters: number, rules: TaxRuleSet = TAX_RULES_2026): number {
  const annualTaxable = monthlyTaxablePiasters * 12 - rules.personalExemptionEgpAnnual * 100;
  if (annualTaxable <= 0) return 0;
  return Math.round(annualIncomeTaxPiasters(annualTaxable, rules) / 12);
}

// --- Martyrs' Fund levy ------------------------------------------------------
/** 0.0002% levy. BASIS IS REVIEWER-UNCONFIRMED: applied here on GROSS pay
 *  as the working basis, flagged in docs/tax-2024-research-note.md. */
export function martyrsLevyPiasters(grossPiasters: number, levyPct = 0.0002): number {
  return Math.round((grossPiasters * levyPct) / 100);
}

// --- Pro-rating ---------------------------------------------------------------
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-based
}

/** Inclusive days of [startDate,endDate] that fall inside the payroll period.
 *  Dates are ISO YYYY-MM-DD. Null start = employed since before the period;
 *  null end = still employed. */
export function workedDaysInPeriod(
  periodStart: string, periodEnd: string, startDate: string | null, endDate: string | null,
): number {
  const pStart = new Date(`${periodStart}T00:00:00Z`).getTime();
  const pEnd = new Date(`${periodEnd}T00:00:00Z`).getTime();
  const from = startDate ? Math.max(pStart, new Date(`${startDate}T00:00:00Z`).getTime()) : pStart;
  const to = endDate ? Math.min(pEnd, new Date(`${endDate}T00:00:00Z`).getTime()) : pEnd;
  if (to < from) return 0;
  return Math.round((to - from) / 86400000) + 1;
}

/** Pro-rate a monthly amount by days worked / days in month (calendar-day
 *  basis — the basis is shown on the payslip, Brief §7). */
export function proRatePiasters(monthlyPiasters: number, daysWorked: number, daysInMonthCount: number): number {
  if (daysWorked >= daysInMonthCount) return monthlyPiasters;
  if (daysWorked <= 0) return 0;
  return Math.round((monthlyPiasters * daysWorked) / daysInMonthCount);
}

// --- Overtime pricing ---------------------------------------------------------
/** Hourly rate in piasters (may be fractional — round only the final amount). */
export function hourlyRatePiasters(basicPiasters: number, standardHoursPerMonth = 208): number {
  return basicPiasters / standardHoursPerMonth;
}

export function overtimePayPiasters(hourlyRate: number, minutes: number, multiplier: number): number {
  if (minutes <= 0) return 0;
  return Math.round(((hourlyRate * minutes) / 60) * multiplier);
}

// --- Payslip calculation ------------------------------------------------------

export interface PayslipAllowance { name: string; amountPiasters: number; taxable: boolean; insurable: boolean }
export interface OvertimeMinutes { dayMin: number; nightMin: number; restDayMin: number; publicHolidayMin: number }
export interface PayslipLine { label: string; labelAr: string; amountPiasters: number; kind: 'earning' | 'deduction' | 'info' }

export interface CalculatePayslipInput {
  basicPiasters: number;
  allowances: PayslipAllowance[]; // fixed monthly allowances
  overtime: OvertimeMinutes;
  bonusPiasters?: number;
  commissionPiasters?: number;
  unpaidLeaveDays?: number;
  /** Advance / loan instalments due this run (piasters). Across months the
   *  same instalment recurs until the balance is cleared (tracked in the
   *  salary structure, not here). */
  advanceInstalmentPiasters?: number;
  loanInstalmentPiasters?: number;
  otherDeductionsPiasters?: number;
  /** Signed next-run adjustment (positive = extra pay, negative = recovery). */
  adjustmentPiasters?: number;
  /** Pro-rating: days worked in the period / days in the month. Full month
   *  when daysWorked === daysInMonthCount. */
  daysWorked: number;
  daysInMonthCount: number;
  contractType?: 'full_time' | 'part_time';
  nosiEmployeePct?: number;
  /** null = UNRESOLVED — employer cost stays PENDING, never invented. */
  nosiEmployerPct?: number | null;
  nosiFloorEgp?: number;
  nosiCeilingEgp?: number;
  minimumWageEgp?: number;
  taxRules?: TaxRuleSet;
  overtimeRules?: OvertimeRuleSet;
}

export interface PayslipResult {
  proRatedBasicPiasters: number;
  proRatedAllowancesPiasters: number;
  overtimePayPiasters: number;
  overtimeBreakdown: { day: number; night: number; restDay: number; publicHoliday: number };
  bonusPiasters: number;
  commissionPiasters: number;
  absenceDeductionPiasters: number;
  grossPiasters: number;
  insurableWagePiasters: number;
  insurableAtFloor: boolean;
  insurableAtCeiling: boolean;
  employeeNosiPiasters: number;
  incomeTaxPiasters: number;
  martyrsLevyPiasters: number;
  advanceInstalmentPiasters: number;
  loanInstalmentPiasters: number;
  otherDeductionsPiasters: number;
  adjustmentPiasters: number;
  totalDeductionsPiasters: number;
  netPiasters: number;
  /** null while the NOSI employer rate is UNRESOLVED — employer cost PENDING. */
  employerNosiPiasters: number | null;
  /** Gross + employer NOSI, or null while the employer rate is pending. */
  totalEmployerCostPiasters: number | null;
  belowMinimumWage: boolean;
  lines: PayslipLine[];
  ruleRefs: { taxRuleVersion: number; taxRuleStatus: string; overtimeRuleVersion: number; overtimeRuleStatus: string };
}

export function calculatePayslip(input: CalculatePayslipInput): PayslipResult {
  const ot = input.overtimeRules ?? OVERTIME_RULES_2026;
  const tax = input.taxRules ?? TAX_RULES_2026;
  const daysWorked = input.daysWorked;
  const daysInMonthCount = input.daysInMonthCount;
  const proRatedBasic = proRatePiasters(input.basicPiasters, daysWorked, daysInMonthCount);
  const allowancesTotal = input.allowances.reduce((s, a) => s + a.amountPiasters, 0);
  const proRatedAllowances = proRatePiasters(allowancesTotal, daysWorked, daysInMonthCount);
  // Insurable allowances pro-rate in the same proportion as the allowance total.
  const insurableAllowances = input.allowances.filter((a) => a.insurable).reduce((s, a) => s + a.amountPiasters, 0);
  const proRatedInsurableAllowances = allowancesTotal === 0 ? 0
    : Math.round((proRatedAllowances * insurableAllowances) / allowancesTotal);

  const hourly = hourlyRatePiasters(input.basicPiasters, ot.standardHoursPerMonth);
  const otDay = overtimePayPiasters(hourly, input.overtime.dayMin, ot.dayMultiplier);
  const otNight = overtimePayPiasters(hourly, input.overtime.nightMin, ot.nightMultiplier);
  const otRest = overtimePayPiasters(hourly, input.overtime.restDayMin, ot.restDayMultiplier);
  const otHoliday = overtimePayPiasters(hourly, input.overtime.publicHolidayMin, ot.publicHolidayMultiplier);
  const overtimePay = otDay + otNight + otRest + otHoliday;
  const bonus = input.bonusPiasters ?? 0;
  const commission = input.commissionPiasters ?? 0;

  // Unpaid-leave / absence deduction: daily rate = contractual monthly pay /
  // calendar days in the month, per unpaid day.
  const dailyRate = Math.round((input.basicPiasters + allowancesTotal) / daysInMonthCount);
  const absenceDeduction = Math.round(dailyRate * (input.unpaidLeaveDays ?? 0));

  const gross = proRatedBasic + proRatedAllowances + overtimePay + bonus + commission - absenceDeduction;

  const insurableBase = proRatedBasic + proRatedInsurableAllowances;
  // No pay in the period (e.g. a leaver whose last day was before it) means
  // no insurable wage at all — the NOSI floor must not invent one.
  const insurable = insurableBase <= 0 ? 0
    : clampInsurableWagePiasters(insurableBase, input.nosiFloorEgp ?? 2700, input.nosiCeilingEgp ?? 16700);
  const employeeNosi = employeeNosiPiasters(insurable, input.nosiEmployeePct ?? 11);
  const incomeTax = monthlyIncomeTaxPiasters(Math.max(0, gross - employeeNosi), tax);
  const levy = martyrsLevyPiasters(Math.max(0, gross));
  const advance = input.advanceInstalmentPiasters ?? 0;
  const loan = input.loanInstalmentPiasters ?? 0;
  const other = input.otherDeductionsPiasters ?? 0;
  const adjustment = input.adjustmentPiasters ?? 0;
  const totalDeductions = employeeNosi + incomeTax + levy + advance + loan + other;
  const net = gross - totalDeductions + adjustment;

  const employerNosi = employerNosiPiasters(insurable, input.nosiEmployerPct ?? null);
  const totalEmployerCost = employerNosi === null ? null : gross + employerNosi;

  const fullMonth = daysWorked >= daysInMonthCount;
  const contractualMonthly = input.basicPiasters + allowancesTotal;
  const belowMinimumWage = (input.contractType ?? 'full_time') === 'full_time'
    && (contractualMonthly < (input.minimumWageEgp ?? 7000) * 100
      || (fullMonth && gross < (input.minimumWageEgp ?? 7000) * 100));

  const lines: PayslipLine[] = [
    { label: 'Basic salary (pro-rated)', labelAr: 'الراتب الأساسي (بنسبة الأيام)', amountPiasters: proRatedBasic, kind: 'earning' },
    { label: 'Fixed allowances', labelAr: 'البدلات الثابتة', amountPiasters: proRatedAllowances, kind: 'earning' },
    { label: 'Overtime — day', labelAr: 'عمل إضافي — نهاري', amountPiasters: otDay, kind: 'earning' },
    { label: 'Overtime — night', labelAr: 'عمل إضافي — ليلي', amountPiasters: otNight, kind: 'earning' },
    { label: 'Overtime — rest day', labelAr: 'عمل إضافي — يوم الراحة', amountPiasters: otRest, kind: 'earning' },
    { label: 'Overtime — public holiday', labelAr: 'عمل إضافي — عطلة رسمية', amountPiasters: otHoliday, kind: 'earning' },
    { label: 'Bonus', labelAr: 'مكافأة', amountPiasters: bonus, kind: 'earning' },
    { label: 'Commission', labelAr: 'عمولة', amountPiasters: commission, kind: 'earning' },
    { label: 'Absence / unpaid leave', labelAr: 'خصم غياب / إجازة بدون أجر', amountPiasters: -absenceDeduction, kind: 'deduction' },
    { label: 'Employee social insurance (11%)', labelAr: 'التأمينات الاجتماعية — حصة الموظف (11٪)', amountPiasters: -employeeNosi, kind: 'deduction' },
    { label: 'Income tax (Law 7/2024)', labelAr: 'ضريبة الدخل (قانون 7 لسنة 2024)', amountPiasters: -incomeTax, kind: 'deduction' },
    { label: "Martyrs' Fund levy (0.0002%)", labelAr: 'صندوق الشهداء (0.0002٪)', amountPiasters: -levy, kind: 'deduction' },
    { label: 'Advance instalment', labelAr: 'قسط سلفة', amountPiasters: -advance, kind: 'deduction' },
    { label: 'Loan instalment', labelAr: 'قسط قرض', amountPiasters: -loan, kind: 'deduction' },
    { label: 'Other deductions', labelAr: 'خصومات أخرى', amountPiasters: -other, kind: 'deduction' },
    { label: 'Next-run adjustment', labelAr: 'تسوية من الشهر السابق', amountPiasters: adjustment, kind: 'earning' },
    { label: 'Gross pay', labelAr: 'إجمالي الأجر', amountPiasters: gross, kind: 'info' },
    { label: 'Net pay', labelAr: 'صافي الأجر', amountPiasters: net, kind: 'info' },
    { label: 'Employer social insurance (employer cost, NOT a deduction)', labelAr: 'التأمينات — حصة صاحب العمل (تكلفة على صاحب العمل، ليست خصماً)', amountPiasters: employerNosi ?? 0, kind: 'info' },
  ];

  return {
    proRatedBasicPiasters: proRatedBasic,
    proRatedAllowancesPiasters: proRatedAllowances,
    overtimePayPiasters: overtimePay,
    overtimeBreakdown: { day: otDay, night: otNight, restDay: otRest, publicHoliday: otHoliday },
    bonusPiasters: bonus,
    commissionPiasters: commission,
    absenceDeductionPiasters: absenceDeduction,
    grossPiasters: gross,
    insurableWagePiasters: insurable,
    insurableAtFloor: insurableBase < (input.nosiFloorEgp ?? 2700) * 100,
    insurableAtCeiling: insurableBase > (input.nosiCeilingEgp ?? 16700) * 100,
    employeeNosiPiasters: employeeNosi,
    incomeTaxPiasters: incomeTax,
    martyrsLevyPiasters: levy,
    advanceInstalmentPiasters: advance,
    loanInstalmentPiasters: loan,
    otherDeductionsPiasters: other,
    adjustmentPiasters: adjustment,
    totalDeductionsPiasters: totalDeductions,
    netPiasters: net,
    employerNosiPiasters: employerNosi,
    totalEmployerCostPiasters: totalEmployerCost,
    belowMinimumWage,
    lines,
    ruleRefs: {
      taxRuleVersion: tax.version, taxRuleStatus: tax.status,
      overtimeRuleVersion: ot.version, overtimeRuleStatus: ot.status,
    },
  };
}

// --- Pre-payroll anomaly check (Brief §7 step 2; Agent 3 in M4) --------------
export interface AnomalyInput {
  employeeId: string;
  netPiasters: number;
  grossPiasters: number;
  overtimePayPiasters: number;
  basicPiasters: number;
  workedDays: number;
  missingClockOuts: number;
  previousNetPiasters: number | null;
  hasApprovedLeave: boolean;
}
export interface Anomaly { employeeId: string; kind: string; severity: 'warning' | 'block'; message: string; amountPiasters?: number }

export function detectPayrollAnomalies(rows: AnomalyInput[]): Anomaly[] {
  const out: Anomaly[] = [];
  for (const r of rows) {
    if (r.missingClockOuts > 0) {
      out.push({ employeeId: r.employeeId, kind: 'missing_clock_out', severity: 'warning', message: `${r.missingClockOuts} missing clock-out(s) in the period — hours for those days are not counted` });
    }
    if (r.basicPiasters > 0 && r.overtimePayPiasters > Math.round(r.basicPiasters * 0.5)) {
      out.push({ employeeId: r.employeeId, kind: 'overtime_spike', severity: 'warning', message: `overtime pay exceeds 50% of basic salary`, amountPiasters: r.overtimePayPiasters });
    }
    if (r.grossPiasters < 7000 * 100) {
      out.push({ employeeId: r.employeeId, kind: 'below_minimum_wage', severity: 'warning', message: 'gross pay is below the EGP 7,000 national minimum wage (full-time)', amountPiasters: r.grossPiasters });
    }
    if (r.previousNetPiasters !== null && r.previousNetPiasters > 0) {
      const move = Math.abs(r.netPiasters - r.previousNetPiasters) / r.previousNetPiasters;
      if (move > 0.25) {
        out.push({ employeeId: r.employeeId, kind: 'sharp_net_move', severity: 'warning', message: `net pay moved ${(move * 100).toFixed(0)}% vs last month`, amountPiasters: r.netPiasters - r.previousNetPiasters });
      }
    }
    if (r.workedDays === 0 && !r.hasApprovedLeave && r.grossPiasters > 0) {
      out.push({ employeeId: r.employeeId, kind: 'zero_attendance_full_pay', severity: 'warning', message: 'zero attendance in the period but full pay calculated — check before approving' });
    }
  }
  return out;
}
