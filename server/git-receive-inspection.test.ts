import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createGitFixture, type GitFixture } from '../tests/git-fixture.ts';
import { inspectReceive, RECEIVE_LIMITS } from './git-receive-inspection.ts';

async function flatCommit(fixture: GitFixture, entries: { path: string; content?: string | Buffer; id?: string; mode?: string }[], parent?: string): Promise<string> {
  const records: string[] = [];
  for (const entry of entries) {
    const id = entry.id ?? (await fixture.git(['hash-object', '-w', '--stdin'], entry.content ?? '')).trim(), mode = entry.mode ?? '100644';
    records.push(`${mode} ${mode === '160000' ? 'commit' : 'blob'} ${id}\t${entry.path}\0`);
  }
  const tree = (await fixture.git(['mktree', '-z'], records.join(''))).trim();
  return (await fixture.git(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], 'Receive inspection fixture\n')).trim();
}
async function inspectPair(fixture: GitFixture, base: string, target: string) {
  await fixture.git(['update-ref', 'refs/heads/inspect', base]);
  return (await inspectReceive(fixture.barePath, `${base} ${target} refs/heads/inspect\n`, 'pre', {})).commits.find(source => source.commit.id === target)!;
}
async function retryHook(configPath: string): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/git-receive-hook.ts'), 'retry'], { env: { ...process.env, PHABRICATOR_RECEIVE_CONFIG: configPath }, stdio: ['ignore', 'ignore', 'pipe'] });
    const errors: Buffer[] = []; child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); if (code === 0) accept(); else reject(new Error(Buffer.concat(errors).toString())); });
  });
}

for (const format of ['sha1', 'sha256'] as const) test(`receive collector checks immutable ${format} content, refs, tags and force`, async () => {
  const fixture = await createGitFixture(format);
  try {
    const zero = '0'.repeat(format === 'sha1' ? 40 : 64);
    const created = await inspectReceive(fixture.barePath, `${zero} ${fixture.importNextCommit} refs/heads/paper\n`, 'pre', {});
    assert.equal(created.commits.length, 3); assert.equal(created.updates[0]!.forced, false);
    const next = created.commits.find(item => item.commit.id === fixture.importNextCommit)!;
    assert.deepEqual(next.branches, ['paper']); assert.equal(next.commit.messageTruncated, false);
    assert.ok(next.files.find(file => file.path === 'README.md')!.added.includes('new complete'));
    assert.ok(next.files.find(file => file.path === 'name with spaces.md')!.removed.includes('spaced file'));
    await fixture.git(['update-ref', 'refs/heads/paper', fixture.importNextCommit]);
    const post = await inspectReceive(fixture.barePath, `${zero} ${fixture.importNextCommit} refs/heads/paper\n`, 'post', {});
    assert.deepEqual(post, created);
    const forced = await inspectReceive(fixture.barePath, `${fixture.importNextCommit} ${fixture.base} refs/heads/paper\n`, 'pre', {});
    assert.equal(forced.updates[0]!.forced, true); assert.equal(forced.commits.length, 0);
    const deleted = await inspectReceive(fixture.barePath, `${fixture.importNextCommit} ${zero} refs/heads/paper\n`, 'pre', {});
    assert.equal(deleted.updates[0]!.newId, null);
    const tag = await inspectReceive(fixture.barePath, `${zero} ${fixture.readmeBlob} refs/tags/blob\n`, 'pre', {});
    assert.equal(tag.updates[0]!.newCommitId, null); assert.equal(tag.commits.length, 0);
    const mixed = await inspectReceive(fixture.barePath, `${zero} ${fixture.head} refs/heads/binary\n`, 'pre', {});
    const binary = mixed.commits.flatMap(item => item.files).find(file => file.path === 'binary.dat')!;
    assert.equal(binary.inspection?.kind, 'binary'); assert.equal(binary.inspection.new?.bytes, 3);
    assert.deepEqual([binary.content, binary.added, binary.removed], ['', '', '']);
    assert.equal(mixed.commits.flatMap(item => item.files).find(file => file.path === 'invalid.txt')!.inspection?.kind, 'non-utf8');
    const gitlink = mixed.commits.flatMap(item => item.files).find(file => file.path === 'module')!;
    assert.deepEqual(gitlink.inspection, { kind: 'gitlink', old: null, new: { id: fixture.base, mode: '160000', bytes: null } });
    const mode = next.files.find(file => file.path === 'tools/check.sh')!;
    assert.equal(mode.inspection?.old?.mode, '100755'); assert.equal(mode.inspection?.new?.mode, '100644');
    assert.equal(mode.inspection?.old?.id, mode.inspection?.new?.id);
    assert.match(mode.content, /old mode 100755\nnew mode 100644/); assert.equal(mode.added, ''); assert.equal(mode.removed, '');
    assert.equal(next.files.find(file => file.path === 'name with spaces.md')!.inspection?.new, null);
    await assert.rejects(inspectReceive(fixture.barePath, `${zero} ${fixture.base} refs/heads/paper\n`, 'pre', {}), /stale/);
    await assert.rejects(inspectReceive(fixture.barePath, `${zero} ${fixture.base} refs/replace/fake\n`, 'pre', {}), /unsupported/);
  } finally { await fixture.close(); }
});

