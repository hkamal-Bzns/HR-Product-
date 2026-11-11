// M3 payroll engine tests — Brief Appendix A (worked example) + Appendix B
// golden cases. All money in piasters. Hand-verified figures in comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePayslip, monthlyIncomeTaxPiasters, annualIncomeTaxPiasters,
  clampInsurableWagePiasters, employerNosiPiasters, employeeNosiPiasters,
  martyrsLevyPiasters, proRatePiasters, workedDaysInPeriod, daysInMonth,
  overtimePayPiasters, hourlyRatePiasters, detectPayrollAnomalies,
  TAX_RULES_2026, OVERTIME_RULES_2026, PAYROLL_REVIEW_STATUS,
  type CalculatePayslipInput,
} from '../src/index.js';

const base = (over: Partial<CalculatePayslipInput> = {}): CalculatePayslipInput => ({
  basicPiasters: 1000000, // EGP 10,000
  allowances: [],
  overtime: { dayMin: 0, nightMin: 0, restDayMin: 0, publicHolidayMin: 0 },
  daysWorked: 30, daysInMonthCount: 30,
  ...over,
});

test('Appendix A worked example: gross 10,000, NOSI 1,100, tax 592.50, levy 0.02, net 8,307.48', () => {
  // Annual taxable: (10,000 − 1,100) × 12 − 20,000 = 86,800.
  // Tax: 0×40,000 + 10%×15,000 (1,500) + 15%×15,000 (2,250) + 20%×16,800 (3,360)
  //   = 7,110 / year → 592.50 / month. Levy: 0.0002% × 10,000 = 0.02.
  const r = calculatePayslip(base());
  assert.equal(r.grossPiasters, 1000000);
  assert.equal(r.insurableWagePiasters, 1000000);
  assert.equal(r.employeeNosiPiasters, 110000);
  assert.equal(r.incomeTaxPiasters, 59250);
  assert.equal(r.martyrsLevyPiasters, 2);
  assert.equal(r.netPiasters, 830748);
  assert.equal(r.employerNosiPiasters, null); // UNRESOLVED — never invented
  assert.equal(r.totalEmployerCostPiasters, null);
  assert.equal(r.ruleRefs.taxRuleStatus, PAYROLL_REVIEW_STATUS);
});

test('Appendix A with reviewer-set employer rate (test-only, via Settings flow): employer cost math', () => {
  // The rate is supplied by the caller (the API test sets it through the
  // guarded Settings change); the engine itself ships no default.
  const r = calculatePayslip(base({ nosiEmployerPct: 18.75 }));
  assert.equal(r.employerNosiPiasters, 187500);
  assert.equal(r.totalEmployerCostPiasters, 1187500);
  // Employer contribution is NEVER a deduction from the employee.
  assert.equal(r.netPiasters, 830748);
});

test('Tax brackets (Law 7/2024): zero below exemption, slices, phase-out above 600k', () => {
  // Monthly taxable 5,000 → annual (5,000×12 − 20,000) = 40,000 → 0% band → 0.
  assert.equal(monthlyIncomeTaxPiasters(500000), 0);
  // Annual taxable 317,956 EGP (gross 30,000 case): 1,500+2,250+26,000
  // + 22.5%×117,956 (26,540.10) = 56,290.10 / year → 4,690.84 / month.
  assert.equal(annualIncomeTaxPiasters(31795600), 5629010);
  assert.equal(monthlyIncomeTaxPiasters(2816300), 469084);
  // Phase-out: annual taxable 650,000 → 10%×55,000 + 15%×15,000 + 20%×130,000
  // + 22.5%×200,000 + 25%×250,000 = 141,250.
  assert.equal(annualIncomeTaxPiasters(65000000), 14125000);
  // Above 1.2m: 25%×1,200,000 + 27.5%×300,000 = 382,500.
  assert.equal(annualIncomeTaxPiasters(150000000), 38250000);
  assert.equal(TAX_RULES_2026.personalExemptionEgpAnnual, 20000);
});

