// M2 roster helpers: templates, coverage warnings, rest guards, swaps, open shifts.
import {
  restBetweenShiftsOk, consecutiveDaysOk, weeklyHoursOk,
} from '@hr-payroll/shared';
import { newId, type MemoryStore, type RosterRecord, type RosterAssignmentRecord } from '@hr-payroll/db';
import { shiftSettings } from './attendance.js';
import { notifyEmployee } from './notify.js';

export interface CoverageWarning { date: string; shiftTemplateId: string | null; role: string; required: number; assigned: number; message: string }

export function templateMinutes(t: { startTime: string; endTime: string; overnight: boolean; unpaidBreakMinutes: number }): number {
  const [sh, sm] = t.startTime.split(':').map(Number);
  const [eh, em] = t.endTime.split(':').map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (t.overnight || mins <= 0) mins += 1440;
  return mins - t.unpaidBreakMinutes;
}

/** Coverage warnings for a set of assignments (never blocks creation — warns). */
export function coverageWarnings(
  store: MemoryStore, tenantId: string,
  assignments: { date: string; shiftTemplateId: string | null; employeeId: string }[],
): CoverageWarning[] {
  const settings = shiftSettings(store, tenantId);
  const warnings: CoverageWarning[] = [];
  const byKey = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const key = `${a.date}|${a.shiftTemplateId ?? ''}`;
    byKey.set(key, [...(byKey.get(key) ?? []), a]);
  }
  for (const [key, group] of byKey) {
    const [date, templateId] = key.split('|');
    const counts = new Map<string, number>();
    for (const a of group) {
      const emp = store.employees.find((e) => e.id === a.employeeId);
      if (emp) counts.set(emp.jobTitle, (counts.get(emp.jobTitle) ?? 0) + 1);
    }
    for (const [role, required] of Object.entries(settings.coverageMinimums)) {
      const assigned = counts.get(role) ?? 0;
      if (assigned < required) {
        warnings.push({ date, shiftTemplateId: templateId || null, role, required, assigned, message: `${date}: only ${assigned}/${required} ${role} assigned` });
      }
    }
  }
  return warnings;
}

/** Rest / overload validation for one employee's new assignment against existing ones. */
export function validateAssignment(
  store: MemoryStore, tenantId: string, employeeId: string, date: string, templateId: string,
): string[] {
  const settings = shiftSettings(store, tenantId);
  const problems: string[] = [];
  const template = store.shiftTemplates.find((t) => t.id === templateId);
  if (!template) return ['unknown shift template'];
  const [sh, sm] = template.startTime.split(':').map(Number);
  const startMs = new Date(`${date}T00:00:00+02:00`).getTime() + (sh * 60 + sm) * 60000;
  const endMs = startMs + templateMinutes(template) * 60000;
  const existing = store.rosterAssignments.filter((a) => a.tenantId === tenantId && a.employeeId === employeeId && !a.onLeave);
  for (const a of existing) {
    const t2 = a.shiftTemplateId ? store.shiftTemplates.find((t) => t.id === a.shiftTemplateId) : undefined;
    if (!t2 || a.date === date) continue;
    const [sh2, sm2] = t2.startTime.split(':').map(Number);
    const s2 = new Date(`${a.date}T00:00:00+02:00`).getTime() + (sh2 * 60 + sm2) * 60000;
    const e2 = s2 + templateMinutes(t2) * 60000;
    // Adjacent shifts: rest in either direction.
    if (Math.abs(startMs - e2) < 7 * 86400000 || Math.abs(s2 - endMs) < 7 * 86400000) {
      const r = e2 <= startMs ? restBetweenShiftsOk(e2, startMs, settings.minRestHoursBetweenShifts) : restBetweenShiftsOk(endMs, s2, settings.minRestHoursBetweenShifts);
      if (!r.ok) problems.push(`insufficient rest: ${r.restHours.toFixed(1)}h between shifts on ${a.date} and ${date} (minimum ${settings.minRestHoursBetweenShifts}h)`);
    }
  }
  // Weekly hours: sum this ISO week's assignments + the new one.
  const weekStart = new Date(`${date}T00:00:00+02:00`);
  const dow = (weekStart.getUTCDay() + 6) % 7; // Monday = 0
  weekStart.setUTCDate(weekStart.getUTCDate() - dow);
  const weekEnd = weekStart.getTime() + 7 * 86400000;
  let weekMinutes = templateMinutes(template);
  for (const a of existing) {
    const d = new Date(`${a.date}T00:00:00+02:00`).getTime();
    if (d >= weekStart.getTime() && d < weekEnd) {
      const t2 = a.shiftTemplateId ? store.shiftTemplates.find((t) => t.id === a.shiftTemplateId) : undefined;
      if (t2) weekMinutes += templateMinutes(t2);
    }
  }
  const wh = weeklyHoursOk(weekMinutes, settings.weeklyHoursCap);
  if (!wh.ok) problems.push(`weekly hours ${wh.hours.toFixed(1)}h exceed cap ${settings.weeklyHoursCap}h`);
  // Consecutive days: count run ending on this date.
  let run = 1;
  const dates = new Set(existing.map((a) => a.date));
  let cursor = new Date(`${date}T00:00:00+02:00`);
  for (let i = 0; i < 30; i++) {
    cursor = new Date(cursor.getTime() - 86400000);
    if (dates.has(cursor.toISOString().slice(0, 10))) run++;
    else break;
  }
  if (!consecutiveDaysOk(run, settings.maxConsecutiveDays)) problems.push(`${run} consecutive days exceeds maximum ${settings.maxConsecutiveDays}`);
  return problems;
}

