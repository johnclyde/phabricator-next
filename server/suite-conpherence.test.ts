import test from 'node:test';
import assert from 'node:assert/strict';
import { conpherenceModule as module } from './suite-conpherence.ts';
import { conpherenceUnread, type ConpherenceData } from '../shared/conpherence.ts';
import type { SuiteEvent, SuiteRecord } from '../shared/suite.ts';
import type { SuiteContext } from './suite-contract.ts';
import { HttpError } from './validation.ts';

const now = '2026-10-14T12:00:00.000Z';
function context(id = 'alice', editable = true): SuiteContext {
  return { actor: { workspaceId: 'workspace', principalId: id, displayName: id.toUpperCase(), credentialId: 'credential', kind: 'session', sessionContext: 'session', scopes: ['read', 'write'] }, now, get() { throw new Error('Unused'); }, list: () => [], exists: () => false, canEdit: () => editable, requireEdit() { if (!editable) throw new HttpError(403, 'Cannot edit.'); }, requirePerson(person) { if (!['alice', 'bob', 'carol'].includes(person)) throw new HttpError(400, 'Unknown person.'); return { id: person, displayName: person.toUpperCase() }; } };
}
function room(input: Record<string, unknown> = {}): SuiteRecord {
  const value = module.create({ kind: 'room', title: 'Research conversation', participantIds: ['bob'], ...input }, context());
  return { id: 'Z1', app: 'conpherence', kind: value.kind, title: value.title, ownerId: 'alice', version: 1, createdAt: now, updatedAt: now, access: { spaceId: 'S1', visibility: 'workspace', memberIds: [], editorIds: [], ...value.access }, data: value.data };
}
function change(record: SuiteRecord, action: string, input: unknown, actor = 'alice', editable = true): SuiteRecord {
  const value = module.command(record, action, input, context(actor, editable));
  return { ...record, ...value, access: { ...record.access, ...value.access }, version: record.version + 1 };
}
test('Conpherence creates a private member-only conversation and attributes its initial message', () => {
  const record = room({ participantIds: ['bob', 'bob'], message: 'Initial evidence' }), data = record.data as ConpherenceData;
  assert.deepEqual(record.access, { spaceId: 'S1', visibility: 'members', memberIds: ['alice', 'bob'], editorIds: ['alice', 'bob'] });
  assert.deepEqual(data.messages[0], { number: 1, authorId: 'alice', authorName: 'ALICE', body: 'Initial evidence', createdAt: now });
  assert.equal(module.canView!(record, context('bob')), true);
  assert.equal(module.canView!(record, context('carol')), false);
  assert.throws(() => module.create({ title: 'Bad', participantIds: 'bob' }, context()), /Participants/);
  assert.throws(() => room({ participantIds: ['missing'] }), /Unknown person/);
});
test('Conpherence message authors cannot be forged and earlier messages are unchanged', () => {
  const initial = room({ message: 'First' });
  const second = change(initial, 'message', { body: 'Second' }, 'bob', false);
  assert.equal((initial.data as ConpherenceData).messages.length, 1);
  assert.deepEqual((second.data as ConpherenceData).messages[0], (initial.data as ConpherenceData).messages[0]);
  assert.equal((second.data as ConpherenceData).messages[1]!.authorId, 'bob');
  assert.throws(() => change(initial, 'message', { body: 'Forged', authorId: 'bob' }), /Unknown field/);
  assert.throws(() => change(initial, 'message', { body: '' }), /nonempty/);
  assert.throws(() => change(initial, 'message', { body: 'Unauthorized' }, 'carol'), /not found/);
});
test('Conpherence read markers are monotonic, viewer-private and do not skip unread messages on reply', () => {
  let record = room({ message: 'First' });
  record = change(record, 'message', { body: 'Second' });
  record = change(record, 'message', { body: 'Reply' }, 'bob');
  assert.equal(conpherenceUnread(record.data as ConpherenceData, 'bob'), 2);
  record = change(record, 'read', { through: 2 }, 'bob');
  record = change(record, 'read', { through: 1 }, 'bob');
  assert.equal((record.data as ConpherenceData).readThrough.bob, 2);
  assert.equal(conpherenceUnread(record.data as ConpherenceData, 'bob'), 0);
  const view = module.present!(record, context('alice')).data as ConpherenceData;
  assert.deepEqual(view.readThrough, { alice: 1 });
  assert.equal(view.unreadCount, 1);
  assert.throws(() => change(record, 'read', { through: 4 }), /saved message/);
  assert.throws(() => change(record, 'read', { through: -1 }), /saved message/);
});
test('Conpherence participant edits synchronize object policy and revoke removed participant access', () => {
  let record = room();
  record = change(record, 'participants', { participantIds: ['alice', 'carol'] });
  assert.deepEqual(record.access.memberIds, ['alice', 'carol']);
  assert.deepEqual(record.access.editorIds, ['alice', 'carol']);
  assert.equal(module.canView!(record, context('bob')), false);
  assert.equal(module.canView!(record, context('carol')), true);
  assert.throws(() => change(record, 'participants', { participantIds: ['carol'] }), /Keep yourself/);
  assert.throws(() => change(record, 'participants', { participantIds: ['alice'] }, 'alice', false), /Cannot edit/);
});
test('Conpherence leaving removes access even for original owner and the last participant can archive', () => {
  const record = change(room(), 'leave', {});
  assert.equal(module.canView!(record, context('alice')), false);
  assert.equal(module.canEdit!(record, context('alice')), false);
  assert.deepEqual(record.access.memberIds, ['bob']);
  assert.throws(() => change(record, 'leave', {}, 'bob'), /last participant/);
  const archived = change(record, 'archive', {}, 'bob');
  assert.equal((module.present!(archived, context('bob')).data as ConpherenceData).archived, true);
});
test('Conpherence archives are personal; sending restores only the sender', () => {
  let record = change(room(), 'archive', {});
  assert.equal((module.present!(record, context('bob')).data as ConpherenceData).archived, false);
  assert.deepEqual((module.present!(record, context('bob')).data as ConpherenceData).archivedBy, []);
  const events: SuiteEvent[] = [{ sequence: 1, recordId: record.id, version: 2, actorId: 'alice', actorName: 'ALICE', action: 'archive', summary: 'Archived conversation for this participant.', createdAt: now }];
  assert.deepEqual(module.presentEvents!(events, record, context('bob')), []);
  assert.equal(module.presentEvents!(events, record, context('alice')).length, 1);
  record = change(record, 'message', { body: 'Hello' }, 'bob');
  assert.equal((module.present!(record, context()).data as ConpherenceData).archived, true);
  record = change(record, 'message', { body: 'Reply' });
  assert.equal((module.present!(record, context()).data as ConpherenceData).archived, false);
  assert.equal(change(record, 'edit', { title: 'Updated', topic: 'Evidence' }).title, 'Updated');
  assert.throws(() => change(record, 'join', {}), /Unknown conversation action/);
});
