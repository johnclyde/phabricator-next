import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { GIT_LIMITS } from '../shared/repositories.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import type { GitFixture } from '../tests/git-fixture.ts';
import { createGitObserver, parseGitRepositories } from './git.ts';
import { HttpError } from './validation.ts';

function hasCode(code: string) { return (error: unknown) => error instanceof HttpError && error.code === code && !error.message.includes('/private/') && !error.message.includes('DO-NOT-DISCLOSE'); }
async function fixtureTest(work: (fixture: GitFixture) => Promise<void>, format: 'sha1' | 'sha256' = 'sha1') {
  const fixture = await createGitFixture(format); try { await work(fixture); } finally { await fixture.close(); }
}
async function commitRecords(fixture: GitFixture, records: string[]): Promise<string> {
  const tree = (await fixture.git(['mktree', '-z'], records.join(''))).trim();
  return (await fixture.git(['commit-tree', tree], 'Import boundary fixture\n')).trim();
}

test('operator bindings accept only bounded repository-ID to absolute-path maps without exposing values', () => {
  assert.deepEqual(parseGitRepositories(undefined), {});
  assert.deepEqual(parseGitRepositories('{"R1":"/srv/git/repository.git"}'), { R1: '/srv/git/repository.git' });
  for (const raw of ['null', '[]', '42', '{"__proto__":"/private/DO-NOT-DISCLOSE"}', '{"R0":"/tmp/repo"}', '{"R1":"relative.git"}', '{"R1":3}', 'DO-NOT-DISCLOSE', JSON.stringify({ R1: '/tmp/\0repo' })]) assert.throws(() => parseGitRepositories(raw), error => error instanceof Error && !error.message.includes('DO-NOT-DISCLOSE'));
  assert.throws(() => parseGitRepositories(JSON.stringify(Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`R${index + 1}`, '/tmp/repo'])))));
});

for (const format of ['sha1', 'sha256'] as const) test(`Git ${format} observes branches/tags and exact immutable commits, trees and text`, async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  assert.deepEqual(await observer.info('R1'), { state: 'ready', objectFormat: format });
  assert.equal((await observer.info('R2')).state, 'unconfigured');
  const refs = await observer.refs('R1'); assert.equal(refs.headCommit, fixture.head); assert.equal(refs.objectFormat, format);
  assert.equal(refs.refs.find(ref => ref.name === 'refs/tags/v2')?.objectId, fixture.annotatedTag);
  assert.equal(refs.refs.find(ref => ref.name === 'refs/tags/v2')?.commitId, fixture.head);
  assert.equal(refs.refs.find(ref => ref.name === 'refs/tags/source-blob')?.commitId, null);
  await fixture.git(['update-ref', 'refs/heads/release.promisor', fixture.base]);
  assert.equal((await observer.refs('R1')).refs.find(ref => ref.name === 'refs/heads/release.promisor')?.commitId, fixture.base);
  const detail = await observer.commit('R1', fixture.head); assert.equal(detail.commit.parentIds.length, 2); assert.equal(detail.commit.message, 'Merge feature branch\n'); assert.equal(detail.commit.author.name, 'Fixture Author');
  const tree = await observer.tree('R1', fixture.head, ''); assert.equal(tree.treeId, detail.commit.treeId);
  assert.equal(tree.entries.find(entry => entry.name === 'link')?.type, 'symlink');
  assert.equal(tree.entries.find(entry => entry.name === 'module')?.type, 'submodule');
  assert.equal((await observer.tree('R1', fixture.head, 'tools')).entries[0]?.mode, '100755');
  assert.equal((await observer.tree('R1', fixture.emptyCommit, '')).entries.length, 0);
  for (const path of ['README.md', 'docs/paper.tex', 'docs/empty.txt', 'unicodé/研究.md', 'name with spaces.md', '<script>.txt']) assert.equal((await observer.blob('R1', fixture.head, path)).state, 'text', path);
  const empty = await observer.blob('R1', fixture.head, 'docs/empty.txt'); assert.equal(empty.state, 'text'); if (empty.state === 'text') assert.equal(empty.content, '');
  const old = await observer.blob('R1', fixture.head, 'README.md'); const next = await fixture.advanceMain();
  assert.equal((await observer.refs('R1')).headCommit, next); assert.deepEqual(await observer.blob('R1', fixture.head, 'README.md'), old);
}, format));