test('receive collector reads genuine receive-pack quarantine without writing receiver refs', async () => {
  const fixture = await createGitFixture();
  try {
    const receiver = join(fixture.root, 'receiver.git'), result = join(fixture.root, 'inspection.json');
    await fixture.git(['init', '--bare', '--template=', receiver]);
    const runner = join(fixture.root, 'collect.mjs');
    await writeFile(runner, `import {readFileSync,writeFileSync} from 'node:fs'; import {inspectReceive} from ${JSON.stringify(resolve('server/git-receive-inspection.ts'))}; const result=await inspectReceive(process.cwd(),readFileSync(0,'utf8'),'pre'); writeFileSync(${JSON.stringify(result)},JSON.stringify(result)); process.exit(1);`);
    await mkdir(join(receiver, 'hooks'));
    const hook = join(receiver, 'hooks', 'pre-receive');
    const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(hook, `#!/bin/sh\nexec ${shell(process.execPath)} --import ${shell(resolve('node_modules/tsx/dist/loader.mjs'))} ${shell(runner)}\n`); await chmod(hook, 0o700);
    await assert.rejects(fixture.git(['push', receiver, `${fixture.importCommit}:refs/heads/main`]), /hook declined/);
    const captured = JSON.parse(await readFile(result, 'utf8')) as { commits: unknown[] };
    assert.equal(captured.commits.length, 2);
    await assert.rejects(fixture.git(['--git-dir', receiver, 'show-ref', '--verify', 'refs/heads/main']));
  } finally { await fixture.close(); }
});

