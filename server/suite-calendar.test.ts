import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarModule as module } from './suite-calendar.ts';
import { calendarInstant, calendarLocalTime, calendarDisplayRange, calendarEditTime, calendarParticipants, validCalendarDate, type CalendarData } from '../shared/calendar.ts';
import type { SuiteRecord } from '../shared/suite.ts';
import type { SuiteContext } from './suite-contract.ts';
import { HttpError } from './validation.ts';

const now = '2026-10-14T12:00:00.000Z';
function context(id = 'alice', editable = true): SuiteContext {
  return { actor: { workspaceId: 'workspace', principalId: id, displayName: id.toUpperCase(), credentialId: 'credential', kind: 'session', sessionContext: 'session', scopes: ['read', 'write'] }, now, get() { throw new Error('Unused'); }, list: () => [], exists: () => false, canEdit: () => editable, requireEdit() { if (!editable) throw new HttpError(403, 'Cannot edit.'); }, requirePerson(person) { if (!['alice', 'bob', 'carol'].includes(person)) throw new HttpError(400, 'Unknown person.'); return { id: person, displayName: person.toUpperCase() }; } };
}
const schedule = { timezone: 'America/Los_Angeles', allDay: false, start: '2026-10-15T09:00', end: '2026-10-15T10:00' };
function event(input: Record<string, unknown> = {}): SuiteRecord {
  const value = module.create({ kind: 'event', title: 'Research meeting', ...schedule, inviteeIds: ['bob'], ...input }, context());
  return { id: 'E1', app: 'calendar', kind: value.kind, title: value.title, ownerId: 'alice', version: 1, createdAt: now, updatedAt: now, access: { spaceId: 'S1', visibility: 'workspace', memberIds: [], editorIds: [] }, data: value.data };
}
function change(record: SuiteRecord, action: string, input: unknown, actor = 'alice', editable = true): SuiteRecord {
  const value = module.command(record, action, input, context(actor, editable));
  return { ...record, ...value, access: { ...record.access, ...value.access }, version: record.version + 1 };
}
test('Calendar creates exact timezone-aware events with host and invitations', () => {
  const record = event(), data = record.data as CalendarData;
  assert.equal(data.start, '2026-10-15T16:00:00.000Z');
  assert.equal(data.end, '2026-10-15T17:00:00.000Z');
  assert.equal(data.hostId, 'alice');
  assert.deepEqual(data.invitees.map(person => [person.id, person.status]), [['alice', 'attending'], ['bob', 'invited']]);
  assert.match(calendarDisplayRange(data), /09:00.*10:00.*America\/Los_Angeles/);
  assert.throws(() => event({ hostId: 'bob' }), /Unknown field/);
  assert.throws(() => event({ recurrence: 'weekly' }), /Unknown field/);
});
test('Calendar rejects nonexistent and ambiguous DST wall times and accepts explicit offsets', () => {
  assert.throws(() => calendarInstant('2026-03-08T02:30', 'America/Los_Angeles'), /does not exist/);
  assert.throws(() => calendarInstant('2026-11-01T01:30', 'America/Los_Angeles'), /occurs twice/);
  assert.equal(calendarInstant('2026-11-01T01:30-07:00', 'America/Los_Angeles'), '2026-11-01T08:30:00.000Z');
  assert.equal(calendarInstant('2026-11-01T01:30-08:00', 'America/Los_Angeles'), '2026-11-01T09:30:00.000Z');
  assert.equal(calendarInstant('2026-10-15T09:30', 'Asia/Kathmandu'), '2026-10-15T03:45:00.000Z');
  assert.equal(calendarLocalTime('2026-10-15T16:00:00.000Z', 'America/Los_Angeles'), '2026-10-15T09:00');
  assert.throws(() => calendarInstant('2011-12-30T12:00', 'Pacific/Apia'), /does not exist/);
  assert.throws(() => calendarInstant('2026-10-04T02:15', 'Australia/Lord_Howe'), /does not exist/);
});
test('Calendar validates real dates, ordered times and actual timezones', () => {
  assert.equal(validCalendarDate('2024-02-29'), true);
  assert.equal(validCalendarDate('2026-02-29'), false);
  assert.throws(() => event({ start: '2026-02-30T10:00Z' }), /valid calendar/);
  assert.throws(() => event({ start: '2026-10-15T25:00' }), /YYYY/);
  assert.throws(() => event({ timezone: 'Invalid/Zone' }), /IANA/);
  assert.throws(() => event({ end: schedule.start }), /follow/);
  assert.throws(() => event({ allDay: 'true' }), /true or false/);
});
test('Calendar edit values use the saved timezone and preserve both repeated DST instants exactly', () => {
  assert.equal(calendarEditTime('2026-10-15T16:00:00.000Z', 'America/Los_Angeles'), '2026-10-15T09:00');
  assert.equal(calendarEditTime('2026-11-01T08:30:00.000Z', 'America/Los_Angeles'), '2026-11-01T01:30-07:00');
  assert.equal(calendarEditTime('2026-11-01T09:30:00.000Z', 'America/Los_Angeles'), '2026-11-01T01:30-08:00');
  const precise = '2026-10-15T16:00:30.125Z', value = calendarEditTime(precise, 'America/Los_Angeles');
  assert.equal(value, '2026-10-15T09:00:30.125-07:00');
  assert.equal(calendarInstant(value, 'America/Los_Angeles'), precise);
  for (const instant of ['2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z']) assert.equal(calendarInstant(calendarEditTime(instant, 'America/Los_Angeles'), 'America/Los_Angeles'), instant);
  const original = event({ start: '2026-11-01T01:30-08:00', end: '2026-11-01T02:30-08:00' }), data = original.data as CalendarData;
  const edited = change(original, 'edit', { title: 'Updated description only', timezone: data.timezone, allDay: false, start: calendarEditTime(data.start, data.timezone), end: calendarEditTime(data.end, data.timezone), description: 'Still the same event' }).data as CalendarData;
  assert.equal(edited.start, data.start); assert.equal(edited.end, data.end);
});
test('Calendar all-day ranges use exact dates and exclusive ends', () => {
  const data = event({ allDay: true, start: '2026-10-15', end: '2026-10-16' }).data as CalendarData;
  assert.equal(data.start, '2026-10-15');
  assert.match(calendarDisplayRange(data), /end exclusive/);
  assert.throws(() => event({ allDay: true, start: '2026-10-15T00:00Z', end: '2026-10-16' }), /All-day dates/);
  assert.throws(() => event({ allDay: true, start: '2026-10-15', end: '2026-10-15' }), /follow/);
});
test('Calendar RSVP is personal, permits a visible-event join, and re-invites preserve answers', () => {
  let record = change(event(), 'rsvp', { status: 'declined' }, 'bob', false);
  record = change(record, 'invite', { inviteeIds: ['bob', 'carol', 'carol'] });
  assert.deepEqual((record.data as CalendarData).invitees.map(person => [person.id, person.status]), [['alice', 'attending'], ['bob', 'declined'], ['carol', 'invited']]);
  record = change(record, 'rsvp', { status: 'attending' }, 'carol', false);
  assert.equal((record.data as CalendarData).invitees.find(person => person.id === 'carol')!.status, 'attending');
  assert.throws(() => change(record, 'rsvp', { status: 'attending', principalId: 'alice' }, 'bob'), /Unknown field/);
  const joined = change(event({ inviteeIds: [] }), 'rsvp', { status: 'attending' }, 'carol', false);
  assert.equal((joined.data as CalendarData).invitees.at(-1)!.id, 'carol');
});
test('Calendar management requires edit authority; invites never widen private access', () => {
  const record = event(); record.access.visibility = 'members';
  const updated = change(record, 'invite', { inviteeIds: ['carol'] });
  assert.deepEqual(updated.access, record.access);
  assert.throws(() => change(record, 'invite', { inviteeIds: ['carol'] }, 'bob', false), /Cannot edit/);
  assert.throws(() => change(record, 'edit', { title: 'Changed', ...schedule }, 'bob', false), /Cannot edit/);
  assert.throws(() => change(record, 'cancel', {}, 'bob', false), /Cannot edit/);
  assert.throws(() => change(record, 'uninvite', { inviteeIds: ['alice'] }), /host/);
  assert.equal((change(record, 'uninvite', { inviteeIds: ['bob'] }).data as CalendarData).invitees.length, 1);
});
test('Calendar cancellation preserves attendance and comments, prevents RSVP, and can be reinstated', () => {
  let record = change(event(), 'comment', { body: 'Agenda attached in the paper review.' }, 'bob', false);
  record = change(record, 'cancel', {});
  assert.equal((record.data as CalendarData).comments[0]!.authorId, 'bob');
  assert.throws(() => change(record, 'rsvp', { status: 'attending' }, 'bob'), /cancelled/);
  assert.throws(() => change(record, 'cancel', {}), /already cancelled/);
  record = change(record, 'reinstate', {});
  assert.equal((record.data as CalendarData).status, 'scheduled');
  assert.equal((record.data as CalendarData).comments.length, 1);
  assert.equal((record.data as CalendarData).invitees.length, 2);
  record = change(record, 'edit', { title: 'Rescheduled', ...schedule, description: 'New agenda', location: 'Room 12' });
  assert.equal(record.title, 'Rescheduled');
  assert.equal((record.data as CalendarData).comments.length, 1);
  assert.throws(() => change(record, 'comment', { body: 'Forged', authorId: 'alice' }, 'bob'), /Unknown field/);
});
test('Calendar generates bounded local-wall-clock series with exact UTC instants across DST', () => {
  const data = event({ start: '2026-10-25T09:00', end: '2026-10-25T10:00', recurrenceFrequency: 'weekly', recurrenceCount: 3 }).data as CalendarData;
  assert.deepEqual(data.recurrence, { frequency: 'weekly', count: 3, startLocal: '2026-10-25T09:00', endLocal: '2026-10-25T10:00' });
  assert.deepEqual(data.occurrences.map(item => item.start), ['2026-10-25T16:00:00.000Z', '2026-11-01T17:00:00.000Z', '2026-11-08T17:00:00.000Z']);
  assert.ok(data.occurrences.every(item => calendarLocalTime(item.start, data.timezone).endsWith('T09:00')));
  const daily = event({ allDay: true, start: '2024-02-28', end: '2024-02-29', recurrenceFrequency: 'daily', recurrenceCount: 3 }).data as CalendarData;
  assert.deepEqual(daily.occurrences.map(item => [item.start, item.end]), [['2024-02-28', '2024-02-29'], ['2024-02-29', '2024-03-01'], ['2024-03-01', '2024-03-02']]);
  assert.throws(() => event({ recurrenceFrequency: 'weekly' }), /Occurrence count/);
  assert.throws(() => event({ recurrenceFrequency: 'weekly', recurrenceCount: 367 }), /2 to 366/);
  assert.throws(() => event({ recurrenceFrequency: 'none', recurrenceCount: 2 }), /one-off/);
});
test('Calendar rejects an entire generated series when a later occurrence is ambiguous or nonexistent', () => {
  assert.throws(() => event({ start: '2026-03-01T02:30', end: '2026-03-01T03:30', recurrenceFrequency: 'weekly', recurrenceCount: 2 }), /Occurrence 2:.*does not exist/);
  assert.throws(() => event({ start: '2026-10-25T01:30', end: '2026-10-25T02:30', recurrenceFrequency: 'weekly', recurrenceCount: 2 }), /Occurrence 2:.*occurs twice/);
  assert.throws(() => event({ start: '2026-10-15T09:00:30-07:00', recurrenceFrequency: 'weekly', recurrenceCount: 2 }), /whole-minute/);
});
test('Calendar records per-occurrence responses and reschedules without replacing original times or other answers', () => {
  let record = event({ recurrenceFrequency: 'weekly', recurrenceCount: 3 });
  const original = record.data as CalendarData;
  record = change(record, 'rsvp', { occurrence: 2, status: 'declined' }, 'bob', false);
  record = change(record, 'edit-occurrence', { occurrence: 2, start: '2026-10-23T12:00', end: '2026-10-23T13:00' });
  const data = record.data as CalendarData;
  assert.equal(data.occurrences[1]!.originalStart, original.occurrences[1]!.start);
  assert.equal(data.occurrences[1]!.start, '2026-10-23T19:00:00.000Z');
  assert.equal(data.occurrences[1]!.overridden, true);
  assert.equal(data.occurrences[1]!.invitees.find(person => person.id === 'bob')!.status, 'declined');
  assert.equal(data.occurrences[0]!.invitees.find(person => person.id === 'bob')!.status, 'invited');
  assert.deepEqual(data.occurrences[2], original.occurrences[2]);
  assert.throws(() => change(record, 'rsvp', { status: 'attending' }, 'bob'), /Occurrence/);
  assert.throws(() => change(record, 'edit', { title: 'Cannot shift the series', ...schedule, start: '2026-10-15T08:00' }), /generated series schedule is fixed/);
  assert.throws(() => change(record, 'edit-occurrence', { occurrence: 4, start: '2026-10-23T12:00', end: '2026-10-23T13:00' }), /saved occurrence/);
  assert.throws(() => change(record, 'edit-occurrence', { occurrence: 2, start: '2026-10-23T12:00', end: '2026-10-23T13:00' }, 'bob', false), /Cannot edit/);
});
test('Calendar whole-series cancellation and reinstatement preserve individually cancelled occurrences', () => {
  let record = event({ recurrenceFrequency: 'daily', recurrenceCount: 3 });
  record = change(record, 'cancel-occurrence', { occurrence: 2 });
  assert.throws(() => change(record, 'rsvp', { occurrence: 2, status: 'attending' }, 'bob'), /occurrence is cancelled/);
  record = change(record, 'rsvp', { occurrence: 1, status: 'attending' }, 'bob');
  record = change(record, 'cancel', {});
  assert.throws(() => change(record, 'rsvp', { occurrence: 1, status: 'declined' }, 'bob'), /event is cancelled/);
  record = change(record, 'reinstate', {});
  assert.deepEqual((record.data as CalendarData).occurrences.map(item => item.status), ['scheduled', 'cancelled', 'scheduled']);
  record = change(record, 'reinstate-occurrence', { occurrence: 2 });
  record = change(record, 'invite', { inviteeIds: ['bob', 'carol'] });
  assert.equal((record.data as CalendarData).occurrences[0]!.invitees.find(person => person.id === 'bob')!.status, 'attending');
  assert.ok((record.data as CalendarData).occurrences.every(item => item.invitees.some(person => person.id === 'carol' && person.status === 'invited')));
  record = change(record, 'uninvite', { inviteeIds: ['carol'] });
  assert.ok((record.data as CalendarData).occurrences.every(item => !item.invitees.some(person => person.id === 'carol')));
});
test('Calendar hosts can remove people who joined only individual recurring occurrences', () => {
  let record = event({ inviteeIds: [], recurrenceFrequency: 'daily', recurrenceCount: 3 });
  record = change(record, 'rsvp', { occurrence: 1, status: 'attending' }, 'bob', false);
  record = change(record, 'rsvp', { occurrence: 2, status: 'declined' }, 'bob', false);
  record = change(record, 'rsvp', { occurrence: 3, status: 'attending' }, 'carol', false);
  const before = record.data as CalendarData;
  assert.equal(before.invitees.some(person => person.id === 'bob'), false);
  assert.deepEqual(calendarParticipants(before).map(person => person.id), ['alice', 'bob', 'carol']);
  assert.throws(() => change(record, 'uninvite', { inviteeIds: ['bob'] }, 'carol', false), /Cannot edit/);
  assert.throws(() => change(record, 'uninvite', { inviteeIds: ['missing'] }), /existing invitations or participants/);
  record = change(record, 'uninvite', { inviteeIds: ['bob'] });
  const after = record.data as CalendarData;
  assert.ok(after.occurrences.every(item => !item.invitees.some(person => person.id === 'bob')));
  assert.deepEqual(calendarParticipants(after).map(person => person.id), ['alice', 'carol']);
  assert.deepEqual(after.occurrences[2], before.occurrences[2]);
  assert.throws(() => change(record, 'uninvite', { inviteeIds: ['alice'] }), /host/);
});
