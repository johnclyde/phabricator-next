import { calendarAddDays, calendarInstant, calendarLocalTime, calendarParticipants, validCalendarDate, validCalendarTimezone, type CalendarData, type CalendarInvitee, type CalendarOccurrence } from '../shared/calendar.ts';
import type { SuiteContext, SuiteModule } from './suite-contract.ts';
import { HttpError, choice, integer, object, optionalString, string } from './validation.ts';

function invitees(value: unknown, context: SuiteContext): CalendarInvitee[] {
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string')) throw new HttpError(400, 'Invitees must be a list of people.');
  return [...new Set(value as string[])].map(id => ({ ...context.requirePerson(id), status: 'invited' }));
}
function schedule(value: Record<string, unknown>) {
  const timezone = string(value.timezone, 'Timezone', 120);
  if (!validCalendarTimezone(timezone)) throw new HttpError(400, 'Use a valid IANA timezone, such as America/Los_Angeles or UTC.');
  if (typeof value.allDay !== 'boolean') throw new HttpError(400, 'All day must be true or false.');
  let start = string(value.start, 'Start', 60), end = string(value.end, 'End', 60);
  if (value.allDay) {
    if (!validCalendarDate(start) || !validCalendarDate(end)) throw new HttpError(400, 'All-day dates must use YYYY-MM-DD; the end date is exclusive.');
  } else {
    try { start = calendarInstant(start, timezone); end = calendarInstant(end, timezone); }
    catch (error) { throw new HttpError(400, (error as Error).message); }
  }
  if (end <= start) throw new HttpError(400, 'The event end must follow its start.');
  return { timezone, allDay: value.allDay, start, end };
}
function recurring(data: CalendarData, value: Record<string, unknown>): Pick<CalendarData, 'recurrence' | 'occurrences'> {
  const frequency = choice(value.recurrenceFrequency ?? 'none', 'recurrence frequency', ['none', 'daily', 'weekly']);
  if (frequency === 'none') {
    if (value.recurrenceCount !== undefined && value.recurrenceCount !== 1) throw new HttpError(400, 'A one-off event must have an occurrence count of 1.');
    return { recurrence: null, occurrences: [] };
  }
  const count = integer(value.recurrenceCount, 'Occurrence count');
  if (count < 2 || count > 366) throw new HttpError(400, 'Recurring series require an explicit count from 2 to 366, including the first occurrence.');
  if (!data.allDay && (![data.start, data.end].every(time => time.endsWith(':00.000Z')))) throw new HttpError(400, 'Recurring events require whole-minute start and end times.');
  const startLocal = data.allDay ? data.start : calendarLocalTime(data.start, data.timezone), endLocal = data.allDay ? data.end : calendarLocalTime(data.end, data.timezone), occurrences: CalendarOccurrence[] = [];
  for (let index = 0; index < count; index++) {
    const shift = index * (frequency === 'weekly' ? 7 : 1), advance = (local: string) => `${calendarAddDays(local.slice(0, 10), shift)}${local.slice(10)}`;
    try {
      const start = index === 0 ? data.start : data.allDay ? advance(startLocal) : calendarInstant(advance(startLocal), data.timezone);
      const end = index === 0 ? data.end : data.allDay ? advance(endLocal) : calendarInstant(advance(endLocal), data.timezone);
      if (end <= start || !validCalendarDate(start.slice(0, 10)) || !validCalendarDate(end.slice(0, 10))) throw new Error('The occurrence has an invalid or unordered date.');
      occurrences.push({ number: index + 1, start, end, originalStart: start, originalEnd: end, status: 'scheduled', overridden: false, invitees: data.invitees.map(person => ({ ...person })) });
    } catch (error) { throw new HttpError(400, `Occurrence ${index + 1}: ${(error as Error).message}`); }
  }
  return { recurrence: { frequency, count, startLocal, endLocal }, occurrences };
}
function occurrence(data: CalendarData, value: unknown): CalendarOccurrence {
  const number = integer(value, 'Occurrence');
  const result = data.occurrences.find(item => item.number === number);
  if (!data.recurrence || !result) throw new HttpError(400, 'Choose a saved occurrence in this recurring series.');
  return result;
}
function withOccurrence(data: CalendarData, changed: CalendarOccurrence): CalendarOccurrence[] { return data.occurrences.map(item => item.number === changed.number ? changed : item); }
export const calendarModule: SuiteModule = {
  app: 'calendar', prefix: 'E',
  create(input, context) {
    const value = object(input, ['kind', 'title', 'description', 'location', 'timezone', 'allDay', 'start', 'end', 'inviteeIds', 'recurrenceFrequency', 'recurrenceCount']);
    if (value.kind !== undefined && value.kind !== 'event') throw new HttpError(400, 'Unknown calendar event kind.');
    const people = invitees(value.inviteeIds ?? [], context).filter(person => person.id !== context.actor.principalId);
    const data: CalendarData = { description: optionalString(value.description, 'Description', 100_000), location: optionalString(value.location, 'Location', 2_000), hostId: context.actor.principalId, ...schedule(value), status: 'scheduled', invitees: [{ id: context.actor.principalId, displayName: context.actor.displayName, status: 'attending' }, ...people], comments: [], recurrence: null, occurrences: [] };
    Object.assign(data, recurring(data, value));
    return { kind: 'event', title: string(value.title, 'Event title', 240).trim(), data, summary: 'Created a calendar event.' };
  },
  command(record, action, input, context) {
    const saved = record.data as CalendarData;
    if (action === 'rsvp') {
      if (saved.status === 'cancelled') throw new HttpError(409, 'This event is cancelled.');
      const value = object(input, ['status', 'occurrence']), status = choice(value.status, 'attendance', ['attending', 'declined'] as const), person = context.requirePerson(context.actor.principalId);
      if (!saved.recurrence && value.occurrence !== undefined) throw new HttpError(400, 'A one-off event does not have recurring occurrences.');
      const item = saved.recurrence ? occurrence(saved, value.occurrence) : null;
      if (item?.status === 'cancelled') throw new HttpError(409, 'This occurrence is cancelled.');
      const people = [...(item?.invitees ?? saved.invitees)], index = people.findIndex(candidate => candidate.id === person.id);
      if (index < 0) people.push({ ...person, status }); else people[index] = { ...people[index]!, status };
      return { data: item ? { ...saved, occurrences: withOccurrence(saved, { ...item, invitees: people }) } : { ...saved, invitees: people }, summary: `${status === 'attending' ? 'Will attend' : 'Declined'} ${item ? `occurrence ${item.number}` : 'the event'}.` };
    }
    if (action === 'comment') {
      const value = object(input, ['body']), body = string(value.body, 'Comment', 100_000);
      return { data: { ...saved, comments: [...saved.comments, { number: saved.comments.length + 1, authorId: context.actor.principalId, authorName: context.actor.displayName, body, createdAt: context.now }] }, summary: 'Commented on the event.' };
    }
    context.requireEdit(record);
    if (action === 'edit') {
      const value = object(input, ['title', 'description', 'location', 'timezone', 'allDay', 'start', 'end']);
      const next = schedule(value);
      if (saved.recurrence && (next.start !== saved.start || next.end !== saved.end || next.timezone !== saved.timezone || next.allDay !== saved.allDay)) throw new HttpError(409, 'The generated series schedule is fixed. Edit an individual occurrence, or create a replacement series.');
      return { title: string(value.title, 'Event title', 240).trim(), data: { ...saved, ...next, description: optionalString(value.description, 'Description', 100_000), location: optionalString(value.location, 'Location', 2_000) }, summary: saved.recurrence ? 'Edited the details for the entire series.' : 'Edited the event details and schedule.' };
    }
    if (action === 'invite') {
      const value = object(input, ['inviteeIds']), added = invitees(value.inviteeIds, context), people = [...saved.invitees];
      for (const person of added) if (!people.some(existing => existing.id === person.id)) people.push(person);
      // Invitations never silently grant access to a private event or Space.
      const occurrences = saved.occurrences.map(item => ({ ...item, invitees: [...item.invitees, ...added.filter(person => !item.invitees.some(existing => existing.id === person.id))] }));
      return { data: { ...saved, invitees: people, occurrences }, summary: saved.recurrence ? 'Invited people to every occurrence in the series.' : 'Invited people to the event.' };
    }
    if (action === 'uninvite') {
      const value = object(input, ['inviteeIds']);
      const participants = calendarParticipants(saved);
      if (!Array.isArray(value.inviteeIds) || !value.inviteeIds.every(id => typeof id === 'string' && participants.some(person => person.id === id))) throw new HttpError(400, 'Choose existing invitations or participants to remove.');
      const removed = value.inviteeIds as string[];
      if (removed.includes(saved.hostId)) throw new HttpError(400, 'The event host cannot be uninvited.');
      return { data: { ...saved, invitees: saved.invitees.filter(person => !removed.includes(person.id)), occurrences: saved.occurrences.map(item => ({ ...item, invitees: item.invitees.filter(person => !removed.includes(person.id)) })) }, summary: saved.recurrence ? 'Removed invitations from every occurrence in the series.' : 'Removed event invitations.' };
    }
    if (action === 'edit-occurrence' || action === 'cancel-occurrence' || action === 'reinstate-occurrence') {
      const value = object(input, action === 'edit-occurrence' ? ['occurrence', 'start', 'end'] : ['occurrence']), item = occurrence(saved, value.occurrence);
      if (action === 'edit-occurrence') {
        const next = schedule({ ...value, allDay: saved.allDay, timezone: saved.timezone });
        return { data: { ...saved, occurrences: withOccurrence(saved, { ...item, start: next.start, end: next.end, overridden: true }) }, summary: `Changed only occurrence ${item.number}; the original generated times remain recorded.` };
      }
      const status = action === 'cancel-occurrence' ? 'cancelled' : 'scheduled';
      if (item.status === status) throw new HttpError(409, `Occurrence ${item.number} is already ${status}.`);
      return { data: { ...saved, occurrences: withOccurrence(saved, { ...item, status }) }, summary: `${status === 'cancelled' ? 'Cancelled' : 'Reinstated'} only occurrence ${item.number}.` };
    }
    if (action === 'cancel' || action === 'reinstate') {
      object(input, []);
      if (saved.status === (action === 'cancel' ? 'cancelled' : 'scheduled')) throw new HttpError(409, action === 'cancel' ? 'This event is already cancelled.' : 'This event is already scheduled.');
      return { data: { ...saved, status: action === 'cancel' ? 'cancelled' : 'scheduled' }, summary: action === 'cancel' ? 'Cancelled the event.' : 'Reinstated the event.' };
    }
    throw new HttpError(400, 'Unknown calendar action.');
  },
};
