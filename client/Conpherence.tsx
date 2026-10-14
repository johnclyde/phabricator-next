import { useState } from 'react';
import type { AppState } from '../shared/types';
import type { ConpherenceData } from '../shared/conpherence';
import type { SuiteDetail, SuiteRecord } from '../shared/suite';
import { SuiteScreen, type SuiteForm } from './SuiteScreen';
import { DiscussionBody, RemarkupBody } from './Remarkup';

export default function Conpherence({ online, state }: { online: boolean; state: AppState }) {
  const people = state.principals.filter(person => !person.disabled).map(person => ({ value: person.id, label: person.displayName }));
  function forms(record: SuiteRecord | null, detail?: SuiteDetail): SuiteForm[] {
    if (!record) return [{ key: 'room', label: 'Create Conversation', fields: [{ name: 'title', label: 'Conversation title', type: 'text', required: true }, { name: 'topic', label: 'Topic', type: 'textarea' }, { name: 'participantIds', label: 'Participants', type: 'multi', options: people }, { name: 'message', label: 'First message', type: 'textarea' }] }];
    const data = record.data as ConpherenceData;
    const result: SuiteForm[] = [
      { key: 'message', label: 'Send Message', fields: [{ name: 'body', label: 'Message', type: 'textarea', required: true, hint: 'Remarkup supports bold, emphasis, lists, quotes and code. @names remain literal text.' }] },
      { key: 'read', label: 'Mark Read', fields: [], values: { through: data.messages.at(-1)?.number || 0 } },
      { key: data.archived ? 'unarchive' : 'archive', label: data.archived ? 'Restore Conversation' : 'Archive for Me', fields: [] },
    ];
    if (detail?.canEdit) result.push(
      { key: 'edit', label: 'Edit Conversation', fields: [{ name: 'title', label: 'Conversation title', type: 'text', required: true }, { name: 'topic', label: 'Topic', type: 'textarea' }], values: { title: record.title, topic: data.topic } },
      { key: 'participants', label: 'Edit Participants', fields: [{ name: 'participantIds', label: 'Participants (keep yourself selected)', type: 'multi', options: people }], values: { participantIds: data.participants.map(person => person.id) } },
    );
    if (data.participants.length > 1) result.push({ key: 'leave', label: 'Leave Conversation', fields: [], confirm: 'Leave this private conversation? You will lose access until a participant adds you again.' });
    return result;
  }
  return <SuiteScreen app="conpherence" title="Conpherence" online={online} state={state} forms={forms} summary={record => { const data = record.data as ConpherenceData; return <>{data.unreadCount || 0} unread · {data.participants.length} participants{data.archived ? ' · Archived for you' : ''}</>; }} render={record => <Conversation key={record.id} record={record}/>}/>;
}

function Conversation({ record }: { record: SuiteRecord }) {
  const data = record.data as ConpherenceData, [shown, setShown] = useState(50), messages = data.messages.slice(-shown);
  return <section aria-label="Conversation messages">
    <p className="info-strip">Private conversation · {data.unreadCount || 0} unread{data.archived ? ' · Archived for you' : ''}</p>
    {data.topic && <RemarkupBody body={data.topic} sourceLabel="Exact topic source" contextKey={`${record.id}:topic`}/>}
    <p><strong>Participants:</strong> {data.participants.map(person => person.displayName).join(', ')}</p>
    <p className="small muted">Messages are saved in this workspace and update while connected. Reading this page does not automatically mark messages as read.</p>
    {data.messages.length > shown && <button className="button" type="button" onClick={() => setShown(value => value + 50)}>Show Earlier Messages</button>}
    <div className="automation-transcript">{messages.map(message => <article key={message.number}><h3>{message.authorName}</h3><p className="small muted">Message {message.number} · {new Date(message.createdAt).toLocaleString()}</p><DiscussionBody body={message.body}/></article>)}</div>
    {!messages.length && <p className="muted">No messages yet. Send the first message.</p>}
  </section>;
}
