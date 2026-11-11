// ============================================================================
// M4 — AI agents v1 (Brief §8, §15 M4). Pure, dependency-free logic.
// Every number an agent reports is rendered from structured data passed in —
// agents never generate figures as free text. The LLM itself is STUBBED in
// M4 (see apps/api/src/agentCore.ts): the "provider" composes outputs
// deterministically from these functions. No real LLM key exists, no real
// API calls are made. Guardrails (Brief §8): no agent changes pay, approves
// leave, publishes a roster, or disciplines anyone on its own; every output
// cites its source numbers; cost per tenant per month is tracked with a cap
// (exceeding the cap pauses the agent, never attendance/payroll).
// ============================================================================
import { detectPayrollAnomalies, type Anomaly, type AnomalyInput } from './payroll.js';

export type AgentId = 'briefing' | 'schedule' | 'anomaly' | 'qa';
export const AGENT_IDS: AgentId[] = ['briefing', 'schedule', 'anomaly', 'qa'];
export const AGENT_NAMES: Record<AgentId, { ar: string; en: string }> = {
  briefing: { ar: 'الإحاطة اليومية للمالك', en: 'Daily owner briefing' },
  schedule: { ar: 'منشئ الجداول', en: 'Schedule builder' },
  anomaly: { ar: 'فاحص شذوذ الرواتب', en: 'Pre-payroll anomaly checker' },
  qa: { ar: 'أسئلة الموظفين', en: 'Employee Q&A' },
};

/** STUBBED cost estimate per agent run, piasters. These are accounting
 *  placeholders for the demo provider — a real provider bills per token and
 *  the real cost ledger must replace these estimates in V1. */
export const AGENT_COST_PIASTERS_PER_RUN: Record<AgentId, number> = {
  briefing: 25, // EGP 0.25
  schedule: 150, // EGP 1.50
  anomaly: 100, // EGP 1.00
  qa: 10, // EGP 0.10
};

/** Default monthly cost cap per agent per tenant (EGP 500 = 50,000 piasters).
 *  Exceeding it pauses that agent only — never attendance or payroll. */
export const DEFAULT_AGENT_MONTHLY_CAP_PIASTERS = 50000;

export function monthKey(dateIso: string): string {
  return dateIso.slice(0, 7); // YYYY-MM
}

/** Cap check: returns whether the cap is exceeded and what remains. */
export function costCapStatus(monthTotalPiasters: number, capPiasters: number): {
  exceeded: boolean; remainingPiasters: number; monthTotalPiasters: number; capPiasters: number;
} {
  return {
    exceeded: monthTotalPiasters >= capPiasters,
    remainingPiasters: Math.max(0, capPiasters - monthTotalPiasters),
    monthTotalPiasters,
    capPiasters,
  };
}

export function isAgentPaused(input: { globalKilled: boolean; tenantKilled: boolean; capExceeded: boolean }): boolean {
  return input.globalKilled || input.tenantKilled || input.capExceeded;
}

// ============================================================================
// Agent 1 — Daily owner briefing (Brief §8). Facts only, rendered from data.
// ============================================================================
export interface UncoveredShift { date: string; branchName: string; shiftName: string; role: string; required: number; assigned: number }
export interface OnLeaveToday { employeeName: string; type: string }

export interface BriefingInput {
  date: string; // briefing date (today)
  yesterdayDate: string;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  missingClockOutCount: number;
  lateNames: string[];
  absentNames: string[];
  missingClockOutNames: string[];
  uncoveredShifts: UncoveredShift[];
  onLeaveToday: OnLeaveToday[];
  openExceptionsCount: number;
  /** Labour cost (gross apportioned over worked days) month-to-date, or null when the data is missing. */
  labourCostToDatePiasters: number | null;
  /** Same-point-last-month labour cost, or null when unavailable. */
  labourCostSamePointLastMonthPiasters: number | null;
  missingData: string[];
}

export interface BriefingOutput {
  textAr: string;
  textEn: string;
  topActionAr: string;
  topActionEn: string;
  facts: {
    presentCount: number; lateCount: number; absentCount: number; missingClockOutCount: number;
    uncoveredShiftCount: number; onLeaveCount: number; openExceptionsCount: number;
    labourCostToDatePiasters: number | null; labourCostSamePointLastMonthPiasters: number | null;
    labourCostMovePct: number | null;
  };
  missingData: string[];
}

