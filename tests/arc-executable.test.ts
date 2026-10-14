import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import type { ReviewAnalysis, RevisionVersion } from '../shared/types.ts';

const executable = fileURLToPath(new URL('../bin/arc.mjs', import.meta.url));

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'arc executable '));
  const cwd = join(root, 'unrelated working copy'), bin = join(root, 'commands');
  await mkdir(cwd); await mkdir(bin);
  await symlink(executable, join(bin, 'arc'));
  await writeFile(join(cwd, 'tsconfig.json'), '{ malformed caller tsconfig');
  const environmentConfig = join(root, 'unrelated configuration.json');
  await writeFile(environmentConfig, '{ malformed environment tsconfig');
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('arc', args, {
      cwd,
      env: {
        ...process.env,
        PATH: [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
        NODE_OPTIONS: undefined, NODE_PATH: undefined,
        TSX_TSCONFIG_PATH: environmentConfig,
        PHABRICATOR_URL: 'https://offline-command.invalid/workspace/',
        PHABRICATOR_TOKEN: undefined,
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { cwd, run, close: () => rm(root, { recursive: true, force: true }) };
}

test('arc on PATH works outside its checkout and ignores caller TypeScript configuration', async () => {
  const fixture = await workspace();
  try {
    for (const environment of [{}, { TSX_TSCONFIG_PATH: undefined }]) {
      const help = await fixture.run(['--help'], environment);
      assert.equal(help.code, 0, help.stderr);
      assert.equal(help.stderr, '');
      assert.match(help.stdout, /\n  arc diff --title/);
      assert.doesNotMatch(help.stdout, /npm run (?:--silent )?arc/);
    }
    const unknown = await fixture.run(['no-such-command']);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.stdout, '');
    assert.match(unknown.stderr, /Unknown command: no-such-command\. Run arc --help\./);
  } finally { await fixture.close(); }
});

test('arc check preserves relative paths, clean JSON output and failing check exit codes offline', async () => {
  const fixture = await workspace();
  try {
    await writeFile(join(fixture.cwd, 'draft résumé.md'), 'A complete draft.\n');
    const clean = await fixture.run(['check', '--kind', 'document', 'draft résumé.md', '--json']);
    assert.equal(clean.code, 0, clean.stderr); assert.equal(clean.stderr, '');
    const cleanReview = JSON.parse(clean.stdout) as ReviewAnalysis;
    assert.equal(cleanReview.provider, 'local'); assert.deepEqual(cleanReview.findings, []);
    await writeFile(join(fixture.cwd, 'draft résumé.md'), '<<<<<<< unfinished\nA draft.\n');
    const failed = await fixture.run(['check', '--kind', 'document', 'draft résumé.md', '--json']);
    assert.equal(failed.code, 1); assert.equal(failed.stderr, '');
    const failedReview = JSON.parse(failed.stdout) as ReviewAnalysis;
    assert.equal(failedReview.provider, 'local'); assert.equal(failedReview.findings.length, 1);
    assert.equal(failedReview.findings[0]!.filePath, 'draft résumé.md');
    assert.equal(failedReview.findings[0]!.severity, 'error');
    const missing = await fixture.run(['check', 'absent.md', '--json']);
    assert.equal(missing.code, 1); assert.equal(missing.stdout, ''); assert.match(missing.stderr, /absent\.md/);
  } finally { await fixture.close(); }
});

test('arc diff submits only explicit caller files through authenticated mounted access and exports plain JSON', async () => {
  const fixture = await workspace(), store = createStore({ path: ':memory:' });
  const basePath = '/workspace/';
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const author = await provision.createAccount({ username: 'arc-author', displayName: 'Arc author', password: 'test-only-arc-executable-password' });
  let providerCalls = 0;
  const app = createApp({ store, seed: false, authMode: 'password', basePath, analyzeAI: async () => { providerCalls++; throw new Error('Review was not requested.'); } });
  try {
    const writer = app.auth.createToken(author.id, { name: 'Submit source', scopes: ['read', 'write'] });
    const reader = app.auth.createToken(author.id, { name: 'Read source', scopes: ['read'] });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const server = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const requests: string[] = [];
    app.server.on('request', request => requests.push(`${request.method} ${request.url}`));
    const content = '\ufeff# A paper\r\n\r\nPreserve the selected text.  \r\n';
    await mkdir(join(fixture.cwd, 'paper sources'));
    await writeFile(join(fixture.cwd, 'paper sources', 'résumé.md'), content);
    await writeFile(join(fixture.cwd, 'unselected.md'), 'This file was not selected.');
    const args = ['diff', '--title', 'A title with spaces', '--test-plan', 'Inspect the selected source.', '--kind', 'document', 'paper sources/résumé.md'];
    const environment = { PHABRICATOR_URL: server, PHABRICATOR_TOKEN: writer.token };
    const denied = await fixture.run(args, { ...environment, PHABRICATOR_TOKEN: reader.token });
    assert.equal(denied.code, 1); assert.equal(store.state({ configured: false, model: null }).revisions.length, 0);
    requests.length = 0;
    const submitted = await fixture.run(args, environment);
    assert.equal(submitted.code, 0, submitted.stderr); assert.equal(submitted.stderr, '');
    assert.match(submitted.stdout, /L1 · v1 · A title with spaces/); assert.ok(submitted.stdout.includes(`${server}#L1`));
    assert.deepEqual(requests, ['POST /workspace/api/revisions']);
    const saved = store.detail('L1');
    assert.deepEqual(saved.versions[0]!.files, [{ path: 'paper sources/résumé.md', content }]);
    assert.equal(saved.reviews.length, 0); assert.equal(providerCalls, 0);
    requests.length = 0;
    const exported = await fixture.run(['export', 'L1', '--version', '1'], environment);
    assert.equal(exported.code, 0, exported.stderr); assert.equal(exported.stderr, '');
    const snapshot = JSON.parse(exported.stdout) as { version: RevisionVersion };
    assert.deepEqual(snapshot.version.files, saved.versions[0]!.files);
    assert.deepEqual(requests, ['GET /workspace/api/revisions/L1', 'GET /workspace/api/revisions/L1/export?version=1']);
    assert.equal(store.detail('L1').versions.length, 1); assert.equal(providerCalls, 0);
  } finally { await app.close(); store.close(); await fixture.close(); }
});
