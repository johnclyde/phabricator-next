import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createGitFixture } from '../tests/git-fixture.ts';
import { inspectReceive } from './git-receive-inspection.ts';

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
    await assert.rejects(inspectReceive(fixture.barePath, `${zero} ${fixture.head} refs/heads/binary\n`, 'pre', {}), /Binary|encoded data/);
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
    await app.close();
    await assert.rejects(fixture.git(['push', receiver, `${fixture.importCommit}:refs/heads/offline`]), /hook declined/);
    await assert.rejects(fixture.git(['--git-dir', receiver, 'show-ref', '--verify', 'refs/heads/offline']));
  } finally { await app.close(); await fixture.close(); }
});
