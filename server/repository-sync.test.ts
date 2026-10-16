import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGitFixture, type GitFixture } from '../tests/git-fixture.ts';
import { isRepositoryOperations, isRepositorySyncSnapshot, validRepositorySyncReceipt } from '../shared/repository-sync.ts';
import { initializeRepositorySync, parseRepositorySyncBindings, RepositorySyncService, withRepositorySyncLock, type RepositorySyncBinding, type RepositorySyncOptions, type RepositorySyncTransport } from './repository-sync.ts';

function database(path = ':memory:'): DatabaseSync { const db = new DatabaseSync(path); if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='repository_sync_targets'").get()) initializeRepositorySync(db); return db; }
function input(service: RepositorySyncService, requestId = 'fixture-request', epoch = 1) { return { actorId: 'P1', requestId, expectedConfiguration: service.snapshot('R1').configuration!, expectedAccessEpoch: epoch }; }
function refs(fixture: GitFixture): Promise<string> { return fixture.git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/', 'refs/tags/']); }
async function fixtures(work: (source: GitFixture, destination: GitFixture) => Promise<void>) {
  const source = await createGitFixture(), destination = await createGitFixture();
  try { await work(source, destination); } finally { await Promise.all([source.close(), destination.close()]); }
}
async function clearRefs(fixture: GitFixture) { for (const line of (await refs(fixture)).split('\n').filter(Boolean)) await fixture.git(['update-ref', '-d', line.split(' ')[1]!]); }
function observing(source: GitFixture, destination: GitFixture): RepositorySyncBinding { return { repositoryId: 'R1', path: destination.barePath, mode: 'observe', observe: { url: source.barePath }, intervalSeconds: 30 }; }
function hosting(source: GitFixture, destination: GitFixture, allowRewrite = false): RepositorySyncBinding { return { repositoryId: 'R1', path: source.barePath, mode: 'host', mirrors: [{ key: 'github', url: destination.barePath, allowRewrite }], intervalSeconds: 30 }; }
const testOptions: RepositorySyncOptions = { allowLocalRemotesForTests: true };
const privateMarker = 'DO-NOT-DISCLOSE';

test('operator configuration accepts one explicit HTTPS authority and rejects hidden destinations', () => {
  assert.deepEqual(parseRepositorySyncBindings(undefined), []);
  const binding = { repositoryId: 'R1', path: '/srv/git/source.git', mode: 'observe', observe: { url: 'https://example.invalid/source.git' } };
  assert.deepEqual(parseRepositorySyncBindings(JSON.stringify([binding])), [binding]);
  for (const value of [null, {}, [{ ...binding, mode: 'host' }], [{ ...binding, observe: undefined }], [{ ...binding, path: 'relative' }], [binding, binding], [{ ...binding, intervalSeconds: 1 }], [{ ...binding, mirrors: [{ key: 'upstream', url: 'https://example.invalid/mirror.git' }] }]]) assert.throws(() => parseRepositorySyncBindings(JSON.stringify(value)));
  for (const url of ['http://example.invalid/source.git', '/tmp/local.git', 'file:///tmp/source.git', 'ext::command', `https://user:${privateMarker}@example.invalid/repo.git`, `https://example.invalid/repo.git?token=${privateMarker}`, 'https://example.invalid/repo.git#fragment', 'https://example.invalid/repo.git\n']) assert.throws(() => parseRepositorySyncBindings(JSON.stringify([{ ...binding, observe: { url } }])), error => error instanceof Error && !error.message.includes(privateMarker));
  const db = database();
  try { assert.throws(() => new RepositorySyncService(db, [{ ...binding, mode: 'observe', observe: { url: '/tmp/local.git' } } as RepositorySyncBinding])); } finally { db.close(); }
});

test('observed refresh atomically follows branches and tags, prunes deletions, preserves internal and immutable old objects', async () => fixtures(async (source, destination) => {
  const db = database(), service = new RepositorySyncService(db, [observing(source, destination)], testOptions);
  try {
    await destination.git(['update-ref', 'refs/heads/removed', destination.emptyCommit]);
    await destination.git(['update-ref', 'refs/phabricator/land-proof/fixture', destination.readmeBlob]);
    await destination.git(['update-ref', 'refs/tags/removed', destination.emptyCommit]);
    await source.git(['update-ref', '-d', 'refs/heads/feature']);
    await source.git(['update-ref', '-d', 'refs/tags/v1']);
    const next = await source.advanceMain();
    await source.git(['update-ref', 'refs/tags/new', next]);
    await service.tick();
    assert.equal(await refs(destination), await refs(source));
    assert.equal((await destination.git(['rev-parse', 'refs/phabricator/land-proof/fixture'])).trim(), destination.readmeBlob);
    assert.equal((await destination.git(['rev-parse', `refs/phabricator/observed/${destination.emptyCommit}`])).trim(), destination.emptyCommit);
    await destination.git(['gc', '--prune=now']);
    assert.equal((await destination.git(['cat-file', '-t', destination.emptyCommit])).trim(), 'commit');
    const snapshot = service.snapshot('R1');
    assert.equal(snapshot.targets[0]!.state, 'idle'); assert.equal(snapshot.targets[0]!.attempts, 1);
    assert.ok(snapshot.recentAttempts[0]!.changedRefs! >= 5); assert.ok(snapshot.targets[0]!.lastSuccessAt);
    assert.ok(isRepositorySyncSnapshot(snapshot, 'R1')); assert.equal(JSON.stringify(snapshot).includes(source.barePath), false);
  } finally { await service.close(); db.close(); }
}));

test('periodic refresh needs no manual request and resumes its schedule across restart', async () => fixtures(async (source, destination) => {
  let now = Date.now(); const dbPath = join(source.root, 'sync.sqlite'); let db = database(dbPath);
  let service = new RepositorySyncService(db, [observing(source, destination)], { ...testOptions, now: () => now });
  try {
    await service.tick(); const initial = service.snapshot('R1').targets[0]!.lastSuccessAt;
    const next = await source.advanceMain();
    await service.close(); db.close(); db = database(dbPath);
    service = new RepositorySyncService(db, [observing(source, destination)], { ...testOptions, now: () => now });
    await service.tick(); assert.equal(service.snapshot('R1').targets[0]!.attempts, 1);
    now += 30_001; await service.tick();
    assert.equal((await destination.git(['rev-parse', 'refs/heads/main'])).trim(), next);
    assert.equal(service.snapshot('R1').targets[0]!.attempts, 2); assert.notEqual(service.snapshot('R1').targets[0]!.lastSuccessAt, initial);
  } finally { await service.close(); db.close(); }
}));

test('mirror publishes only heads and tags, advances fast-forward, and deletes only previously mirrored refs', async () => fixtures(async (source, destination) => {
  await clearRefs(destination); await destination.git(['gc', '--prune=now']);
  const hiddenBlob = (await source.git(['hash-object', '-w', '--stdin'], 'Private land proof DO-NOT-DISCLOSE\n')).trim();
  await source.git(['update-ref', 'refs/phabricator/land-proof/private', hiddenBlob]);
  await source.git(['update-ref', 'refs/phabricator/private-revision', source.importCommit]);
  await source.git(['repack', '-ad']);
  const db = database(), service = new RepositorySyncService(db, [hosting(source, destination)], testOptions);
  try {
    await service.tick(); assert.equal(await refs(source), await refs(destination));
    assert.equal((await destination.git(['for-each-ref', '--format=%(refname)', 'refs/phabricator/'])).trim(), '');
    await assert.rejects(destination.git(['cat-file', '-e', hiddenBlob]));
    await assert.rejects(destination.git(['cat-file', '-e', source.importCommit]));
    await source.advanceMain(); await source.git(['update-ref', '-d', 'refs/heads/feature']); await source.git(['update-ref', '-d', 'refs/tags/v1']);
    service.request('R1', input(service)); await service.tick(); assert.equal(await refs(source), await refs(destination));
    assert.equal(service.snapshot('R1').targets[0]!.state, 'idle');
  } finally { await service.close(); db.close(); }
}));

test('mirror refuses divergent branches and unknown destination deletion; explicit rewrite remains lease-bound', async () => fixtures(async (source, destination) => {
  const db = database(); let service = new RepositorySyncService(db, [hosting(source, destination)], testOptions);
  try {
    await destination.git(['update-ref', 'refs/heads/foreign', destination.emptyCommit]);
    const before = await refs(destination); await service.tick();
    assert.equal(await refs(destination), before); assert.equal(service.snapshot('R1').targets[0]!.state, 'failed');
    assert.match(service.snapshot('R1').targets[0]!.lastError!, /conflicting/);
    await destination.git(['update-ref', '-d', 'refs/heads/foreign']);
    await destination.git(['update-ref', 'refs/heads/main', destination.emptyCommit]);
    service.request('R1', input(service)); await service.tick();
    assert.equal((await destination.git(['rev-parse', 'refs/heads/main'])).trim(), destination.emptyCommit);
    assert.equal(service.snapshot('R1').targets[0]!.state, 'failed');
    const oldConfiguration = service.snapshot('R1').configuration;
    await service.close(); service = new RepositorySyncService(db, [hosting(source, destination, true)], testOptions);
    assert.notEqual(service.snapshot('R1').configuration, oldConfiguration);
    await service.tick(); assert.equal(await refs(source), await refs(destination)); assert.equal(service.snapshot('R1').targets[0]!.state, 'idle');
  } finally { await service.close(); db.close(); }
}));

test('mirror refuses changed tags by default and never pushes internal refs with rewrite enabled', async () => fixtures(async (source, destination) => {
  await source.git(['update-ref', 'refs/tags/v1', source.head]);
  await source.git(['update-ref', 'refs/phabricator/observed/private', source.head]);
  const db = database(); let service = new RepositorySyncService(db, [hosting(source, destination)], testOptions);
  try {
    await service.tick(); assert.equal(service.snapshot('R1').targets[0]!.state, 'failed');
    await service.close(); service = new RepositorySyncService(db, [hosting(source, destination, true)], testOptions);
    await service.tick(); assert.equal(await refs(source), await refs(destination));
    assert.equal((await destination.git(['for-each-ref', '--format=%(refname)', 'refs/phabricator/'])).trim(), '');
  } finally { await service.close(); db.close(); }
}));

test('manual request is durable, exact, fenced to configuration and access epoch, and never requeues a replay', async () => fixtures(async (source, destination) => {
  const db = database(); let service = new RepositorySyncService(db, [observing(source, destination)], testOptions);
  try {
    const request = input(service), first = service.request('R1', request);
    assert.equal(first.receipt.replayed, false); await service.tick();
    const second = service.request('R1', request); assert.equal(second.receipt.replayed, true); assert.equal(second.snapshot.targets[0]!.state, 'idle');
    assert.throws(() => service.request('R1', { ...request, expectedAccessEpoch: 2 }), /another synchronization/);
    await service.close(); service = new RepositorySyncService(db, [observing(source, destination)], testOptions);
    assert.equal(service.request('R1', request).receipt.replayed, true);
    await service.close(); service = new RepositorySyncService(db, [hosting(destination, source)], testOptions);
    assert.throws(() => service.request('R1', request), /configuration changed/);
    assert.throws(() => service.request('R2', request), /No synchronization targets/);
  } finally { await service.close(); db.close(); }
}));

test('failures redact private diagnostics and retry with bounded backoff after restart', async () => fixtures(async (source, destination) => {
  const db = database(); let now = Date.now(), failures = true, calls = 0;
  const transport: RepositorySyncTransport = { async sync() { calls++; if (failures) throw new Error(`${privateMarker}: https://user:token@example.invalid/private/path`); return { changedRefs: 2 }; } };
  const options = { ...testOptions, now: () => now, transport };
  let service = new RepositorySyncService(db, [observing(source, destination)], options);
  try {
    await service.tick(); const snapshot = service.snapshot('R1');
    assert.equal(snapshot.targets[0]!.state, 'retrying'); assert.equal(snapshot.targets[0]!.consecutiveFailures, 1); assert.ok(!JSON.stringify(snapshot).includes(privateMarker));
    await service.close(); service = new RepositorySyncService(db, [observing(source, destination)], options);
    await service.tick(); assert.equal(calls, 1);
    now += 30_001; failures = false; await service.tick();
    assert.equal(calls, 2); assert.equal(service.snapshot('R1').targets[0]!.consecutiveFailures, 0); assert.equal(service.snapshot('R1').targets[0]!.lastError, null);
  } finally { await service.close(); db.close(); }
}));

test('only one target runs per repository across service instances and requests during a run stay queued', async () => fixtures(async (source, destination) => {
  const db = database(); let release!: () => void, started!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const transport: RepositorySyncTransport = { async sync() { calls++; started(); await new Promise<void>(resolve => { release = resolve; }); return { changedRefs: 0 }; } };
  const binding = observing(source, destination), options = { ...testOptions, transport };
  const first = new RepositorySyncService(db, [binding], options), second = new RepositorySyncService(db, [binding], options);
  try {
    const running = first.tick(); await ready; await second.tick(); assert.equal(calls, 1);
    first.request('R1', input(first)); release(); await running;
    assert.equal(first.snapshot('R1').targets[0]!.state, 'queued');
    const next = second.tick(); await new Promise(resolve => setImmediate(resolve)); release(); await next;
    assert.equal(calls, 2); assert.equal(first.snapshot('R1').targets[0]!.state, 'idle');
  } finally { await first.close(); await second.close(); db.close(); }
}));

test('close cancels active work, persists interruption, and permits retry after restart', async () => fixtures(async (source, destination) => {
  const db = database(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const transport: RepositorySyncTransport = { async sync(_binding, _target, { signal }) { started(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(privateMarker)), { once: true })); return { changedRefs: 0 }; } };
  let service = new RepositorySyncService(db, [observing(source, destination)], { ...testOptions, transport });
  try {
    const pending = service.tick(); await ready; await service.close(); await pending;
    assert.equal(service.snapshot('R1').targets[0]!.state, 'queued'); assert.equal(service.snapshot('R1').recentAttempts[0]!.status, 'interrupted');
    service = new RepositorySyncService(db, [observing(source, destination)], testOptions); await service.tick(); assert.equal(service.snapshot('R1').targets[0]!.state, 'idle');
  } finally { await service.close(); db.close(); }
}));

test('expired crash leases recover durable attempts and do not strand work', async () => fixtures(async (source, destination) => {
  let now = Date.now(); const db = database(); const service = new RepositorySyncService(db, [observing(source, destination)], { ...testOptions, now: () => now });
  try {
    const state = service.snapshot('R1').targets[0]!; state.state = 'running'; state.attempts = 1;
    db.prepare('UPDATE repository_sync_targets SET data=?,next_at=NULL').run(JSON.stringify(state));
    db.prepare('INSERT INTO repository_sync_leases VALUES(?,?,?)').run('R1', 'dead-process', now + 1000);
    db.prepare('INSERT INTO repository_sync_attempts VALUES(?,?,?,?,?,?)').run('SYNC-dead', 'R1', service.snapshot('R1').configuration, 'upstream', now, JSON.stringify({ id: 'SYNC-dead', targetKey: 'upstream', direction: 'fetch', startedAt: new Date(now).toISOString(), finishedAt: null, status: 'running', message: null, changedRefs: null }));
    await service.tick(); assert.equal(service.snapshot('R1').targets[0]!.state, 'running');
    now += 1001; await service.tick(); assert.equal(service.snapshot('R1').targets[0]!.state, 'idle');
    assert.equal(service.snapshot('R1').recentAttempts.find(attempt => attempt.id === 'SYNC-dead')!.status, 'interrupted');
  } finally { await service.close(); db.close(); }
}));

test('Git bindings reject unsafe repository config and symlink roots before running network', async () => fixtures(async (source, destination) => {
  const config = await readFile(join(destination.barePath, 'config'), 'utf8');
  await writeFile(join(destination.barePath, 'config'), `${config}\n[include]\npath = /${privateMarker}\n`);
  const db = database(); let service = new RepositorySyncService(db, [observing(source, destination)], testOptions);
  try {
    await service.tick(); assert.equal(service.snapshot('R1').targets[0]!.state, 'retrying'); assert.ok(!JSON.stringify(service.snapshot('R1')).includes(privateMarker));
    await service.close(); await writeFile(join(destination.barePath, 'config'), config);
    const link = join(destination.root, 'link.git'); await symlink(destination.barePath, link);
    assert.throws(() => new RepositorySyncService(db, [observing(source, destination), { ...hosting(destination, source), repositoryId: 'R2', path: link }], testOptions), /distinct repository IDs/);
    service = new RepositorySyncService(db, [{ ...observing(source, destination), path: link }], testOptions);
    await service.tick(); assert.equal(service.snapshot('R1').targets[0]!.state, 'retrying');
  } finally { await service.close(); db.close(); }
}));

test('credential files must be private regular files and their bytes never enter public status', async () => fixtures(async (_source, destination) => {
  const credential = join(destination.root, 'credentials.json');
  await writeFile(credential, JSON.stringify({ username: 'fixture', token: privateMarker }), { mode: 0o644 }); await chmod(credential, 0o644);
  const binding: RepositorySyncBinding = { repositoryId: 'R1', mode: 'observe', path: destination.barePath, observe: { url: 'https://example.invalid/private.git', credentialFile: credential } };
  const db = database(); const service = new RepositorySyncService(db, [binding]);
  try {
    await service.tick(); assert.match(service.snapshot('R1').targets[0]!.lastError!, /credential file/); assert.equal(JSON.stringify(service.snapshot('R1')).includes(privateMarker), false);
    await chmod(credential, 0o600); await writeFile(credential, JSON.stringify({ username: 'fixture\nAuthorization: malicious', token: privateMarker }));
    service.request('R1', input(service)); await service.tick(); assert.match(service.snapshot('R1').targets[0]!.lastError!, /credential file/);
    await rm(credential); await symlink(join(destination.root, 'missing'), credential);
    service.request('R1', input(service, 'second')); await service.tick(); assert.match(service.snapshot('R1').targets[0]!.lastError!, /credential file/);
  } finally { await service.close(); db.close(); }
}));

test('shared repository lock excludes concurrent writers and cleans up after cancellation or failure', async () => fixtures(async (_source, destination) => {
  const signal = new AbortController().signal; let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = withRepositorySyncLock(destination.barePath, signal, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return 42; });
  await ready; await assert.rejects(withRepositorySyncLock(destination.barePath, signal, async () => 0), /busy/);
  release(); assert.equal(await pending, 42);
  await assert.rejects(withRepositorySyncLock(destination.barePath, signal, async () => { throw new Error('Expected fixture failure'); }), /Expected fixture/);
  assert.equal(await withRepositorySyncLock(destination.barePath, signal, async () => 7), 7);
  const lock = join(destination.barePath, 'phabricator-write.lock'); await mkdir(lock); await writeFile(join(lock, 'owner'), JSON.stringify({ pid: process.pid, host: 'another-host' }));
  await assert.rejects(withRepositorySyncLock(destination.barePath, signal, async () => 0), /busy/);
}));

