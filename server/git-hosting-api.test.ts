import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import type { GitReceiveReceipt } from '../shared/git-automation.ts';
import type { BuildPlan, Build } from '../shared/harbormaster.ts';
import type { HeraldRule, HeraldRuleInput } from '../shared/herald.ts';
import type { AuditDetail } from '../shared/audit.ts';

interface GitResult { code: number | null; stdout: Buffer; stderr: string }
function git(root: string, args: string[], input?: string | Buffer): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'credential.helper=', '-c', 'http.proxy=', ...args], {
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: root,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
        GIT_AUTHOR_NAME: 'Git HTTP Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Git HTTP Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z', LC_ALL: 'C',
      }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [], err: Buffer[] = []; let bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) child.kill('SIGKILL'); else out.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) child.kill('SIGKILL'); else err.push(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }); });
    child.stdin.on('error', () => undefined); child.stdin.end(input);
  });
}
function ok(result: GitResult): string { assert.equal(result.code, 0, result.stderr); return result.stdout.toString('utf8').trim(); }
const credential = (username: string, token: string) => `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });

async function start(basePath = '/', mode: 'host' | 'observe' = 'host') {
  const fixture = await createGitFixture(), store = new Store({ path: ':memory:' });
  const provisioner = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Gate Manager', password: 'Git hosting manager fixture password' });
  const bob = await provisioner.createAccount({ username: 'bob', displayName: 'Actual Pusher', password: 'Git hosting pusher fixture password' });
  const app = createApp({ store, seed: false, basePath, authMode: 'password', automation: { managers: ['alice'] }, repositorySyncBindings: [{ repositoryId: 'R1', path: fixture.barePath, mode, intervalSeconds: 60, mirrors: [], ...(mode === 'observe' ? { observe: { url: 'https://example.invalid/upstream.git' } } : {}) }], ...(mode === 'observe' ? { repositorySyncOptions: { transport: { sync: async () => ({ changedRefs: 0 }) } } } : {}) });
  store.createRepository({ name: 'Hosted HTTP fixture', remoteUrl: 'https://example.invalid/never-fetched.git' });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Configure rules', scopes: ['read', 'write'] }),
    bob: app.auth.createToken(bob.id, { name: 'Git push', scopes: ['read', 'write'] }),
    reader: app.auth.createToken(bob.id, { name: 'Git clone', scopes: ['read'] }),
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, url = `${origin}${basePath}git/R1.git`;
  const client = (args: string[], actor: keyof typeof tokens | null = 'bob', input?: string | Buffer) => git(fixture.root, [...(actor ? ['-c', `http.extraHeader=Authorization: ${credential(actor === 'alice' ? 'alice' : 'bob', tokens[actor].token)}`] : []), ...args], input);
  async function api<T = { error: string }>(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${origin}${basePath}${path.replace(/^\//, '')}`, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens.alice.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  function policy(patch: Record<string, unknown>) { const current = app.policies.policy('R1', alice.id); app.policies.setPolicy('R1', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...patch }, alice.id); }
  return { ...app, fixture, alice, bob, tokens, origin, url, client, api, policy, close: async () => { await app.close(); store.close(); await fixture.close(); } };
}
async function newCommit(root: string, repository: string, parent: string, label: string): Promise<string> {
  const command = (args: string[], input?: string | Buffer) => git(root, ['--git-dir', repository, ...args], input);
  const text = ok(await command(['hash-object', '-w', '--stdin'], `${label}\n`)), binary = ok(await command(['hash-object', '-w', '--stdin'], Buffer.from([0, 255, 1, 2, 42])));
  const tree = ok(await command(['mktree', '-z'], `100644 blob ${text}\tREADME.md\0` + `100644 blob ${binary}\tpayload.bin\0`));
  return ok(await command(['commit-tree', tree, '-p', parent], `${label}\n`));
}
function pushRule(patch: Partial<HeraldRuleInput> = {}): HeraldRuleInput {
  return { name: 'HTTP push gate', contentType: 'push-content', ruleType: 'global', objectId: null, enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'always', operator: 'true', value: null }], actions: [{ type: 'block-push', value: 'This push requires review.' }], ...patch };
}
function packet(line: string): Buffer { const content = Buffer.from(line); return Buffer.concat([Buffer.from((content.length + 4).toString(16).padStart(4, '0')), content]); }
async function rawReceive(app: Awaited<ReturnType<typeof start>>, ref: string, objectId: string, pack: Buffer): Promise<void> {
  const command = packet(`${'0'.repeat(40)} ${objectId} ${ref}\0report-status\n`);
  const response = await fetch(`${app.url}/git-receive-pack`, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${app.tokens.bob.token}`, 'Content-Type': 'application/x-git-receive-pack-request' }, body: Buffer.concat([command, Buffer.from('0000'), pack]) });
  await response.arrayBuffer();
}

for (const basePath of ['/', '/workspace/']) test(`real Git HTTP clone, fetch, binary push, branches and tags work at ${basePath}`, async () => {
  const app = await start(basePath);
  try {
    const clone = join(app.fixture.root, 'client.git');
    ok(await app.client(['clone', '--bare', app.url, clone], 'reader'));
    assert.equal(ok(await git(app.fixture.root, ['--git-dir', clone, 'rev-parse', 'main'])), app.fixture.head);
    const next = await newCommit(app.fixture.root, clone, app.fixture.head, 'HTTP binary branch and tag');
    ok(await git(app.fixture.root, ['--git-dir', clone, 'tag', '-a', '-m', 'HTTP release', 'http-release', next]));
    ok(await app.client(['--git-dir', clone, 'push', '--atomic', app.url, `${next}:refs/heads/main`, `${next}:refs/heads/review`, 'refs/tags/http-release:refs/tags/http-release']));
    assert.equal((await app.fixture.git(['rev-parse', 'refs/heads/main'])).trim(), next);
    assert.equal((await app.fixture.git(['rev-parse', 'refs/heads/review'])).trim(), next);
    assert.equal((await app.fixture.git(['rev-parse', 'refs/tags/http-release^{}'])).trim(), next);
    const payload = await git(app.fixture.root, ['--git-dir', app.fixture.barePath, 'cat-file', 'blob', `${next}:payload.bin`]);
    assert.equal(payload.code, 0); assert.deepEqual(payload.stdout, Buffer.from([0, 255, 1, 2, 42]));
    ok(await app.client(['--git-dir', clone, 'fetch', app.url, 'refs/heads/main:refs/heads/main'], 'reader'));
    assert.equal(ok(await git(app.fixture.root, ['--git-dir', clone, 'rev-parse', 'main'])), next);
    const records = app.store.database.prepare('SELECT data FROM git_receive_records ORDER BY sequence').all() as { data: string }[];
    const post = records.map(row => JSON.parse(row.data) as { facts: { pusherId: string; phase: string }; receipt: GitReceiveReceipt }).filter(row => row.facts.phase === 'post');
    assert.equal(post.length, 1); assert.equal(post[0]!.facts.pusherId, app.bob.id); assert.equal(post[0]!.receipt.allowed, true);
    const bearer = await git(app.fixture.root, ['-c', `http.extraHeader=Authorization: Bearer ${app.tokens.reader.token}`, 'ls-remote', app.url]);
    assert.match(ok(bearer), new RegExp(`${next}\\s+refs/heads/main`));
  } finally { await app.close(); }
});

test('Git HTTP requires current token scope and repository/Space access without enabling dumb HTTP', async () => {
  const app = await start('/workspace/');
  try {
    assert.notEqual((await app.client(['ls-remote', app.url], null)).code, 0);
    const clone = join(app.fixture.root, 'denied-client.git'); ok(await app.client(['clone', '--bare', app.url, clone]));
    const next = await newCommit(app.fixture.root, clone, app.fixture.head, 'Denied HTTP push');
    const push = (actor: keyof typeof app.tokens) => app.client(['--git-dir', clone, 'push', app.url, `${next}:refs/heads/main`], actor);
    assert.notEqual((await push('reader')).code, 0); assert.equal((await app.fixture.git(['rev-parse', 'main'])).trim(), app.fixture.head);
    app.policy({ edit: members(app.alice.id) }); assert.notEqual((await push('bob')).code, 0);
    app.policy({ edit: { kind: 'workspace' }, view: members(app.alice.id) }); assert.notEqual((await app.client(['ls-remote', app.url])).code, 0);
    app.policy({ view: { kind: 'workspace' } });
    const space = app.policies.createSpace({ name: 'Private Git Space', view: members(app.alice.id), edit: members(app.alice.id) }, app.alice.id);
    app.policy({ spaceId: space.id }); assert.notEqual((await app.client(['ls-remote', app.url])).code, 0); assert.notEqual((await push('bob')).code, 0);
    app.policy({ spaceId: 'S1' }); app.auth.revokeToken(app.bob.id, app.tokens.bob.record.id);
    assert.notEqual((await app.client(['ls-remote', app.url])).code, 0); assert.notEqual((await push('bob')).code, 0);
    for (const path of ['/git/R1.git/HEAD', '/git/R1.git/config', '/git/R1.git/objects/info/packs', '/git/R1.git/info/refs', '/git/R99.git/info/refs?service=git-upload-pack']) {
      const response = await fetch(`${app.origin}/workspace${path}`, { headers: { Authorization: `Bearer ${app.tokens.alice.token}` }, signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 404, path); assert.ok(!(await response.text()).includes(app.fixture.barePath));
    }
    assert.equal((await app.fixture.git(['rev-parse', 'main'])).trim(), app.fixture.head);
    assert.equal(app.store.database.prepare('SELECT count(*) AS n FROM git_receive_records').get()!.n, 0);
  } finally { await app.close(); }
});

test('Herald rejects actual Git pushes before refs change and accepted commits trigger build/audit evidence', async () => {
  const app = await start();
  try {
    const clone = join(app.fixture.root, 'gated-client.git'); ok(await app.client(['clone', '--bare', app.url, clone]));
    const next = await newCommit(app.fixture.root, clone, app.fixture.head, 'Immutable HTTP push evidence');
    const created = await app.api<{ rule: HeraldRule }>('/api/herald/rules', 'POST', pushRule()); assert.equal(created.status, 201);
    const blocked = await app.client(['--git-dir', clone, 'push', app.url, `${next}:refs/heads/main`]);
    assert.notEqual(blocked.code, 0); assert.equal((await app.fixture.git(['rev-parse', 'main'])).trim(), app.fixture.head);
    assert.equal(app.store.database.prepare("SELECT count(*) AS n FROM git_receive_records WHERE phase='post'").get()!.n, 0);
    const pre = app.store.database.prepare("SELECT data FROM git_receive_records WHERE phase='pre'").get() as { data: string };
    assert.equal((JSON.parse(pre.data) as { receipt: GitReceiveReceipt }).receipt.allowed, false);
    assert.equal((await app.api(`/api/herald/rules/${created.body.rule.id}`, 'PUT', { ...pushRule(), enabled: false, expectedVersion: created.body.rule.version })).status, 200);
    const plan = await app.api<{ plan: BuildPlan }>('/api/harbormaster/plans', 'POST', { name: 'Exact HTTP commit build', description: '', enabled: true, steps: [{ key: 'worker', name: 'Worker', kind: 'external', worker: 'test-worker', dependsOn: [] }] }); assert.equal(plan.status, 201);
    assert.equal((await app.api('/api/herald/rules', 'POST', pushRule({ name: 'Build pushed commit', contentType: 'commit', actions: [{ type: 'run-build-plans', targets: [plan.body.plan.id] }, { type: 'add-auditors', targets: [app.alice.id] }] }))).status, 201);
    ok(await app.client(['--git-dir', clone, 'push', app.url, `${next}:refs/heads/main`]));
    assert.equal((await app.fixture.git(['rev-parse', 'main'])).trim(), next);
    const builds = await app.api<{ builds: Build[] }>('/api/harbormaster/builds?objectId=R1'); assert.equal(builds.status, 200); assert.equal(builds.body.builds.length, 1);
    const post = app.store.database.prepare("SELECT data FROM git_receive_records WHERE phase='post'").get() as { data: string };
    const saved = JSON.parse(post.data) as { receipt: GitReceiveReceipt }; assert.equal(saved.receipt.commitIds.length, 1);
    const commit = app.automation.git.commit(saved.receipt.commitIds[0]!); assert.equal(commit.commit.id, next);
    const audit = await app.api<AuditDetail>(`/api/audit/commits/${saved.receipt.commitIds[0]}`); assert.equal(audit.status, 200);
    assert.equal(audit.body.audit.source.commit.id, next); assert.ok(audit.body.audit.auditors.some(auditor => auditor.principalId === app.alice.id));
  } finally { await app.close(); }
});

test('observed repositories proxy authenticated reads and reject Git pushes while the remote remains authoritative', async () => {
  const app = await start('/workspace/', 'observe');
  try {
    const clone = join(app.fixture.root, 'observed-client.git'); ok(await app.client(['clone', '--bare', app.url, clone], 'reader'));
    assert.equal(ok(await git(app.fixture.root, ['--git-dir', clone, 'rev-parse', 'main'])), app.fixture.head);
    const next = await newCommit(app.fixture.root, clone, app.fixture.head, 'Refuse a second repository authority');
    const result = await app.client(['--git-dir', clone, 'push', app.url, `${next}:refs/heads/main`]); assert.notEqual(result.code, 0);
    assert.equal((await app.fixture.git(['rev-parse', 'refs/heads/main'])).trim(), app.fixture.head);
    assert.equal(app.store.database.prepare('SELECT count(*) AS n FROM git_receive_records').get()!.n, 0);
    assert.equal(app.repositorySync.snapshot('R1').mode, 'observe');
  } finally { await app.close(); }
});

test('Git HTTP decodes gzip negotiation requests before invoking upload-pack', async () => {
  const app = await start();
  try {
    const packet = (line: string) => (Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line;
    const body = gzipSync(Buffer.from(packet(`want ${app.fixture.head}\n`) + '0000' + packet('done\n')));
    const response = await fetch(`${app.url}/git-upload-pack`, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${app.tokens.reader.token}`, 'Content-Type': 'application/x-git-upload-pack-request', 'Content-Encoding': 'gzip' }, body });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/x-git-upload-pack-result');
    assert.ok(Buffer.from(await response.arrayBuffer()).includes(Buffer.from('PACK')));
  } finally { await app.close(); }
});