test('NOSI floor 2,700 and ceiling 16,700 (golden cases)', () => {
  assert.equal(clampInsurableWagePiasters(250000), 270000);
  assert.equal(clampInsurableWagePiasters(3000000), 1670000);
  assert.equal(clampInsurableWagePiasters(1000000), 1000000);
  assert.equal(employeeNosiPiasters(270000), 29700); // 11% of 2,700
  assert.equal(employeeNosiPiasters(1670000), 183700); // 11% of 16,700
  assert.equal(employerNosiPiasters(1000000, null), null);
  // Floor employee: gross 2,500 → insurable 2,700, NOSI 297, tax 0, net 2,202.99
  const floor = calculatePayslip(base({ basicPiasters: 200000, allowances: [{ name: 'Transport', amountPiasters: 50000, taxable: true, insurable: true }] }));
  assert.equal(floor.insurableWagePiasters, 270000);
  assert.equal(floor.insurableAtFloor, true);
  assert.equal(floor.employeeNosiPiasters, 29700);
  assert.equal(floor.incomeTaxPiasters, 0);
  assert.equal(floor.netPiasters, 250000 - 29700 - 1); // levy 0.5 piaster rounds to 1
  // Ceiling employee: gross 30,000 → insurable capped at 16,700
  const ceil = calculatePayslip(base({ basicPiasters: 3000000 }));
  assert.equal(ceil.insurableWagePiasters, 1670000);
  assert.equal(ceil.insurableAtCeiling, true);
  assert.equal(ceil.employeeNosiPiasters, 183700);
});

test('Pro-rating: joiner mid-month and leaver mid-month (golden cases)', () => {
  assert.equal(daysInMonth(2026, 11), 30);
  assert.equal(workedDaysInPeriod('2026-11-01', '2026-11-30', '2026-11-16', null), 15);
  assert.equal(workedDaysInPeriod('2026-11-01', '2026-11-30', null, '2026-11-15'), 15);
  assert.equal(workedDaysInPeriod('2026-11-01', '2026-11-30', null, null), 30);
  assert.equal(proRatePiasters(1000000, 15, 30), 500000);
  const joiner = calculatePayslip(base({ daysWorked: 15 }));
  assert.equal(joiner.grossPiasters, 500000);
  assert.equal(joiner.employeeNosiPiasters, 55000); // 11% of 5,000
  const leaver = calculatePayslip(base({ daysWorked: 15 }));
  assert.equal(leaver.grossPiasters, 500000);
});

test('Minimum wage flag: pay below EGP 7,000 flagged (golden case)', () => {
  const low = calculatePayslip(base({ basicPiasters: 600000 }));
  assert.equal(low.belowMinimumWage, true);
  const ok = calculatePayslip(base({ basicPiasters: 700000 }));
  assert.equal(ok.belowMinimumWage, false);
  // Part-time staff are not flagged against the full-time minimum.
  const pt = calculatePayslip(base({ basicPiasters: 400000, contractType: 'part_time' }));
  assert.equal(pt.belowMinimumWage, false);
});

test('Overtime multipliers: day 1.35, night 1.70, rest day 2.00, public holiday 3.00', () => {
  const hourly = hourlyRatePiasters(800000); // 8,000 / 208h
  assert.equal(overtimePayPiasters(hourly, 120, OVERTIME_RULES_2026.dayMultiplier), 10385);
  assert.equal(overtimePayPiasters(hourly, 120, OVERTIME_RULES_2026.nightMultiplier), 13077);
  assert.equal(overtimePayPiasters(hourly, 480, OVERTIME_RULES_2026.restDayMultiplier), 61538);
  assert.equal(overtimePayPiasters(hourly, 480, OVERTIME_RULES_2026.publicHolidayMultiplier), 92308);
  // Rest-day + holiday OT on a payslip (golden cases)
  const r = calculatePayslip(base({ basicPiasters: 800000, overtime: { dayMin: 0, nightMin: 0, restDayMin: 480, publicHolidayMin: 480 } }));
  assert.equal(r.overtimeBreakdown.restDay, 61538);
  assert.equal(r.overtimeBreakdown.publicHoliday, 92308);
  assert.equal(r.overtimePayPiasters, 61538 + 92308);
});

