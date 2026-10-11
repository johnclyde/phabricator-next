import { lifecycleAction, closeRevision } from './revision-lifecycle-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAuth } from '../server/auth.ts';
import { PolicyStore } from '../server/policy.ts';
import { Store } from '../server/store.ts';
import type { Audience } from '../shared/policy.ts';
import type { Activity } from '../shared/types.ts';

const password = 'correct horse battery staple';
const request = { method: 'GET', headers: { host: '127.0.0.1:4310' } } as IncomingMessage;
const workspace: Audience = { kind: 'workspace' };
const selected = (...principalIds: string[]): Audience => ({ kind: 'principals', principalIds });
const schemaVersion = (store: Store) => (store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const latch = (store: Store) => store.database.prepare("SELECT value FROM auth_meta WHERE name = 'require_auth'").get();

test('password activation preserves local access until local-only grants are explicitly reassigned', async () => {
  const store = new Store({ path: ':memory:' });
  try {
    const local = createAuth({ database: store.database, mode: 'local', basePath: '/' });
    const identity = local.authenticate(request).principalId;
    const policies = new PolicyStore(store.database, { principalExists: id => id === identity || local.listAccounts().some(account => account.id === id) });
    const space = policies.createSpace({ name: 'Private local research' }, identity);
    const task = store.createTask({ title: 'Local research notes' });
    policies.configureNew(task.id, { spaceId: space.id }, identity);
    const version = schemaVersion(store);
    const policyBefore = policies.policy(task.id, identity);
    const spaceBefore = policies.getSpace(space.id, identity);
    const epoch = policies.epoch();
    const provisioner = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
    const account = await provisioner.createAccount({ username: 'alice', displayName: 'Alice', password });
    assert.equal(latch(store), undefined, 'provisioning an account does not activate authentication');
    // Explicit password provisioning is also metadata-only, even with an account.
    createAuth({ database: store.database, mode: 'password', basePath: '/', provisioning: true });
    assert.equal(latch(store), undefined);
    assert.throws(() => createAuth({ database: store.database, mode: 'password', basePath: '/' }), /policies reference the local-only principal.*APP_AUTH_MODE=local/);
    assert.equal(latch(store), undefined); assert.equal(schemaVersion(store), version);
    assert.equal(local.authenticate(request).principalId, identity);
    assert.deepEqual(policies.policy(task.id, identity), policyBefore);
    assert.deepEqual(policies.getSpace(space.id, identity), spaceBefore);
    assert.equal(policies.epoch(), epoch, 'activation cannot silently rewrite policy ownership');

    const transferred = provisioner.transferLocalPolicies(account.id);
    assert.equal(transferred.spaces, 1); assert.equal(transferred.objects, 0);
    assert.equal(latch(store), undefined, 'explicit handoff remains separate from activation');
    const authenticated = createAuth({ database: store.database, mode: 'password', basePath: '/' });
    assert.equal(authenticated.mode, 'password'); assert.ok(latch(store));
    assert.equal(schemaVersion(store), version, 'activation does not downgrade the policy schema');
    assert.equal(policies.access(task.id, account.id).edit, true);
    assert.equal(policies.access(task.id, identity).view, false);
    assert.throws(() => local.authenticate(request), (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === 401);
  } finally { store.close(); }
});

test('terminal handoff preserves other grants and immutable content, versions changed policies once, and audits atomically', async () => {
  const store = new Store({ path: ':memory:' });
  try {
    const operator = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
    const identity = operator.authenticate(request).principalId;
    const alice = await operator.createAccount({ username: 'alice', displayName: 'Alice', password });
    const bob = await operator.createAccount({ username: 'bob', displayName: 'Bob', password });
    const policies = new PolicyStore(store.database, { principalExists: id => [identity, alice.id, bob.id].includes(id) });
    const space = policies.createSpace({ name: 'Research', view: selected(identity, alice.id, bob.id), edit: selected(identity, alice.id) }, identity);
    const wiki = store.createDocument({ title: 'Preserve source', slug: '/', content: `A literal principal in source: ${identity}` });
    store.updateDocument(wiki.id, { title: wiki.title, slug: wiki.slug, content: 'Second immutable snapshot.', expectedVersion: 1 });
    policies.configureNew(wiki.id, { spaceId: space.id, view: selected(identity, alice.id, bob.id), edit: selected(identity), interact: selected(identity, bob.id) }, identity);
    const revision = store.createRevision({ title: 'Preserve paper', kind: 'paper', files: [{ path: 'paper.tex', content: 'Original paper.' }] });
    store.createVersion(revision.revision.id, { files: [{ path: 'paper.tex', content: 'Revised paper.' }], message: 'Second immutable version.', expectedVersion: 1 });
    const beforePolicy = policies.policy(wiki.id, identity);
    const beforeSpace = policies.getSpace(space.id, identity);
    const unchangedPolicy = policies.policy(revision.revision.id, identity);
    const source = () => ['entities', 'versions', 'wiki_versions'].map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const contentBefore = source();
    const permissions = () => ['policy_spaces', 'object_policies', 'policy_meta', 'activity'].map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    let before = permissions();
    assert.throws(() => operator.transferLocalPolicies('missing'), /Active account not found/);
    assert.deepEqual(permissions(), before);
    operator.setAccountDisabled(alice.id, true);
    assert.throws(() => operator.transferLocalPolicies(alice.id), /Active account not found/);
    assert.deepEqual(permissions(), before);
    operator.setAccountDisabled(alice.id, false);
    const ordinary = createAuth({ database: store.database, mode: 'local', basePath: '/' });
    assert.throws(() => ordinary.transferLocalPolicies(alice.id), /terminal provisioning access/);
    assert.deepEqual(permissions(), before);

    store.database.exec(`CREATE TRIGGER fail_transfer_audit BEFORE INSERT ON activity WHEN NEW.object_id = '${wiki.id}' AND json_extract(NEW.data, '$.action') = 'local_grants_transferred' BEGIN SELECT RAISE(ABORT, 'Injected transfer audit failure'); END;`);
    assert.throws(() => operator.transferLocalPolicies(alice.id), /Injected transfer audit failure/);
    assert.deepEqual(permissions(), before, 'failed audit rolls back prior grants, versions and audit entries');
    store.database.exec('DROP TRIGGER fail_transfer_audit');
    const epoch = policies.epoch();
    const transferred = operator.transferLocalPolicies(alice.id);
    assert.deepEqual(transferred, { account: alice, spaces: 1, objects: 1, tasks: 0, revisions: 0, projectMemberships: 0 });
    assert.equal(policies.epoch(), epoch + 1);
    const afterPolicy = policies.policy(wiki.id, alice.id);
    const afterSpace = policies.getSpace(space.id, alice.id);
    assert.equal(afterPolicy.version, beforePolicy.version + 1);
    assert.equal(afterSpace.version, beforeSpace.version + 1);
    assert.deepEqual(afterPolicy.rules.view.kind === 'principals' ? [...afterPolicy.rules.view.principalIds].sort() : null, [alice.id, bob.id].sort());
    assert.deepEqual(afterPolicy.rules.edit, selected(alice.id));
    assert.deepEqual(new Set(afterPolicy.rules.interact.kind === 'principals' ? afterPolicy.rules.interact.principalIds : []), new Set([alice.id, bob.id]));
    assert.deepEqual(new Set(afterSpace.view.kind === 'principals' ? afterSpace.view.principalIds : []), new Set([alice.id, bob.id]));
    assert.deepEqual(afterSpace.edit, selected(alice.id));
    assert.deepEqual(policies.policy(revision.revision.id, alice.id), unchangedPolicy, 'unaffected rules and versions are unchanged');
    assert.deepEqual(source(), contentBefore, 'source metadata and immutable snapshots remain byte-for-byte identical');
    const audits = (store.database.prepare("SELECT data FROM activity WHERE json_extract(data, '$.action') = 'local_grants_transferred'").all() as { data: string }[]).map(row => JSON.parse(row.data) as Activity);
    assert.equal(audits.length, 2); assert.equal(new Set(audits.map(item => item.attribution!.requestId)).size, 1);
    for (const audit of audits) {
      assert.equal(audit.actor, 'Terminal operator'); assert.equal(audit.attribution!.displayName, 'Terminal operator');
      assert.equal(audit.attribution!.principalId, `operator:${operator.workspaceId}`); assert.equal(audit.attribution!.credentialId, null);
      assert.doesNotMatch(audit.detail, /Alice|Bob|Research/);
    }
    before = permissions();
    assert.deepEqual(operator.transferLocalPolicies(alice.id), { account: alice, spaces: 0, objects: 0, tasks: 0, revisions: 0, projectMemberships: 0 });
    assert.deepEqual(permissions(), before, 'repeat handoff is a no-op, including versions, epoch and audit');
    assert.equal(latch(store), undefined);
    createAuth({ database: store.database, mode: 'password', basePath: '/' });
    assert.throws(() => operator.transferLocalPolicies(alice.id), /before password authentication is activated/);
    assert.deepEqual(permissions(), before);
  } finally { store.close(); }
});

test('transfer-local command reports the chosen account and counts without activating sign-in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-policy-transfer-'));
  const path = join(directory, 'workspace.sqlite');
  const store = new Store({ path });
  try {
    const operator = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
    const account = await operator.createAccount({ username: 'alice', displayName: 'Alice', password });
    const identity = operator.authenticate(request).principalId;
    const policies = new PolicyStore(store.database, { principalExists: id => [identity, account.id].includes(id) });
    const space = policies.createSpace({ name: 'CLI handoff' }, identity);
    const ownedTask = store.createTask({ title: 'CLI ownership handoff', ownerId: identity });
    const ownedRevision = store.createRevision({ kind: 'paper', title: 'CLI revision handoff', files: [{ path: 'paper.tex', content: 'Exact original source' }] }, { principalId: identity, displayName: 'You', credentialId: null, requestId: 'local-create' });
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/accounts.ts', import.meta.url)), ...args], { env: { ...process.env, DATABASE_PATH: path }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', reject); child.on('close', code => resolveRun({ code, stdout, stderr }));
    });
    assert.equal((await run(['transfer-local', 'missing'])).code, 1);
    const result = await run(['transfer-local', 'ALICE']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Transferred local-only grants to alice \([a-f0-9-]+\): 1 Space\(s\), 0 object\(s\), 1 task owner\(s\)/);
    assert.match(result.stdout, /1 revision owner\(s\)/);
    assert.match(result.stdout, /Password authentication remains inactive/);
    assert.equal(latch(store), undefined);
    assert.deepEqual(policies.getSpace(space.id, account.id).view, selected(account.id));
    assert.equal(store.taskDetail(ownedTask.id).task.ownerId, account.id);
    assert.equal(store.revisionAuthorship.state(ownedRevision.revision.id).author?.principalId, account.id);
    assert.equal(store.revisionAuthorship.state(ownedRevision.revision.id).originalAuthor?.principalId, identity);
    const repeat = await run(['transfer-local', 'alice']);
    assert.equal(repeat.code, 0, repeat.stderr); assert.match(repeat.stdout, /0 Space\(s\), 0 object\(s\)/);
    createAuth({ database: store.database, mode: 'password', basePath: '/' });
    const activated = await run(['transfer-local', 'alice']);
    assert.equal(activated.code, 1); assert.match(activated.stderr, /before password authentication is activated/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('every explicit local Space and object grant blocks transition, without false matches on descriptive text', async () => {
  const store = new Store({ path: ':memory:' });
  try {
    const local = createAuth({ database: store.database, mode: 'local', basePath: '/' });
    const identity = local.authenticate(request).principalId;
    const account = await local.createAccount({ username: 'alice', displayName: 'Alice', password });
    const policies = new PolicyStore(store.database, { principalExists: id => id === identity || id === account.id });
    const task = store.createTask({ title: 'Policy activation test' });
    const policy = policies.policy(task.id, identity);
    const sharedSpace = policies.getSpace('S1', identity);
    for (const field of ['view', 'edit', 'interact'] as const) {
      const restricted = { ...policy, rules: { ...policy.rules, [field]: selected(identity, account.id) } };
      store.database.prepare('UPDATE object_policies SET data = ? WHERE object_id = ?').run(JSON.stringify(restricted), task.id);
      assert.throws(() => createAuth({ database: store.database, mode: 'password', basePath: '/' }), /local-only principal/, field);
      assert.equal(latch(store), undefined);
      store.database.prepare('UPDATE object_policies SET data = ? WHERE object_id = ?').run(JSON.stringify(policy), task.id);
    }
    for (const field of ['view', 'edit'] as const) {
      const restricted = { ...sharedSpace, [field]: selected(identity, account.id) };
      store.database.prepare('UPDATE policy_spaces SET data = ? WHERE id = ?').run(JSON.stringify(restricted), 'S1');
      assert.throws(() => createAuth({ database: store.database, mode: 'password', basePath: '/' }), /local-only principal/, `Space ${field}`);
      assert.equal(latch(store), undefined);
      store.database.prepare('UPDATE policy_spaces SET data = ? WHERE id = ?').run(JSON.stringify(sharedSpace), 'S1');
    }
    const project = store.createProject({ name: 'Join-only local grant' });
    const projectPolicy = policies.configureNew(project.id, { spaceId: 'S1', join: selected(identity) }, identity);
    assert.throws(() => createAuth({ database: store.database, mode: 'password', basePath: '/' }), /policies reference the local-only principal/);
    assert.equal(latch(store), undefined);
    policies.setPolicy(project.id, { expectedVersion: projectPolicy.version, spaceId: 'S1', view: workspace, edit: workspace, interact: workspace, join: workspace }, identity);
    policies.updateSpace('S1', { expectedVersion: 1, description: `A historical note mentioning ${identity}.`, view: workspace, edit: workspace }, identity);
    createAuth({ database: store.database, mode: 'password', basePath: '/' });
    assert.ok(latch(store), 'descriptions are not policy grants');

    // A previously activated workspace must remain usable when dormant legacy
    // identities remain in a rule; account access is still evaluated normally.
    const historical = { ...policy, rules: { ...policy.rules, interact: selected(identity, account.id) } };
    store.database.prepare('UPDATE object_policies SET data = ? WHERE object_id = ?').run(JSON.stringify(historical), task.id);
    assert.doesNotThrow(() => createAuth({ database: store.database, mode: 'password', basePath: '/' }));
  } finally { store.close(); }
});

test('local revision ownership requires explicit terminal handoff and preserves source evidence atomically', async () => {
  const store = new Store({ path: ':memory:' });
  try {
    const ordinary = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
    const identity = ordinary.authenticate(request).principalId;
    const alice = await ordinary.createAccount({ username: 'alice', displayName: 'Alice', password });
    const policies = new PolicyStore(store.database, { principalExists: id => [identity, alice.id].includes(id) });
    const attribution = { principalId: identity, displayName: 'You', credentialId: null, requestId: 'local-author' };
    const revisions = (['paper', 'document'] as const).map(kind => store.createRevision({ kind, title: 'An owner-only manuscript', files: [{ path: 'draft.txt', content: `Exact ${kind} source` }] }, attribution));
    for (const detail of revisions) policies.configureNew(detail.revision.id, { spaceId: 'S1', view: workspace, edit: selected(), interact: selected() }, identity);
    store.saveReview(revisions[0]!.revision.id, 1, { provider: 'local', model: 'fixture', summary: 'Historical evidence', findings: [] }, attribution);
    lifecycleAction(store, revisions[0]!.revision.id, 'accept_reviewed', attribution);
    closeRevision(store, revisions[1]!.revision.id, attribution);
    assert.equal(policies.access(revisions[0]!.revision.id, identity).edit, true);
    assert.equal(policies.access(revisions[0]!.revision.id, alice.id).edit, false);
    assert.throws(() => createAuth({ database: store.database, mode: 'password', basePath: '/' }), /revision ownership references the local-only principal/);
    assert.equal(latch(store), undefined);
    // This unrelated grant proves the ownership failure rolls back prior policy changes too.
    policies.createSpace({ name: 'Local grant before ownership transfer' }, identity);
    const tables = ['entities', 'versions', 'reviews', 'revision_authorship', 'revision_author_transactions', 'revision_author_operations', 'policy_spaces', 'object_policies', 'policy_meta', 'activity'];
    const snapshot = () => tables.map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const source = () => ['entities', 'versions', 'reviews'].map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot(), originalSource = source();
    assert.throws(() => ordinary.transferLocalPolicies(alice.id), /Revision ownership transfer requires the current accounts command/);
    assert.deepEqual(snapshot(), before);
    const operator = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true, transferRevisionAuthors: (from, to, actor) => store.transferLocalRevisionAuthors(from, to, actor) });
    operator.setAccountDisabled(alice.id, true);
    assert.throws(() => operator.transferLocalPolicies(alice.id), /Active account not found/);
    assert.deepEqual(snapshot(), before); operator.setAccountDisabled(alice.id, false);
    const lastId = revisions.map(detail => detail.revision.id).sort().at(-1)!;
    store.database.exec(`CREATE TRIGGER reject_revision_transfer BEFORE INSERT ON revision_author_operations WHEN NEW.revision_id = '${lastId}' BEGIN SELECT RAISE(ABORT, 'Injected revision ownership failure'); END;`);
    assert.throws(() => operator.transferLocalPolicies(alice.id), /Injected revision ownership failure/);
    assert.deepEqual(snapshot(), before, 'second ownership failure rolls back first ownership, policy and epoch changes');
    store.database.exec('DROP TRIGGER reject_revision_transfer');
    const epoch = policies.epoch(), result = operator.transferLocalPolicies(alice.id);
    assert.deepEqual(result, { account: alice, spaces: 1, objects: 0, tasks: 0, revisions: 2, projectMemberships: 0 });
    assert.equal(policies.epoch(), epoch + 3, 'each ownership transition and the policy batch advance authority');
    assert.deepEqual(source(), originalSource, 'source, status, original attribution and review evidence are unchanged');
    for (const detail of revisions) {
      const authorship = store.revisionAuthorship.state(detail.revision.id);
      assert.equal(authorship.version, 1); assert.deepEqual(authorship.author, { principalId: alice.id, displayName: 'Alice' });
      assert.deepEqual(authorship.originalAuthor, { principalId: identity, displayName: 'You' });
      const transfer = store.revisionAuthorship.history(detail.revision.id).transactions[0]!;
      assert.equal(transfer.attribution.principalId, `operator:${operator.workspaceId}`);
      assert.equal(transfer.previousAuthor?.principalId, identity);
      assert.deepEqual(store.revisionAuthorship.operation(transfer.operationId).receipt.transaction, transfer);
      assert.equal(policies.access(detail.revision.id, alice.id).edit, true);
      assert.equal(policies.access(detail.revision.id, identity).edit, false);
      assert.equal(policies.access(detail.revision.id, alice.id).interact, false);
    }
    const transferred = snapshot(); assert.equal(operator.transferLocalPolicies(alice.id).revisions, 0);
    assert.deepEqual(snapshot(), transferred, 'repeat handoff creates no ownership history or epoch changes');
    createAuth({ database: store.database, mode: 'password', basePath: '/' }); assert.ok(latch(store));
    assert.throws(() => operator.transferLocalPolicies(alice.id), /before password authentication is activated/);
  } finally { store.close(); }
});