function egp(piasters: number): string {
  return (piasters / 100).toFixed(2);
}

/** The one action that matters most. Priority: uncovered shift > missing
 *  clock-out > absence > late > labour-cost jump > open exceptions > none. */
export function briefingTopAction(input: BriefingInput): { ar: string; en: string } {
  if (input.uncoveredShifts.length > 0) {
    const u = input.uncoveredShifts[0];
    return {
      ar: `غطِّ وردية ${u.shiftName} في ${u.branchName} يوم ${u.date} — ${u.assigned} من ${u.required} ${u.role} فقط.`,
      en: `Cover the ${u.shiftName} shift at ${u.branchName} on ${u.date} — only ${u.assigned} of ${u.required} ${u.role} assigned.`,
    };
  }
  if (input.missingClockOutCount > 0) {
    return {
      ar: `راجع ${input.missingClockOutCount} سجلاً بلا تسجيل خروج من أمس (${input.missingClockOutNames.slice(0, 3).join('، ')}).`,
      en: `Resolve ${input.missingClockOutCount} missing clock-out(s) from yesterday (${input.missingClockOutNames.slice(0, 3).join(', ')}).`,
    };
  }
  if (input.absentCount > 0) {
    return {
      ar: `تابع غياب ${input.absentNames.slice(0, 3).join('، ')} أمس — تحقق مما إذا كان مبرراً.`,
      en: `Follow up the absence of ${input.absentNames.slice(0, 3).join(', ')} yesterday — check whether it was justified.`,
    };
  }
  if (input.lateCount > 0) {
    return {
      ar: `تابع تأخر ${input.lateNames.slice(0, 3).join('، ')} أمس.`,
      en: `Follow up the lateness of ${input.lateNames.slice(0, 3).join(', ')} yesterday.`,
    };
  }
  if (input.labourCostToDatePiasters !== null && input.labourCostSamePointLastMonthPiasters !== null
    && input.labourCostSamePointLastMonthPiasters > 0) {
    const move = (input.labourCostToDatePiasters - input.labourCostSamePointLastMonthPiasters) / input.labourCostSamePointLastMonthPiasters;
    if (move > 0.1) {
      return {
        ar: `تكلفة العمل ارتفعت ${(move * 100).toFixed(0)}٪ مقارنة بنفس الفترة من الشهر الماضي — راجع العمل الإضافي.`,
        en: `Labour cost is up ${(move * 100).toFixed(0)}% vs the same point last month — review overtime.`,
      };
    }
  }
  if (input.openExceptionsCount > 0) {
    return {
      ar: `لديك ${input.openExceptionsCount} استثناءً مفتوحاً بانتظار المراجعة.`,
      en: `You have ${input.openExceptionsCount} open exception(s) awaiting review.`,
    };
  }
  return { ar: 'لا يوجد إجراء عاجل اليوم.', en: 'No urgent action today.' };
}

