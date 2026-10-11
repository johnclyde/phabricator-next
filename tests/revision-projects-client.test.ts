import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mergeProjectTagHistory, prepareProjectTagDraft, projectTagDraftMatches, projectTagIntent, projectTagReading, verifiedProjectTagResult, revisionProjectIds } from '../client/revision-projects.ts';
import { revisionProjectCreationInput, revisionProjectInput, type RevisionProjectSnapshot, type RevisionProjectHistory, type RevisionProjectTransaction, type RevisionProjectReceipt } from '../shared/revision-projects.ts';
import { snapshot, history } from './revision-projects-client-fixture.ts';
const date = '2026-10-01T00:00:00.000Z';
const transaction = (version: number): RevisionProjectTransaction => ({ id: `tx${version}`, revisionId: 'P1', operationId: `op${version}`, projectVersion: version, before: { ...snapshot.tags, version: version - 1, updatedAt: version === 1 ? null : date }, after: { ...snapshot.tags, version, updatedAt: date }, attribution: { principalId: 'U1', displayName: 'Editor', requestId: 'request', credentialId: null }, createdAt: date });
test('project tag cache requires matched versions, authority and bounded exact continuation', () => {
  const reading = { snapshot, history }; assert.deepEqual(projectTagReading(reading, 'P1'), reading);
  for (const value of [{ ...reading, history: { ...history, projectVersion: 1 } }, { ...reading, history: { ...history, accessEpoch: 2 } }, { ...reading, snapshot: { ...snapshot, access: { ...snapshot.access, capabilities: { ...snapshot.access.capabilities, view: false } } } }, { ...reading, snapshot: { ...snapshot, tags: { ...snapshot.tags, projectIds: ['PROJ2', 'PROJ1'] } } }]) assert.equal(projectTagReading(value, 'P1'), null);
  const first = { ...history, projectVersion: 3, transactions: [transaction(3)], nextBefore: 3 }, next = { ...history, projectVersion: 3, transactions: [transaction(2), transaction(1)], nextBefore: null };
  assert.equal(mergeProjectTagHistory(first, next).transactions.length, 3);
  for (const page of [first, { ...next, accessEpoch: 2 }, { ...next, projectVersion: 4 }, { ...next, nextBefore: 7 }, { ...next, transactions: [transaction(1), transaction(2)] }]) assert.throws(() => mergeProjectTagHistory(first, page), /changed/);
});
test('ordered tag drafts keep their exact version and source-independent shape', () => {
  const draft = { ...prepareProjectTagDraft(snapshot, 'add'), projectIds: ['PROJ2', 'PROJ1'] }, intent = { id: '61eb8a98-0397-49d3-bf10-cf67fffcf83b', revisionId: 'P1', body: draft, draft };
  assert.deepEqual(projectTagIntent(intent, 'P1'), intent); assert.equal(projectTagIntent({ ...intent, id: '-'.repeat(36) }, 'P1'), null); assert.equal(projectTagIntent({ ...intent, draft: { ...draft, projectIds: ['PROJ1', 'PROJ2'] } }, 'P1'), null);
  assert.equal(projectTagDraftMatches(draft, snapshot), true); assert.equal(projectTagDraftMatches(draft, { ...snapshot, tags: { ...snapshot.tags, version: 1 } }), false); assert.equal(projectTagDraftMatches(draft, { ...snapshot, accessEpoch: 2 }), false);
  assert.deepEqual(Object.keys(draft), ['action', 'projectIds', 'expectedProjectVersion', 'expectedAccessEpoch']); assert.deepEqual(revisionProjectInput({ ...draft, action: 'set', projectIds: [] }).projectIds, []);
});
test('creation keeps legacy scalar, omitted and new ordered tag inputs distinct', () => {
  assert.deepEqual(revisionProjectCreationInput({ projectId: 'PROJ1' }), { projectId: 'PROJ1' }); assert.deepEqual(revisionProjectCreationInput({}), {}); assert.deepEqual(revisionProjectCreationInput({ projectId: null }), { projectId: null }); assert.deepEqual(revisionProjectCreationInput({ projectIds: ['PROJ2', 'PROJ1'] }), { projectIds: ['PROJ2', 'PROJ1'] }); assert.throws(() => revisionProjectCreationInput({ projectId: null, projectIds: [] }));
  assert.deepEqual(revisionProjectIds({ projectId: 'PROJ1' }), ['PROJ1']); assert.deepEqual(revisionProjectIds({ projectId: 'PROJ1', projectIds: [] }), []);
});
test('verified receipts permit redacted equal visible states and no-op receipts while binding input and actor', async () => {
  const input = { ...prepareProjectTagDraft(snapshot, 'add'), projectIds: ['PROJ2'] }, tx = transaction(1), receipt: RevisionProjectReceipt = { revisionId: 'P1', operationId: tx.operationId, inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), changed: true, tags: tx.after, transaction: tx, accessEpoch: 1 };
  assert.deepEqual(await verifiedProjectTagResult(receipt, 'P1', input, 'U1'), receipt); await assert.rejects(verifiedProjectTagResult(receipt, 'P1', input, 'U2'), /does not match/); await assert.rejects(verifiedProjectTagResult({ ...receipt, inputSha256: 'a'.repeat(64) }, 'P1', input, 'U1'), /different request/);
  const noOp = { ...receipt, changed: false, tags: snapshot.tags, transaction: null }; assert.deepEqual(await verifiedProjectTagResult(noOp, 'P1', input, 'U1'), noOp);
});