test('local task ownership blocks password activation and terminal transfer preserves author, subscriptions and prior history atomically', async () => {
  const store = new Store({ path: ':memory:' });
  try {
    const ordinary = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
    const identity = ordinary.authenticate(request).principalId;
    const alice = await ordinary.createAccount({ username: 'alice', displayName: 'Alice', password });
    const policies = new PolicyStore(store.database, { principalExists: id => [identity, alice.id].includes(id) });
    const attribution = { principalId: identity, displayName: 'You', credentialId: null, requestId: 'local-author' };
    const task = store.createTask({ title: 'An owner-only task', ownerId: identity }, attribution);
    const noOne = selected();
    policies.configureNew(task.id, { spaceId: 'S1', view: noOne, edit: noOne, interact: noOne }, identity);
    assert.equal(policies.access(task.id, identity).edit, true);
    assert.equal(policies.access(task.id, alice.id).view, false);
    assert.throws(() => createAuth({ database: store.database, mode: 'password', basePath: '/' }), /task ownership references the local-only principal/);
    assert.equal(latch(store), undefined);
    const space = policies.createSpace({ name: 'Also transfer this Space' }, identity);
    const tables = ['entities', 'policy_spaces', 'object_policies', 'policy_meta', 'task_transactions', 'task_subscriptions', 'activity'];
    const snapshot = () => tables.map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    assert.throws(() => ordinary.transferLocalPolicies(alice.id), /current accounts command/);
    assert.deepEqual(snapshot(), before, 'a missing owner-transfer integration must roll back policy edits');
    const operator = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true, transferTaskOwners: (from, to, actor) => store.transferTaskOwners(from, to, actor) });
    store.database.exec("CREATE TRIGGER reject_owner_transfer BEFORE INSERT ON task_transactions WHEN json_extract(NEW.data, '$.attribution.principalId') LIKE 'operator:%' BEGIN SELECT RAISE(ABORT, 'Injected ownership audit failure'); END;");
    assert.throws(() => operator.transferLocalPolicies(alice.id), /Injected ownership audit failure/);
    assert.deepEqual(snapshot(), before, 'ownership, policy changes, membership and evidence share one transaction');
    store.database.exec('DROP TRIGGER reject_owner_transfer');
    const oldHistory = store.database.prepare('SELECT * FROM task_transactions ORDER BY rowid').all();
    const oldSubscriptions = store.database.prepare('SELECT * FROM task_subscriptions ORDER BY rowid').all();
    const result = operator.transferLocalPolicies(alice.id);
    assert.deepEqual(result, { account: alice, spaces: 1, objects: 0, tasks: 1, revisions: 0, projectMemberships: 0 });
    const current = store.taskDetail(task.id).task;
    assert.equal(current.ownerId, alice.id); assert.equal(current.authorId, identity);
    assert.equal(current.version, task.version + 1);
    assert.deepEqual(store.database.prepare('SELECT * FROM task_subscriptions ORDER BY rowid').all(), oldSubscriptions, 'existing personal preferences are not transferred');
    assert.deepEqual(store.database.prepare('SELECT * FROM task_transactions ORDER BY rowid LIMIT ?').all(oldHistory.length), oldHistory);
    const ownerEdit = store.taskHistory(task.id).transactions.find(item => item.kind === 'edit')!;
    assert.deepEqual(ownerEdit.changes, [{ field: 'ownerId', oldValue: identity, newValue: alice.id }]);
    assert.equal(ownerEdit.attribution?.principalId, `operator:${operator.workspaceId}`);
    assert.equal(policies.access(task.id, alice.id).edit, true);
    assert.equal(policies.access(task.id, identity).view, false);
    assert.deepEqual(policies.getSpace(space.id, alice.id).view, selected(alice.id));
    const transferred = snapshot();
    assert.deepEqual(operator.transferLocalPolicies(alice.id), { account: alice, spaces: 0, objects: 0, tasks: 0, revisions: 0, projectMemberships: 0 });
    assert.deepEqual(snapshot(), transferred);
    createAuth({ database: store.database, mode: 'password', basePath: '/' });
    assert.ok(latch(store));
    assert.equal((store.database.prepare("SELECT json_extract(data, '$.authorId') AS author FROM entities WHERE id = ?").get(task.id) as { author: string }).author, identity);
  } finally { store.close(); }
});