export function composeBriefing(input: BriefingInput): BriefingOutput {
  const movePct = input.labourCostToDatePiasters !== null && input.labourCostSamePointLastMonthPiasters !== null
    && input.labourCostSamePointLastMonthPiasters > 0
    ? Math.round(((input.labourCostToDatePiasters - input.labourCostSamePointLastMonthPiasters) / input.labourCostSamePointLastMonthPiasters) * 1000) / 10
    : null;
  const top = briefingTopAction(input);
  const labourAr = input.labourCostToDatePiasters === null
    ? 'تكلفة العمل حتى الآن: لا توجد بيانات.'
    : input.labourCostSamePointLastMonthPiasters === null
      ? `تكلفة العمل حتى الآن: ${egp(input.labourCostToDatePiasters)} جنيه (لا توجد بيانات مقارنة من الشهر الماضي).`
      : `تكلفة العمل حتى الآن: ${egp(input.labourCostToDatePiasters)} جنيه مقابل ${egp(input.labourCostSamePointLastMonthPiasters)} جنيه في نفس الفترة من الشهر الماضي (${movePct !== null && movePct >= 0 ? '+' : ''}${movePct}٪).`;
  const labourEn = input.labourCostToDatePiasters === null
    ? 'Labour cost to date: no data available.'
    : input.labourCostSamePointLastMonthPiasters === null
      ? `Labour cost to date: EGP ${egp(input.labourCostToDatePiasters)} (no comparison data from last month).`
      : `Labour cost to date: EGP ${egp(input.labourCostToDatePiasters)} vs EGP ${egp(input.labourCostSamePointLastMonthPiasters)} at the same point last month (${movePct !== null && movePct >= 0 ? '+' : ''}${movePct}%).`;
  const uncoveredAr = input.uncoveredShifts.length === 0
    ? 'لا توجد ورديات غير مغطاة اليوم.'
    : input.uncoveredShifts.map((u) => `${u.date} — ${u.branchName} — ${u.shiftName}: ${u.assigned} من ${u.required} ${u.role}`).join('؛ ');
  const uncoveredEn = input.uncoveredShifts.length === 0
    ? 'No uncovered shifts today.'
    : input.uncoveredShifts.map((u) => `${u.date} — ${u.branchName} — ${u.shiftName}: ${u.assigned} of ${u.required} ${u.role}`).join('; ');
  const missingAr = input.missingData.length > 0 ? `\nملاحظة: ${input.missingData.join('؛ ')}` : '';
  const missingEn = input.missingData.length > 0 ? `\nNote: ${input.missingData.join('; ')}` : '';
  const textAr = `إحاطة ${input.date} — أمس (${input.yesterdayDate}): حضر ${input.presentCount}، تأخر ${input.lateCount}${input.lateNames.length ? ` (${input.lateNames.join('، ')})` : ''}، غاب ${input.absentCount}${input.absentNames.length ? ` (${input.absentNames.join('، ')})` : ''}، بلا تسجيل خروج ${input.missingClockOutCount}${input.missingClockOutNames.length ? ` (${input.missingClockOutNames.join('، ')})` : ''}.\nاليوم: ${uncoveredAr} في إجازة اليوم: ${input.onLeaveToday.length === 0 ? 'لا أحد' : input.onLeaveToday.map((l) => `${l.employeeName} (${l.type})`).join('، ')}.\n${labourAr}\nالاستثناءات المفتوحة: ${input.openExceptionsCount}.\nالإجراء الأهم: ${top.ar}${missingAr}`;
  const textEn = `Briefing ${input.date} — yesterday (${input.yesterdayDate}): present ${input.presentCount}, late ${input.lateCount}${input.lateNames.length ? ` (${input.lateNames.join(', ')})` : ''}, absent ${input.absentCount}${input.absentNames.length ? ` (${input.absentNames.join(', ')})` : ''}, missing clock-out ${input.missingClockOutCount}${input.missingClockOutNames.length ? ` (${input.missingClockOutNames.join(', ')})` : ''}.\nToday: ${uncoveredEn} On leave today: ${input.onLeaveToday.length === 0 ? 'nobody' : input.onLeaveToday.map((l) => `${l.employeeName} (${l.type})`).join(', ')}.\n${labourEn}\nOpen exceptions: ${input.openExceptionsCount}.\nTop action: ${top.en}${missingEn}`;
  return {
    textAr, textEn, topActionAr: top.ar, topActionEn: top.en,
    facts: {
      presentCount: input.presentCount, lateCount: input.lateCount, absentCount: input.absentCount,
      missingClockOutCount: input.missingClockOutCount, uncoveredShiftCount: input.uncoveredShifts.length,
      onLeaveCount: input.onLeaveToday.length, openExceptionsCount: input.openExceptionsCount,
      labourCostToDatePiasters: input.labourCostToDatePiasters,
      labourCostSamePointLastMonthPiasters: input.labourCostSamePointLastMonthPiasters,
      labourCostMovePct: movePct,
    },
    missingData: input.missingData,
  };
}

// ============================================================================
// Agent 2 — Schedule builder (Brief §8). Draft ONLY, never auto-publishes.
// Every suggestion shows its reason; violations are explicit.
// ============================================================================
export interface DraftSuggestionInput {
  employeeId: string;
  employeeName: string;
  jobTitle: string;
  date: string;
  shiftTemplateId: string;
  shiftName: string;
  /** How many of the last N weeks the employee worked this template on this weekday. */
  historyWeeksWorked: number;
  historyWeeksTotal: number;
  onLeave: boolean;
  restHoursBefore: number | null; // null = no previous shift found
  weeklyHoursAfter: number;
  weeklyHoursCap: number;
  consecutiveDays: number;
  maxConsecutiveDays: number;
  minRestHours: number;
  coverageRequired: number;
  coverageAssigned: number;
}