test('Git HTTP hides private internal refs, denies writing them and never executes repository hooks', async () => {
  const app = await start();
  try {
    const secret = (await app.fixture.git(['hash-object', '-w', '--stdin'], 'PRIVATE landing evidence')).trim();
    await app.fixture.git(['update-ref', 'refs/phabricator/land-proof/internal-test', secret]);
    await app.fixture.git(['update-ref', 'refs/phabricator/land/internal-test', app.fixture.head]);
    const marker = join(app.fixture.root, 'untrusted-hook-ran'); await mkdir(join(app.fixture.barePath, 'hooks'), { recursive: true });
    const shell = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    for (const hook of ['pre-receive', 'post-receive']) {
      const path = join(app.fixture.barePath, 'hooks', hook); await writeFile(path, `#!/bin/sh\nprintf unsafe > ${shell(marker)}\nexit 0\n`); await chmod(path, 0o700);
    }
    const advertised = ok(await app.client(['ls-remote', app.url])); assert.equal(advertised.includes('refs/phabricator/'), false); assert.equal(advertised.includes(secret), false);
    const clone = join(app.fixture.root, 'hidden-client.git'); ok(await app.client(['clone', '--bare', app.url, clone]));
    assert.notEqual((await git(app.fixture.root, ['--git-dir', clone, 'cat-file', '-e', secret])).code, 0, 'normal clones exclude private proof objects');
    for (const protocol of ['0', '2']) assert.notEqual((await app.client(['-c', `protocol.version=${protocol}`, '--git-dir', clone, 'fetch', app.url, secret])).code, 0, `protocol ${protocol} cannot fetch an unadvertised proof blob by object ID`);
    assert.notEqual((await app.client(['--git-dir', clone, 'push', app.url, `${app.fixture.head}:refs/phabricator/land/forged`])).code, 0);
    await assert.rejects(app.fixture.git(['rev-parse', '--verify', 'refs/phabricator/land/forged']));
    const next = await newCommit(app.fixture.root, clone, app.fixture.head, 'Safe HTTP push'); ok(await app.client(['--git-dir', clone, 'push', app.url, `${next}:refs/heads/main`]));
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    assert.match(await readFile(join(app.fixture.barePath, 'hooks', 'pre-receive'), 'utf8'), /printf unsafe/, 'existing hooks are not overwritten');
    assert.equal((await app.fixture.git(['rev-parse', 'refs/phabricator/land-proof/internal-test'])).trim(), secret);
  } finally { await app.close(); }
});