test('Unpaid leave day deducts one daily rate (golden case)', () => {
  // Daily rate = 10,000 / 30 = 333.33 → 33,333 piasters for 1 day.
  const r = calculatePayslip(base({ unpaidLeaveDays: 1 }));
  assert.equal(r.absenceDeductionPiasters, 33333);
  assert.equal(r.grossPiasters, 1000000 - 33333);
});

test('Advance / loan instalment deducted across two months (golden case)', () => {
  const month1 = calculatePayslip(base({ advanceInstalmentPiasters: 100000, loanInstalmentPiasters: 50000 }));
  const month2 = calculatePayslip(base({ advanceInstalmentPiasters: 100000, loanInstalmentPiasters: 50000 }));
  assert.equal(month1.netPiasters, month2.netPiasters);
  assert.equal(month1.netPiasters, 830748 - 150000);
  assert.equal(month1.advanceInstalmentPiasters, 100000);
});

test('Locked run corrected only via next-run adjustment (golden case)', () => {
  // The engine treats adjustments as signed lines on a LATER payslip; the
  // locked run's own figures are never recomputed (enforced in the API).
  const corrected = calculatePayslip(base({ adjustmentPiasters: -50000 }));
  assert.equal(corrected.netPiasters, 830748 - 50000);
  assert.equal(corrected.adjustmentPiasters, -50000);
  const plain = calculatePayslip(base());
  assert.equal(plain.netPiasters, 830748); // original run untouched
});

test('Leaver with zero days in the period: no pay, no NOSI floor, net zero', () => {
  const r = calculatePayslip(base({ daysWorked: 0 }));
  assert.equal(r.grossPiasters, 0);
  assert.equal(r.insurableWagePiasters, 0);
  assert.equal(r.employeeNosiPiasters, 0);
  assert.equal(r.incomeTaxPiasters, 0);
  assert.equal(r.netPiasters, 0);
});

test('Martyrs levy: 0.0002% on gross (basis REVIEWER-UNCONFIRMED)', () => {
  assert.equal(martyrsLevyPiasters(1000000), 2);
  assert.equal(martyrsLevyPiasters(0), 0);
});

test('Anomaly detection: missing clock-out, OT spike, below minimum, sharp move, zero attendance', () => {
  const rows = detectPayrollAnomalies([
    { employeeId: 'e1', netPiasters: 800000, grossPiasters: 900000, overtimePayPiasters: 0, basicPiasters: 800000, workedDays: 22, missingClockOuts: 2, previousNetPiasters: 800000, hasApprovedLeave: false },
    { employeeId: 'e2', netPiasters: 1200000, grossPiasters: 1300000, overtimePayPiasters: 600000, basicPiasters: 800000, workedDays: 22, missingClockOuts: 0, previousNetPiasters: 800000, hasApprovedLeave: false },
    { employeeId: 'e3', netPiasters: 600000, grossPiasters: 600000, overtimePayPiasters: 0, basicPiasters: 600000, workedDays: 22, missingClockOuts: 0, previousNetPiasters: 600000, hasApprovedLeave: false },
    { employeeId: 'e4', netPiasters: 1000000, grossPiasters: 1000000, overtimePayPiasters: 0, basicPiasters: 1000000, workedDays: 0, missingClockOuts: 0, previousNetPiasters: null, hasApprovedLeave: false },
  ]);
  const kinds = rows.map((r) => r.kind);
  assert.ok(kinds.includes('missing_clock_out'));
  assert.ok(kinds.includes('overtime_spike'));
  assert.ok(kinds.includes('below_minimum_wage'));
  assert.ok(kinds.includes('sharp_net_move')); // e2 net +50% vs last month
  assert.ok(kinds.includes('zero_attendance_full_pay'));
});