test('portable operation validator binds repository, configuration, access epoch, and receipt', () => {
  const db = database(); const service = new RepositorySyncService(db, [{ repositoryId: 'R1', path: '/srv/git/repository.git', mode: 'observe', observe: { url: 'https://example.invalid/repository.git' } }], { transport: { async sync() { return { changedRefs: 0 }; } } });
  try {
    const request = input(service), result = service.request('R1', request), envelope = { ...result, canSync: true, cloneUrl: null, accessEpoch: 1 };
    assert.ok(isRepositoryOperations(envelope, 'R1')); assert.ok(validRepositorySyncReceipt(envelope, 'R1', request.requestId, request));
    assert.equal(validRepositorySyncReceipt(envelope, 'R2', request.requestId, request), false);
    assert.equal(validRepositorySyncReceipt(envelope, 'R1', 'other', request), false);
    assert.equal(isRepositoryOperations({ ...envelope, cloneUrl: 'https://user:secret@example.invalid/repo' }), false);
    assert.equal(validRepositorySyncReceipt({ ...envelope, accessEpoch: 2 }, 'R1', request.requestId, request), false);
  } finally { db.close(); }
});

test('accepted local changes immediately queue mirrors inside a parent transaction and repeated notifications coalesce', async () => fixtures(async (source, destination) => {
  const db = database(), service = new RepositorySyncService(db, [hosting(source, destination)], testOptions);
  try {
    await service.tick(); assert.equal(service.snapshot('R1').targets[0]!.state, 'idle');
    db.exec('BEGIN IMMEDIATE'); service.notifyChanged('R1'); db.exec('ROLLBACK');
    assert.equal(service.snapshot('R1').targets[0]!.state, 'idle');
    await source.advanceMain(); db.exec('BEGIN IMMEDIATE'); service.notifyChanged('R1'); service.notifyChanged('R1'); db.exec('COMMIT');
    assert.equal(service.snapshot('R1').targets[0]!.state, 'queued');
    await service.tick(); assert.equal(await refs(source), await refs(destination));
    assert.equal(service.snapshot('R1').targets[0]!.attempts, 2);
    db.exec('BEGIN IMMEDIATE'); const request = input(service); service.request('R1', request); db.exec('ROLLBACK');
    assert.equal(service.snapshot('R1').targets[0]!.state, 'idle'); assert.equal(service.request('R1', request).receipt.replayed, false);
  } finally { await service.close(); db.close(); }
}));