export async function publishRoster(
  store: MemoryStore, tenantId: string, roster: RosterRecord, publishedByUserId: string,
): Promise<{ roster: RosterRecord; warnings: CoverageWarning[]; notified: number; stubbed: true }> {
  const assignments: RosterAssignmentRecord[] = store.rosterAssignments.filter((a) => a.rosterId === roster.id);
  const warnings = coverageWarnings(store, tenantId, assignments);
  roster.status = 'published';
  roster.publishedAt = new Date().toISOString();
  roster.publishedByUserId = publishedByUserId;
  let notified = 0;
  const settings = shiftSettings(store, tenantId);
  if (settings.publishNotificationsOn) {
    const seen = new Set<string>();
    for (const a of assignments) {
      if (seen.has(a.employeeId)) continue;
      seen.add(a.employeeId);
      const emp = store.employees.find((e) => e.id === a.employeeId);
      if (!emp) continue;
      await notifyEmployee(store, tenantId, emp, 'roster_published',
        `جدول الأسبوع ${roster.weekStart} تم نشره. راجع وردياتك في التطبيق. / Your roster for week ${roster.weekStart} is published.`);
      notified++;
    }
  }
  store.log({ tenantId, actorUserId: publishedByUserId, actorKind: 'tenant_user', action: 'roster.publish', entity: 'roster', detail: { rosterId: roster.id, weekStart: roster.weekStart, notified, warnings: warnings.length, note: 'WhatsApp notify STUBBED — queued only, not delivered' } });
  return { roster, warnings, notified, stubbed: true };
}

/** Swap validation: cover must share the requester's role and pass rest rules. */
export function validateSwapCover(
  store: MemoryStore, tenantId: string, assignment: RosterAssignmentRecord, coverEmployeeId: string,
): string[] {
  const requester = store.employees.find((e) => e.id === assignment.employeeId);
  const cover = store.employees.find((e) => e.id === coverEmployeeId);
  if (!requester || !cover) return ['unknown employee'];
  if (requester.tenantId !== tenantId || cover.tenantId !== tenantId) return ['cross-tenant access denied'];
  if (requester.jobTitle !== cover.jobTitle) return [`cover role ${cover.jobTitle} does not match required role ${requester.jobTitle}`];
  if (!assignment.shiftTemplateId) return ['assignment has no shift template'];
  return validateAssignment(store, tenantId, coverEmployeeId, assignment.date, assignment.shiftTemplateId);
}

export function newRosterId(): string { return newId('roster'); }
