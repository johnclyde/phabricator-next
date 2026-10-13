import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.ts';
import { Store } from './store.ts';
import { createAuth } from './auth.ts';
import { HeraldStore } from './herald.ts';
import { applyHeraldAction, canApplyHeraldAction } from './herald-effects.ts';
import type { HeraldAction, HeraldRule, HeraldRuleInput } from '../shared/herald.ts';
import type { ActorAttribution } from '../shared/types.ts';

async function fixture() {
  const store = new Store({ path: ':memory:' });
  const auth = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await auth.createAccount({ username: 'alice', displayName: 'Alice', password: 'a sufficiently lengthy alice password' }), bob = await auth.createAccount({ username: 'bob', displayName: 'Bob', password: 'a sufficiently lengthy bob password' });
  const app = createApp({ store, seed: false, authMode: 'password', automation: { managers: ['alice'] } });
  const automation = app.automation;
  const actor: ActorAttribution = { principalId: alice.id, displayName: 'Alice', credentialId: null, requestId: 'fixture' };
  const base: HeraldRuleInput = { name: 'Route review', contentType: 'revision', ruleType: 'global', objectId: null, enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'always', operator: 'true', value: null }], actions: [{ type: 'nothing' }] };
  const revision = store.createRevision({ testPlan: 'Verify Herald evidence.', title: 'Exact source', kind: 'code', files: [{ path: 'a.ts', content: 'const test = true;\n' }] }, actor);
  const rule = automation.herald.create(base, alice.id, automation.authority);
  const apply = (action: HeraldAction, id = revision.revision.id, ruleOverride: HeraldRule = rule) => store.transaction(() => applyHeraldAction(store, app.auth, app.policies, automation.harbormaster, ruleOverride, action, automation.snapshot(id, crypto.randomUUID(), alice.id)));
  return { ...app, alice, bob, actor, base, rule, revision, apply, finish: async () => { await app.close(); store.close(); } };
}

test('Herald effects add optional and required reviewers and subscribers through immutable native histories', async () => {
  const f = await fixture(); try {
    const id = f.revision.revision.id;
    assert.equal(f.apply({ type: 'add-reviewers', targets: [f.bob.id], required: true }).changed, true);
    assert.equal(f.store.revisionReviewers.state(id).members[0].status, 'blocking');
    assert.equal(f.apply({ type: 'add-reviewers', targets: [f.bob.id], required: true }).changed, false);
    assert.equal(f.apply({ type: 'add-subscribers', targets: [f.bob.id] }).changed, false, 'reviewers already follow automatically');
    assert.equal(f.apply({ type: 'remove-subscribers', targets: [f.bob.id] }).changed, false, 'automation preserves automatic following');
    assert.deepEqual(f.store.detail(id).versions, f.revision.versions); assert.deepEqual(f.store.detail(id).reviews, []);
    const history = f.store.revisionReviewers.history(id).transactions; assert.equal(history.length, 2); assert.ok(history.every(item => item.attribution?.principalId === f.alice.id && item.attribution.requestId.startsWith('herald:')));
    const second = f.store.createRevision({ testPlan: 'Verify Herald evidence.', title: 'Other', kind: 'paper', files: [{ path: 'paper.tex', content: 'content' }] }, f.actor).revision.id;
    assert.equal(f.apply({ type: 'add-subscribers', targets: [f.bob.id] }, second).changed, true); assert.equal(f.store.revisionSubscriptions.status(second, f.bob.id).following, true);
    assert.equal(f.apply({ type: 'remove-subscribers', targets: [f.bob.id] }, second).changed, true); assert.equal(f.store.revisionSubscriptions.status(second, f.bob.id).following, false);
  } finally { await f.finish(); }
});