test('blob states preserve binary, invalid encoding, oversized, symlink and submodule distinctions', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  for (const [path, state] of [['binary.dat', 'binary'], ['invalid.txt', 'unsupported_encoding'], ['oversized.txt', 'oversized'], ['link', 'symlink'], ['module', 'submodule']]) {
    const result = await observer.blob('R1', fixture.head, path!); assert.equal(result.state, state); assert.equal(Object.hasOwn(result, 'content'), false);
    if (state === 'submodule') assert.equal(result.size, null); else assert.equal(typeof result.size, 'number');
  }
  await assert.rejects(observer.blob('R1', fixture.head, 'link/secret'), hasCode('GIT_OBJECT_UNAVAILABLE'));
  await assert.rejects(observer.blob('R1', fixture.head, 'module/README.md'), hasCode('GIT_OBJECT_UNAVAILABLE'));
}));

test('detached HEAD resolves only an existing commit and does not advertise missing objects or blobs', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  for (const [head, expected] of [[fixture.base, fixture.base], [fixture.readmeBlob, null], ['f'.repeat(40), null]] as const) {
    await writeFile(join(fixture.barePath, 'HEAD'), `${head}\n`); assert.equal((await observer.refs('R1')).headCommit, expected);
  }
}));

test('UTF-8 byte order marks remain literal in blob contents, path names and commit messages', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath }); const content = '\ufeffLiteral source.\n'; const path = '\ufeffsource.txt';
  const blob = (await fixture.git(['hash-object', '-w', '--stdin'], content)).trim();
  const tree = (await fixture.git(['mktree', '-z'], `100644 blob ${blob}\t${path}\0`)).trim();
  const commit = (await fixture.git(['commit-tree', tree], '\ufeffLiteral commit message.\n')).trim();
  assert.equal((await observer.tree('R1', commit, '')).entries[0]?.name, path);
  const result = await observer.blob('R1', commit, path); assert.equal(result.state, 'text'); if (result.state === 'text') assert.equal(result.content, content);
  assert.equal((await observer.commit('R1', commit)).commit.message, '\ufeffLiteral commit message.\n');
}));

test('history preserves commit identity across pages, merges and branch movement', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath }); const first = await observer.history('R1', { commit: fixture.head, limit: 2 });
  assert.equal(first.commits[0]?.id, fixture.head); assert.equal(first.commits[0]?.parentIds.length, 2); assert.equal(first.nextAfter, 2);
  await fixture.advanceMain();
  const second = await observer.history('R1', { commit: fixture.head, after: first.nextAfter!, limit: 2 });
  assert.equal(second.commitId, fixture.head); assert.equal(second.nextAfter, null);
  assert.equal(new Set([...first.commits, ...second.commits].map(commit => commit.id)).size, 4);
  const file = await observer.history('R1', { commit: fixture.head, path: 'docs/paper.tex' }); assert.equal(file.commits.length, 1);
  assert.deepEqual((await observer.history('R1', { commit: fixture.head, path: 'does-not-exist' })).commits, []);
  for (const query of [{ commit: 'main' }, { commit: fixture.head, after: -1 }, { commit: fixture.head, after: GIT_LIMITS.historyOffset + 1 }, { commit: fixture.head, limit: 101 }, { commit: fixture.head, path: '../escape' }]) await assert.rejects(observer.history('R1', query), hasCode('GIT_INVALID_QUERY'));
}));

test('only full object IDs and literal safe tree paths are accepted', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  for (const id of ['HEAD', 'main', `${fixture.head}~1`, '--help', fixture.head.slice(0, 7), 'f'.repeat(39)]) await assert.rejects(observer.commit('R1', id), hasCode('GIT_INVALID_QUERY'));
  for (const path of ['/README.md', '..', 'docs/../README.md', 'docs//paper.tex', 'README.md\0', 'x'.repeat(4097)]) await assert.rejects(observer.blob('R1', fixture.head, path), hasCode('GIT_INVALID_QUERY'));
  await assert.rejects(observer.commit('R1', 'f'.repeat(40)), hasCode('GIT_OBJECT_UNAVAILABLE'));
  await assert.rejects(observer.blob('R1', fixture.head, ':(top)*'), hasCode('GIT_OBJECT_UNAVAILABLE'));
  await assert.rejects(observer.tree('R1', fixture.head, 'README.md'), hasCode('GIT_OBJECT_UNAVAILABLE'));
}));

