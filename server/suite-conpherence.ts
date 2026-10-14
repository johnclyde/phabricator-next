import type { ConpherenceData, ConpherenceParticipant } from '../shared/conpherence.ts';
import { conpherenceUnread } from '../shared/conpherence.ts';
import type { SuiteRecord } from '../shared/suite.ts';
import type { SuiteContext, SuiteModule } from './suite-contract.ts';
import { HttpError, object, optionalString, string } from './validation.ts';

function data(record: SuiteRecord): ConpherenceData { return record.data as ConpherenceData; }
function member(record: SuiteRecord, context: SuiteContext): boolean { return data(record).participants.some(person => person.id === context.actor.principalId); }
function requireMember(record: SuiteRecord, context: SuiteContext): void { if (!member(record, context)) throw new HttpError(404, 'Conversation was not found.'); }
function people(value: unknown, context: SuiteContext): ConpherenceParticipant[] {
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string')) throw new HttpError(400, 'Participants must be a list of people.');
  return [...new Set(value as string[])].map(id => context.requirePerson(id));
}
function access(participants: ConpherenceParticipant[]) { const ids = participants.map(person => person.id); return { visibility: 'members' as const, memberIds: ids, editorIds: ids }; }

export const conpherenceModule: SuiteModule = {
  app: 'conpherence', prefix: 'Z',
  create(input, context) {
    const value = object(input, ['kind', 'title', 'topic', 'participantIds', 'message']);
    if (value.kind !== undefined && value.kind !== 'room') throw new HttpError(400, 'Unknown conversation kind.');
    const title = string(value.title, 'Conversation title', 240).trim();
    const participants = people([context.actor.principalId, ...(Array.isArray(value.participantIds) ? value.participantIds : [])], context);
    if (value.participantIds !== undefined) people(value.participantIds, context);
    const message = optionalString(value.message, 'Message', 100_000);
    const initial: ConpherenceData = { topic: optionalString(value.topic, 'Topic', 2_000), participants, messages: message.trim() ? [{ number: 1, authorId: context.actor.principalId, authorName: context.actor.displayName, body: message, createdAt: context.now }] : [], readThrough: { [context.actor.principalId]: message.trim() ? 1 : 0 }, archivedBy: [] };
    return { kind: 'room', title, data: initial, access: access(participants), summary: 'Created a private conversation.' };
  },
  canView: member,
  canEdit: member,
  present(record, context) {
    const saved = data(record), actor = context.actor.principalId;
    return { ...record, data: { ...saved, readThrough: { [actor]: saved.readThrough[actor] || 0 }, archivedBy: saved.archivedBy.includes(actor) ? [actor] : [], unreadCount: conpherenceUnread(saved, actor), archived: saved.archivedBy.includes(actor) } };
  },
  presentEvents(events, _record, context) {
    return events.filter(event => event.actorId === context.actor.principalId || !['read', 'archive', 'unarchive'].includes(event.action));
  },
  command(record, action, input, context) {
    requireMember(record, context);
    const saved = data(record), actor = context.actor.principalId;
    if (action === 'message') {
      const value = object(input, ['body']), body = string(value.body, 'Message', 100_000), number = (saved.messages.at(-1)?.number || 0) + 1;
      // Sending a reply does not mark previously unseen messages as read.
      return { data: { ...saved, messages: [...saved.messages, { number, authorId: actor, authorName: context.actor.displayName, body, createdAt: context.now }], archivedBy: saved.archivedBy.filter(id => id !== actor) }, summary: 'Sent a message.' };
    }
    if (action === 'read') {
      const value = object(input, ['through']);
      if (typeof value.through !== 'number' || !Number.isSafeInteger(value.through) || value.through < 0 || value.through > (saved.messages.at(-1)?.number || 0)) throw new HttpError(400, 'The read position must refer to a saved message.');
      return { data: { ...saved, readThrough: { ...saved.readThrough, [actor]: Math.max(saved.readThrough[actor] || 0, value.through) } }, summary: 'Updated personal read position.' };
    }
    if (action === 'archive' || action === 'unarchive') {
      object(input, []);
      return { data: { ...saved, archivedBy: action === 'archive' ? [...new Set([...saved.archivedBy, actor])] : saved.archivedBy.filter(id => id !== actor) }, summary: action === 'archive' ? 'Archived conversation for this participant.' : 'Restored conversation for this participant.' };
    }
    if (action === 'leave') {
      object(input, []);
      if (saved.participants.length === 1) throw new HttpError(409, 'The last participant must keep the conversation. Archive it instead.');
      const participants = saved.participants.filter(person => person.id !== actor);
      return { data: { ...saved, participants }, access: access(participants), summary: 'Left the conversation.' };
    }
    context.requireEdit(record);
    if (action === 'edit') {
      const value = object(input, ['title', 'topic']);
      return { title: string(value.title, 'Conversation title', 240).trim(), data: { ...saved, topic: optionalString(value.topic, 'Topic', 2_000) }, summary: 'Edited the conversation title and topic.' };
    }
    if (action === 'participants') {
      const value = object(input, ['participantIds']), participants = people(value.participantIds, context);
      if (!participants.some(person => person.id === actor)) throw new HttpError(400, 'Keep yourself in the participant list; use Leave Conversation to leave.');
      return { data: { ...saved, participants }, access: access(participants), summary: 'Updated conversation participants.' };
    }
    throw new HttpError(400, 'Unknown conversation action.');
  },
};