test('Herald task effects preserve normal versions, dependencies, project history, assignment and source-bound comments', async () => {
  const f = await fixture(); try {
    const task = f.store.createTask({ title: 'Route task' }, f.actor), project = f.store.createProject({ name: 'Build work' }, f.actor);
    f.apply({ type: 'task-priority', value: 'urgent' }, task.id); f.apply({ type: 'task-status', value: 'in_progress' }, task.id); f.apply({ type: 'assign', value: f.bob.id }, task.id); f.apply({ type: 'add-projects', targets: [project.id] }, task.id);
    let current = f.store.taskDetail(task.id).task; assert.equal(current.priority, 'urgent'); assert.equal(current.status, 'in_progress'); assert.equal(current.ownerId, f.bob.id); assert.deepEqual(current.projectIds, [project.id]);
    f.apply({ type: 'remove-projects', targets: [project.id] }, task.id); current = f.store.taskDetail(task.id).task; assert.deepEqual(current.projectIds, []);
    const text = 'Herald review reminder'; f.apply({ type: 'comment', value: text }, task.id); assert.ok(f.store.taskDetail(task.id).history.transactions.some(item => item.kind === 'comment' && item.comment === text));
    f.apply({ type: 'comment', value: text }); assert.equal(f.store.detail(f.revision.revision.id).comments[0].versionId, f.revision.versions[0].id);
    f.apply({ type: 'add-projects', targets: [project.id] }); assert.deepEqual(f.store.revisionProjects.state(f.revision.revision.id).projectIds, [project.id]);
    const paste = f.store.pastes.create({ title: 'Snippet', content: 'source' }, f.actor); f.apply({ type: 'comment', value: text }, paste.id); f.apply({ type: 'add-subscribers', targets: [f.bob.id] }, paste.id); assert.equal(f.store.pastes.history(paste.id).transactions[0].contentVersion, 1); assert.equal(f.store.objectSubscriptions.status(paste.id, f.bob.id).following, true);
    const wiki = f.store.createDocument({ title: 'Guide', slug: '/', content: 'Source' }, f.actor); f.apply({ type: 'add-subscribers', targets: [f.bob.id] }, wiki.id); assert.equal(f.store.objectSubscriptions.status(wiki.id, f.bob.id).following, true);
  } finally { await f.finish(); }
});

test('Herald invokes immutable build plans without changing source or review acceptance', async () => {
  const f = await fixture(); try {
    const buildActor = { principalId: f.alice.id, displayName: 'Alice', workspaceId: f.auth.workspaceId };
    const plan = f.automation.harbormaster.createPlan({ name: 'Local checks', description: '', enabled: true, steps: [{ key: 'checks', name: 'Checks', kind: 'local-checks', dependsOn: [], worker: null }] }, buildActor);
    const result = f.apply({ type: 'run-build-plans', targets: [plan.id] }); assert.equal(result.references?.length, 1);
    const detail = f.automation.harbormaster.detail(result.references![0], buildActor); assert.equal(detail.buildable.versionId, f.revision.versions[0].id); assert.equal(detail.buildable.contentHash, f.revision.versions[0].contentHash); assert.equal(detail.build.planVersion, 1);
    assert.deepEqual(f.store.detail(f.revision.revision.id).versions, f.revision.versions); assert.equal(f.store.detail(f.revision.revision.id).revision.status, 'needs_review');
  } finally { await f.finish(); }
});