test('local unsafe config and includes are rejected before source access or executable behavior', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath }); const configPath = join(fixture.barePath, 'config'); const original = await readFile(configPath); const marker = join(fixture.root, 'DO-NOT-DISCLOSE');
  for (const addition of [
    `\n[include]\n path = ${marker}\n`,
    `\n[core]\n fsmonitor = touch ${marker}\n`,
    `\n[alias]\n cat-file = !touch ${marker}\n`,
    '\n[extensions]\n partialClone = origin\n',
    '\n[remote "origin"]\n promisor = true\n',
    '\n[extensions]\n refStorage = reftable\n',
    '\n[core]\n worktree = /private/DO-NOT-DISCLOSE\n',
  ]) {
    await writeFile(configPath, Buffer.concat([original, Buffer.from(addition)]));
    assert.equal((await observer.info('R1')).state, 'unavailable');
    await assert.rejects(observer.blob('R1', fixture.head, 'README.md'), hasCode('GIT_UNAVAILABLE'));
  }
  await writeFile(configPath, original); await assert.rejects(readFile(marker), { code: 'ENOENT' });
  // A remote URL is inert metadata: reading a missing object never invokes it.
  await appendFile(configPath, `\n[remote "origin"]\n url = ext::touch ${marker}\n fetch = +refs/heads/*:refs/remotes/origin/*\n`);
  assert.equal((await observer.info('R1')).state, 'ready');
  await assert.rejects(observer.commit('R1', 'f'.repeat(40)), hasCode('GIT_OBJECT_UNAVAILABLE'));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
}));

test('repository files, alternates, grafts, shallow state and symlink indirection are rejected', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  for (const path of ['shallow', 'commondir', 'config.worktree', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) {
    const target = join(fixture.barePath, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, '');
    assert.equal((await observer.info('R1')).state, 'unavailable', path); await rm(target);
  }
  const replace = join(fixture.barePath, 'refs/replace'); await mkdir(replace); assert.equal((await observer.info('R1')).state, 'unavailable'); await rm(replace, { recursive: true });
  const packedRefs = join(fixture.barePath, 'packed-refs'); await writeFile(packedRefs, `${fixture.head} refs/replace/${fixture.base}\n`); assert.equal((await observer.info('R1')).state, 'unavailable'); await rm(packedRefs);
  const promisor = join(fixture.barePath, 'objects/pack', `pack-${'0'.repeat(40)}.promisor`); await writeFile(promisor, ''); assert.equal((await observer.info('R1')).state, 'unavailable'); await rm(promisor);
  const linked = join(fixture.root, 'alias.git'); await symlink(fixture.barePath, linked);
  assert.equal((await createGitObserver({ R1: linked }).info('R1')).state, 'unavailable');
  const objectLink = join(fixture.barePath, 'objects', 'escape'); await symlink(fixture.root, objectLink);
  assert.equal((await observer.info('R1')).state, 'unavailable'); await rm(objectLink);
  assert.equal((await observer.info('R1')).state, 'ready');
}));

test('inherited Git configuration and object-directory environment cannot redirect reads', async () => fixtureTest(async fixture => {
  const keys = ['GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL']; const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.GIT_DIR = '/private/DO-NOT-DISCLOSE'; process.env.GIT_OBJECT_DIRECTORY = '/private/DO-NOT-DISCLOSE';
    process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'core.worktree'; process.env.GIT_CONFIG_VALUE_0 = '/private/DO-NOT-DISCLOSE'; process.env.GIT_CONFIG_PARAMETERS = "'include.path=/private/DO-NOT-DISCLOSE'"; process.env.GIT_CONFIG_GLOBAL = '/private/DO-NOT-DISCLOSE';
    const result = await createGitObserver({ R1: fixture.barePath }).blob('R1', fixture.head, 'README.md'); assert.equal(result.state, 'text');
  } finally { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
}));

test('refs and tree limits fail explicitly without returning a partial or empty result', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  await fixture.git(['update-ref', '--stdin'], Array.from({ length: GIT_LIMITS.refs + 1 }, (_, index) => `create refs/heads/limit-${index} ${fixture.base}\n`).join(''));
  await assert.rejects(observer.refs('R1'), hasCode('GIT_LIMIT_EXCEEDED'));
  const tree = (await fixture.git(['mktree', '-z'], Array.from({ length: GIT_LIMITS.treeEntries + 1 }, (_, index) => `100644 blob ${fixture.readmeBlob}\tf${index}\0`).join(''))).trim();
  const commit = (await fixture.git(['commit-tree', tree], 'Oversized tree\n')).trim();
  await assert.rejects(observer.tree('R1', commit, ''), hasCode('GIT_LIMIT_EXCEEDED'));
}));