export interface DraftViolation { code: string; reasonAr: string; reasonEn: string }

export function scoreDraftSuggestion(s: DraftSuggestionInput): {
  ok: boolean; violations: DraftViolation[]; warnings: DraftViolation[]; reasonAr: string; reasonEn: string; score: number;
} {
  const violations: DraftViolation[] = [];
  const warnings: DraftViolation[] = [];
  if (s.onLeave) {
    violations.push({ code: 'on_leave', reasonAr: 'الموظف في إجازة معتمدة في هذا التاريخ', reasonEn: 'employee is on approved leave on this date' });
  }
  if (s.restHoursBefore !== null && s.restHoursBefore < s.minRestHours) {
    violations.push({ code: 'insufficient_rest', reasonAr: `راحة ${s.restHoursBefore.toFixed(1)} ساعة فقط قبل هذه الوردية (الحد الأدنى ${s.minRestHours} ساعة)`, reasonEn: `only ${s.restHoursBefore.toFixed(1)}h rest before this shift (minimum ${s.minRestHours}h)` });
  }
  if (s.weeklyHoursAfter > s.weeklyHoursCap) {
    violations.push({ code: 'weekly_hours_cap', reasonAr: `ساعات الأسبوع ${s.weeklyHoursAfter.toFixed(1)} تتجاوز الحد ${s.weeklyHoursCap}`, reasonEn: `weekly hours ${s.weeklyHoursAfter.toFixed(1)} exceed the ${s.weeklyHoursCap}h cap` });
  }
  if (s.consecutiveDays > s.maxConsecutiveDays) {
    violations.push({ code: 'consecutive_days', reasonAr: `${s.consecutiveDays} أيام متتالية تتجاوز الحد ${s.maxConsecutiveDays}`, reasonEn: `${s.consecutiveDays} consecutive days exceed the maximum ${s.maxConsecutiveDays}` });
  }
  if (s.coverageAssigned < s.coverageRequired) {
    warnings.push({ code: 'coverage_shortfall', reasonAr: `التغطية ${s.coverageAssigned} من ${s.coverageRequired} ${s.jobTitle} في هذه الوردية`, reasonEn: `coverage ${s.coverageAssigned} of ${s.coverageRequired} ${s.jobTitle} on this shift` });
  }
  const historyAr = s.historyWeeksTotal > 0
    ? `عمل هذه الوردية ${s.historyWeeksWorked} من آخر ${s.historyWeeksTotal} أسابيع في هذا اليوم`
    : 'لا يوجد سجل سابق لهذا اليوم — تم الاختيار من الوردية الأكثر تكراراً للموظف';
  const historyEn = s.historyWeeksTotal > 0
    ? `worked this shift ${s.historyWeeksWorked} of the last ${s.historyWeeksTotal} weeks on this weekday`
    : 'no history for this weekday — chosen from the employee\u2019s most frequent shift';
  const score = Math.max(0, 100 - violations.length * 30 - warnings.length * 10);
  return {
    ok: violations.length === 0,
    violations,
    warnings,
    reasonAr: `${historyAr}. ${violations.length ? 'مخالفات: ' + violations.map((v) => v.reasonAr).join('؛ ') : 'لا مخالفات لقواعد الراحة والساعات.'}`,
    reasonEn: `${historyEn}. ${violations.length ? 'Violations: ' + violations.map((v) => v.reasonEn).join('; ') : 'No rest/hours rule violations.'}`,
    score,
  };
}

// ============================================================================
// Agent 3 — Pre-payroll anomaly checker (Brief §8). Ranked, amounts in EGP.
// Extends the M3 base check with: duplicate payment, overtime spike vs the
// employee's own history, and missing clock-outs priced as full days.
// ============================================================================
export interface Agent3AnomalyInput extends AnomalyInput {
  /** Average overtime pay (piasters) across the employee's prior runs, or null when there is no history. */
  previousOvertimePayAvgPiasters: number | null;
  /** True when the employee appears more than once in this run. */
  duplicateInRun: boolean;
  daysInMonthCount: number;
}

