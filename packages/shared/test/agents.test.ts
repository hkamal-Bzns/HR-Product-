// M4 — AI agents pure logic tests (Brief §8). All figures rendered from
// structured data; nothing is generated as free text.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeBriefing, briefingTopAction, scoreDraftSuggestion,
  detectAgent3Anomalies, rankAnomalies, matchQaIntent, extractEgpAmountPiasters,
  composeQaAnswer, maskName, maskPhone, classifyOfflineSync, aggregateSyncStatus,
  costCapStatus, isAgentPaused, AGENT_COST_PIASTERS_PER_RUN,
  DEFAULT_AGENT_MONTHLY_CAP_PIASTERS,
} from '../src/agents.js';

const baseBriefing = {
  date: '2026-11-11', yesterdayDate: '2026-11-10',
  presentCount: 3, lateCount: 1, absentCount: 0, missingClockOutCount: 1,
  lateNames: ['سارة علي'], absentNames: [], missingClockOutNames: ['حسن إبراهيم'],
  uncoveredShifts: [], onLeaveToday: [{ employeeName: 'نورا سامي', type: 'annual' }],
  openExceptionsCount: 3,
  labourCostToDatePiasters: 1000000, labourCostSamePointLastMonthPiasters: 900000,
  missingData: [],
};

test('M4 Agent 1: briefing renders counts/names/amounts from data, never invents', () => {
  const out = composeBriefing(baseBriefing);
  assert.match(out.textAr, /حضر 3/);
  assert.match(out.textAr, /سارة علي/);
  assert.match(out.textAr, /10000\.00 جنيه/);
  assert.match(out.textAr, /9000\.00 جنيه/);
  assert.match(out.textAr, /\+11\.1٪/);
  assert.equal(out.facts.presentCount, 3);
  assert.equal(out.facts.labourCostMovePct, 11.1);
  // Missing data is stated, never invented.
  const missing = composeBriefing({ ...baseBriefing, labourCostToDatePiasters: null, labourCostSamePointLastMonthPiasters: null, missingData: ['لا توجد بيانات تكلفة عمل للشهر الماضي'] });
  assert.match(missing.textAr, /لا توجد بيانات/);
  assert.equal(missing.facts.labourCostToDatePiasters, null);
});

test('M4 Agent 1: top action priority — uncovered shift beats missing clock-out beats late', () => {
  const uncovered = briefingTopAction({ ...baseBriefing, uncoveredShifts: [{ date: '2026-11-11', branchName: 'الزمالك', shiftName: 'صباحي', role: 'Waiter', required: 2, assigned: 0 }] });
  assert.match(uncovered.ar, /غطِّ وردية/);
  const mco = briefingTopAction(baseBriefing);
  assert.match(mco.ar, /بلا تسجيل خروج/);
  const late = briefingTopAction({ ...baseBriefing, missingClockOutCount: 0, missingClockOutNames: [] });
  assert.match(late.ar, /تابع تأخر/);
  const none = briefingTopAction({ ...baseBriefing, lateCount: 0, lateNames: [], missingClockOutCount: 0, missingClockOutNames: [], openExceptionsCount: 0, labourCostToDatePiasters: 900000 });
  assert.match(none.ar, /لا يوجد إجراء عاجل/);
});

