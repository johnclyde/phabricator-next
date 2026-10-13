import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import { PolicyStore } from './policy.ts';
import { HeraldStore } from './herald.ts';
import { visibleHeraldRule, presentHeraldTranscript } from './automation-projection.ts';
import type { HeraldRuleInput, HeraldSnapshot } from '../shared/herald.ts';
import type { ActorAttribution } from '../shared/types.ts';
const actor: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'test' };
function fixture() {
  const store = new Store({ path: ':memory:' }), herald = new HeraldStore(store.database), policies = new PolicyStore(store.database, { principalExists: id => ['alice', 'bob'].includes(id) });
  const project = store.createProject({ name: 'Private project' }, actor), second = store.createProject({ name: 'Public project' }, actor), repository = store.createRepository({ name: 'Private repository', remoteUrl: 'https://example.test/repo.git' });
  for (const id of [project.id, repository.id]) { const policy = policies.policy(id, 'alice'); policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: { kind: 'principals', principalIds: ['alice'] } }, 'alice'); }
  const detail = store.createRevision({ title: 'Public source', testPlan: 'Verify source visibility.', kind: 'code', files: [{ path: 'a.ts', content: 'const x = 1;' }] }, actor), id = detail.revision.id;
  const input: HeraldRuleInput = { name: 'A rule', contentType: 'revision', ruleType: 'global', objectId: null, enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'always', operator: 'true', value: null }], actions: [{ type: 'nothing' }] };
  const authority = { isEnabledPrincipal: () => true, canManageGlobal: () => true, canEditObject: () => true };
  const snapshot: HeraldSnapshot = { objectId: id, contentType: 'revision', eventId: 'event1', actorId: 'alice', isNew: false, title: 'Public source', body: '', comment: '', status: 'needs_review', priority: null, authorId: 'alice', ownerId: null, repositoryId: repository.id, projectIds: [project.id, second.id], subscriberIds: [], reviewerIds: [], files: detail.versions[0].files, version: 1, versionId: detail.versions[0].id, contentHash: detail.versions[0].contentHash };
  return { store, herald, policies, project, second, repository, detail, input, authority, snapshot, rule: (patch: Partial<HeraldRuleInput> = {}) => herald.create({ ...input, ...patch }, 'alice', authority) };
}

test('current rule metadata hides scope, typed reference, and dependency chains without hiding unrelated rules', () => {
  const f = fixture(); try {
    const visible = f.rule(), scoped = f.rule({ ruleType: 'object', objectId: f.project.id }), condition = f.rule({ conditions: [{ field: 'projectIds', operator: 'any', value: [f.project.id] }] }), repository = f.rule({ conditions: [{ field: 'repositoryId', operator: 'isany', value: [f.repository.id] }] }), action = f.rule({ actions: [{ type: 'add-projects', targets: [f.project.id] }] });
    const dependent = f.rule({ conditions: [{ field: 'rule', operator: 'conditions', value: condition.id }] });
    assert.equal(visibleHeraldRule(visible, 'bob', f.herald, f.policies), true);
    for (const rule of [scoped, condition, repository, action, dependent]) { assert.equal(visibleHeraldRule(rule, 'bob', f.herald, f.policies), false); assert.equal(visibleHeraldRule(rule, 'alice', f.herald, f.policies), true); }
    const broken = f.rule({ conditions: [{ field: 'rule', operator: 'conditions', value: 'H999' }] }); assert.equal(visibleHeraldRule(broken, 'bob', f.herald, f.policies), true, 'unavailable explicit monograms do not expose hidden content');
  } finally { f.store.close(); }
});

test('historical transcript visibility follows exact rule versions and leaves saved evidence unchanged', () => {
  const f = fixture(); try {
    const visible = f.rule({ name: 'Visible rule' }), privateRule = f.rule({ name: 'Secret routing context', conditions: [{ field: 'projectIds', operator: 'any', value: [f.project.id] }], actions: [{ type: 'add-projects', targets: [f.project.id] }] }), dependent = f.rule({ name: 'Depends on private context', conditions: [{ field: 'rule', operator: 'conditions', value: privateRule.id }] });
    const transcript = f.herald.evaluate(f.snapshot, { canEvaluate: () => true, canApply: () => true, apply: () => ({ changed: true, message: 'Changed.', references: [f.project.id, f.second.id, 'visible-comment'] }) });
    f.herald.update(privateRule.id, 1, { ...f.input, name: 'Now public' }, 'alice', f.authority);
    assert.equal(visibleHeraldRule(f.herald.get(privateRule.id), 'bob', f.herald, f.policies), true);
    const presented = presentHeraldTranscript(transcript, 'bob', f.herald, f.policies);
    assert.deepEqual(presented.rules.map(rule => rule.ruleId), [visible.id]); assert.ok(presented.actions.every(action => action.ruleId === visible.id));
    assert.deepEqual(presented.snapshot.projectIds, [f.second.id]); assert.equal(presented.snapshot.repositoryId, null); assert.equal(JSON.stringify(presented).includes('Secret routing context'), false); assert.equal(JSON.stringify(presented).includes(dependent.name), false);
    assert.deepEqual(f.herald.transcript(transcript.id, () => true), transcript); assert.deepEqual(transcript.snapshot.projectIds, [f.project.id, f.second.id]);
    assert.deepEqual(presentHeraldTranscript(transcript, 'alice', f.herald, f.policies), transcript);
  } finally { f.store.close(); }
});

test('source policy revocation blocks even already-loaded transcript presentation and missing historical proof fails closed', () => {
  const f = fixture(); try {
    const rule = f.rule(), transcript = f.herald.evaluate(f.snapshot, { canEvaluate: () => true, canApply: () => true, apply: () => ({ changed: false, message: 'No changes.' }) });
    const changed = structuredClone(transcript); changed.rules[0].ruleVersion = 500;
    assert.deepEqual(presentHeraldTranscript(changed, 'bob', f.herald, f.policies).rules, []);
    const policy = f.policies.policy(f.detail.revision.id, 'alice'); f.policies.setPolicy(f.detail.revision.id, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: { kind: 'principals', principalIds: ['alice'] } }, 'alice');
    assert.throws(() => presentHeraldTranscript(transcript, 'bob', f.herald, f.policies), { status: 404 }); assert.equal(rule.version, 1);
  } finally { f.store.close(); }
});