/** Rank: blocks first, then warnings, each by amount descending. */
export function rankAnomalies(anomalies: Anomaly[]): Anomaly[] {
  return [...anomalies].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'block' ? -1 : 1;
    return (b.amountPiasters ?? 0) - (a.amountPiasters ?? 0);
  });
}

export function detectAgent3Anomalies(rows: Agent3AnomalyInput[]): Anomaly[] {
  const out: Anomaly[] = [];
  // Base M3 check first (missing clock-out, OT > 50% of basic, below minimum
  // wage, sharp net move, zero attendance but full pay).
  const base = detectPayrollAnomalies(rows);
  for (const a of base) {
    if (a.kind === 'missing_clock_out') {
      // Price the missing clock-out as full day(s): daily rate × missing days.
      // Base is gross when calculated, basic when only a preview exists.
      const row = rows.find((r) => r.employeeId === a.employeeId)!;
      const base = Math.max(row.grossPiasters, row.basicPiasters);
      const dailyRate = row.daysInMonthCount > 0 ? Math.round(base / row.daysInMonthCount) : 0;
      out.push({
        ...a,
        amountPiasters: dailyRate * row.missingClockOuts,
        message: `${a.message} — priced as ${row.missingClockOuts} full day(s) at EGP ${(dailyRate / 100).toFixed(2)}/day (EGP ${((dailyRate * row.missingClockOuts) / 100).toFixed(2)} at risk)`,
      });
    } else {
      out.push(a);
    }
  }
  for (const r of rows) {
    if (r.duplicateInRun) {
      out.push({
        employeeId: r.employeeId, kind: 'duplicate_payment', severity: 'block',
        message: 'employee appears more than once in this run — duplicate payment risk, do not approve until resolved',
        amountPiasters: r.netPiasters,
      });
    }
    if (r.previousOvertimePayAvgPiasters !== null && r.previousOvertimePayAvgPiasters > 0
      && r.overtimePayPiasters > 2 * r.previousOvertimePayAvgPiasters && r.overtimePayPiasters > 50000) {
      out.push({
        employeeId: r.employeeId, kind: 'overtime_spike_vs_history', severity: 'warning',
        message: `overtime pay EGP ${(r.overtimePayPiasters / 100).toFixed(2)} is more than double the employee's own average of EGP ${(r.previousOvertimePayAvgPiasters / 100).toFixed(2)}`,
        amountPiasters: r.overtimePayPiasters - r.previousOvertimePayAvgPiasters,
      });
    }
  }
  return rankAnomalies(out);
}

// ============================================================================
// Agent 4 — Employee Q&A (Brief §8). Own data only; payslip answers quote
// the payslip lines, they never recalculate pay. Unanswered → route to manager.
// ============================================================================
export type QaIntent = 'next_shift' | 'leave_balance' | 'payslip_deduction' | 'unknown';

const QA_KEYWORDS: { intent: QaIntent; ar: string[]; en: string[] }[] = [
  { intent: 'payslip_deduction', ar: ['خصم', 'خصموا', 'ليه', 'لماذا', 'راتب', 'مرتب', 'كشف'], en: ['deduct', 'deduction', 'why', 'payslip', 'salary', 'pay'] },
  { intent: 'leave_balance', ar: ['إجازة', 'اجازة', 'رصيد', 'عطلة'], en: ['leave', 'vacation', 'balance', 'days off'] },
  { intent: 'next_shift', ar: ['وردية', 'وردي', 'شيفت', 'شفت', 'دوام', 'امتى', 'متى'], en: ['shift', 'next shift', 'when', 'schedule', 'work'] },
];

export function matchQaIntent(question: string): { intent: QaIntent; confidence: number; matchedKeywords: string[] } {
  const q = question.toLowerCase();
  for (const group of QA_KEYWORDS) {
    const matched = [...group.ar, ...group.en].filter((k) => q.includes(k.toLowerCase()));
    if (matched.length > 0) return { intent: group.intent, confidence: Math.min(1, 0.5 + matched.length * 0.25), matchedKeywords: matched };
  }
  return { intent: 'unknown', confidence: 0, matchedKeywords: [] };
}

