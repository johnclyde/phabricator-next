import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeraldStore, initializeHerald, heraldRegexp, type HeraldAuthority, type HeraldHooks } from './herald.ts';
import type { HeraldRuleInput, HeraldSnapshot } from '../shared/herald.ts';
const input: HeraldRuleInput = { name: 'Notify interested people', contentType: 'revision', ruleType: 'global', objectId: null, enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'title', operator: 'contains', value: 'duck' }], actions: [{ type: 'add-subscribers', targets: ['bob'] }] };
const snapshot: HeraldSnapshot = { objectId: 'D1', eventId: 'event1', contentType: 'revision', actorId: 'alice', isNew: false, title: 'A duck revision', body: 'Description', comment: '', status: 'needs_review', priority: null, authorId: 'alice', ownerId: null, repositoryId: 'R1', projectIds: ['PROJ1'], subscriberIds: [], reviewerIds: [], files: [{ path: 'src/a.ts', content: 'source' }], version: 1, versionId: 'v1', contentHash: 'a'.repeat(64) };
const authority: HeraldAuthority = { isEnabledPrincipal: value => ['alice', 'bob'].includes(value), canManageGlobal: value => value === 'alice', canEditObject: (value, id) => value === 'alice' && id === 'R1' };
const fixture = () => { const db = new DatabaseSync(':memory:'); initializeHerald(db); db.exec('CREATE TABLE effects(value TEXT)'); const store = new HeraldStore(db); let calls = 0; const hooks: HeraldHooks = { canEvaluate: () => true, canApply: () => true, apply: (_rule, action) => { calls++; db.prepare('INSERT INTO effects(value) VALUES(?)').run(JSON.stringify(action)); return { changed: true, message: 'Applied.' }; } }; return { db, store, hooks, calls: () => calls }; };

test('Herald rule authority, immutable scope, exact versions, disable/reactivate, and history are durable', () => {
  const f = fixture(); try {
    assert.throws(() => f.store.create(input, 'bob', authority), { status: 403 });
    assert.throws(() => f.store.create({ ...input, ruleType: 'object', objectId: 'R2' }, 'alice', authority), { status: 403 });
    const rule = f.store.create(input, 'alice', authority); assert.equal(rule.id, 'H1'); assert.deepEqual(f.store.get(rule.id), rule);
    assert.throws(() => f.store.update(rule.id, 1, { ...input, ruleType: 'personal' }, 'alice', authority), { status: 400 });
    const disabled = f.store.update(rule.id, 1, { ...input, enabled: false }, 'alice', authority); assert.equal(disabled.version, 2); assert.equal(disabled.enabled, false);
    assert.throws(() => f.store.update(rule.id, 1, input, 'alice', authority), { status: 409 });
    assert.equal(f.store.update(rule.id, 2, { ...input, enabled: false }, 'alice', authority).version, 2);
    assert.equal(f.store.update(rule.id, 2, input, 'alice', authority).version, 3);
    assert.deepEqual(f.store.history(rule.id).versions.map(entry => entry.rule.version), [3, 2, 1]);
    assert.equal(f.store.history(rule.id, undefined, 2).nextBefore, 2); assert.equal(f.store.history(rule.id, 2).versions[0].rule.version, 1);
    for (const sql of ['DELETE FROM herald_rule_versions', 'UPDATE herald_rule_versions SET version=version']) assert.throws(() => f.db.exec(sql), /immutable/);
    const personal = f.store.create({ ...input, ruleType: 'personal', actions: [{ type: 'add-self-subscriber' }] }, 'bob', authority); assert.throws(() => f.store.update(personal.id, 1, { ...input, ruleType: 'personal', actions: [{ type: 'add-self-subscriber' }] }, 'alice', authority), { status: 403 });
  } finally { f.db.close(); }
});