test('Git HTTP cannot expose a hidden existing object through a public ref and an empty object pack', async () => {
  const app = await start();
  try {
    const secret = (await app.fixture.git(['hash-object', '-w', '--stdin'], 'PRIVATE proof unavailable to Git clients')).trim();
    await app.fixture.git(['update-ref', 'refs/phabricator/land-proof/private-receive', secret]);
    const header = Buffer.from('5041434b0000000200000000', 'hex');
    const emptyPack = Buffer.concat([header, createHash('sha1').update(header).digest()]);
    await rawReceive(app, 'refs/tags/stolen-proof', secret, emptyPack);
    await assert.rejects(app.fixture.git(['rev-parse', '--verify', 'refs/tags/stolen-proof']), 'an object known only through hidden server refs must not become public');
    assert.equal(app.store.database.prepare("SELECT count(*) AS n FROM git_receive_records WHERE phase='post'").get()!.n, 0);
  } finally { await app.close(); }
});

test('Git HTTP rejects a thin pack whose delta base is available only through private server objects', async () => {
  const app = await start();
  try {
    const clone = join(app.fixture.root, 'thin-client.git'), clean = join(app.fixture.root, 'thin-public-control.git');
    ok(await app.client(['clone', '--bare', app.url, clone])); ok(await app.client(['clone', '--bare', app.url, clean]));
    const content = Array.from({ length: 3_000 }, (_, index) => `PRIVATE base line ${index}: exact data used as an unadvertised delta dictionary.\n`).join('');
    const baseBlob = (await app.fixture.git(['hash-object', '-w', '--stdin'], content)).trim();
    const baseTree = (await app.fixture.git(['mktree', '-z'], `100644 blob ${baseBlob}\tREADME.md\0`)).trim();
    const baseCommit = (await app.fixture.git(['commit-tree', baseTree, '-p', app.fixture.head], 'Private delta dictionary\n')).trim();
    await app.fixture.git(['update-ref', 'refs/phabricator/land/private-delta', baseCommit]);
    // Construct an adversarial sender independently of the public HTTP clone.
    ok(await git(app.fixture.root, ['--git-dir', clone, 'fetch', app.fixture.barePath, baseCommit]));
    const changedBlob = ok(await git(app.fixture.root, ['--git-dir', clone, 'hash-object', '-w', '--stdin'], content.replace('PRIVATE base line 1500:', 'Changed line 1500:')));
    const changedTree = ok(await git(app.fixture.root, ['--git-dir', clone, 'mktree', '-z'], `100644 blob ${changedBlob}\tREADME.md\0`));
    const next = ok(await git(app.fixture.root, ['--git-dir', clone, 'commit-tree', changedTree, '-p', baseCommit], 'Commit carried by a hidden-base thin pack\n'));
    const packed = await git(app.fixture.root, ['--git-dir', clone, 'pack-objects', '--stdout', '--thin', '--revs'], `${next}\n^${baseCommit}\n`); assert.equal(packed.code, 0, packed.stderr);
    const publicCheck = await git(app.fixture.root, ['--git-dir', clean, 'index-pack', '--fix-thin', '--stdin'], packed.stdout);
    assert.notEqual(publicCheck.code, 0, 'fixture pack must actually require an unavailable private delta base');
    ok(await git(app.fixture.root, ['--git-dir', clone, 'index-pack', '--fix-thin', '--stdin'], packed.stdout));
    await rawReceive(app, 'refs/heads/private-delta', next, packed.stdout);
    await assert.rejects(app.fixture.git(['rev-parse', '--verify', 'refs/heads/private-delta']), 'receive must verify against public objects, not the hidden dictionary');
    assert.equal(app.store.database.prepare("SELECT count(*) AS n FROM git_receive_records WHERE phase='post'").get()!.n, 0);
  } finally { await app.close(); }
});