/** Extract an EGP amount mentioned in the question ("why was EGP 500 deducted?"). */
export function extractEgpAmountPiasters(question: string): number | null {
  const m = question.match(/(?:EGP|جنيه|ج\.م)\s*([\d,]+(?:\.\d{1,2})?)/i) ?? question.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:EGP|جنيه)/i);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export interface QaOwnData {
  employeeName: string;
  nextShift: { date: string; shiftName: string; startTime: string; endTime: string; branchName: string } | null;
  leaveBalances: { type: string; remainingDays: number; entitlementDays: number }[];
  latestPayslip: { period: string; netPiasters: number; lines: { label: string; labelAr: string; amountPiasters: number; kind: string }[] } | null;
  questionAmountPiasters: number | null;
}

export interface QaAnswer { answerAr: string; answerEn: string; sources: string[]; routed: boolean }

export function composeQaAnswer(intent: QaIntent, data: QaOwnData): QaAnswer {
  if (intent === 'next_shift') {
    if (!data.nextShift) {
      return {
        answerAr: 'لا توجد وردية قادمة منشورة لك حالياً. إذا كان لديك سؤال آخر، أخبرني وسأحوّله إلى مديرك.',
        answerEn: 'You have no upcoming published shift right now. If you have another question, tell me and I will route it to your manager.',
        sources: ['published rosters'], routed: false,
      };
    }
    const s = data.nextShift;
    return {
      answerAr: `ورديتك القادمة: ${s.date} — ${s.shiftName} (${s.startTime}–${s.endTime}) في فرع ${s.branchName}.`,
      answerEn: `Your next shift: ${s.date} — ${s.shiftName} (${s.startTime}–${s.endTime}) at ${s.branchName}.`,
      sources: ['published rosters'], routed: false,
    };
  }
  if (intent === 'leave_balance') {
    if (data.leaveBalances.length === 0) {
      return {
        answerAr: 'لا توجد بيانات رصيد إجازات لك حالياً.',
        answerEn: 'No leave balance data is available for you right now.',
        sources: ['leave balances'], routed: false,
      };
    }
    const parts = data.leaveBalances.map((b) => `${b.type}: ${b.remainingDays} من ${b.entitlementDays}`);
    return {
      answerAr: `رصيد إجازاتك المتبقي: ${parts.join('، ')} يوم.`,
      answerEn: `Your remaining leave balance: ${parts.join(', ')} days.`,
      sources: ['leave balances'], routed: false,
    };
  }
  if (intent === 'payslip_deduction') {
    if (!data.latestPayslip) {
      return {
        answerAr: 'لا يوجد كشف راتب لك بعد في هذه الفترة. سأحوّل سؤالك إلى مديرك.',
        answerEn: 'There is no payslip for you yet in this period. I will route your question to your manager.',
        sources: ['payslips'], routed: true,
      };
    }
    const deductions = data.latestPayslip.lines.filter((l) => l.amountPiasters < 0);
    const p = data.latestPayslip;
    if (data.questionAmountPiasters !== null) {
      const match = deductions.find((l) => Math.abs(l.amountPiasters) === data.questionAmountPiasters);
      if (match) {
        return {
          answerAr: `في كشف راتب ${p.period}: خصم ${match.labelAr} (${match.label}) بقيمة ${(Math.abs(match.amountPiasters) / 100).toFixed(2)} جنيه. صافي أجرك في هذه الفترة ${(p.netPiasters / 100).toFixed(2)} جنيه. هذا مقتبس من كشف راتبك — لم يُعاد حساب الأجر.`,
          answerEn: `In your ${p.period} payslip: ${match.label} of EGP ${(Math.abs(match.amountPiasters) / 100).toFixed(2)}. Your net pay for the period is EGP ${(p.netPiasters / 100).toFixed(2)}. This is quoted from your payslip — pay was not recalculated.`,
          sources: [`payslip ${p.period}`], routed: false,
        };
      }
      return {
        answerAr: `في كشف راتب ${p.period} لا يوجد خصم بقيمة ${(data.questionAmountPiasters / 100).toFixed(2)} جنيه بالضبط. الخصومات في كشفك هي: ${deductions.map((l) => `${l.labelAr} ${(Math.abs(l.amountPiasters) / 100).toFixed(2)} جنيه`).join('، ') || 'لا توجد خصومات'}. سأحوّل سؤالك إلى مديرك للتأكيد.`,
        answerEn: `Your ${p.period} payslip has no deduction of exactly EGP ${(data.questionAmountPiasters / 100).toFixed(2)}. Its deductions are: ${deductions.map((l) => `${l.label} EGP ${(Math.abs(l.amountPiasters) / 100).toFixed(2)}`).join(', ') || 'none'}. I will route your question to your manager to confirm.`,
        sources: [`payslip ${p.period}`], routed: true,
      };
    }
    if (deductions.length === 0) {
      return {
        answerAr: `في كشف راتب ${p.period} لا توجد خصومات. صافي أجرك ${(p.netPiasters / 100).toFixed(2)} جنيه.`,
        answerEn: `Your ${p.period} payslip has no deductions. Net pay is EGP ${(p.netPiasters / 100).toFixed(2)}.`,
        sources: [`payslip ${p.period}`], routed: false,
      };
    }
    return {
      answerAr: `في كشف راتب ${p.period} الخصومات هي: ${deductions.map((l) => `${l.labelAr} ${(Math.abs(l.amountPiasters) / 100).toFixed(2)} جنيه`).join('، ')}. صافي أجرك ${(p.netPiasters / 100).toFixed(2)} جنيه. هذا مقتبس من كشف راتبك — لم يُعاد حساب الأجر.`,
      answerEn: `In your ${p.period} payslip the deductions are: ${deductions.map((l) => `${l.label} EGP ${(Math.abs(l.amountPiasters) / 100).toFixed(2)}`).join(', ')}. Net pay is EGP ${(p.netPiasters / 100).toFixed(2)}. This is quoted from your payslip — pay was not recalculated.`,
      sources: [`payslip ${p.period}`], routed: false,
    };
  }
  return {
    answerAr: 'لم أفهم سؤالك. سأحوّله إلى مديرك وسيرد عليك.',
    answerEn: 'I did not understand your question. I will route it to your manager, who will reply.',
    sources: [], routed: true,
  };
}