test('M4 Agent 2: draft scoring flags rest/caps/leave with reasons, never silent', () => {
  const ok = scoreDraftSuggestion({
    employeeId: 'e1', employeeName: 'أحمد', jobTitle: 'Barista', date: '2026-11-16',
    shiftTemplateId: 'tpl-morning', shiftName: 'صباحي', historyWeeksWorked: 3, historyWeeksTotal: 4,
    onLeave: false, restHoursBefore: 14, weeklyHoursAfter: 40, weeklyHoursCap: 48,
    consecutiveDays: 3, maxConsecutiveDays: 6, minRestHours: 11,
    coverageRequired: 1, coverageAssigned: 1,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.score, 100);
  assert.match(ok.reasonAr, /3 من آخر 4 أسابيع/);
  const bad = scoreDraftSuggestion({
    employeeId: 'e1', employeeName: 'أحمد', jobTitle: 'Barista', date: '2026-11-16',
    shiftTemplateId: 'tpl-morning', shiftName: 'صباحي', historyWeeksWorked: 0, historyWeeksTotal: 4,
    onLeave: true, restHoursBefore: 5, weeklyHoursAfter: 55, weeklyHoursCap: 48,
    consecutiveDays: 7, maxConsecutiveDays: 6, minRestHours: 11,
    coverageRequired: 2, coverageAssigned: 1,
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.violations.map((v) => v.code), ['on_leave', 'insufficient_rest', 'weekly_hours_cap', 'consecutive_days']);
  assert.equal(bad.warnings[0].code, 'coverage_shortfall');
  assert.ok(bad.score < 100);
  assert.match(bad.reasonAr, /في إجازة/);
});

test('M4 Agent 3: extended anomalies — duplicate (block), OT spike vs own history, missing clock-out priced as full day', () => {
  const rows = [
    {
      employeeId: 'e-dup', netPiasters: 800000, grossPiasters: 900000, overtimePayPiasters: 0,
      basicPiasters: 800000, workedDays: 20, missingClockOuts: 0, previousNetPiasters: 800000,
      hasApprovedLeave: false, previousOvertimePayAvgPiasters: null, duplicateInRun: true, daysInMonthCount: 30,
    },
    {
      employeeId: 'e-ot', netPiasters: 1200000, grossPiasters: 1300000, overtimePayPiasters: 300000,
      basicPiasters: 800000, workedDays: 22, missingClockOuts: 0, previousNetPiasters: 900000,
      hasApprovedLeave: false, previousOvertimePayAvgPiasters: 100000, duplicateInRun: false, daysInMonthCount: 30,
    },
    {
      employeeId: 'e-mco', netPiasters: 750000, grossPiasters: 750000, overtimePayPiasters: 0,
      basicPiasters: 700000, workedDays: 10, missingClockOuts: 2, previousNetPiasters: 750000,
      hasApprovedLeave: false, previousOvertimePayAvgPiasters: null, duplicateInRun: false, daysInMonthCount: 30,
    },
  ];
  const out = detectAgent3Anomalies(rows);
  // Duplicate is a block and ranks first.
  assert.equal(out[0].kind, 'duplicate_payment');
  assert.equal(out[0].severity, 'block');
  assert.equal(out[0].amountPiasters, 800000);
  const spike = out.find((a) => a.kind === 'overtime_spike_vs_history');
  assert.ok(spike);
  assert.equal(spike.amountPiasters, 200000); // 300,000 − 100,000 average
  assert.match(spike.message, /3000\.00/);
  const mco = out.find((a) => a.employeeId === 'e-mco' && a.kind === 'missing_clock_out');
  assert.ok(mco);
  assert.equal(mco.amountPiasters, 50000); // 750,000/30 = 25,000/day × 2 days
  assert.match(mco.message, /full day/);
  // Ranking: blocks first.
  assert.equal(rankAnomalies(out)[0].severity, 'block');
});

test('M4 Agent 3: no history means no OT-spike flag (never invent a baseline)', () => {
  const out = detectAgent3Anomalies([{
    employeeId: 'e1', netPiasters: 900000, grossPiasters: 1000000, overtimePayPiasters: 400000,
    basicPiasters: 800000, workedDays: 22, missingClockOuts: 0, previousNetPiasters: null,
    hasApprovedLeave: false, previousOvertimePayAvgPiasters: null, duplicateInRun: false, daysInMonthCount: 30,
  }]);
  assert.equal(out.some((a) => a.kind === 'overtime_spike_vs_history'), false);
});

test('M4 Agent 4: intent matching in Arabic and English', () => {
  assert.equal(matchQaIntent('ما هي ورديتي القادمة؟').intent, 'next_shift');
  assert.equal(matchQaIntent('What is my next shift?').intent, 'next_shift');
  assert.equal(matchQaIntent('كم رصيد إجازتي؟').intent, 'leave_balance');
  assert.equal(matchQaIntent('How much leave do I have?').intent, 'leave_balance');
  assert.equal(matchQaIntent('لماذا تم خصم 500 جنيه من راتبي؟').intent, 'payslip_deduction');
  assert.equal(matchQaIntent('Why was EGP 500 deducted?').intent, 'payslip_deduction');
  assert.equal(matchQaIntent('ما هو الطقس اليوم؟').intent, 'unknown');
  assert.equal(extractEgpAmountPiasters('Why was EGP 500 deducted?'), 50000);
  assert.equal(extractEgpAmountPiasters('لماذا تم خصم 592.50 جنيه؟'), 59250);
  assert.equal(extractEgpAmountPiasters('ما هي ورديتي؟'), null);
});

test('M4 Agent 4: deduction answers trace to payslip lines, never recalculate', () => {
  const data = {
    employeeName: 'أحمد محمد',
    nextShift: { date: '2026-11-16', shiftName: 'صباحي', startTime: '09:00', endTime: '17:00', branchName: 'الزمالك' },
    leaveBalances: [{ type: 'annual', remainingDays: 19, entitlementDays: 21 }],
    latestPayslip: {
      period: '2026-11', netPiasters: 830748,
      lines: [
        { label: 'Basic salary (pro-rated)', labelAr: 'الراتب الأساسي', amountPiasters: 800000, kind: 'earning' },
        { label: 'Employee social insurance (11%)', labelAr: 'التأمينات الاجتماعية — حصة الموظف (11٪)', amountPiasters: -110000, kind: 'deduction' },
        { label: 'Income tax (Law 7/2024)', labelAr: 'ضريبة الدخل', amountPiasters: -59250, kind: 'deduction' },
      ],
    },
    questionAmountPiasters: 110000,
  };
  const a = composeQaAnswer('payslip_deduction', data);
  assert.equal(a.routed, false);
  assert.match(a.answerAr, /التأمينات الاجتماعية/);
  assert.match(a.answerAr, /1100\.00 جنيه/);
  assert.match(a.answerAr, /8307\.48/);
  assert.match(a.answerAr, /لم يُعاد حساب الأجر/);
  // Amount not on the payslip → routed to the manager, with the actual lines quoted.
  const noMatch = composeQaAnswer('payslip_deduction', { ...data, questionAmountPiasters: 50000 });
  assert.equal(noMatch.routed, true);
  assert.match(noMatch.answerAr, /لا يوجد خصم بقيمة 500\.00/);
  // Next shift and leave balance come from the employee's own data only.
  const shift = composeQaAnswer('next_shift', data);
  assert.match(shift.answerAr, /2026-11-16/);
  const leave = composeQaAnswer('leave_balance', data);
  assert.match(leave.answerAr, /19 من 21/);
  const unknown = composeQaAnswer('unknown', data);
  assert.equal(unknown.routed, true);
});

test('M4 support masking: names initialled, phones partially masked', () => {
  assert.equal(maskName('أحمد محمد'), 'أ. م.');
  assert.equal(maskName('سارة'), 'س.');
  assert.equal(maskPhone('+201012345678'), '+2010•••5678');
  assert.ok(!maskPhone('+201012345678').includes('1234'));
});

test('M4 offline: conflict rules — duplicate, unsigned, invalid signature, stale, overlap', () => {
  const base = { alreadyExists: false, overlapsActiveSession: false, ageHours: 2, toleranceHours: 24, signaturePresent: true, signatureValid: true as boolean | null };
  assert.equal(classifyOfflineSync(base).outcome, 'accepted');
  assert.equal(classifyOfflineSync({ ...base, alreadyExists: true }).outcome, 'duplicate');
  assert.equal(classifyOfflineSync({ ...base, signaturePresent: false }).outcome, 'unsigned');
  assert.equal(classifyOfflineSync({ ...base, signatureValid: false }).outcome, 'invalid_signature');
  assert.equal(classifyOfflineSync({ ...base, ageHours: 30 }).outcome, 'stale');
  assert.equal(classifyOfflineSync({ ...base, overlapsActiveSession: true }).outcome, 'conflict_overlap');
  const agg = aggregateSyncStatus(
    [{ outcome: 'accepted' }, { outcome: 'duplicate' }, { outcome: 'stale' }, { outcome: 'accepted' }],
    2,
  );
  assert.deepEqual(agg, { accepted: 2, conflicted: 2, pending: 2, total: 4 });
});

test('M4 guardrails: cost cap pauses the agent, never payroll; stub costs are piasters', () => {
  assert.equal(AGENT_COST_PIASTERS_PER_RUN.briefing, 25);
  assert.equal(DEFAULT_AGENT_MONTHLY_CAP_PIASTERS, 50000);
  assert.equal(costCapStatus(49999, 50000).exceeded, false);
  assert.equal(costCapStatus(50000, 50000).exceeded, true);
  assert.equal(costCapStatus(60000, 50000).remainingPiasters, 0);
  assert.equal(isAgentPaused({ globalKilled: false, tenantKilled: false, capExceeded: false }), false);
  assert.equal(isAgentPaused({ globalKilled: true, tenantKilled: false, capExceeded: false }), true);
  assert.equal(isAgentPaused({ globalKilled: false, tenantKilled: false, capExceeded: true }), true);
});