test('receive collector retains binary, invalid UTF-8, large, symlink, gitlink and deletion identities without attributes', async () => {
  const fixture = await createGitFixture();
  try {
    const binary = Buffer.from([0, 1, 2, 255]), invalid = Buffer.from([0xc0, 0xaf]), huge = 'x'.repeat(RECEIVE_LIMITS.blobBytes + 1);
    const marker = join(fixture.root, 'driver-executed');
    await mkdir(join(fixture.barePath, 'info'), { recursive: true });
    await writeFile(join(fixture.barePath, 'info', 'attributes'), '*.txt diff=evil\n*.dat diff\n');
    await fixture.git(['config', 'diff.evil.command', `touch ${marker}`]);
    await fixture.git(['config', 'diff.evil.textconv', `touch ${marker}`]);
    await fixture.git(['config', 'diff.ignoreSubmodules', 'all']);
    await fixture.git(['config', 'diff.relative', 'true']);
    const shared = [
      { path: '.gitattributes', content: '* -diff\n' },
      { path: 'deleted.dat', content: binary },
      { path: 'large-deleted.txt', content: huge },
      { path: 'large-edit.txt', content: 'stable'.repeat(400_000) + '\nold line\n' },
      { path: 'type-change', content: 'old source\n' },
      { path: 'changed.dat', content: binary },
    ];
    const base = await flatCommit(fixture, shared);
    const target = await flatCommit(fixture, [
      shared[0]!, { path: 'large-edit.txt', content: 'stable'.repeat(400_000) + '\nnew line\n' },
      { path: 'type-change', id: fixture.base, mode: '160000' },
      { path: 'added.dat', content: binary }, { path: 'changed.dat', content: Buffer.from([255, 0, 42]) },
      { path: 'invalid.txt', content: invalid }, { path: 'large-added.txt', content: huge },
      { path: 'source.txt', content: '\ufeffprotected source\r\n' },
      { path: 'link', content: 'source.txt', mode: '120000' }, { path: 'empty.txt', content: '' },
      { path: 'many-added.txt', content: 'ordinary line\n'.repeat(3_000) },
    ], base);
    const result = await inspectPair(fixture, base, target);
    assert.deepEqual(result.files.map(file => file.path).sort(), ['added.dat', 'changed.dat', 'deleted.dat', 'empty.txt', 'invalid.txt', 'large-added.txt', 'large-deleted.txt', 'large-edit.txt', 'link', 'many-added.txt', 'source.txt', 'type-change']);
    const files = new Map(result.files.map(file => [file.path, file]));
    for (const path of ['added.dat', 'changed.dat', 'deleted.dat']) assert.equal(files.get(path)!.inspection?.kind, 'binary');
    assert.equal(files.get('deleted.dat')!.inspection?.new, null); assert.equal(files.get('added.dat')!.inspection?.old, null);
    assert.equal(files.get('invalid.txt')!.inspection?.kind, 'non-utf8');
    for (const path of ['large-added.txt', 'large-deleted.txt']) {
      const file = files.get(path)!; assert.equal(file.inspection?.kind, 'too-large');
      assert.equal((file.inspection?.new ?? file.inspection?.old)?.bytes, RECEIVE_LIMITS.blobBytes + 1);
    }
    assert.equal(files.get('type-change')!.inspection?.old?.bytes, 11);
    assert.equal(files.get('type-change')!.inspection?.new?.bytes, null);
    assert.equal(files.get('type-change')!.inspection?.kind, 'gitlink');
    assert.equal(files.get('link')!.inspection?.new?.mode, '120000'); assert.equal(files.get('link')!.added, 'source.txt');
    assert.equal(files.get('empty.txt')!.inspection?.kind, 'text'); assert.equal(files.get('empty.txt')!.inspection?.new?.bytes, 0);
    assert.equal(files.get('source.txt')!.added, '\ufeffprotected source\r');
    assert.equal(files.get('large-edit.txt')!.inspection?.kind, 'text');
    assert.equal(files.get('large-edit.txt')!.added, 'new line'); assert.equal(files.get('large-edit.txt')!.removed, 'old line');
    assert.equal(files.get('many-added.txt')!.inspection?.kind, 'text'); assert.equal(files.get('many-added.txt')!.added.split('\n').length, 3_000);
    for (const file of result.files.filter(file => file.inspection?.kind !== 'text')) assert.deepEqual([file.content, file.added, file.removed], ['', '', '']);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally { await fixture.close(); }
});

test('receive collector marks uncaptured text explicitly when output, encoded payload or line budgets are exhausted', async () => {
  const fixture = await createGitFixture();
  try {
    const base = await flatCommit(fixture, []);
    const entries = Array.from({ length: 6 }, (_, index) => ({ path: `${index}.txt`, content: `${index}`.repeat(1024 * 1024) }));
    const target = await flatCommit(fixture, [...entries, { path: 'many-lines.txt', content: 'x\n'.repeat(RECEIVE_LIMITS.diffLines + 1) }], base);
    const result = await inspectPair(fixture, base, target);
    assert.equal(result.files.length, 7); assert.ok(result.files.some(file => file.inspection?.kind === 'text'));
    assert.ok(result.files.filter(file => file.inspection?.kind === 'too-large').length >= 3);
    const captured = result.files.reduce((sum, file) => sum + Buffer.byteLength(file.content) + Buffer.byteLength(file.added) + Buffer.byteLength(file.removed), 0);
    assert.ok(captured <= RECEIVE_LIMITS.bytes);
    assert.equal(result.files.find(file => file.path === 'many-lines.txt')!.inspection?.kind, 'too-large');
    const escaped = await flatCommit(fixture, [0, 1].map(index => ({ path: `control-${index}.txt`, content: '\x01'.repeat(1024 * 1024) })), base);
    const escapedResult = await inspectPair(fixture, base, escaped);
    assert.equal(escapedResult.files[0]!.inspection?.kind, 'text'); assert.equal(escapedResult.files[1]!.inspection?.kind, 'too-large');
    assert.ok(Buffer.byteLength(JSON.stringify(escapedResult)) < 24 * 1024 * 1024);
  } finally { await fixture.close(); }
});

test('receive collector rejects corrupt raw content and cancellation instead of recording unavailable evidence', async () => {
  const fixture = await createGitFixture();
  try {
    const base = await flatCommit(fixture, []), id = (await fixture.git(['hash-object', '-w', '--stdin'], 'original')).trim();
    const target = await flatCommit(fixture, [{ path: 'source.txt', id }], base);
    const loose = join(fixture.barePath, 'objects', id.slice(0, 2), id.slice(2)); await chmod(loose, 0o600);
    await writeFile(loose, deflateSync(Buffer.from('blob 8\0modified')));
    await assert.rejects(inspectPair(fixture, base, target), /Blob content does not match/);
    await assert.rejects(inspectReceive(fixture.barePath, `${base} ${target} refs/heads/inspect\n`, 'pre', {}, { signal: AbortSignal.abort() }), /cancelled/);
  } finally { await fixture.close(); }
});

test('installed pre/post hooks block real pushes, retain receipts, and fail closed when API is unavailable', async () => {
  const { createApp } = await import('./app.ts');
  const fixture = await createGitFixture();
  const app = createApp({ databasePath: ':memory:', seed: false, automation: { gitReceivers: { R1: ['local'] } } });
  try {
    app.store.createRepository({ name: 'Receiving fixture', description: '', remoteUrl: 'https://example.invalid/fixture.git', defaultBranch: 'main' });
    const authorId = `local:${app.auth.workspaceId}`;
    const rule = app.automation.herald.create({ name: 'No protected content', contentType: 'push-content', ruleType: 'global', objectId: null, enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'diffAdded', operator: 'contains', value: 'new complete review version' }], actions: [{ type: 'block-push', value: 'Protected content may not be pushed.' }] }, authorId, app.automation.authority);
    await new Promise<void>(accept => app.server.listen(0, '127.0.0.1', accept));
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const receiver = join(fixture.root, 'receiver.git'), configPath = join(fixture.root, 'receive.json'), tokenFile = join(fixture.root, 'token'), spoolDirectory = join(fixture.root, 'spool');
    await fixture.git(['init', '--bare', '--template=', receiver]); await mkdir(join(receiver, 'hooks')); await mkdir(spoolDirectory, { mode: 0o700 });
    await writeFile(tokenFile, `phab_${'a'.repeat(43)}`, { mode: 0o600 });
    await writeFile(configPath, JSON.stringify({ serverUrl: `http://127.0.0.1:${address.port}/`, repositoryId: 'R1', repositoryPath: receiver, tokenFile, pusherId: authorId, spoolDirectory }), { mode: 0o600 });
    const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const [name, phase] of [['pre-receive', 'pre'], ['post-receive', 'post']]) {
      const hook = join(receiver, 'hooks', name!);
      await writeFile(hook, `#!/bin/sh\nexport PHABRICATOR_RECEIVE_CONFIG=${shell(configPath)}\nexec ${shell(process.execPath)} --import ${shell(resolve('node_modules/tsx/dist/loader.mjs'))} ${shell(resolve('scripts/git-receive-hook.ts'))} ${phase}\n`); await chmod(hook, 0o700);
    }
    await assert.rejects(fixture.git(['push', receiver, `${fixture.importNextCommit}:refs/heads/main`]), /Protected content may not be pushed/);
    const rejected = app.store.database.prepare("SELECT data FROM git_receive_records WHERE phase='pre'").get() as { data: string }; assert.equal(JSON.parse(rejected.data).receipt.allowed, false);
    const { id: _id, version: _version, authorId: _author, createdAt: _created, updatedAt: _updated, ...fields } = rule;
    app.automation.herald.update(rule.id, rule.version, { ...fields, enabled: false }, authorId, app.automation.authority);
    await fixture.git(['push', receiver, `${fixture.importNextCommit}:refs/heads/main`]);
    const accepted = app.store.database.prepare("SELECT data FROM git_receive_records WHERE phase='post'").get() as { data: string }; assert.equal(JSON.parse(accepted.data).receipt.commitIds.length, 3);

    const binaryCommit = await flatCommit(fixture, [{ path: 'upload.dat', content: Buffer.from([1, 0, 255]) }, { path: 'large.txt', content: 'large'.repeat(Math.ceil((RECEIVE_LIMITS.blobBytes + 1) / 5)) }], fixture.importNextCommit);
    const contentRule = app.automation.herald.create({ ...fields, name: 'Text must be inspectable', enabled: true, conditions: [{ field: 'diffAdded', operator: 'contains', value: 'not-present' }] }, authorId, app.automation.authority);
    await assert.rejects(fixture.git(['push', receiver, `${binaryCommit}:refs/heads/binary`]), /could not be safely evaluated/);
    app.automation.herald.update(contentRule.id, contentRule.version, { ...fields, name: contentRule.name, enabled: false }, authorId, app.automation.authority);
    app.automation.herald.create({ ...fields, name: 'Block forbidden paths', enabled: true, conditions: [{ field: 'filePaths', operator: 'contains', value: 'forbidden.dat' }] }, authorId, app.automation.authority);
    await fixture.git(['push', receiver, `${binaryCommit}:refs/heads/binary`]);
    const mixedRows = app.store.database.prepare("SELECT data FROM git_receive_records WHERE phase='post' ORDER BY sequence DESC LIMIT 1").get() as { data: string };
    const mixedFacts = JSON.parse(mixedRows.data).facts.updates.flatMap((update: { commits: { commit: { id: string }; files: { path: string; inspection: { kind: string } }[] }[] }) => update.commits);
    const mixedSource = mixedFacts.find((commit: { commit: { id: string } }) => commit.commit.id === binaryCommit);
    assert.equal(mixedSource.files.find((file: { path: string }) => file.path === 'upload.dat').inspection.kind, 'binary');
    assert.equal(mixedSource.files.find((file: { path: string }) => file.path === 'large.txt').inspection.kind, 'too-large');

    // Post-receive failure cannot undo accepted refs. The exact observation is
    // retained privately, then delivered unchanged and idempotently on retry.
    const offlineConfig = join(fixture.root, 'offline-receive.json');
    await writeFile(offlineConfig, JSON.stringify({ ...JSON.parse(await readFile(configPath, 'utf8')), serverUrl: 'http://127.0.0.1:1/' }), { mode: 0o600 });
    const postHook = join(receiver, 'hooks', 'post-receive');
    await writeFile(postHook, `#!/bin/sh\nexport PHABRICATOR_RECEIVE_CONFIG=${shell(offlineConfig)}\nexec ${shell(process.execPath)} --import ${shell(resolve('node_modules/tsx/dist/loader.mjs'))} ${shell(resolve('scripts/git-receive-hook.ts'))} post\n`); await chmod(postHook, 0o700);
    const later = await flatCommit(fixture, [{ path: 'upload.dat', content: Buffer.from([2, 0, 255]) }, { path: 'large.txt', content: 'later'.repeat(Math.ceil((RECEIVE_LIMITS.blobBytes + 1) / 5)) }], binaryCommit);
    await fixture.git(['push', receiver, `${later}:refs/heads/binary`]);
    const spoolFiles = (await readdir(spoolDirectory)).filter(name => /^post-.*\.json$/.test(name)); assert.equal(spoolFiles.length, 1);
    const pendingPath = join(spoolDirectory, spoolFiles[0]!), pending = await readFile(pendingPath, 'utf8');
    const pendingFacts = JSON.parse(pending), pendingFiles = pendingFacts.updates[0].commits[0].files;
    assert.deepEqual(pendingFiles.map((file: { inspection: { kind: string } }) => file.inspection.kind).sort(), ['binary', 'too-large']);
    assert.equal((await fixture.git(['--git-dir', receiver, 'rev-parse', 'refs/heads/binary'])).trim(), later);
    await retryHook(configPath); assert.equal((await readdir(spoolDirectory)).length, 0);
    const retried = app.store.database.prepare("SELECT data FROM git_receive_records WHERE phase='post' AND request_id=?").get(pendingFacts.requestId) as { data: string };
    assert.ok(retried); assert.deepEqual(JSON.parse(retried.data).facts.updates[0].commits[0].files, pendingFiles);
    const count = app.store.database.prepare('SELECT count(*) AS count FROM git_receive_records').get() as { count: number };
    await writeFile(pendingPath, pending, { mode: 0o600 }); await retryHook(configPath);
    assert.deepEqual(app.store.database.prepare('SELECT count(*) AS count FROM git_receive_records').get(), count); assert.equal((await readdir(spoolDirectory)).length, 0);
    await app.close();
    await assert.rejects(fixture.git(['push', receiver, `${fixture.importCommit}:refs/heads/offline`]), /hook declined/);
    await assert.rejects(fixture.git(['--git-dir', receiver, 'show-ref', '--verify', 'refs/heads/offline']));
  } finally { await app.close(); await fixture.close(); }
});