test('events apply once, retries preserve transcripts, altered identities conflict, and dry runs never consume repetition', () => {
  const f = fixture(); try {
    f.store.create({ ...input, repetition: 'first' }, 'alice', authority);
    const dry = f.store.evaluate(snapshot, f.hooks, true); assert.equal(dry.actions[0].status, 'dry-run'); assert.equal(f.calls(), 0);
    assert.deepEqual(f.db.prepare('SELECT * FROM herald_rule_state').all(), []);
    const live = f.store.evaluate(snapshot, f.hooks); assert.equal(live.actions[0].status, 'applied'); assert.equal(f.calls(), 1);
    assert.deepEqual(f.store.evaluate(snapshot, f.hooks), live); assert.equal(f.calls(), 1);
    assert.throws(() => f.store.evaluate({ ...snapshot, title: 'Different' }, f.hooks), { status: 409, code: 'HERALD_EVENT_CHANGED' });
    assert.equal(f.store.evaluate({ ...snapshot, eventId: 'event2' }, f.hooks).rules[0].status, 'already-applied');
    assert.equal(f.store.evaluate(snapshot, f.hooks, true).actions[0].status, 'dry-run'); assert.equal(f.calls(), 1);
    for (const sql of ['DELETE FROM herald_transcripts', 'UPDATE herald_transcripts SET data=data']) assert.throws(() => f.db.exec(sql), /immutable/);
  } finally { f.db.close(); }
});

test('action failures rollback their partial writes, continue other effects, and recheck authority each time', () => {
  const f = fixture(); try {
    f.store.create({ ...input, actions: [{ type: 'comment', value: 'failing' }, { type: 'comment', value: 'okay' }, { type: 'comment', value: 'revoked' }] }, 'alice', authority);
    let checks = 0;
    const result = f.store.evaluate(snapshot, { ...f.hooks, canApply: () => ++checks < 3, apply: (_rule, action) => { f.db.prepare('INSERT INTO effects(value) VALUES(?)').run(JSON.stringify(action)); if ('value' in action && action.value === 'failing') throw new Error('private internal details'); return { changed: true, message: 'Applied.' }; } });
    assert.deepEqual(result.actions.map(action => action.status), ['error', 'applied', 'forbidden']);
    assert.equal(result.actions[0].message.includes('private internal'), false); assert.equal((f.db.prepare('SELECT count(*) AS n FROM effects').get() as { n: number }).n, 1);
    assert.equal(checks, 3);
  } finally { f.db.close(); }
});

test('all rule conditions use original source and outer mutation rollback removes effects, transcripts, state, and IDs', () => {
  const f = fixture(); try {
    f.db.exec('BEGIN'); f.store.create(input, 'alice', authority); f.store.evaluate(snapshot, f.hooks); f.db.exec('ROLLBACK');
    assert.deepEqual(f.store.list().rules, []); assert.deepEqual(f.store.transcripts({}, () => true).transcripts, []); assert.equal(f.store.create(input, 'alice', authority).id, 'H1');
    f.store.create(input, 'alice', authority);
    const result = f.store.evaluate(snapshot, { ...f.hooks, apply: (_rule, _action, current) => { current.title = 'changed'; current.files[0].content = 'changed'; return { changed: true, message: 'Applied.' }; } });
    assert.equal(result.actions.length, 2); assert.equal(result.snapshot.title, snapshot.title); assert.equal(result.snapshot.files[0].content, 'source');
  } finally { f.db.close(); }
});

test('transcript reading filters current object permission before loading data and pagination advances through hidden objects', () => {
  const f = fixture(); try {
    f.store.create(input, 'alice', authority);
    const visible = f.store.evaluate(snapshot, f.hooks); f.store.evaluate({ ...snapshot, objectId: 'D2', eventId: 'event2' }, f.hooks);
    assert.throws(() => f.store.transcript(visible.id, () => false), { status: 404 });
    assert.deepEqual(f.store.transcripts({}, id => id === 'D1').transcripts.map(value => value.id), [visible.id]);
    const page = f.store.transcripts({ limit: 1 }, () => true); assert.ok(page.nextBefore); assert.equal(f.store.transcripts({ before: page.nextBefore!, limit: 1 }, () => true).transcripts[0].id, visible.id);
    assert.equal(f.store.transcripts({ objectId: 'D1' }, () => true).transcripts.length, 1);
  } finally { f.db.close(); }
});

