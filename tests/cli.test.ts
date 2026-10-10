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
