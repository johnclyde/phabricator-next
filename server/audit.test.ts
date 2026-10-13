import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { auditStatus } from '../shared/audit.ts';
import type { GitAutomationObject } from '../shared/git-automation.ts';
import type { GitCommitResult } from '../shared/repositories.ts';
import { AuditStore, initializeAudit, type AuditHooks } from './audit.ts';
import type { BuildActor } from './harbormaster.ts';
import { initializeGitAutomation } from './git-automation.ts';
import { HttpError } from './validation.ts';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const alice: BuildActor = { principalId: 'alice', displayName: 'Alice', workspaceId: 'workspace' };
const bob: BuildActor = { principalId: 'bob', displayName: 'Bob', workspaceId: 'workspace' };
const reader: BuildActor = { principalId: 'reader', displayName: 'Reader', workspaceId: 'workspace' };
const source: GitCommitResult = { repositoryId: 'R1', objectFormat: 'sha1', commit: { id: 'a'.repeat(40), treeId: 'b'.repeat(40), parentIds: [], author: { name: 'Commit Author', email: 'author@example.test', timestamp: '2020-01-01T00:00:00Z' }, committer: { name: 'Committer', email: 'committer@example.test', timestamp: '2020-01-01T00:00:00Z' }, message: 'Exact committed source\n\nDetailed message.', messageTruncated: false } };
const sourceId = (value: GitCommitResult) => `GC-${hash([value.repositoryId, value.commit.id])}`;
const id = sourceId(source);

function setup(path = ':memory:') {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys=ON');
  initializeAudit(database);
  let now = Date.parse('2026-01-01T00:00:00Z');
  const sources = new Map([[id, structuredClone(source)]]), disabled = new Set<string>(), hidden = new Set<string>();
  const accounts = new Map([alice, bob, reader].map(actor => [actor.principalId, { id: actor.principalId, displayName: actor.displayName }]));
  const hooks: AuditHooks = {
    authorize(actor, repositoryId, write) {
      if (actor.workspaceId !== 'workspace' || disabled.has(actor.principalId) || !accounts.has(actor.principalId)) throw new HttpError(403, 'Disabled.');
      if (repositoryId && hidden.has(`${actor.principalId}:${repositoryId}`)) throw new HttpError(404, 'Unavailable.');
      if (write && actor.principalId === 'reader') throw new HttpError(403, 'Read only.');
    },
    principal(principalId, repositoryId) { return disabled.has(principalId) || hidden.has(`${principalId}:${repositoryId}`) ? null : accounts.get(principalId) ?? null; },
    source(subjectId) { return structuredClone(sources.get(subjectId) ?? null); },
  };
  const audit = new AuditStore(database, hooks, () => now);
  const command = (actor: BuildActor, action: 'concern' | 'accept' | 'resign' | 'comment', comment?: string) => audit.command(id, { expectedVersion: audit.detail(id, actor).audit.version, command: action, ...(comment === undefined ? {} : { comment }) }, actor);
  return { database, audit, hooks, sources, disabled, hidden, accounts, command, tick: () => { now += 1_000; } };
}

test('Audit aggregates original individual-auditor states, ignoring resigned decisions', () => {
  const status = (...values: ('requested' | 'concerned' | 'accepted' | 'resigned')[]) => auditStatus(values.map(status => ({ status })));
  assert.equal(status(), 'none');
  assert.equal(status('resigned'), 'none');
  assert.equal(status('requested', 'resigned'), 'needs-audit');
  assert.equal(status('accepted', 'requested'), 'partially-audited');
  assert.equal(status('accepted', 'resigned'), 'audited');
  assert.equal(status('accepted', 'concerned', 'requested'), 'concern-raised');
});

