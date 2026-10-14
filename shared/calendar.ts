export type CalendarAttendance = 'invited' | 'attending' | 'declined';
export interface CalendarInvitee { id: string; displayName: string; status: CalendarAttendance }
export interface CalendarComment { number: number; authorId: string; authorName: string; body: string; createdAt: string }
export interface CalendarOccurrence { number: number; start: string; end: string; originalStart: string; originalEnd: string; status: 'scheduled' | 'cancelled'; overridden: boolean; invitees: CalendarInvitee[] }
export interface CalendarData extends Record<string, unknown> {
  description: string; location: string; hostId: string; timezone: string; allDay: boolean;
  /** Timed events use ISO instants. All-day events use YYYY-MM-DD, end exclusive. */
  start: string; end: string; status: 'scheduled' | 'cancelled';
  invitees: CalendarInvitee[]; comments: CalendarComment[];
  recurrence: { frequency: 'daily' | 'weekly'; count: number; startLocal: string; endLocal: string } | null;
  occurrences: CalendarOccurrence[];
}
export function calendarAddDays(date: string, count: number): string {
  const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
export function calendarOccurrences(data: CalendarData): CalendarOccurrence[] {
  return data.recurrence ? data.occurrences : [{ number: 1, start: data.start, end: data.end, originalStart: data.start, originalEnd: data.end, status: data.status, overridden: false, invitees: data.invitees }];
}
/** Include people who joined an individual occurrence without a series invite. */
export function calendarParticipants(data: CalendarData): CalendarInvitee[] {
  const people = new Map<string, CalendarInvitee>();
  for (const person of [...data.invitees, ...data.occurrences.flatMap(item => item.invitees)]) if (!people.has(person.id)) people.set(person.id, person);
  return [...people.values()];
}

export function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && Number(value.slice(0, 4)) >= 1000;
}
export function validCalendarTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(0); return Boolean(timezone); } catch { return false; }
}
export function calendarLocalTime(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const part = (name: string) => parts.find(item => item.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
/** Prefer editable wall-clock values, adding the original offset only when it
 * is needed to preserve a repeated DST time or sub-minute precision exactly. */
export function calendarEditTime(instant: string, timezone: string): string {
  const canonical = new Date(instant).toISOString(), local = calendarLocalTime(canonical, timezone);
  try { if (calendarInstant(local, timezone) === canonical) return local; } catch { /* Repeated wall clock requires an explicit offset. */ }
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, second: '2-digit', fractionalSecondDigits: 3 }).formatToParts(new Date(canonical));
  const seconds = parts.find(part => part.type === 'second')!.value.padStart(2, '0'), fraction = parts.find(part => part.type === 'fractionalSecond')!.value.padEnd(3, '0');
  const exactLocal = `${local}:${seconds}.${fraction}`, offset = (Date.parse(`${exactLocal}Z`) - Date.parse(canonical)) / 60_000;
  // Historic timezone offsets can contain seconds, which ISO offsets cannot
  // represent here. Preserve the exact instant explicitly in that rare case.
  if (!Number.isInteger(offset) || Math.abs(offset) > 23 * 60 + 59) return canonical;
  const suffix = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  return `${local}${seconds !== '00' || fraction !== '000' ? `:${seconds}${fraction !== '000' ? `.${fraction}` : ''}` : ''}${suffix}`;
}
/** Resolve an IANA wall clock without silently shifting a DST gap or choosing
 * one of two repeated instants. Explicit ISO offsets can disambiguate repeats. */
export function calendarInstant(value: string, timezone: string): string {
  if (!validCalendarTimezone(timezone)) throw new Error('Use a valid IANA timezone, such as America/Los_Angeles or UTC.');
  const explicit = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (explicit) {
    if (!validCalendarDate(explicit[1]!) || Number(explicit[2]) > 23 || Number(explicit[3]) > 59 || Number(explicit[4] || 0) > 59) throw new Error('Use a valid calendar date and time.');
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) throw new Error('Use a valid ISO time offset.');
    return time.toISOString();
  }
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!local || !validCalendarDate(local[1]!) || Number(local[2]) > 23 || Number(local[3]) > 59) throw new Error('Use YYYY-MM-DDTHH:mm, or an ISO timestamp with an explicit offset.');
  const nominal = Date.parse(`${value}:00Z`), offsets = new Set<number>();
  // Sampling both sides captures transition offsets, including half-hour and
  // full-day transitions. A candidate must round-trip to the exact wall clock.
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = nominal + hours * 3_600_000;
    offsets.add(Date.parse(`${calendarLocalTime(new Date(probe).toISOString(), timezone)}:00Z`) - probe);
  }
  const candidates = [...offsets].map(offset => new Date(nominal - offset).toISOString()).filter(candidate => calendarLocalTime(candidate, timezone) === value);
  if (!candidates.length) throw new Error('This local time does not exist because the timezone clock changes. Choose another time.');
  if (candidates.length !== 1) throw new Error('This local time occurs twice because the timezone clock changes. Supply an ISO timestamp with an explicit offset.');
  return candidates[0]!;
}
export function calendarDisplayRange(data: CalendarData): string {
  if (data.allDay) return `${data.start} – ${data.end} (end exclusive) · All day`;
  return `${calendarLocalTime(data.start, data.timezone).replace('T', ' ')} – ${calendarLocalTime(data.end, data.timezone).replace('T', ' ')} · ${data.timezone}`;
}
