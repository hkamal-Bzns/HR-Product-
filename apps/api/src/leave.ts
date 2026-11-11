// M2 leave: request validation, approval (marks roster on-leave), balances,
// Egypt public holidays 2026 (pre-loaded, editable by the owner).
import { canRequestLeave, isPublicHoliday, leaveBalance, EGYPT_PUBLIC_HOLIDAYS_2026, DEFAULT_LEAVE_SETTINGS, type LeaveType } from '@hr-payroll/shared';
import { newId, type MemoryStore, type LeaveRequestRecord } from '@hr-payroll/db';
import { notifyEmployee } from './notify.js';

export function leaveSettings(store: MemoryStore, tenantId: string) {
  const latest = store.latestSettings(tenantId, 'leave');
  const value = (latest?.value ?? {}) as Record<string, unknown>;
  return {
    types: (value.types as { type: LeaveType; yearlyDays: number; accrual: string; carryOverCapDays: number; negativeAllowed: boolean; minNoticeDays: number; approver: string; evidenceRequired: boolean }[] | undefined)
      ?? DEFAULT_LEAVE_SETTINGS.types,
    publicHolidays: (value.publicHolidays as { date: string; nameAr: string; nameEn: string; provisional: boolean }[] | undefined) ?? EGYPT_PUBLIC_HOLIDAYS_2026,
  };
}
export function daysBetween(startDate: string, endDate: string): number {
  const s = new Date(`${startDate}T00:00:00Z`).getTime();
  const e = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.round((e - s) / 86400000) + 1;
}

export function validateLeaveRequest(
  store: MemoryStore, tenantId: string, employeeId: string, type: LeaveType,
  startDate: string, endDate: string,
): { ok: boolean; reasons: string[]; warnings: string[]; days: number } {
  const settings = leaveSettings(store, tenantId);
  const typeCfg = settings.types.find((t) => t.type === type);
  if (!typeCfg) return { ok: false, reasons: [`unknown leave type ${type}`], warnings: [], days: 0 };
  const days = daysBetween(startDate, endDate);
  if (days <= 0) return { ok: false, reasons: ['end date must be on or after start date'], warnings: [], days };
  const year = Number(startDate.slice(0, 4));
  const bal = store.leaveBalanceFor(tenantId, employeeId, year, type);
  const balanceDays = bal ? leaveBalance(bal.entitlementDays, bal.carriedDays, bal.takenDays) : typeCfg.yearlyDays;
  const daysUntilStart = Math.round((new Date(`${startDate}T00:00:00Z`).getTime() - Date.now()) / 86400000);
  const check = canRequestLeave(balanceDays, days, typeCfg.negativeAllowed, 0, daysUntilStart, typeCfg.minNoticeDays);
  const warnings: string[] = [];
  // Public-holiday overlap is a warning, not a block — the owner may still approve.
  for (let d = new Date(`${startDate}T00:00:00Z`); d <= new Date(`${endDate}T00:00:00Z`); d = new Date(d.getTime() + 86400000)) {
    const h = isPublicHoliday(d.toISOString().slice(0, 10), settings.publicHolidays);
    if (h) warnings.push(`${h.date} is a public holiday (${h.nameEn})${h.provisional ? ' — date provisional' : ''}`);
  }
  return { ok: check.ok, reasons: check.reasons, warnings, days };
}

/** Approve: deduct balance, mark roster assignments on-leave, notify (stubbed). */
export async function approveLeave(
  store: MemoryStore, tenantId: string, req: LeaveRequestRecord, decidedByUserId: string,
): Promise<LeaveRequestRecord> {
  req.status = 'approved';
  req.decidedByUserId = decidedByUserId;
  req.decidedAt = new Date().toISOString();
  const year = Number(req.startDate.slice(0, 4));
  const bal = store.leaveBalanceFor(tenantId, req.employeeId, year, req.type);
  if (bal) bal.takenDays = Math.round((bal.takenDays + req.days) * 100) / 100;
  // Approved leave removes the employee from expected attendance.
  let marked = 0;
  for (const a of store.rosterAssignments) {
    if (a.tenantId === tenantId && a.employeeId === req.employeeId && a.date >= req.startDate && a.date <= req.endDate && !a.onLeave) {
      a.onLeave = true; marked++;
    }
  }
  const emp = store.employees.find((e) => e.id === req.employeeId);
  if (emp) {
    await notifyEmployee(store, tenantId, emp, 'leave_decision',
      `تمت الموافقة على إجازتك (${req.type}) من ${req.startDate} إلى ${req.endDate}. / Your ${req.type} leave ${req.startDate} to ${req.endDate} was approved.`);
  }
  store.log({ tenantId, actorUserId: decidedByUserId, actorKind: 'tenant_user', action: 'leave.approve', entity: 'leave_request', detail: { requestId: req.id, employeeId: req.employeeId, days: req.days, rosterAssignmentsMarkedOnLeave: marked } });
  return req;
}

export function newLeaveRequestId(): string { return newId('leave'); }
