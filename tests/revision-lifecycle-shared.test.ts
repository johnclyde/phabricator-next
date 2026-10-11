import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REVISION_LIFECYCLE_CONFIG, revisionLifecycleActions, revisionLifecycleInput, type RevisionLifecycleSnapshot } from '../shared/revision-lifecycle.ts';
import { revisionStackTopology } from '../shared/revision-stack.ts';

const head = { versionId: 'source-v1', number: 1, contentHash: 'a'.repeat(64) };
const base: Omit<RevisionLifecycleSnapshot, 'actions' | 'access' | 'accessEpoch'> = { lifecycle: { revisionId: 'P1', version: 0, status: 'needs_review', reviewStarted: true, closedFromAccepted: null, resumeAcceptanceHead: null, updatedAt: null }, head, authorship: { version: 0, author: { principalId: 'U1', displayName: 'Author' } }, evidence: { sha256: 'b'.repeat(64), reviewIds: ['review'], errorCount: 0 }, config: { ...DEFAULT_REVISION_LIFECYCLE_CONFIG }, configId: 'c'.repeat(64) };
const available = (snapshot = base, principal = 'U1') => revisionLifecycleActions(snapshot, principal).filter(a => a.available).map(a => a.action);
test('native lifecycle applies author and terminal rules, with explicit operator overrides', () => {
  assert.deepEqual(available(), ['plan_changes', 'abandon', 'accept_reviewed']);
  assert.deepEqual(available(base, 'U2'), ['accept_reviewed']);
  assert.deepEqual(available({ ...base, lifecycle: { ...base.lifecycle, status: 'draft', reviewStarted: false } }, 'U2'), ['request_review']);
  assert.deepEqual(available({ ...base, lifecycle: { ...base.lifecycle, status: 'abandoned' } }), ['reclaim']);
  assert.deepEqual(available({ ...base, lifecycle: { ...base.lifecycle, status: 'closed' } }), []);
  assert.deepEqual(available({ ...base, lifecycle: { ...base.lifecycle, status: 'closed' }, config: { ...base.config, allowReopen: true } }, 'U2'), ['reopen']);
  assert.deepEqual(available({ ...base, lifecycle: { ...base.lifecycle, status: 'accepted' }, config: { ...base.config, closeOnAccept: true } }), []);
  assert.deepEqual(available({ ...base, lifecycle: { ...base.lifecycle, status: 'accepted' }, config: { ...base.config, alwaysAllowClose: true, alwaysAllowAbandon: true } }, 'U2'), ['abandon', 'close']);
});
test('a planned acceptance resumes only for the exact still-clean reviewed source', () => {
  const snapshot = { ...base, lifecycle: { ...base.lifecycle, status: 'changes_planned' as const, resumeAcceptanceHead: head } };
  const next = (s = snapshot) => revisionLifecycleActions(s, 'U1').find(a => a.action === 'request_review')!.targetStatus;
  assert.equal(next(), 'accepted');
  assert.equal(next({ ...snapshot, head: { ...head, contentHash: 'd'.repeat(64) } }), 'needs_review');
  assert.equal(next({ ...snapshot, evidence: { ...base.evidence, errorCount: 1 } }), 'needs_review');
  assert.equal(next({ ...snapshot, evidence: { ...base.evidence, reviewIds: [] } }), 'needs_review');
});
test('intents require every inspected identity and preserve canonical property order', () => {
  const input = { action: 'plan_changes', message: '', expectedLifecycleVersion: 0, expectedAuthorVersion: 0, expectedVersion: 1, expectedVersionId: head.versionId, expectedContentHash: head.contentHash, expectedAccessEpoch: 0, expectedConfigId: base.configId, expectedEvidenceSha256: base.evidence.sha256 };
  assert.deepEqual(revisionLifecycleInput(Object.fromEntries(Object.entries(input).reverse())), input);
  for (const key of Object.keys(input)) { const missing = { ...input } as Record<string, unknown>; delete missing[key]; assert.throws(() => revisionLifecycleInput(missing)); }
  for (const patch of [{ action: 'accepted' }, { expectedConfigId: 'invalid' }, { expectedAuthorVersion: -1 }, { expectedLifecycleVersion: 0.1 }, { message: '\0' }, { unexpected: true }]) assert.throws(() => revisionLifecycleInput({ ...input, ...patch }));
});
test('abandoned and operator-terminal accepted ancestors stay in Stack but leave open counts', () => {
  const nodes = [{ id: 'P1', status: 'needs_review' as const }, { id: 'P2', status: 'abandoned' as const }, { id: 'P3', status: 'accepted' as const }], edges = [{ childId: 'P1', parentId: 'P2' }, { childId: 'P2', parentId: 'P3' }];
  assert.deepEqual(revisionStackTopology('P1', nodes, edges), { order: ['P1', 'P2', 'P3'], openParentIds: ['P3'] });
  assert.deepEqual(revisionStackTopology('P1', nodes, edges, true), { order: ['P1', 'P2', 'P3'], openParentIds: [] });
});