test('commit messages are explicitly truncated only after verifying the complete bounded object', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath }); const tree = (await observer.commit('R1', fixture.base)).commit.treeId;
  const normal = (await fixture.git(['commit-tree', tree], 'é'.repeat(16_100))).trim(); const result = await observer.commit('R1', normal);
  assert.equal(result.commit.messageTruncated, true); assert.ok(Buffer.byteLength(result.commit.message) <= GIT_LIMITS.messageBytes); assert.ok(!result.commit.message.includes('\ufffd'));
  const huge = (await fixture.git(['commit-tree', tree], 'x'.repeat(GIT_LIMITS.outputBytes + 1))).trim();
  await assert.rejects(observer.commit('R1', huge), hasCode('GIT_LIMIT_EXCEEDED'));
  const bytes = Buffer.concat([Buffer.from(`tree ${tree}\nauthor A <a@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\n`), Buffer.from([0xc0, 0xaf])]);
  const invalid = (await fixture.git(['hash-object', '-t', 'commit', '-w', '--stdin'], bytes)).trim();
  await assert.rejects(observer.commit('R1', invalid), hasCode('GIT_UNSUPPORTED_ENCODING'));
}));

test('raw object hash verification rejects modified content under an existing object ID', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const body = Buffer.from('Tampered source.\n'); const raw = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
  assert.notEqual(createHash('sha1').update(raw).digest('hex'), fixture.readmeBlob);
  const file = join(fixture.barePath, 'objects', fixture.readmeBlob.slice(0, 2), fixture.readmeBlob.slice(2));
  await chmod(file, 0o600); await writeFile(file, deflateSync(raw));
  await assert.rejects(observer.blob('R1', fixture.head, 'README.md'), hasCode('GIT_INVALID_OBJECT'));
}));

