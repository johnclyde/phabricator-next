import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinRevisionView, matchRevisionViews, revisionViewDirty, revisionViewDraft, revisionViewIntent, savedRevisionView, type RevisionViewIntent } from '../client/revision-view-model.ts';
import type { RevisionSavedView } from '../shared/revision-views.ts';

const view: RevisionSavedView = { id: 'RV1', version: 2, name: 'Exact paper view', filters: { kind: 'paper', query: '  [literal] 😀 ', status: 'accepted', projectId: 'PROJ42', following: true, authored: true }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' };
test('saved selection preserves exact filters and original version independently of newer server evidence', () => {
  const selected = savedRevisionView(view);
  assert.equal(revisionViewDirty(selected), false);
  const draft = { ...selected, filters: { ...selected.filters, query: 'new unsaved literal' } };
  const newer = { ...view, version: 3, filters: { ...view.filters, projectId: null } };
  assert.equal(revisionViewDirty(draft), true); assert.equal(draft.base?.version, 2);
  assert.equal(draft.filters.projectId, 'PROJ42'); assert.notDeepEqual(draft.filters, newer.filters);
  assert.deepEqual(revisionViewDraft(draft, 'paper'), draft);
  assert.equal(revisionViewDraft(draft, 'code'), null);
});
test('builtin views are clean, independent kind choices; edits are authored recovery data', () => {
  for (const kind of ['code', 'paper', 'document'] as const) for (const builtin of ['all', 'authored', 'following'] as const) {
    const draft = builtinRevisionView(kind, builtin); assert.equal(revisionViewDirty(draft), false);
    assert.equal(draft.filters.authored, builtin === 'authored'); assert.equal(draft.filters.following, builtin === 'following');
    assert.equal(revisionViewDirty({ ...draft, name: 'unsaved name' }), true);
  }
});
test('exact retry identity rejects altered filters, version, owner and target without replacing saved draft', () => {
  const draft = savedRevisionView(view), intent: RevisionViewIntent = { id: '10000000-0000-4000-8000-000000000001', principalId: 'U1', action: 'edit', viewId: view.id, input: { name: view.name, filters: view.filters, expectedVersion: 2, expectedAccessEpoch: 7 }, draft };
  assert.deepEqual(revisionViewIntent(intent, 'U1'), intent);
  assert.equal(revisionViewIntent(intent, 'U2'), null);
  assert.equal(revisionViewIntent({ ...intent, input: { ...intent.input, expectedVersion: 3 } }, 'U1'), null);
  assert.equal(revisionViewIntent({ ...intent, input: { ...intent.input, filters: { ...view.filters, projectId: null } } }, 'U1'), null);
  assert.equal(revisionViewIntent({ ...intent, viewId: 'RV2' }, 'U1'), null);
  assert.deepEqual(draft.filters, view.filters);
});
test('voice matching never resolves a partial name, another kind, or an ambiguous name versus ID', () => {
  const alias = { ...view, id: 'RV2', name: 'RV1' }, code = { ...view, id: 'RV3', filters: { ...view.filters, kind: 'code' as const } };
  assert.deepEqual(matchRevisionViews([view, code], 'paper', 'EXACT PAPER VIEW'), [view]);
  assert.deepEqual(matchRevisionViews([view], 'paper', 'Exact paper'), []);
  assert.deepEqual(matchRevisionViews([view], 'code', 'RV1'), []);
  assert.equal(matchRevisionViews([view, alias], 'paper', 'RV1').length, 2);
});