test('Audit requests, acceptance, concerns, resignation and resumed decisions retain exact source and full history', () => {
  const f = setup();
  try {
    const observed = f.audit.observe(id, alice);
    assert.deepEqual(observed.source, source);
    assert.equal(observed.status, 'none');
    assert.equal(f.audit.observe(id, alice).version, 1);
    let detail = f.audit.request(id, { expectedVersion: 1, auditorIds: ['alice', 'bob'], comment: 'Please check the committed behavior.' }, alice);
    assert.equal(detail.audit.status, 'needs-audit');
    assert.equal(detail.history.events.length, 2);
    f.tick(); detail = f.command(alice, 'accept', 'This is correct.');
    assert.equal(detail.audit.status, 'partially-audited');
    detail = f.command(bob, 'concern', 'The error case needs attention.');
    assert.equal(detail.audit.status, 'concern-raised');
    assert.deepEqual(detail.history.events[0]!.changes, [{ principalId: 'bob', displayName: 'Bob', before: 'requested', after: 'concerned' }]);
    detail = f.command(bob, 'resign');
    assert.equal(detail.audit.status, 'audited');
    detail = f.command(bob, 'concern');
    assert.equal(detail.audit.status, 'concern-raised');
    detail = f.command(bob, 'accept');
    assert.equal(detail.audit.status, 'audited');
    detail = f.command(alice, 'comment', 'Follow-up recorded on this same object.');
    assert.equal(detail.audit.status, 'audited');
    assert.equal(detail.audit.version, 8);
    assert.deepEqual(detail.audit.source, source);
    assert.deepEqual(detail.history.events.map(event => event.action), ['comment', 'accept', 'concern', 'resign', 'concern', 'accept', 'request', 'observed']);
    assert.equal(detail.history.events[0]!.auditVersion, detail.audit.version);
  } finally { f.database.close(); }
});

test('Audit acts only for the authenticated auditor, self-enrolls decisions, and preserves existing requests', () => {
  const f = setup();
  try {
    f.audit.observe(id, alice);
    assert.throws(() => f.command(bob, 'resign'), /active auditor/);
    let detail = f.command(bob, 'accept');
    assert.equal(detail.audit.auditors[0]!.principalId, 'bob');
    assert.equal(detail.audit.status, 'audited');
    assert.throws(() => f.command(bob, 'accept'), /already recorded/);
    assert.throws(() => f.audit.command(id, { expectedVersion: detail.audit.version, command: 'accept', principalId: 'alice' }, bob), /Unknown field/);
    assert.throws(() => f.command(alice, 'comment', '   '), /Write a comment/);
    detail = f.audit.request(id, { expectedVersion: detail.audit.version, auditorIds: ['bob'] }, alice);
    assert.equal(detail.audit.version, 2);
    assert.equal(detail.audit.auditors[0]!.status, 'accepted');
    detail = f.command(bob, 'resign');
    detail = f.audit.request(id, { expectedVersion: detail.audit.version, auditorIds: ['bob'] }, alice);
    assert.equal(detail.audit.auditors[0]!.status, 'resigned');
    assert.equal(detail.audit.status, 'none');
  } finally { f.database.close(); }
});

test('Audit actions enforce optimistic versions, validate all request targets atomically, and reject forged source', () => {
  const f = setup();
  try {
    f.audit.observe(id, alice);
    f.disabled.add('bob');
    assert.throws(() => f.audit.request(id, { expectedVersion: 1, auditorIds: ['alice', 'bob'] }, alice), /active account/);
    assert.equal(f.audit.detail(id, alice).audit.auditors.length, 0);
    f.disabled.delete('bob');
    f.hidden.add('bob:R1');
    assert.throws(() => f.audit.request(id, { expectedVersion: 1, auditorIds: ['bob'] }, alice), /active account/);
    assert.throws(() => f.audit.request(id, { expectedVersion: 1, auditorIds: ['alice', 'alice'] }, alice), /once/);
    assert.throws(() => f.audit.request(id, { expectedVersion: 1, auditorIds: [] }, alice), /between/);
    assert.throws(() => f.audit.request(id, { expectedVersion: 1, auditorIds: ['alice'], source }, alice), /Unknown field/);
    f.command(alice, 'comment', 'Changed version.');
    assert.throws(() => f.audit.command(id, { expectedVersion: 1, command: 'accept' }, alice), (error: unknown) => error instanceof HttpError && error.code === 'AUDIT_CHANGED');
    assert.equal(f.audit.detail(id, alice).audit.version, 2);
    assert.throws(() => f.audit.observe('GP-' + 'a'.repeat(64), alice), /not found/);
    assert.throws(() => f.audit.observe('GC-' + 'e'.repeat(64), alice), /not found/);
    f.sources.set(id, { ...source, commit: { ...source.commit, treeId: 'c'.repeat(40) } });
    assert.throws(() => f.audit.detail(id, alice), /source changed/);
    assert.throws(() => f.audit.observe(id, alice), /source changed/);
    assert.equal((f.database.prepare('SELECT count(*) n FROM audit_events').get() as { n: number }).n, 2);
  } finally { f.database.close(); }
});