test('local project join grants and active membership require an explicit atomic handoff while watcher and silence evidence stays historical', async () => {
  const store = new Store({ path: ':memory:' });
  try {
    const ordinary = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
    const local = ordinary.authenticate(request).principalId;
    const alice = await ordinary.createAccount({ username: 'alice', displayName: 'Alice', password });
    const actor = { principalId: local, displayName: 'You', credentialId: null, requestId: 'local-project' };
    const policies = new PolicyStore(store.database, { principalExists: id => [local, alice.id].includes(id) });
    const project = store.createProject({ name: 'Portable project', memberIds: [local] }, actor);
    policies.configureNew(project.id, { spaceId: 'S1', view: { kind: 'project-members' }, edit: { kind: 'project-members' }, join: selected(local) }, local);
    store.updateProjectWatcher(project.id, { principalId: local, action: 'watch', expectedVersion: 0 }, actor);
    store.updateProjectSilence(project.id, { silenced: true, expectedVersion: 0 }, actor);
    assert.throws(() => createAuth({ database: store.database, mode: 'password', basePath: '/' }), /project membership references the local-only principal/);
    const tables = ['object_policies', 'policy_meta', 'project_profiles', 'project_relations', 'project_transactions', 'project_preference_events', 'activity'];
    const snapshot = () => tables.map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    assert.throws(() => ordinary.transferLocalPolicies(alice.id), /current accounts command/); assert.deepEqual(snapshot(), before);
    const operator = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true, transferLocalProjectMemberships: (from, to, attribution) => store.transferLocalProjectMemberships(from, to, attribution) });
    store.database.exec("CREATE TRIGGER reject_project_transfer BEFORE INSERT ON project_transactions WHEN json_extract(NEW.data, '$.attribution.principalId') LIKE 'operator:%' BEGIN SELECT RAISE(ABORT, 'Injected project transfer failure'); END;");
    assert.throws(() => operator.transferLocalPolicies(alice.id), /Injected project transfer failure/); assert.deepEqual(snapshot(), before); store.database.exec('DROP TRIGGER reject_project_transfer');
    const result = operator.transferLocalPolicies(alice.id); assert.equal(result.objects, 1); assert.equal(result.projectMemberships, 1); assert.equal(latch(store), undefined);
    const policy = policies.policy(project.id, alice.id); assert.equal(policy.kind, 'project'); if (policy.kind !== 'project') throw new Error('Expected project policy');
    assert.deepEqual(policy.rules.join, selected(alice.id)); assert.equal(policies.access(project.id, alice.id).edit, true); assert.equal(policies.access(project.id, local).view, false);
    assert.equal(store.projectPreferences(project.id, local).membership.active, false); assert.equal(store.projectPreferences(project.id, alice.id).membership.active, true);
    assert.equal(store.projectPreferences(project.id, local).watching.active, true); assert.equal(store.projectPreferences(project.id, local).silence.active, true); assert.equal(store.projectPreferences(project.id, alice.id).watching.active, false);
    const transferred = snapshot(); assert.equal(operator.transferLocalPolicies(alice.id).projectMemberships, 0); assert.deepEqual(snapshot(), transferred);
    createAuth({ database: store.database, mode: 'password', basePath: '/' }); assert.ok(latch(store));
  } finally { store.close(); }
});