test('malformed non-ASCII tree modes cannot be normalized into ordinary file modes', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const rawTree = Buffer.concat([Buffer.from([0xb1]), Buffer.from('00644 invalid.txt\0'), Buffer.from(fixture.readmeBlob, 'hex')]);
  const tree = (await fixture.git(['hash-object', '--literally', '-t', 'tree', '-w', '--stdin'], rawTree)).trim();
  const commit = (await fixture.git(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nauthor A <a@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\nMalformed mode\n`)).trim();
  await assert.rejects(observer.tree('R1', commit, ''), hasCode('GIT_INVALID_OBJECT'));
}));

test('aborted requests are cancelled and a saturated observer rejects excess queue entries', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath }); const controller = new AbortController(); controller.abort();
  await assert.rejects(observer.commit('R1', fixture.head, controller.signal), hasCode('GIT_ABORTED'));
  const queuedController = new AbortController();
  const requests = Array.from({ length: GIT_LIMITS.concurrency + GIT_LIMITS.queued + 5 }, () => observer.history('R1', { commit: fixture.head }, queuedController.signal));
  queuedController.abort(); const results = await Promise.allSettled(requests);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason instanceof HttpError && result.reason.code === 'GIT_BUSY').length, 5);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal((await observer.info('R1')).state, 'ready');
}));

test('the whole-operation deadline covers preflight and waiting requests, then releases capacity', async context => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const requests = Array.from({ length: GIT_LIMITS.concurrency + 2 }, () => observer.history('R1', { commit: fixture.head }));
    const results = Promise.allSettled(requests); context.mock.timers.tick(GIT_LIMITS.timeoutMs);
    assert.ok((await results).every(result => result.status === 'rejected' && result.reason instanceof HttpError && result.reason.code === 'GIT_LIMIT_EXCEEDED'));
  } finally { context.mock.timers.reset(); }
  assert.equal((await observer.info('R1')).state, 'ready');
}));

for (const format of ['sha1', 'sha256'] as const) test(`Git ${format} imports one complete immutable text tree with exact blob and executable provenance`, async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const result = await observer.importSnapshot('R1', fixture.importCommit);
  assert.equal(result.repositoryId, 'R1'); assert.equal(result.objectFormat, format);
  assert.equal(result.provenance.kind, 'git'); assert.equal(result.provenance.scope, 'complete-text-tree');
  assert.equal(result.provenance.repositoryId, 'R1'); assert.equal(result.provenance.objectFormat, format);
  assert.equal(result.provenance.commitId, fixture.importCommit);
  assert.equal(result.provenance.treeId, (await observer.commit('R1', fixture.importCommit)).commit.treeId);
  assert.equal(result.files.length, 8);
  const paths = result.files.map(file => file.path); assert.deepEqual(paths, [...paths].sort());
  assert.deepEqual(result.provenance.manifest.map(entry => entry.path), paths);
  assert.equal(result.files.find(file => file.path === 'docs/empty.txt')?.content, '');
  assert.equal(result.files.find(file => file.path === '\ufeffsource.txt')?.content, '\ufeffLiteral source.\n');
  assert.equal(result.files.find(file => file.path === '<script>.txt')?.content, '<script>window.fixtureExecuted = true</script>\n');
  assert.equal(result.files.find(file => file.path === 'unicodé/研究.md')?.content, 'Unicode source.\n');
  for (const [index, file] of result.files.entries()) {
    const manifest = result.provenance.manifest[index]!;
    assert.equal(manifest.mode, file.path === 'tools/check.sh' ? '100755' : '100644');
    const bytes = Buffer.from(file.content, 'utf8');
    assert.equal(manifest.objectId, createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
  }
  await fixture.advanceMain();
  assert.deepEqual(await observer.importSnapshot('R1', fixture.importCommit), result);
  for (const id of ['main', 'HEAD', fixture.importCommit.slice(0, 12), `${fixture.importCommit}:README.md`]) await assert.rejects(observer.importSnapshot('R1', id), hasCode('GIT_INVALID_QUERY'));
}, format));

test('imports reject the whole tree when any file is binary, invalid UTF-8, oversized, a symlink or a submodule', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const cases: { content?: Buffer | string; mode: string; type: string; code: string }[] = [
    { content: Buffer.from([65, 0, 66]), mode: '100644', type: 'blob', code: 'GIT_IMPORT_UNSUPPORTED' },
    { content: Buffer.from([0xc0, 0xaf]), mode: '100644', type: 'blob', code: 'GIT_IMPORT_UNSUPPORTED' },
    { content: 'x'.repeat(GIT_LIMITS.blobBytes + 1), mode: '100644', type: 'blob', code: 'GIT_LIMIT_EXCEEDED' },
    { content: 'a-safe.txt', mode: '120000', type: 'blob', code: 'GIT_IMPORT_UNSUPPORTED' },
    { mode: '160000', type: 'commit', code: 'GIT_IMPORT_UNSUPPORTED' },
  ];
  for (const entry of cases) {
    const object = entry.content === undefined ? fixture.base : (await fixture.git(['hash-object', '-w', '--stdin'], entry.content)).trim();
    const commit = await commitRecords(fixture, [`100644 blob ${fixture.readmeBlob}\ta-safe.txt\0`, `${entry.mode} ${entry.type} ${object}\tz-rejected\0`]);
    let delivered = false;
    await assert.rejects(observer.importSnapshot('R1', commit).then(result => { delivered = true; return result; }), hasCode(entry.code));
    assert.equal(delivered, false);
  }
  await assert.rejects(observer.importSnapshot('R1', fixture.head), hasCode('GIT_IMPORT_UNSUPPORTED'));
  assert.equal((await observer.importSnapshot('R1', fixture.importCommit)).files.length, 8);
}));

test('imports reject unsafe revision paths, empty trees and empty subtrees without omitting source entries', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  for (const path of ['unsafe:filename', 'unsafe\\filename', 'unsafe\nfilename', ' ', 'x'.repeat(241)]) {
    const commit = await commitRecords(fixture, [`100644 blob ${fixture.readmeBlob}\ta-safe.txt\0`, `100644 blob ${fixture.readmeBlob}\t${path}\0`]);
    await assert.rejects(observer.importSnapshot('R1', commit), hasCode('GIT_IMPORT_UNSUPPORTED'));
  }
  await assert.rejects(observer.importSnapshot('R1', fixture.emptyCommit), hasCode('GIT_IMPORT_UNSUPPORTED'));
  const empty = (await fixture.git(['mktree'], '')).trim();
  const withEmpty = await commitRecords(fixture, [`100644 blob ${fixture.readmeBlob}\ta-safe.txt\0`, `040000 tree ${empty}\tempty\0`]);
  await assert.rejects(observer.importSnapshot('R1', withEmpty), hasCode('GIT_IMPORT_UNSUPPORTED'));
  const invalidName = Buffer.concat([Buffer.from('100644 '), Buffer.from([0xc0, 0xaf]), Buffer.from([0]), Buffer.from(fixture.readmeBlob, 'hex')]);
  const invalidTree = (await fixture.git(['hash-object', '--literally', '-t', 'tree', '-w', '--stdin'], invalidName)).trim();
  const invalidCommit = (await fixture.git(['commit-tree', invalidTree], 'Invalid UTF-8 name\n')).trim();
  await assert.rejects(observer.importSnapshot('R1', invalidCommit), hasCode('GIT_UNSUPPORTED_ENCODING'));
}));

test('import limits count every file and repeated blob byte while bounding the entire traversed tree', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const atFileLimit = await commitRecords(fixture, Array.from({ length: 100 }, (_, index) => `100644 blob ${fixture.readmeBlob}\tf${index}\0`));
  assert.equal((await observer.importSnapshot('R1', atFileLimit)).files.length, 100);
  const overFileLimit = await commitRecords(fixture, Array.from({ length: 101 }, (_, index) => `100644 blob ${fixture.readmeBlob}\tf${index}\0`));
  await assert.rejects(observer.importSnapshot('R1', overFileLimit), hasCode('GIT_LIMIT_EXCEEDED'));
  const content = 'é'.repeat(125_000); const blob = (await fixture.git(['hash-object', '-w', '--stdin'], content)).trim();
  const atByteLimit = await commitRecords(fixture, Array.from({ length: 6 }, (_, index) => `100644 blob ${blob}\tf${index}\0`));
  assert.equal((await observer.importSnapshot('R1', atByteLimit)).files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0), 1_500_000);
  const overByteLimit = await commitRecords(fixture, Array.from({ length: 7 }, (_, index) => `100644 blob ${blob}\tf${index}\0`));
  await assert.rejects(observer.importSnapshot('R1', overByteLimit), hasCode('GIT_LIMIT_EXCEEDED'));
  const child = (await observer.commit('R1', fixture.base)).commit.treeId;
  const overTreeLimit = await commitRecords(fixture, Array.from({ length: GIT_LIMITS.treeEntries }, (_, index) => `040000 tree ${child}\td${index}\0`));
  await assert.rejects(observer.importSnapshot('R1', overTreeLimit), hasCode('GIT_LIMIT_EXCEEDED'));
}));

test('imports verify blob bytes against immutable object IDs before returning any source', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const body = Buffer.from('Tampered imported source.\n'); const raw = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
  const file = join(fixture.barePath, 'objects', fixture.readmeBlob.slice(0, 2), fixture.readmeBlob.slice(2));
  await chmod(file, 0o600); await writeFile(file, deflateSync(raw));
  await assert.rejects(observer.importSnapshot('R1', fixture.importCommit), hasCode('GIT_INVALID_OBJECT'));
}));

test('imports share browsing queue bounds and release capacity on cancellation', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath }); const controller = new AbortController(); controller.abort();
  await assert.rejects(observer.importSnapshot('R1', fixture.importCommit, controller.signal), hasCode('GIT_ABORTED'));
  const active = new AbortController();
  const requests = Array.from({ length: GIT_LIMITS.concurrency + GIT_LIMITS.queued }, (_, index) => index % 2 ? observer.importSnapshot('R1', fixture.importCommit, active.signal) : observer.history('R1', { commit: fixture.head }, active.signal));
  const settled = Promise.allSettled(requests);
  await assert.rejects(observer.importSnapshot('R1', fixture.importCommit), hasCode('GIT_BUSY'));
  active.abort(); assert.ok((await settled).every(result => result.status === 'rejected' && result.reason instanceof HttpError && result.reason.code === 'GIT_ABORTED'));
  assert.equal((await observer.importSnapshot('R1', fixture.importCommit)).files.length, 8);
}));

test('one import deadline covers collection, preflight and queued operations without partial snapshots', async context => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const requests = Array.from({ length: GIT_LIMITS.concurrency + 2 }, () => observer.importSnapshot('R1', fixture.importCommit));
    const settled = Promise.allSettled(requests); context.mock.timers.tick(GIT_LIMITS.timeoutMs);
    assert.ok((await settled).every(result => result.status === 'rejected' && result.reason instanceof HttpError && result.reason.code === 'GIT_LIMIT_EXCEEDED'));
  } finally { context.mock.timers.reset(); }
  assert.equal((await observer.importSnapshot('R1', fixture.importCommit)).files.length, 8);
}));