test('Audit read and write authority follows current repository policy and current account state', () => {
  const f = setup();
  try {
    f.audit.observe(id, alice);
    assert.equal(f.audit.detail(id, reader).canEdit, false);
    assert.throws(() => f.audit.command(id, { expectedVersion: 1, command: 'accept' }, reader), /Read only/);
    assert.throws(() => f.audit.observe(id, reader), /Read only/);
    f.hidden.add('bob:R1');
    assert.throws(() => f.audit.detail(id, bob), /Unavailable/);
    assert.deepEqual(f.audit.list(bob), { audits: [], nextBefore: null });
    f.hidden.delete('bob:R1');
    assert.equal(f.audit.list(bob).audits.length, 1);
    f.disabled.add('alice');
    assert.throws(() => f.audit.detail(id, alice), /Disabled/);
    assert.throws(() => f.audit.list(alice), /Disabled/);
    assert.throws(() => f.audit.requestFromHerald(id, ['bob'], alice), /Disabled/);
    assert.equal(f.audit.detail(id, bob).audit.version, 1);
  } finally { f.database.close(); }
});

test('Audit personal decisions use current Interact permission without granting repository Edit', () => {
  const f = setup();
  let permitted = true;
  f.hooks.interact = (actor, repositoryId) => {
    f.hooks.authorize(actor, repositoryId, false);
    if (!permitted) throw new HttpError(403, 'Interaction revoked.');
  };
  try {
    f.audit.observe(id, alice);
    let detail = f.audit.detail(id, reader);
    assert.equal(detail.canEdit, false);
    assert.equal(detail.canInteract, true);
    detail = f.command(reader, 'accept');
    assert.equal(detail.audit.status, 'audited');
    assert.throws(() => f.audit.request(id, { expectedVersion: detail.audit.version, auditorIds: ['bob'] }, reader), /Read only/);
    detail = f.command(reader, 'concern');
    assert.equal(detail.audit.status, 'concern-raised');
    f.command(reader, 'comment', 'Reviewing does not need push permission.');
    detail = f.command(reader, 'resign');
    assert.equal(detail.audit.status, 'none');
    permitted = false;
    assert.equal(f.audit.detail(id, reader).canInteract, false);
    assert.throws(() => f.command(reader, 'accept'), /Interaction revoked/);
    permitted = true;
    let calls = 0;
    f.hooks.interact = (actor, repositoryId) => {
      f.hooks.authorize(actor, repositoryId, false);
      if (++calls > 1) throw new HttpError(403, 'Interaction revoked before save.');
    };
    assert.throws(() => f.audit.command(id, { expectedVersion: detail.audit.version, command: 'accept' }, reader), /revoked before save/);
    assert.equal((JSON.parse((f.database.prepare('SELECT data FROM audit_commits WHERE id=?').get(id) as { data: string }).data)).version, detail.audit.version);
  } finally { f.database.close(); }
});