test('local hierarchy handoff transfers leaf memberships atomically and preserves derived ancestor and milestone authority', async () => {
  const store = new Store({ path: ':memory:' });
  try {
    const operator = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true, transferLocalProjectMemberships: (from, to, attribution) => store.transferLocalProjectMemberships(from, to, attribution) });
    const local = operator.authenticate(request).principalId;
    const alice = await operator.createAccount({ username: 'alice', displayName: 'Alice', password });
    const actor = { principalId: local, displayName: 'You', credentialId: null, requestId: 'local-hierarchy' };
    const policies = new PolicyStore(store.database, { principalExists: id => [local, alice.id].includes(id) });
    const members = { kind: 'project-members' } as const;
    const parent = store.createProject({ name: 'Local hierarchy parent', memberIds: [local] }, actor);
    policies.configureNew(parent.id, { spaceId: 'S1', view: members, edit: members, join: selected(local) }, local);
    const child = (parentId: string, name: string, kind: 'project' | 'milestone') => {
      const preview = store.projectChildPreview(parentId, kind);
      const created = store.createProject({ parentId, name, kind, expectedParentVersion: preview.expectedParentVersion, expectedHierarchyVersion: preview.expectedHierarchyVersion, expectedParentMembersVersion: preview.expectedParentMembersVersion, confirmMembershipConversion: preview.conversionRequired }, actor);
      policies.configureNew(created.id, undefined, local); return created;
    };
    const milestone = child(parent.id, 'Local milestone', 'milestone');
    const middle = child(parent.id, 'Local middle', 'project');
    const leaf = child(middle.id, 'Local leaf', 'project');
    assert.throws(() => createAuth({ database: store.database, mode: 'password', basePath: '/' }), /project membership references the local-only principal/);
    const tables = ['object_policies', 'policy_meta', 'project_profiles', 'project_hierarchy', 'project_relations', 'project_transactions', 'project_preference_events', 'activity'];
    const snapshot = () => tables.map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    store.database.exec("CREATE TRIGGER reject_hierarchy_transfer BEFORE INSERT ON project_transactions WHEN json_extract(NEW.data, '$.attribution.principalId') LIKE 'operator:%' BEGIN SELECT RAISE(ABORT, 'Injected hierarchy transfer failure'); END;");
    assert.throws(() => operator.transferLocalPolicies(alice.id), /Injected hierarchy transfer failure/); assert.deepEqual(snapshot(), before); store.database.exec('DROP TRIGGER reject_hierarchy_transfer');
    const epoch = policies.epoch(); const transferred = operator.transferLocalPolicies(alice.id);
    assert.equal(transferred.projectMemberships, 1, 'only the leaf has a direct grant to transfer'); assert.ok(policies.epoch() > epoch);
    for (const project of [parent, milestone, middle, leaf]) {
      assert.equal(store.projectPreferences(project.id, alice.id).membership.active, true);
      assert.equal(store.projectPreferences(project.id, local).membership.active, false);
      assert.equal(policies.access(project.id, alice.id).edit, true);
      assert.equal(policies.access(project.id, local).view, false);
    }
    assert.equal(store.projectPreferences(parent.id, alice.id).membership.version, null);
    assert.deepEqual(store.projectPreferences(milestone.id, alice.id).membership.sourceProjectIds, [leaf.id]);
    createAuth({ database: store.database, mode: 'password', basePath: '/' }); assert.ok(latch(store));
  } finally { store.close(); }
});