test('time limits cancel transport and keep retry state instead of claiming success', async () => fixtures(async (source, destination) => {
  const db = database();
  const transport: RepositorySyncTransport = { async sync(_binding, _target, { signal }) { await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); }); return { changedRefs: 0 }; } };
  const service = new RepositorySyncService(db, [observing(source, destination)], { ...testOptions, timeoutMs: 50, transport });
  // Keep the event loop alive as production's HTTP listener does; service timers intentionally unref.
  const keepAlive = setInterval(() => undefined, 1000);
  try { await service.tick(); assert.equal(service.snapshot('R1').targets[0]!.state, 'retrying'); assert.match(service.snapshot('R1').targets[0]!.lastError!, /time or result limit/); assert.equal(service.snapshot('R1').targets[0]!.lastSuccessAt, null); }
  finally { clearInterval(keepAlive); await service.close(); db.close(); }
}));

test('mirror rejection is atomic: an unwritable ref leaves other destination refs unchanged', async () => fixtures(async (source, destination) => {
  const before = await refs(destination); await source.advanceMain(); await source.git(['update-ref', 'refs/heads/new', source.head]);
  await writeFile(join(destination.barePath, 'refs', 'heads', 'main.lock'), 'A concurrent receiver owns this lock.\n');
  const db = database(), service = new RepositorySyncService(db, [hosting(source, destination)], testOptions);
  try { await service.tick(); assert.equal(await refs(destination), before); assert.equal(service.snapshot('R1').targets[0]!.state, 'retrying'); }
  finally { await service.close(); db.close(); }
}));

test('observed fetch rejection keeps branch/tag updates and pruning atomic', async () => fixtures(async (source, destination) => {
  const before = await refs(destination); await source.advanceMain(); await source.git(['update-ref', 'refs/tags/new', source.head]); await source.git(['update-ref', '-d', 'refs/heads/feature']);
  await writeFile(join(destination.barePath, 'refs', 'heads', 'main.lock'), 'A concurrent writer owns this lock.\n');
  const db = database(), service = new RepositorySyncService(db, [observing(source, destination)], testOptions);
  try { await service.tick(); assert.equal(await refs(destination), before); assert.equal(service.snapshot('R1').targets[0]!.state, 'retrying'); }
  finally { await service.close(); db.close(); }
}));