test('Audit history and filtered commit lists page without losing visible records behind hidden repositories', () => {
  const f = setup();
  try {
    f.audit.observe(id, alice);
    for (let number = 0; number < 8; number++) f.command(alice, 'comment', `Comment ${number}`);
    const sequences: number[] = [];
    let before: number | undefined;
    do {
      const page = f.audit.detail(id, alice, { limit: 3, ...(before === undefined ? {} : { before }) }).history;
      sequences.push(...page.events.map(event => event.sequence));
      before = page.nextBefore ?? undefined;
    } while (before !== undefined);
    assert.equal(sequences.length, 9);
    assert.equal(new Set(sequences).size, 9);
    for (let number = 1; number <= 204; number++) {
      const next: GitCommitResult = { ...source, repositoryId: number % 2 ? 'R2' : 'R1', commit: { ...source.commit, id: number.toString(16).padStart(40, '0') } };
      const nextId = sourceId(next); f.sources.set(nextId, next); f.audit.observe(nextId, alice);
    }
    f.hidden.add('bob:R2');
    const all = new Set<string>(); before = undefined;
    do {
      const page = f.audit.list(bob, { limit: 17, ...(before === undefined ? {} : { before }) });
      for (const item of page.audits) { assert.equal(item.source.repositoryId, 'R1'); assert.ok(!all.has(item.id)); all.add(item.id); }
      before = page.nextBefore ?? undefined;
    } while (before !== undefined);
    assert.equal(all.size, 103);
    f.audit.request(id, { expectedVersion: 9, auditorIds: ['alice'] }, alice);
    assert.deepEqual(f.audit.list(alice, { status: 'needs-audit', auditorId: 'alice', repositoryId: 'R1' }).audits.map(item => item.id), [id]);
    assert.throws(() => f.audit.detail(id, alice, { limit: 101 }), /at most 100/);
    assert.throws(() => f.audit.list(alice, { before: 0 }), /positive integer/);
  } finally { f.database.close(); }
});

test('Herald auditor requests are idempotent and reveal no private rule details', () => {
  const f = setup();
  try {
    let detail = f.audit.requestFromHerald(id, ['bob'], alice);
    assert.equal(detail.audit.status, 'needs-audit');
    assert.equal(detail.history.events[0]!.origin, 'herald');
    assert.equal(detail.history.events[0]!.comment, '');
    assert.equal(detail.audit.version, 2);
    detail = f.audit.requestFromHerald(id, ['bob'], alice);
    assert.equal(detail.audit.version, 2);
    f.command(bob, 'accept');
    detail = f.audit.requestFromHerald(id, ['bob'], alice);
    assert.equal(detail.audit.status, 'audited');
    assert.equal(detail.audit.version, 3);
    assert.equal(detail.history.events.length, 3);
  } finally { f.database.close(); }
});

test('Audit changes revalidate write authority before persistence and roll back on a history failure', () => {
  const f = setup();
  try {
    f.audit.observe(id, alice);
    const original = f.hooks.principal;
    f.hooks.principal = (...args) => { const result = original(...args); f.disabled.add('alice'); return result; };
    assert.throws(() => f.audit.request(id, { expectedVersion: 1, auditorIds: ['bob'] }, alice), /Disabled/);
    f.disabled.delete('alice'); f.hooks.principal = original;
    assert.equal(f.audit.detail(id, alice).audit.version, 1);
    f.database.exec("CREATE TRIGGER reject_audit_event BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'Simulated history failure'); END");
    assert.throws(() => f.command(alice, 'accept'), /Simulated history/);
    assert.equal(f.audit.detail(id, alice).audit.version, 1);
    assert.equal(f.audit.detail(id, alice).audit.auditors.length, 0);
  } finally { f.database.close(); }
});

