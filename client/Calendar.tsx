import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import { calendarAddDays, calendarDisplayRange, calendarEditTime, calendarLocalTime, calendarOccurrences, calendarParticipants, type CalendarData } from '../shared/calendar';
import type { SuiteDetail, SuiteList, SuiteRecord } from '../shared/suite';
import { SuiteScreen, type SuiteField, type SuiteForm } from './SuiteScreen';
import { useWorkspace } from './SessionGate';
import { onSessionLocked } from './session';
import { AutomationPanel } from './AutomationSupport';

export default function Calendar({ online, state }: { online: boolean; state: AppState }) {
  const people = state.principals.filter(person => !person.disabled).map(person => ({ value: person.id, label: person.displayName }));
  const fields: SuiteField[] = [
    { name: 'title', label: 'Event title', type: 'text', required: true }, { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'location', label: 'Location', type: 'text' }, { name: 'timezone', label: 'IANA timezone', type: 'text', required: true },
    { name: 'allDay', label: 'All-day event (use dates only; end is exclusive)', type: 'checkbox' },
    { name: 'start', label: 'Starts (YYYY-MM-DDTHH:mm, or date for all-day)', type: 'text', required: true },
    { name: 'end', label: 'Ends (YYYY-MM-DDTHH:mm, or date for all-day)', type: 'text', required: true },
  ];
  function forms(record: SuiteRecord | null, detail?: SuiteDetail): SuiteForm[] {
    if (!record) {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', day = calendarLocalTime(new Date().toISOString(), timezone).slice(0, 10);
      return [{ key: 'event', label: 'Create Event', fields: [...fields, { name: 'recurrenceFrequency', label: 'Repeat', type: 'select', options: [{ value: 'none', label: 'Does not repeat' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }] }, { name: 'recurrenceCount', label: 'Occurrence count (1 for one-off; 2–366 for a series)', type: 'number', required: true }, { name: 'inviteeIds', label: 'Invite people', type: 'multi', options: people }], values: { timezone, allDay: false, start: `${day}T09:00`, end: `${day}T10:00`, recurrenceFrequency: 'none', recurrenceCount: 1 } }];
    }
    const data = record.data as CalendarData, result: SuiteForm[] = [];
    const occurrenceOptions = data.occurrences.map(item => ({ value: String(item.number), label: `${item.number}. ${data.allDay ? item.start : calendarLocalTime(item.start, data.timezone).replace('T', ' ')}${item.status === 'cancelled' ? ' · Cancelled' : ''}` }));
    const occurrenceField: SuiteField = { name: 'occurrence', label: 'Occurrence', type: 'select', options: occurrenceOptions, required: true };
    const occurrenceBody = (values: Record<string, unknown>) => ({ ...values, occurrence: Number(values.occurrence) });
    if (data.status === 'scheduled') result.push({ key: 'rsvp', label: 'Respond to Event', fields: [...(data.recurrence ? [occurrenceField] : []), { name: 'status', label: 'Attendance', type: 'select', options: [{ value: 'attending', label: 'Attending' }, { value: 'declined', label: 'Declined' }], required: true }], values: { status: data.invitees.find(person => person.id === state.currentPrincipalId)?.status === 'declined' ? 'declined' : 'attending' }, ...(data.recurrence ? { transform: occurrenceBody } : {}) });
    result.push({ key: 'comment', label: 'Comment', fields: [{ name: 'body', label: 'Event comment', type: 'textarea', required: true }] });
    if (detail?.canEdit) result.push(
      { key: 'edit', label: 'Edit Event', fields, values: { title: record.title, description: data.description, location: data.location, timezone: data.timezone, allDay: data.allDay, start: data.allDay ? data.start : calendarEditTime(data.start, data.timezone), end: data.allDay ? data.end : calendarEditTime(data.end, data.timezone) } },
      { key: 'invite', label: 'Invite People', fields: [{ name: 'inviteeIds', label: 'People to invite', type: 'multi', options: people }] },
      { key: 'uninvite', label: 'Remove Invitations', fields: [{ name: 'inviteeIds', label: 'Invitations to remove', type: 'multi', options: calendarParticipants(data).filter(person => person.id !== data.hostId).map(person => ({ value: person.id, label: person.displayName })) }] },
      { key: data.status === 'cancelled' ? 'reinstate' : 'cancel', label: data.status === 'cancelled' ? 'Reinstate Event' : 'Cancel Event', fields: [], confirm: data.status === 'cancelled' ? 'Reinstate this event with its saved schedule and attendance?' : 'Cancel this event? Its history and attendance will be preserved.' },
    );
    if (detail?.canEdit && data.recurrence) result.push(
      { key: 'edit-occurrence', label: 'Reschedule One Occurrence', fields: [occurrenceField, fields.find(field => field.name === 'start')!, fields.find(field => field.name === 'end')!], transform: occurrenceBody },
      { key: 'cancel-occurrence', label: 'Cancel One Occurrence', fields: [occurrenceField], transform: occurrenceBody, confirm: 'Cancel only the selected occurrence? The rest of the series will remain scheduled.' },
      { key: 'reinstate-occurrence', label: 'Reinstate One Occurrence', fields: [occurrenceField], transform: occurrenceBody },
    );
    return result;
  }
  return <><CalendarOverview online={online}/><SuiteScreen app="calendar" title="Calendar" online={online} state={state} forms={forms} summary={record => { const data = record.data as CalendarData; return <small>{data.status === 'cancelled' ? 'Cancelled · ' : ''}{calendarDisplayRange(data)}{data.recurrence ? ` · ${data.recurrence.count} ${data.recurrence.frequency} occurrences` : ''}</small>; }} render={record => <Event record={record}/>}/></>;
}