test('current authority is rechecked and a failed multi-target action rolls back native edits and queued notification causes', async () => {
  const f = await fixture(); try {
    const id = f.revision.revision.id, snapshot = f.automation.snapshot(id, 'revoked-event', f.alice.id);
    const personal: HeraldRule = { ...f.rule, ruleType: 'personal', authorId: f.bob.id };
    const policy = f.policies.policy(id, f.alice.id); f.policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, edit: { kind: 'principals', principalIds: [f.alice.id] } }, f.alice.id);
    assert.equal(canApplyHeraldAction(f.store, f.auth, f.policies, f.automation.harbormaster, personal, { type: 'add-self-subscriber' }, snapshot), true);
    assert.equal(canApplyHeraldAction(f.store, f.auth, f.policies, f.automation.harbormaster, personal, { type: 'add-self-reviewer' }, snapshot), false);
    assert.equal(canApplyHeraldAction(f.store, f.auth, f.policies, f.automation.harbormaster, personal, { type: 'comment', value: 'forbidden' }, snapshot), false);
    f.auth.setAccountDisabled(f.bob.id, true); assert.equal(canApplyHeraldAction(f.store, f.auth, f.policies, f.automation.harbormaster, personal, { type: 'add-self-reviewer' }, snapshot), false); f.auth.setAccountDisabled(f.bob.id, false);
    const failing = f.automation.herald.create({ ...f.base, actions: [{ type: 'add-reviewers', targets: [f.bob.id, f.alice.id] }, { type: 'comment', value: 'continues' }] }, f.alice.id, f.automation.authority);
    const result = f.store.mutate('atomic-herald-effects', 'fingerprint', () => ({ status: 200, body: f.automation.herald.evaluate({ ...snapshot, eventId: 'atomic-event' }, { canEvaluate: rule => rule.id === failing.id, canApply: (rule, action, snap) => canApplyHeraldAction(f.store, f.auth, f.policies, f.automation.harbormaster, rule, action, snap), apply: (rule, action, snap) => applyHeraldAction(f.store, f.auth, f.policies, f.automation.harbormaster, rule, action, snap) }) }));
    const transcript = result.body as ReturnType<HeraldStore['evaluate']>; assert.deepEqual(transcript.actions.map(action => action.status), ['error', 'applied']); assert.deepEqual(f.store.revisionReviewers.state(id).members, []); assert.ok(f.store.detail(id).comments.some(comment => comment.body === 'continues'));
  } finally { await f.finish(); }
});


test('automation cannot subscribe, review, or assign people who cannot view the source object', async () => {
  const f = await fixture(); try {
    for (const id of [f.revision.revision.id, f.store.createTask({ title: 'Private task' }, f.actor).id]) {
      const policy = f.policies.policy(id, f.alice.id); f.policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: { kind: 'principals', principalIds: [f.alice.id] } }, f.alice.id);
      assert.throws(() => f.apply({ type: 'add-subscribers', targets: [f.bob.id] }, id), { status: 404 });
      if (id.startsWith('T')) { assert.throws(() => f.apply({ type: 'assign', value: f.bob.id }, id), { status: 404 }); assert.equal(f.store.taskDetail(id).task.ownerId, null); }
      else { assert.throws(() => f.apply({ type: 'add-reviewers', targets: [f.bob.id] }, id), { status: 404 }); assert.deepEqual(f.store.revisionReviewers.state(id).members, []); }
    }
  } finally { await f.finish(); }
});

test('personal rules cannot promote an interacting viewer to task owner or alter editor-managed reviewer membership', async () => {
  const f = await fixture(); try {
    const task = f.store.createTask({ title: 'Editor-controlled assignment' }, f.actor);
    const personal: HeraldRule = { ...f.rule, ruleType: 'personal', authorId: f.bob.id };
    for (const [id, action] of [[task.id, { type: 'assign-self' }], [f.revision.revision.id, { type: 'add-self-reviewer' }]] as const) {
      const policy = f.policies.policy(id, f.alice.id); f.policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, edit: { kind: 'principals', principalIds: [f.alice.id] }, interact: { kind: 'workspace' } }, f.alice.id);
      const before = f.policies.access(id, f.bob.id); assert.equal(before.view, true); assert.equal(before.interact, true); assert.equal(before.edit, false);
      const snapshot = f.automation.snapshot(id, `self-effect-${id}`, f.bob.id);
      assert.equal(canApplyHeraldAction(f.store, f.auth, f.policies, f.automation.harbormaster, personal, action, snapshot), false);
      assert.throws(() => f.apply(action, id, personal), { status: 403 });
      assert.deepEqual(f.policies.access(id, f.bob.id), before);
    }
    assert.equal(f.store.taskDetail(task.id).task.ownerId, null); assert.deepEqual(f.store.revisionReviewers.state(f.revision.revision.id).members, []);
    const policy = f.policies.policy(task.id, f.alice.id); f.policies.setPolicy(task.id, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, edit: { kind: 'workspace' } }, f.alice.id);
    assert.equal(f.apply({ type: 'assign-self' }, task.id, personal).changed, true); assert.equal(f.store.taskDetail(task.id).task.ownerId, f.bob.id);
  } finally { await f.finish(); }
});