test('Audit preserves immutable evidence on disk, rejects conflicting schema, and protects history/source', () => {
  const root = mkdtempSync(join(tmpdir(), 'audit-store-')), path = join(root, 'workspace.sqlite');
  const f = setup(path);
  try {
    f.audit.observe(id, alice); f.command(bob, 'accept'); f.database.close();
    const database = new DatabaseSync(path); initializeAudit(database);
    const reopened = new AuditStore(database, f.hooks);
    assert.equal(reopened.detail(id, alice).audit.status, 'audited');
    assert.equal(reopened.detail(id, alice).history.events.length, 2);
    assert.throws(() => database.exec("UPDATE audit_commits SET source='{}'"), /immutable/);
    assert.throws(() => database.exec('DELETE FROM audit_commits'), /immutable/);
    assert.throws(() => database.exec("UPDATE audit_events SET data='{}'"), /immutable/);
    assert.throws(() => database.exec('DELETE FROM audit_events'), /immutable/);
    database.close();
    const collision = new DatabaseSync(':memory:');
    collision.exec('CREATE TABLE audit_commits(id TEXT PRIMARY KEY,data TEXT)');
    assert.throws(() => initializeAudit(collision), /Unexpected audit_commits schema/);
    assert.equal(collision.prepare("SELECT 1 FROM sqlite_master WHERE name='audit_events'").get(), undefined);
    collision.close();
  } finally { try { f.database.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
});

function savedSource(value: GitCommitResult): GitAutomationObject {
  const subjectId = sourceId(value);
  return { id: subjectId, repositoryId: value.repositoryId, kind: 'commit', objectFormat: value.objectFormat, commit: { commit: structuredClone(value.commit), files: [], inspectionComplete: true }, snapshot: { objectId: subjectId, eventId: 'git-receive:original', actorId: 'original-pusher', isNew: true, contentType: 'commit', comment: '', title: value.commit.message, body: value.commit.message, status: '', priority: null, authorId: null, ownerId: null, repositoryId: value.repositoryId, projectIds: [], subscriberIds: [], reviewerIds: [], files: [], version: 1, versionId: value.commit.id, contentHash: 'historical' } };
}
test('Audit migration backfills exact historical commits once without rewriting their original evidence', () => {
  const database = new DatabaseSync(':memory:');
  try {
    initializeGitAutomation(database);
    const original = savedSource(source), originalData = JSON.stringify(original);
    database.prepare('INSERT INTO git_automation_objects VALUES(?,?,?,?,?)').run(id, source.repositoryId, 'commit', hash(original), originalData);
    const sha256 = savedSource({ ...source, objectFormat: 'sha256', commit: { ...source.commit, id: 'c'.repeat(64), treeId: 'd'.repeat(64) } });
    database.prepare('INSERT INTO git_automation_objects VALUES(?,?,?,?,?)').run(sha256.id, source.repositoryId, 'commit', hash(sha256), JSON.stringify(sha256));
    initializeAudit(database);
    const before = database.prepare('SELECT * FROM audit_commits ORDER BY sequence').all();
    assert.equal(before.length, 2);
    const events = database.prepare('SELECT data FROM audit_events').all() as { data: string }[];
    assert.ok(events.every(row => JSON.parse(row.data).actorId === 'original-pusher'));
    initializeAudit(database);
    assert.deepEqual(database.prepare('SELECT * FROM audit_commits ORDER BY sequence').all(), before);
    assert.deepEqual(database.prepare('SELECT data FROM audit_events').all(), events);
    assert.equal((database.prepare('SELECT data FROM git_automation_objects WHERE id=?').get(id) as { data: string }).data, originalData);
  } finally { database.close(); }
});

test('Audit migration rolls back if historical source evidence is corrupt or belongs to another commit', () => {
  for (const corrupt of ['hash', 'identity', 'format']) {
    const database = new DatabaseSync(':memory:');
    try {
      initializeGitAutomation(database);
      const original = savedSource(source);
      if (corrupt === 'identity') original.commit!.commit.id = 'e'.repeat(40);
      if (corrupt === 'format') original.objectFormat = 'sha256';
      database.prepare('INSERT INTO git_automation_objects VALUES(?,?,?,?,?)').run(id, source.repositoryId, 'commit', corrupt === 'hash' ? 'forged' : hash(original), JSON.stringify(original));
      assert.throws(() => initializeAudit(database), /cannot verify|invalid/);
      assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='audit_commits'").get(), undefined);
    } finally { database.close(); }
  }
});