function Event({ record }: { record: SuiteRecord }) {
  const data = record.data as CalendarData;
  return <section aria-label="Calendar event">
    <p className="info-strip"><strong>{data.status === 'cancelled' ? 'Cancelled' : 'Scheduled'}</strong> · {calendarDisplayRange(data)}</p>
    {data.location && <p><strong>Location:</strong> {data.location}</p>}
    {data.description && <p className="audit-comment">{data.description}</p>}
    <p className="small muted">Invitations are recorded here. Private events still require access to the event and its Space. Email invitations are not available yet.</p>
    {data.recurrence ? <><p className="info-strip">{data.recurrence.count} {data.recurrence.frequency} occurrences. Attendance is recorded separately for each occurrence. Invite/remove actions apply to the entire series. Cancel Event cancels the entire series; occurrence actions affect only the selected date.</p><p className="small muted">The generated schedule stays fixed. Edit Event changes shared details; use Reschedule One Occurrence to move an individual date. Reinstating the series preserves separately cancelled occurrences.</p><div className="automation-transcript">{data.occurrences.map(item => <article key={item.number}><h3>Occurrence {item.number} · {data.status === 'cancelled' || item.status === 'cancelled' ? 'Cancelled' : 'Scheduled'}</h3><p>{calendarDisplayRange({ ...data, start: item.start, end: item.end })}</p>{item.overridden && <p className="small muted">Rescheduled from {calendarDisplayRange({ ...data, start: item.originalStart, end: item.originalEnd })}</p>}<p>{item.invitees.map(person => `${person.displayName}: ${person.status}`).join(' · ')}</p></article>)}</div></> : <><h3>Attendance</h3><div className="audit-auditors">{data.invitees.map(person => <article key={person.id}><strong>{person.displayName}{person.id === data.hostId ? ' · Host' : ''}</strong><span className="badge">{person.status === 'attending' ? 'Attending' : person.status === 'declined' ? 'Declined' : 'Invited'}</span></article>)}</div></>}
    <h3>Discussion</h3><div className="automation-transcript">{data.comments.map(comment => <article key={comment.number}><h3>{comment.authorName}</h3><p className="small muted">{new Date(comment.createdAt).toLocaleString()}</p><p className="audit-comment">{comment.body}</p></article>)}</div>{!data.comments.length && <p className="muted">No event comments yet.</p>}
  </section>;
}

/** Fetch every visible page before asserting that a date is empty. Retire the
 * complete inventory together whenever current access changes or locks. */