// ============================================================================
// Support tooling — masked ticket context (Brief §11). Names initialled,
// phones partially masked, no photos, no salary figures, ever.
// ============================================================================
export function maskName(fullNameAr: string): string {
  const parts = fullNameAr.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '؟';
  const initial = (w: string) => `${w.charAt(0)}.`;
  return parts.length === 1 ? initial(parts[0]) : `${initial(parts[0])} ${initial(parts[parts.length - 1])}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 8) return '•••';
  return `+${digits.slice(0, 4)}•••${digits.slice(-4)}`;
}

// ============================================================================
// Offline hardening (Brief §9) — conflict-resolution rules for the M2 queue.
// ============================================================================
export type OfflineSyncOutcome =
  | 'accepted' | 'duplicate' | 'conflict_overlap' | 'stale' | 'unsigned' | 'invalid_signature';

export function classifyOfflineSync(input: {
  alreadyExists: boolean;
  overlapsActiveSession: boolean;
  ageHours: number;
  toleranceHours: number;
  signaturePresent: boolean;
  signatureValid: boolean | null; // null = no strict verification configured (legacy)
}): { outcome: OfflineSyncOutcome; reason: string } {
  if (input.alreadyExists) {
    return { outcome: 'duplicate', reason: 'duplicate offline record for the same employee and device time — kept for review, never silently overwritten' };
  }
  if (!input.signaturePresent) {
    return { outcome: 'unsigned', reason: 'unsigned offline record — held for review' };
  }
  if (input.signatureValid === false) {
    return { outcome: 'invalid_signature', reason: 'offline record signature verification failed — held for review' };
  }
  if (input.overlapsActiveSession) {
    return { outcome: 'conflict_overlap', reason: 'employee already has an active clock-in session overlapping this offline record — held for review' };
  }
  if (input.ageHours > input.toleranceHours) {
    return { outcome: 'stale', reason: `offline record synced ${input.ageHours.toFixed(1)}h after device time (tolerance ${input.toleranceHours}h) — held for review` };
  }
  return { outcome: 'accepted', reason: 'accepted' };
}

/** Sync-status aggregation: pending = offline records still awaiting review,
 *  accepted = applied, conflicted = everything held for review. */
export function aggregateSyncStatus(records: { outcome: OfflineSyncOutcome }[], pendingReviewCount: number): {
  accepted: number; conflicted: number; pending: number; total: number;
} {
  const accepted = records.filter((r) => r.outcome === 'accepted').length;
  const conflicted = records.filter((r) => r.outcome !== 'accepted').length;
  return { accepted, conflicted, pending: pendingReviewCount, total: records.length };
}
