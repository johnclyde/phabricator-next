import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import type { WorkboardDetail, WorkboardReceipt } from '../shared/workboards.ts';

const cli = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
function runCommand(cwd: string, args: string[], token?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, cli, ...args], { cwd, env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
const run = (cwd: string, paths: string[]) => runCommand(cwd, ['check', '--kind', 'document', '--json', '--server', 'https://network-access-is-not-needed.invalid', ...paths]);

test('CLI checks regular Unicode source names offline and validates path limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-'));
  try {
    await writeFile(join(root, 'résumé-研究.md'), '# Argument\nA complete draft.');
    const valid = await run(root, ['résumé-研究.md']);
    assert.equal(valid.code, 0, valid.stderr); assert.equal(JSON.parse(valid.stdout).provider, 'local');
    const directoryName = 'a'.repeat(120); await mkdir(join(root, directoryName));
    const longFile = `${'b'.repeat(120)}.md`; await writeFile(join(root, directoryName, longFile), 'Draft');
    const long = await run(root, [`${directoryName}/${longFile}`]);
    assert.equal(long.code, 1); assert.match(long.stderr, /240 characters/);
    const duplicate = await run(root, ['résumé-研究.md', './résumé-研究.md']);
    assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /unique paths/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI rejects file and directory symlinks before reading outside or credential sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-boundary-')); const workspace = join(root, 'workspace');
  try {
    await mkdir(workspace); await mkdir(join(root, 'outside')); await mkdir(join(workspace, '.aws'));
    await writeFile(join(root, 'outside', 'private.md'), 'DO-NOT-DISCLOSE-OUTSIDE');
    await writeFile(join(workspace, '.env'), 'DO-NOT-DISCLOSE-ENV');
    await writeFile(join(workspace, '.aws', 'credentials'), 'DO-NOT-DISCLOSE-CREDENTIALS');
    await writeFile(join(workspace, 'allowed.md'), 'Allowed draft');
    await symlink(join(root, 'outside', 'private.md'), join(workspace, 'outside.md'));
    await symlink(join(root, 'outside'), join(workspace, 'directory'));
    await symlink(join(workspace, '.env'), join(workspace, 'innocent.md'));
    await symlink(join(workspace, '.aws'), join(workspace, 'configuration'));
    await symlink(join(workspace, 'allowed.md'), join(workspace, 'allowed-alias.md'));
    for (const path of ['outside.md', 'directory/private.md', 'innocent.md', 'configuration/credentials', 'allowed-alias.md']) {
      const result = await run(workspace, [path]);
      assert.equal(result.code, 1, path); assert.match(result.stderr, /Symbolic links cannot be submitted/);
      assert.ok(!`${result.stdout}${result.stderr}`.includes('DO-NOT-DISCLOSE'));
    }
    for (const path of ['../outside/private.md', '.env', '.aws/credentials']) {
      const result = await run(workspace, [path]); assert.equal(result.code, 1, path);
      assert.ok(!`${result.stdout}${result.stderr}`.includes('DO-NOT-DISCLOSE'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI refuses binary, invalid UTF-8, and oversized source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-content-'));
  try {
    await writeFile(join(root, 'binary.md'), Buffer.from([97, 0, 98]));
    await writeFile(join(root, 'encoding.md'), Buffer.from([0xc0, 0xaf]));
    await writeFile(join(root, 'large.md'), 'x'.repeat(500_001));
    for (const path of ['binary.md', 'encoding.md', 'large.md']) assert.equal((await run(root, [path])).code, 1, path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI preserves a server mount for every API command and its printed revision link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-mount-'));
  const app = createApp({ databasePath: ':memory:', seed: false, basePath: '/tools/workspace/' });
  const requested: string[] = [];
  app.server.prependListener('request', req => requested.push(`${req.method} ${req.url}`));
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/tools/workspace`;
  try {
    await writeFile(join(root, 'draft.md'), '# Draft\nA complete initial argument.');
    const created = await runCommand(root, ['diff', '--server', server, '--title', 'Mounted revision', '--kind', 'document', 'draft.md']);
    assert.equal(created.code, 0, created.stderr); assert.match(created.stdout, /L1 · v1/);
    assert.ok(created.stdout.includes(`${server}/#L1`), created.stdout);
    await writeFile(join(root, 'draft.md'), '# Draft\nA revised complete argument.');
    const updated = await runCommand(root, ['diff', '--server', `${server}/`, '--revision', 'L1', 'draft.md']);
    assert.equal(updated.code, 0, updated.stderr); assert.match(updated.stdout, /L1 · v2/);
    for (const args of [['list'], ['show', 'L1'], ['review', 'L1'], ['export', 'L1', '--version', '1']]) {
      const result = await runCommand(root, [...args, '--server', `${server}/`]);
      assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
      if (args[0] === 'export') assert.equal(JSON.parse(result.stdout).version.number, 1);
    }
    assert.deepEqual(requested, [
      'POST /tools/workspace/api/revisions',
      'GET /tools/workspace/api/revisions/L1',
      'POST /tools/workspace/api/revisions/L1/versions',
      'GET /tools/workspace/api/state',
      'GET /tools/workspace/api/revisions/L1',
      'GET /tools/workspace/api/revisions/L1',
      'POST /tools/workspace/api/revisions/L1/reviews',
      'GET /tools/workspace/api/revisions/L1',
      'GET /tools/workspace/api/revisions/L1/export?version=1',
    ]);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('CLI rejects ambiguous server URLs before sending requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-server-url-'));
  try {
    for (const suffix of ['?token=private', '#revision', '?', '#', '/path/../', '/path/%2e%2e/', '/path//', '/path\\escape']) {
      const result = await runCommand(root, ['list', '--server', `http://127.0.0.1:1${suffix}`]);
      assert.equal(result.code, 1, suffix);
      assert.match(result.stderr, /APP_BASE_PATH|HTTP\(S\) server URL/, suffix);
      assert.doesNotMatch(result.stderr, /fetch failed/, suffix);
    }
    const credentials = await runCommand(root, ['list', '--server', 'http://user:private@127.0.0.1:1/workspace']);
    assert.equal(credentials.code, 1); assert.match(credentials.stderr, /without embedded credentials/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI task reads preserve mounts, filters and current object visibility with a read-only token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-tasks-'));
  const store = createStore({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'test-only-task-cli-password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'test-only-task-cli-password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath: '/tools/tasks/' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/tools/tasks/`;
  const token = app.auth.createToken(bob.id, { name: 'Task read fixture', scopes: ['read'] });
  try {
    const normal = store.createTask({ title: 'A visible normal task', priority: 'normal', ownerId: bob.id });
    const urgent = store.createTask({ title: 'A visible urgent task', priority: 'urgent', status: 'in_progress', ownerId: bob.id });
    const closed = store.createTask({ title: 'A resolved task', status: 'resolved', ownerId: bob.id });
    const hidden = store.createTask({ title: 'Private task marker' });
    app.policies.configureNew(hidden.id, { spaceId: 'S1', view: { kind: 'principals', principalIds: [alice.id] } }, alice.id);
    store.updateTaskDependencies(normal.id, { taskId: hidden.id, action: 'add', expectedVersion: normal.version });
    // Distinct fixture timestamps make each sort mode observable without sleeps.
    for (const [id, createdAt, updatedAt] of [[normal.id, '2024-01-01', '2027-01-01'], [urgent.id, '2026-01-01', '2025-01-01'], [closed.id, '2025-01-01', '2026-01-01']]) {
      store.database.prepare("UPDATE entities SET data = json_set(data, '$.createdAt', ?, '$.updatedAt', ?) WHERE id = ?").run(createdAt!, updatedAt!, id!);
    }
    const read = (args: string[]) => runCommand(root, [...args, '--server', server], token.token);
    const open = await read(['tasks', '--json']);
    assert.equal(open.code, 0, open.stderr); assert.deepEqual(JSON.parse(open.stdout).map((task: { id: string }) => task.id), [urgent.id, normal.id]);
    const resolved = await read(['tasks', '--status', 'closed', '--json']);
    assert.equal(resolved.code, 0, resolved.stderr); assert.deepEqual(JSON.parse(resolved.stdout).map((task: { id: string }) => task.id), [closed.id]);
    const limited = await read(['tasks', '--status', 'all', '--order', 'priority', '--limit', '1', '--json']);
    assert.equal(limited.code, 0, limited.stderr); assert.equal(JSON.parse(limited.stdout)[0].id, urgent.id);
    const newest = await read(['tasks', '--status', 'all', '--order', 'created', '--json']);
    assert.equal(newest.code, 0, newest.stderr); assert.deepEqual(JSON.parse(newest.stdout).map((task: { id: string }) => task.id), [urgent.id, closed.id, normal.id]);
    const modified = await read(['tasks', '--status', 'all', '--order', 'modified', '--json']);
    assert.equal(modified.code, 0, modified.stderr); assert.deepEqual(JSON.parse(modified.stdout).map((task: { id: string }) => task.id), [normal.id, closed.id, urgent.id]);
    const shown = await read(['show', normal.id]);
    assert.equal(shown.code, 0, shown.stderr); const detail = JSON.parse(shown.stdout);
    assert.equal(detail.task.id, normal.id); assert.equal(detail.task.version, 2); assert.deepEqual(detail.dependsOn, []);
    assert.ok(!shown.stdout.includes(hidden.id)); assert.ok(!shown.stdout.includes(hidden.title));
    const denied = await read(['show', hidden.id]); assert.equal(denied.code, 1); assert.ok(!denied.stderr.includes(hidden.title));
    const unassigned = store.createTask({ title: 'An unassigned task' });
    const other = store.createTask({ title: 'Another member owns this task', ownerId: alice.id });
    const attribution = { principalId: bob.id, displayName: bob.displayName, credentialId: 'cli-fixture', requestId: 'cli-fixture' };
    store.updateTaskSubscription(other.id, { principalId: bob.id, action: 'subscribe', expectedMembershipVersion: 0 }, attribution);
    // Following a hidden task must not reveal it through the state or CLI filters.
    store.updateTaskSubscription(hidden.id, { principalId: bob.id, action: 'subscribe', expectedMembershipVersion: 0 }, attribution);
    for (const [args, ids] of [
      [['--unassigned'], [unassigned.id]],
      [['--owner', 'unassigned'], [unassigned.id]],
      [['--owner', 'ALICE'], [other.id]],
      [['--owner', 'user:alice'], [other.id]],
      [['--owner', alice.id], [other.id]],
      [['--owner', 'all', '--subscribed'], [urgent.id, normal.id, other.id]],
      [['--subscribed'], [urgent.id, normal.id]],
      [['--owner', 'all'], [urgent.id, normal.id, unassigned.id, other.id]],
    ] as [string[], string[]][]) {
      const filtered = await read(['tasks', ...args, '--json']);
      assert.equal(filtered.code, 0, filtered.stderr);
      assert.deepEqual(JSON.parse(filtered.stdout).map((task: { id: string }) => task.id), ids, args.join(' '));
      assert.ok(!filtered.stdout.includes(hidden.id)); assert.ok(!filtered.stdout.includes(hidden.title));
    }
    const duplicate = store.createTask({ title: 'A retained duplicate', ownerId: bob.id }, attribution);
    store.mergeTask(duplicate.id, { taskId: other.id, expectedVersion: duplicate.version, expectedTargetVersion: other.version }, attribution);
    const openAfterMerge = await read(['tasks', '--json']);
    assert.equal(openAfterMerge.code, 0, openAfterMerge.stderr);
    assert.deepEqual(JSON.parse(openAfterMerge.stdout).map((task: { id: string }) => task.id), [urgent.id, normal.id]);
    const closedAfterMerge = await read(['tasks', '--status', 'closed', '--json']);
    assert.equal(closedAfterMerge.code, 0, closedAfterMerge.stderr);
    assert.deepEqual(JSON.parse(closedAfterMerge.stdout).map((task: { id: string }) => task.id), [closed.id, duplicate.id]);
    const shownDuplicate = await read(['show', duplicate.id]);
    assert.equal(shownDuplicate.code, 0, shownDuplicate.stderr);
    assert.equal(JSON.parse(shownDuplicate.stdout).task.id, duplicate.id, 'the CLI retains the source task rather than following a redirect');
    assert.equal(JSON.parse(shownDuplicate.stdout).task.status, 'duplicate');
    assert.equal(JSON.parse(shownDuplicate.stdout).duplicateOf[0].id, other.id);
    const otherPolicy = app.policies.policy(other.id, alice.id);
    app.policies.setPolicy(other.id, { expectedVersion: otherPolicy.version, spaceId: otherPolicy.spaceId, view: { kind: 'principals', principalIds: [alice.id] }, edit: otherPolicy.rules.edit, interact: otherPolicy.rules.interact }, alice.id);
    const filteredDuplicate = await read(['show', duplicate.id]);
    assert.equal(filteredDuplicate.code, 0, filteredDuplicate.stderr);
    assert.deepEqual(JSON.parse(filteredDuplicate.stdout).duplicateOf, []);
    assert.ok(!filteredDuplicate.stdout.includes(other.id)); assert.ok(!filteredDuplicate.stdout.includes(other.title));
    const writing = store.createProject({ name: 'Paper writing' });
    const citations = store.createProject({ name: 'Citation checks' });
    const secretProject = store.createProject({ name: 'Private project marker' });
    app.policies.configureNew(secretProject.id, { spaceId: 'S1', view: { kind: 'principals', principalIds: [alice.id] } }, alice.id);
    for (const [taskId, projectIds] of [[normal.id, [writing.id, citations.id, secretProject.id]], [urgent.id, [writing.id]], [hidden.id, [writing.id, citations.id]]] as [string, string[]][]) {
      store.updateTaskProjects(taskId, { action: 'set', projectIds, expectedVersion: store.taskDetail(taskId).task.version }, attribution);
    }
    for (const [filters, expected] of [
      [['--project', writing.id], [urgent.id, normal.id]],
      [['--project', 'PAPER WRITING'], [urgent.id, normal.id]],
      [['--project', '#paper_writing'], [urgent.id, normal.id]],
      [['--project', writing.id, '--project', citations.id], [normal.id]],
      [['--project', citations.name], [normal.id]],
      [['--project', writing.id, '--project', writing.id], [urgent.id, normal.id]],
    ] as [string[], string[]][]) {
      const filtered = await read(['tasks', '--owner', 'all', ...filters, '--json']);
      assert.equal(filtered.code, 0, filtered.stderr);
      assert.deepEqual(JSON.parse(filtered.stdout).map((task: { id: string }) => task.id), expected);
      assert.ok(!filtered.stdout.includes(secretProject.id)); assert.ok(!filtered.stdout.includes(secretProject.name));
      assert.ok(!filtered.stdout.includes(hidden.id)); assert.ok(!filtered.stdout.includes(hidden.title));
    }
    const tagged = await read(['show', normal.id]);
    assert.equal(tagged.code, 0, tagged.stderr);
    assert.deepEqual(JSON.parse(tagged.stdout).task.projectIds, [writing.id, citations.id].sort());
    assert.equal(JSON.parse(tagged.stdout).task.projectId, undefined);
    assert.ok(!tagged.stdout.includes(secretProject.id)); assert.ok(!tagged.stdout.includes(secretProject.name));
    const hiddenProjectFilter = await read(['tasks', '--project', secretProject.id]);
    const missingProjectFilter = await read(['tasks', '--project', 'PROJ99999']);
    assert.equal(hiddenProjectFilter.code, 1); assert.equal(hiddenProjectFilter.stderr, missingProjectFilter.stderr);
    const ambiguousLegacyProject = store.createProject({ name: 'Legacy citation project' });
    store.database.prepare("UPDATE project_profiles SET data = json_set(data, '$.name', ?) WHERE project_id = ?").run(citations.name, ambiguousLegacyProject.id);
    const ambiguousProject = await read(['tasks', '--project', citations.name]);
    assert.equal(ambiguousProject.code, 1); assert.match(ambiguousProject.stderr, /ambiguous/);
    for (const args of [['tasks', '--status', 'invalid'], ['tasks', '--order', 'invalid'], ['tasks', '--limit', '0'], ['tasks', '--limit', '1.5'], ['tasks', '--unassigned', '--owner', 'all'], ['tasks', '--owner', 'missing-user']]) {
      const invalid = await read(args); assert.equal(invalid.code, 1, args.join(' '));
    }
    for (const output of [open, resolved, limited, shown, denied]) assert.ok(!`${output.stdout}${output.stderr}`.includes(token.token));
  } finally { await app.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('CLI project reads preserve mounts, membership filters and private profiles with a read-only token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-projects-'));
  const store = createStore({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'test-only-project-cli-password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'test-only-project-cli-password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath: '/tools/projects/' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/tools/projects/`;
  const token = app.auth.createToken(bob.id, { name: 'Project read fixture', scopes: ['read'] });
  const attribution = { principalId: bob.id, displayName: bob.displayName, credentialId: 'cli-fixture', requestId: 'cli-fixture' };
  const paths: string[] = [];
  app.server.prependListener('request', req => paths.push(req.url || ''));
  try {
    const alpha = store.createProject({ name: 'Alpha research', aliases: ['research-notes'], memberIds: [bob.id] });
    const beta = store.createProject({ name: 'Beta writing' });
    const archived = store.createProject({ name: 'Archived study', memberIds: [bob.id] });
    const hidden = store.createProject({ name: 'Hidden project marker' });
    store.updateProject(archived.id, { status: 'archived', expectedVersion: archived.version }, attribution);
    store.updateProjectWatcher(alpha.id, { principalId: bob.id, action: 'watch', expectedVersion: 0 }, attribution);
    store.updateProjectWatcher(beta.id, { principalId: bob.id, action: 'watch', expectedVersion: 0 }, attribution);
    store.updateProjectWatcher(hidden.id, { principalId: bob.id, action: 'watch', expectedVersion: 0 }, attribution);
    app.policies.configureNew(hidden.id, { spaceId: 'S1', view: { kind: 'principals', principalIds: [alice.id] } }, alice.id);
    const read = (args: string[]) => runCommand(root, [...args, '--server', server], token.token);
    for (const [filters, expected] of [
      [[], [alpha.id, beta.id]], [['--joined'], [alpha.id]], [['--watching'], [alpha.id, beta.id]],
      [['--joined', '--watching'], [alpha.id]], [['--joined', '--status', 'all'], [alpha.id, archived.id]],
      [['--status', 'archived'], [archived.id]], [['--status', 'all', '--limit', '1'], [alpha.id]],
    ] as [string[], string[]][]) {
      const result = await read(['projects', ...filters, '--json']);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).map((project: { id: string }) => project.id), expected, filters.join(' '));
      assert.ok(!result.stdout.includes(hidden.id)); assert.ok(!result.stdout.includes(hidden.name));
      assert.ok(!`${result.stdout}${result.stderr}`.includes(token.token));
    }
    const shown = await read(['show', alpha.id]);
    assert.equal(shown.code, 0, shown.stderr);
    const detail = JSON.parse(shown.stdout);
    assert.equal(detail.project.id, alpha.id); assert.equal(detail.project.primarySlug, 'alpha_research');
    assert.deepEqual(detail.project.aliases, ['research-notes']);
    assert.equal(detail.viewer.membership.active, true); assert.equal(detail.viewer.watching.active, true);
    assert.equal(detail.history.transactions.at(-1).kind, 'create');
    const denied = await read(['show', hidden.id]); const missing = await read(['show', 'PROJ99999']);
    assert.equal(denied.code, 1); assert.equal(denied.stderr, missing.stderr);
    for (const args of [['projects', '--status', 'open'], ['projects', '--limit', '0'], ['projects', '--limit', '1.5'], ['projects', alpha.id]]) assert.equal((await read(args)).code, 1);
    assert.ok(paths.length > 0); assert.ok(paths.every(path => path.startsWith('/tools/projects/api/')));
  } finally { await app.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('CLI project filters include visible descendants and distinguish milestone display names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-hierarchy-'));
  const store = createStore({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'test-only-hierarchy-cli-password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'test-only-hierarchy-cli-password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath: '/workspace/' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/workspace/`;
  const token = app.auth.createToken(bob.id, { name: 'Hierarchy CLI read', scopes: ['read'] });
  const read = (args: string[]) => runCommand(root, [...args, '--server', server], token.token);
  const actor = { principalId: bob.id, displayName: bob.displayName, credentialId: null, requestId: 'cli-hierarchy' };
  const child = (parentId: string, name: string, kind: 'project' | 'milestone' = 'project') => {
    const preview = store.projectChildPreview(parentId, kind);
    return store.createProject({ name, kind, parentId, expectedParentVersion: preview.expectedParentVersion,
      expectedHierarchyVersion: preview.expectedHierarchyVersion, expectedParentMembersVersion: preview.expectedParentMembersVersion,
      ...(preview.conversionRequired ? { confirmMembershipConversion: true } : {}) }, actor);
  };
  try {
    const parent = store.createProject({ name: 'Research', memberIds: [bob.id] }, actor);
    const methods = child(parent.id, 'Methods'); const calibration = child(methods.id, 'Calibration');
    const milestone = child(parent.id, 'Round one', 'milestone'); const methodsMilestone = child(methods.id, 'Round one', 'milestone');
    const secret = child(parent.id, 'Hidden child marker'); const hiddenLeaf = child(secret.id, 'Hidden descendant marker');
    app.policies.configureNew(secret.id, { spaceId: 'S1', view: { kind: 'principals', principalIds: [alice.id] } }, alice.id);
    const nestedTask = store.createTask({ title: 'Calibration notes', projectIds: [calibration.id] }, actor);
    const milestoneTask = store.createTask({ title: 'First review', projectIds: [milestone.id] }, actor);
    store.createTask({ title: 'Visible task with a hidden project', projectIds: [hiddenLeaf.id] }, actor);
    store.updateProjectWatcher(parent.id, { principalId: bob.id, action: 'watch', expectedVersion: 0 }, actor);
    for (const [filters, expected] of [
      [['--project', parent.id], [nestedTask.id, milestoneTask.id]],
      [['--project', methods.id], [nestedTask.id]],
      [['--project', 'Research (Round one)'], [milestoneTask.id]],
      [['--project', parent.id, '--project', methods.id], [nestedTask.id]],
    ] as [string[], string[]][]) {
      const result = await read(['tasks', '--owner', 'all', ...filters, '--json']);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).map((task: { id: string }) => task.id), expected);
      assert.ok(!result.stdout.includes(secret.id)); assert.ok(!result.stdout.includes(hiddenLeaf.id));
    }
    const ambiguous = await read(['tasks', '--owner', 'all', '--project', 'Round one']);
    assert.equal(ambiguous.code, 1); assert.match(ambiguous.stderr, /ambiguous/);
    const projects = await read(['projects']);
    assert.equal(projects.code, 0, projects.stderr); assert.match(projects.stdout, /Research \(Round one\)/); assert.match(projects.stdout, /Methods \(Round one\)/);
    assert.ok(!projects.stdout.includes(secret.name)); assert.ok(!projects.stdout.includes(hiddenLeaf.name));
    const watching = await read(['projects', '--watching', '--json']);
    assert.equal(watching.code, 0, watching.stderr); assert.deepEqual(JSON.parse(watching.stdout).map((project: { id: string }) => project.id), [parent.id]);
    const joined = await read(['projects', '--joined', '--json']);
    assert.equal(joined.code, 0, joined.stderr);
    assert.deepEqual(new Set(JSON.parse(joined.stdout).map((project: { id: string }) => project.id)), new Set([parent.id, methods.id, calibration.id, milestone.id, methodsMilestone.id]));
    const shown = await read(['show', methodsMilestone.id]);
    assert.equal(shown.code, 0, shown.stderr);
    const detail = JSON.parse(shown.stdout);
    assert.equal(detail.project.primarySlug, null); assert.equal(detail.viewer.membership.version, null);
    assert.equal(detail.viewer.effectiveWatching, true); assert.deepEqual(detail.viewer.watchingInheritedFrom, [parent.id]);
    assert.deepEqual(detail.hierarchy.ancestors.map((project: { id: string }) => project.id), [parent.id, methods.id]);
    assert.ok(!shown.stdout.includes(secret.id)); assert.ok(!shown.stdout.includes(hiddenLeaf.id));
  } finally { await app.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('CLI workboards read all filtered pages with scoped tokens and reject concurrent layout or access changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-workboards-'));
  const store = createStore({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'test-only-board-cli-password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'test-only-board-cli-password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath: '/workspace/' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/workspace/`;
  const readToken = app.auth.createToken(bob.id, { name: 'Board CLI read', scopes: ['read'] });
  const writeToken = app.auth.createToken(bob.id, { name: 'Board fixture write', scopes: ['read', 'write'] });
  const actor = { principalId: bob.id, displayName: bob.displayName, credentialId: null, requestId: 'cli-workboard' };
  const paths: string[] = [];
  app.server.prependListener('request', req => paths.push(req.url || ''));
  const read = (args: string[]) => runCommand(root, [...args, '--server', server], readToken.token);
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(new URL(`api${path}`, server), { method, headers: { Authorization: `Bearer ${writeToken.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result: unknown = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result as T;
  };
  try {
    const project = store.createProject({ name: 'CLI research board', aliases: ['research-board'] }, actor);
    const secret = store.createProject({ name: 'Private board project marker' }, actor);
    const tasks = Array.from({ length: 105 }, (_, index) => store.createTask({ title: `Visible board card ${index}`, projectIds: [project.id, secret.id], ownerId: index % 2 === 0 ? bob.id : null }, actor));
    const closed = store.createTask({ title: 'Closed board card', status: 'resolved', projectIds: [project.id] }, actor);
    // Leave this task unassigned so Bob gets no automatic owner access.
    const hidden = store.createTask({ title: 'Private task marker', projectIds: [project.id] });
    app.policies.configureNew(hidden.id, { spaceId: 'S1', view: { kind: 'principals', principalIds: [alice.id] } }, alice.id);
    app.policies.configureNew(secret.id, { spaceId: 'S1', view: { kind: 'principals', principalIds: [alice.id] } }, alice.id);
    const path = `/projects/${project.id}/workboard`;
    await request(path, 'PUT', { enabled: true, expectedBoardVersion: 0 });
    let board = await request<WorkboardDetail>(path);
    const column = await request<WorkboardReceipt>(`${path}/columns`, 'POST', { name: 'Writing', expectedBoardVersion: board.board.version });
    board = await request<WorkboardDetail>(path);
    const writing = board.columns.find(item => item.name === 'Writing')!;
    assert.equal(column.columnId, writing.id);
    await request(`${path}/moves`, 'POST', { taskId: tasks[0]!.id, columnId: writing.id, expectedBoardVersion: board.board.version, expectedTaskVersion: tasks[0]!.version, position: { edge: 'start' } });
    const listed = await read(['board', '#research-board', '--json']);
    assert.equal(listed.code, 0, listed.stderr);
    const result = JSON.parse(listed.stdout) as WorkboardDetail;
    assert.equal(result.canEdit, false);
    assert.equal(result.columns.flatMap(item => item.cards.cards).length, 105);
    assert.ok(result.columns.every(item => item.cards.nextAfter === null && item.cards.cards.every(card => !card.canMove)));
    assert.equal(result.columns.find(item => item.name === 'Writing')!.cards.cards[0]!.id, tasks[0]!.id);
    assert.ok(paths.some(path => path.includes('/cards?') && path.includes('expectedBoardVersion=')));
    for (const value of [hidden.id, hidden.title, secret.id, secret.name, readToken.token, writeToken.token]) assert.ok(!listed.stdout.includes(value), value);
    for (const [args, count] of [[['--owner', 'me'], 53], [['--unassigned'], 52], [['--status', 'all'], 106]] as [string[], number][]) {
      const filtered = await read(['board', project.id, ...args, '--json']); assert.equal(filtered.code, 0, filtered.stderr);
      assert.equal((JSON.parse(filtered.stdout) as WorkboardDetail).columns.flatMap(item => item.cards.cards).length, count);
    }
    const limited = await read(['board', project.id, '--limit', '2', '--json']); assert.equal(limited.code, 0, limited.stderr);
    const limitedBoard = JSON.parse(limited.stdout) as WorkboardDetail;
    assert.equal(limitedBoard.columns.find(item => item.isDefault)!.cards.cards.length, 2);
    assert.notEqual(limitedBoard.columns.find(item => item.isDefault)!.cards.nextAfter, null);
    assert.ok(!(JSON.parse(listed.stdout) as WorkboardDetail).columns.flatMap(item => item.cards.cards).some(task => task.id === closed.id));
    const denied = await read(['board', secret.id]); const missing = await read(['board', 'PROJ99999']);
    assert.equal(denied.code, 1); assert.equal(denied.stderr, missing.stderr);
    for (const args of [[], [project.id, 'extra'], [project.id, '--status', 'closed'], [project.id, '--limit', '0'], [project.id, '--owner', 'me', '--unassigned']]) assert.equal((await read(['board', ...args])).code, 1);
    let change: (() => void) | null = () => { store.createTask({ title: 'Concurrent board card', projectIds: [project.id] }, actor); };
    const interrupt = (req: import('node:http').IncomingMessage) => { if (req.url?.includes('/cards?') && change) { const next = change; change = null; next(); } };
    app.server.prependListener('request', interrupt);
    try {
      const changed = await read(['board', project.id]); assert.equal(changed.code, 1); assert.equal(changed.stdout, '');
      change = () => { app.policies.configureNew(tasks[1]!.id, { spaceId: 'S1', view: { kind: 'principals', principalIds: [alice.id] } }, alice.id); };
      const revoked = await read(['board', project.id]); assert.equal(revoked.code, 1); assert.equal(revoked.stdout, '');
    } finally { app.server.removeListener('request', interrupt); }
    assert.ok(paths.every(path => path.startsWith('/workspace/api/')));
  } finally { await app.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('CLI authenticates with scoped environment tokens without following redirects or exposing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-cli-auth-'));
  const store = createStore({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const account = await provision.createAccount({ username: 'cli-user', displayName: 'CLI user', password: 'test-only-cli-long-password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath: '/workspace/' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/workspace/`;
  const read = app.auth.createToken(account.id, { name: 'CLI read fixture', scopes: ['read'] });
  const write = app.auth.createToken(account.id, { name: 'CLI write fixture', scopes: ['read', 'write', 'review:local'] });
  let redirectHits = 0;
  const redirect = createServer((_req, res) => { redirectHits++; res.writeHead(302, { Location: `${server}api/state` }); res.end(); });
  await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(join(root, 'draft.md'), '# Private draft\nAn explicit source snapshot.');
    const denied = await runCommand(root, ['diff', '--title', 'Denied', '--server', server, 'draft.md'], read.token);
    assert.equal(denied.code, 1);
    const created = await runCommand(root, ['diff', '--title', 'Authenticated CLI draft', '--server', server, 'draft.md'], write.token);
    assert.equal(created.code, 0, created.stderr);
    const shown = await runCommand(root, ['show', 'D1', '--server', server], read.token);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).versions[0].attribution.principalId, account.id);
    app.auth.revokeToken(account.id, read.record.id);
    const revoked = await runCommand(root, ['list', '--server', server], read.token);
    assert.equal(revoked.code, 1);
    const redirected = await runCommand(root, ['list', '--server', `http://127.0.0.1:${(redirect.address() as AddressInfo).port}`], write.token);
    assert.equal(redirected.code, 1); assert.equal(redirectHits, 1);
    const insecure = await runCommand(root, ['list', '--server', 'http://tokens-must-not-travel.invalid'], write.token);
    assert.equal(insecure.code, 1); assert.match(insecure.stderr, /require HTTPS/);
    for (const result of [denied, created, shown, revoked, redirected, insecure]) {
      assert.ok(!`${result.stdout}${result.stderr}`.includes(read.token));
      assert.ok(!`${result.stdout}${result.stderr}`.includes(write.token));
    }
  } finally {
    await new Promise<void>((resolve, reject) => redirect.close(error => error ? reject(error) : resolve()));
    await app.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});