function CalendarOverview({ online }: { online: boolean }) {
  const client = useWorkspace(), [records, setRecords] = useState<SuiteRecord[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0), generation = useRef(0);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', today = calendarLocalTime(new Date().toISOString(), timezone).slice(0, 10), [month, setMonth] = useState(today.slice(0, 7)), [day, setDay] = useState(today);
  useEffect(() => {
    const clear = () => { generation.current++; setRecords([]); setError(''); setLoading(false); };
    const access = client.onAccessChange(() => { clear(); setRevision(value => value + 1); }), locked = onSessionLocked(clear);
    return () => { clear(); access(); locked(); };
  }, [client]);
  useEffect(() => {
    if (!online || !client.isActive()) return;
    const ticket = ++generation.current; setLoading(true); setError('');
    void (async () => {
      const collected: SuiteRecord[] = []; let before: number | null = null, epoch: number | null = null;
      do {
        const result: SuiteList = await client.request(`/api/suite/calendar?limit=100${before ? `&before=${before}` : ''}`);
        if (ticket !== generation.current || !client.isActive()) return;
        if (result.accessEpoch !== client.session?.accessEpoch || epoch !== null && result.accessEpoch !== epoch) throw new Error('Calendar access changed while loading. Refresh the calendar.');
        epoch = result.accessEpoch; collected.push(...result.records);
        if (before !== null && result.nextBefore !== null && result.nextBefore >= before) throw new Error('Calendar pagination did not advance. Refresh the calendar.');
        before = result.nextBefore;
      } while (before !== null);
      if (ticket === generation.current && client.isActive()) setRecords(collected);
    })().catch(failure => { if (ticket === generation.current) { setRecords([]); setError(failure instanceof Error ? failure.message : 'Calendar could not be loaded.'); } }).finally(() => { if (ticket === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [client, online, revision]);
  const year = Number(month.slice(0, 4)), monthNumber = Number(month.slice(5, 7)), first = new Date(Date.UTC(year, monthNumber - 1, 1)), monthDays = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const items = records.flatMap(record => { const data = record.data as CalendarData; return calendarOccurrences(data).map(item => {
    const startDay = data.allDay ? item.start : calendarLocalTime(item.start, timezone).slice(0, 10), endLocal = data.allDay ? item.end : calendarLocalTime(item.end, timezone), endInstant = new Date(item.end), endsAtMidnight = endLocal.endsWith('T00:00') && endInstant.getUTCSeconds() === 0 && endInstant.getUTCMilliseconds() === 0, endDay = data.allDay || endsAtMidnight ? calendarAddDays(endLocal.slice(0, 10), -1) : endLocal.slice(0, 10);
    return { record, data, item, startDay, endDay, cancelled: data.status === 'cancelled' || item.status === 'cancelled' };
  }); }).sort((left, right) => left.item.start.localeCompare(right.item.start));
  const onDate = (date: string) => items.filter(item => item.startDay <= date && item.endDay >= date);
  const move = (offset: number) => { const next = new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 7); setMonth(next); setDay(`${next}-01`); };
  return <div className="automation-workspace"><AutomationPanel title="Month and Agenda"><div className="automation-actions"><button className="button" type="button" onClick={() => move(-1)}>Previous Month</button><button className="button" type="button" onClick={() => { setMonth(today.slice(0, 7)); setDay(today); }}>Today</button><button className="button" type="button" onClick={() => move(1)}>Next Month</button><button className="button" type="button" disabled={!online || loading} onClick={() => setRevision(value => value + 1)}>Refresh Calendar</button></div><h3>{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h3><p className="small muted">Timed events are shown in {timezone}. All-day dates stay on their stated date. Counts include cancelled occurrences, which are labeled in the agenda.</p>
    {loading && <p role="status">Loading all visible calendar events…</p>}{error && <p role="alert" className="banner error">{error}</p>}{!online && <p className="info-strip">Offline. Refresh after reconnecting to update this calendar.</p>}
    <div role="group" aria-label="Calendar month" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 3 }}>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(label => <span key={label} style={{ textAlign: 'center', fontSize: 12 }}>{label}</span>)}{Array.from({ length: first.getUTCDay() }, (_, index) => <span key={`blank-${index}`}/>)}{Array.from({ length: monthDays }, (_, index) => { const date = `${month}-${String(index + 1).padStart(2, '0')}`, count = onDate(date).length; return <button key={date} className={`button${day === date ? ' primary' : ''}`} type="button" aria-label={`${date}${!loading && !error ? `, ${count} event occurrences` : ''}`} aria-pressed={day === date} onClick={() => setDay(date)} style={{ minHeight: 52, minWidth: 0, padding: '6px 2px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}><span>{index + 1}</span>{!loading && !error && count > 0 && <small>{count}</small>}</button>; })}</div>
    <h3>Agenda for {day}</h3>{!loading && !error && <><p className="small muted">{records.length} visible event records loaded · {onDate(day).length} occurrences on this date</p><div className="automation-transcript">{onDate(day).map(({ record, data, item, cancelled }) => <article key={`${record.id}:${item.number}`}><h3><a href={`#calendar/${record.id}`}>{record.title}</a></h3><p>{data.allDay ? 'All day' : `${calendarLocalTime(item.start, timezone).replace('T', ' ')} – ${calendarLocalTime(item.end, timezone).replace('T', ' ')}`}{data.recurrence ? ` · Occurrence ${item.number}` : ''}{cancelled ? ' · Cancelled' : ''}</p></article>)}</div>{!onDate(day).length && <p className="muted">No visible event occurrences on this date.</p>}</>}
  </AutomationPanel></div>;
}
