import assert from 'node:assert/strict';
import test from 'node:test';
import { slowvoteModule as module } from './suite-slowvote.ts';
import type { SuiteContext } from './suite-contract.ts';
import type { SuiteEvent, SuiteRecord } from '../shared/suite.ts';
import type { SlowvoteData, SlowvoteView } from '../shared/slowvote.ts';
import { HttpError } from './validation.ts';
function context(id = 'owner'): SuiteContext {
  const value: SuiteContext = { actor: { principalId: id, displayName: id, workspaceId: 'workspace', kind: 'local', credentialId: null, scopes: ['read', 'write'], sessionContext: null }, now: '2026-10-13T12:00:00Z', get() { throw new Error('Unexpected lookup'); }, list: () => [], exists: () => false, canEdit: record => record.ownerId === id, requireEdit(record) { if (!value.canEdit(record)) throw new HttpError(403, 'Forbidden'); }, requirePerson: person => ({ id: person, displayName: person }) }; return value;
}
function poll(extra: Record<string, unknown> = {}): SuiteRecord {
  const created = module.create({ kind: 'poll', title: 'Lunch?', choices: ['Soup', 'Salad', 'Bread'], ...extra }, context());
  return { ...created, app: 'slowvote', id: 'V1', ownerId: 'owner', version: 1, createdAt: context().now, updatedAt: context().now, access: { spaceId: 'S1', visibility: 'workspace', memberIds: [], editorIds: [] } };
}
function act(record: SuiteRecord, action: string, input: unknown, who = 'owner'): SuiteRecord { const changed = module.command(record, action, input, context(who)); return { ...record, ...changed, access: record.access, version: record.version + 1 }; }
function view(record: SuiteRecord, who: string): SlowvoteView { return module.present!(record, context(who)).data as unknown as SlowvoteView; }
test('Slowvote plurality rejects multiple/unknown options and replaces a previous ballot', () => {
  const record = poll(); assert.throws(() => act(record, 'vote', { choiceIds: ['option-1', 'option-2'] }, 'a'), /exactly one/); assert.throws(() => act(record, 'vote', { choiceIds: ['unknown'] }, 'a'), /valid poll options/);
  const voted = act(act(record, 'vote', { choiceIds: ['option-1'] }, 'a'), 'vote', { choiceIds: 'option-2' }, 'a'); const result = view(voted, 'b');
  assert.equal(result.voterCount, 1); assert.equal(result.results?.[0]?.count, 0); assert.equal(result.results?.[1]?.count, 1); assert.equal('ballots' in result, false);
});
test('Slowvote approval counts each person once for each selected option', () => {
  let record = poll({ method: 'multiple' }); record = act(record, 'vote', { choiceIds: ['option-1', 'option-2', 'option-2'] }, 'a'); record = act(record, 'vote', { choiceIds: ['option-2'] }, 'b');
  assert.equal(view(record, 'owner').voterCount, 2); assert.deepEqual(view(record, 'owner').results?.map(result => result.count), [1, 2, 0]);
});
test('Slowvote after-vote mode does not grant an unvoted owner access', () => {
  const record = act(poll({ responseVisibility: 'aftervote' }), 'vote', { choiceIds: ['option-1'] }, 'a');
  for (const who of ['owner', 'b']) { const result = view(record, who); assert.equal(result.results, null); assert.equal(result.voterCount, null); assert.deepEqual(result.ownChoiceIds, []); assert.equal(JSON.stringify(result).includes('actorId'), false); }
  assert.equal(view(record, 'a').resultsVisible, true); const withdrawn = act(record, 'withdraw', {}, 'a'); assert.equal(view(withdrawn, 'a').resultsVisible, false);
});
test('Slowvote owner-only preserves own choices without leaking another ballot', () => {
  let record = poll({ responseVisibility: 'owner' }); record = act(record, 'vote', { choiceIds: ['option-1'] }, 'a'); record = act(record, 'vote', { choiceIds: ['option-2'] }, 'b');
  assert.equal(view(record, 'a').results, null); assert.deepEqual(view(record, 'a').ownChoiceIds, ['option-1']); assert.equal(view(record, 'owner').voterCount, 2);
  const closed = act(record, 'close', {}); assert.equal(view(closed, 'a').results, null);
});
test('Slowvote closed-results extension reveals results only while closed', () => {
  const record = act(poll({ responseVisibility: 'closed' }), 'vote', { choiceIds: ['option-1'] }, 'a'); assert.equal(view(record, 'a').results, null);
  const closed = act(record, 'close', {}); assert.equal(view(closed, 'b').voterCount, 1); assert.throws(() => act(closed, 'vote', { choiceIds: ['option-2'] }, 'a'), /closed/); assert.throws(() => act(closed, 'withdraw', {}, 'a'), /Reopen/);
  assert.equal(view(act(closed, 'reopen', {}), 'b').results, null);
});
test('Slowvote owner alone can manage details and result policy; options are immutable', () => {
  const record = poll(); assert.equal(module.canEdit!(record, context('a')), false); assert.throws(() => act(record, 'close', {}, 'a'), /Forbidden/); assert.throws(() => act(record, 'edit', { title: 'New', choices: ['New', 'Old'] }), /Unknown field/);
  const changed = act(record, 'edit', { title: 'Lunch tomorrow?', description: 'Bring lunch', responseVisibility: 'owner' }); assert.equal(changed.title, 'Lunch tomorrow?'); assert.equal(view(changed, 'a').results, null);
});
test('Slowvote protected-result history excludes other voters and never contains selections', () => {
  const record = act(poll({ responseVisibility: 'owner' }), 'vote', { choiceIds: ['option-1'] }, 'a');
  const events: SuiteEvent[] = ['owner', 'a', 'b'].map((actorId, index) => ({ sequence: index + 1, recordId: 'V1', version: index + 1, actorId, actorName: actorId, action: 'vote', summary: 'Updated a poll response.', createdAt: context().now }));
  assert.deepEqual(module.presentEvents!(events, record, context('a')).map(event => event.actorId), ['a']); assert.equal(module.presentEvents!(events, record, context('owner')).length, 3);
  const before = JSON.stringify(record); module.present!(record, context('b')); assert.equal(JSON.stringify(record), before);
});
test('Slowvote comments survive closing and cannot impersonate the actor', () => {
  const record = act(act(poll(), 'close', {}), 'comment', { body: 'Thanks.' }, 'reader'); const data = record.data as unknown as SlowvoteData;
  assert.equal(data.comments[0]?.actorId, 'reader'); assert.equal(data.comments[0]?.body, 'Thanks.'); assert.throws(() => act(record, 'comment', { body: 'Hi', actorId: 'owner' }, 'reader'), /Unknown field/);
});
test('Slowvote input rejects duplicate choices and arbitrary create fields', () => {
  assert.throws(() => poll({ choices: ['One', ' One '] }), /distinct/); assert.throws(() => poll({ choices: ['One'] }), /between 2/); assert.throws(() => poll({ ballots: [] }), /Unknown field/); assert.throws(() => poll({ method: 'ranked' }), /voting method/);
});
