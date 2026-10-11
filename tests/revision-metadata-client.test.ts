import test from 'node:test';
import assert from 'node:assert/strict';
import { metadataDraft, metadataDraftError, metadataDraftMatches, metadataHistory, metadataIntent, metadataReading, metadataReadingCurrent, mergeMetadataHistory, prepareMetadataDraft, verifiedMetadataResult } from '../client/revision-metadata.ts';
import { revisionRefreshDirection } from '../client/revision-lifecycle.ts';
import { revisionMetadataInput, type RevisionMetadataReceipt, type RevisionMetadataTransaction } from '../shared/revision-metadata.ts';
import { snapshot, history } from './revision-metadata-client-fixture.ts';

const input = { ...prepareMetadataDraft(snapshot), title: ' Revised manuscript ', message: ' Exact explanation\r\n' };
const intent = { id: '61eb8a98-0397-49d3-bf10-cf67fffcf83b', revisionId: 'P1', body: input, draft: input };
const transaction = (number: number): RevisionMetadataTransaction => ({ id: `metadata-${number}`, revisionId: 'P1', operationId: `operation-${number}`, metadataVersion: number, head: snapshot.head, before: { ...snapshot.metadata, version: number - 1, ...(number > 1 ? { title: `Title ${number - 1}`, updatedAt: '2026-10-11T10:00:00Z' } : {}) }, after: { ...snapshot.metadata, version: number, title: `Title ${number}`, updatedAt: '2026-10-11T10:00:00Z' }, message: '', attribution: { principalId: 'U1', displayName: 'Editor', credentialId: null, requestId: `request-${number}` }, createdAt: '2026-10-11T10:00:00Z' });
test('metadata snapshots keep unknown legacy plans and require matching authorized history versions', () => {
  assert.ok(metadataReading({ snapshot, history }, 'P1'));
  assert.equal(metadataReading({ snapshot, history: { ...history, metadataVersion: 1 } }, 'P1'), null);
  assert.equal(metadataReading({ snapshot: { ...snapshot, accessEpoch: 2 }, history }, 'P1'), null);
  assert.equal(metadataReading({ snapshot: { ...snapshot, access: { ...snapshot.access, capabilities: { ...snapshot.access.capabilities, view: false } } }, history }, 'P1'), null);
  const legacy = { ...snapshot, metadata: { ...snapshot.metadata, testPlan: null } };
  assert.equal(metadataReading({ snapshot: legacy, history }, 'P1')!.snapshot.metadata.testPlan, null);
  assert.equal(prepareMetadataDraft(legacy).testPlan, ''); assert.ok(metadataDraftError(prepareMetadataDraft(legacy), true));
});
test('incomplete authored fields survive reload without changing exact source, configuration or metadata pins', () => {
  const incomplete = { ...input, title: '', testPlan: '' };
  assert.deepEqual(metadataDraft(incomplete), incomplete); assert.ok(metadataDraftError(incomplete, true));
  assert.equal(metadataDraftError({ ...input, title: ' ', testPlan: '\r\n' }, true), null);
  assert.ok(metadataDraftError({ ...input, title: 'é'.repeat(128) }, false));
  assert.equal(metadataDraftMatches(input, snapshot), true);
  for (const changed of [{ ...snapshot, metadata: { ...snapshot.metadata, version: 1 } }, { ...snapshot, head: { ...snapshot.head, number: 2 } }, { ...snapshot, accessEpoch: 2 }, { ...snapshot, configId: 'c'.repeat(64) }]) assert.equal(metadataDraftMatches(input, changed), false);
  assert.deepEqual(metadataIntent(intent, 'P1'), intent); assert.equal(metadataIntent({ ...intent, id: 'a'.repeat(36) }, 'P1'), null); assert.equal(metadataIntent({ ...intent, body: { ...input, testPlan: 'Substituted' } }, 'P1'), null);
});
test('metadata history rejects overlap, mixed versions, malformed cursors and duplicate operations', () => {
  const first = { ...history, metadataVersion: 3, transactions: [transaction(3)], nextBefore: 3 };
  const second = { ...history, metadataVersion: 3, transactions: [transaction(2), transaction(1)], nextBefore: null };
  assert.equal(mergeMetadataHistory(first, second).transactions.length, 3);
  assert.equal(metadataHistory({ ...first, nextBefore: 2 }, 'P1'), false);
  assert.throws(() => mergeMetadataHistory(first, { ...second, transactions: [transaction(3)] }));
  assert.throws(() => mergeMetadataHistory(first, { ...second, metadataVersion: 4 }));
  assert.equal(metadataHistory({ ...second, transactions: [transaction(2), { ...transaction(1), operationId: 'operation-2' }] }, 'P1'), false);
});
test('metadata receipt verification binds exact strings, actor, source, changed and no-op requests', async () => {
  const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
  const after = { ...snapshot.metadata, version: 1, title: input.title, updatedAt: '2026-10-11T10:00:00Z' }, t = { ...transaction(1), after, message: input.message };
  const receipt: RevisionMetadataReceipt = { revisionId: 'P1', operationId: t.operationId, inputSha256: await digest(revisionMetadataInput(input)), changed: true, metadata: after, transaction: t, accessEpoch: 1 };
  assert.deepEqual(await verifiedMetadataResult(receipt, 'P1', input, 'U1'), receipt);
  await assert.rejects(verifiedMetadataResult({ ...receipt, inputSha256: 'e'.repeat(64) }, 'P1', input, 'U1'));
  await assert.rejects(verifiedMetadataResult(receipt, 'P1', { ...input, title: input.title.trim() }, 'U1'));
  await assert.rejects(verifiedMetadataResult(receipt, 'P1', input, 'U2'));
  const noopInput = prepareMetadataDraft(snapshot), noop = { revisionId: 'P1', operationId: 'noop', inputSha256: await digest(revisionMetadataInput(noopInput)), changed: false, metadata: snapshot.metadata, transaction: null, accessEpoch: 1 };
  assert.deepEqual(await verifiedMetadataResult(noop, 'P1', noopInput, 'U1'), noop);
});
test('same-epoch metadata refresh advances full detail without making absent counters loop other panels', () => {
  const base = { currentVersion: 1, authorVersion: 0, lifecycleVersion: 0, reviewerVersion: 0, status: 'accepted' };
  assert.equal(revisionRefreshDirection({ ...base, metadataVersion: 1 }, { ...base, metadataVersion: 2 }), 'workspace');
  assert.equal(revisionRefreshDirection({ ...base, metadataVersion: 2 }, { ...base, metadataVersion: 1 }), 'revision');
  assert.equal(revisionRefreshDirection({ ...base, metadataVersion: 2 }, base), null);
  assert.equal(metadataReadingCurrent({ snapshot, history }, { currentVersion: 1, metadataVersion: 1 }), false);
  assert.equal(metadataReadingCurrent({ snapshot, history }, { currentVersion: 2, metadataVersion: 0 }), false);
});