test('bounded regex handles flags and paired patterns, rejects PCRE-only syntax, and interrupts pathological backtracking', () => {
  assert.equal(heraldRegexp('/duck/i', ['DUCK']), true); assert.equal(heraldRegexp('/duck/', ['DUCK']), false);
  assert.throws(() => heraldRegexp('/(a+)+$/', [`${'a'.repeat(100_000)}!`], 10), /bounded/);
  const f = fixture(); try {
    for (const value of ['duck', '/duck/g', '/duck/ii', '/(?P<name>duck)/']) assert.throws(() => f.store.create({ ...input, conditions: [{ field: 'title', operator: 'regexp', value }] }, 'alice', authority), { status: 400 });
    f.store.create({ ...input, conditions: [{ field: 'fileContent', operator: 'regexp-pair', value: '["/\\\\.ts$/", "/source/"]' }] }, 'alice', authority);
    assert.equal(f.store.evaluate(snapshot, f.hooks).actions.length, 1);
  } finally { f.db.close(); }
});

test('rules and repetition state survive closing and reopening without touching unrelated data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'herald-')), path = join(directory, 'db.sqlite'); let db = new DatabaseSync(path);
  try { db.exec('CREATE TABLE existing(value TEXT); INSERT INTO existing VALUES(\'kept\')'); initializeHerald(db); let store = new HeraldStore(db); store.create({ ...input, repetition: 'first', actions: [{ type: 'nothing' }] }, 'alice', authority); const hooks: HeraldHooks = { canEvaluate: () => true, canApply: () => true, apply: () => { throw new Error('nothing should not invoke'); } }; const transcript = store.evaluate(snapshot, hooks); db.close(); db = new DatabaseSync(path); initializeHerald(db); store = new HeraldStore(db); assert.equal(store.list().rules[0].id, 'H1'); assert.equal(store.evaluate({ ...snapshot, eventId: 'second' }, hooks).rules[0].status, 'already-applied'); assert.deepEqual(store.transcript(transcript.id, () => true), transcript); assert.equal((db.prepare('SELECT value FROM existing').get() as { value: string }).value, 'kept'); }
  finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('schema collisions roll back initialization and evidence corruption is rejected', () => {
  const collision = new DatabaseSync(':memory:'); try { collision.exec('CREATE TABLE herald_meta(unexpected TEXT)'); assert.throws(() => initializeHerald(collision)); assert.deepEqual(collision.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['herald_meta']); } finally { collision.close(); }
  const f = fixture(); try {
    const first = f.store.create(input, 'alice', authority); f.store.update(first.id, 1, { ...input, name: 'Renamed' }, 'alice', authority);
    f.db.prepare('UPDATE herald_rules SET version=1,data=? WHERE id=?').run(JSON.stringify(first), first.id); assert.throws(() => f.store.get(first.id), { code: 'HERALD_INTEGRITY' });
  } finally { f.db.close(); }
  const g = fixture(); try {
    const transcript = g.store.evaluate(snapshot, g.hooks); g.db.exec('DROP TRIGGER herald_transcripts_no_update'); g.db.prepare("UPDATE herald_transcripts SET data=json_set(data,'$.snapshot.title','Corrupt') WHERE id=?").run(transcript.id);
    assert.throws(() => g.store.transcript(transcript.id, () => false), { status: 404 }); assert.throws(() => g.store.transcript(transcript.id, () => true), { code: 'HERALD_INTEGRITY' });
  } finally { g.db.close(); }
});
