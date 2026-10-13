import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitAutomationStore, initializeGitAutomation, parseGitReceiveFacts, type GitAutomationHooks } from './git-automation.ts';
import { HeraldStore, initializeHerald } from './herald.ts';
import { parseHeraldRuleInput, type HeraldRuleInput } from '../shared/herald.ts';
import { heraldPolicyObjectId, type GitReceiveFacts } from '../shared/git-automation.ts';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const person = { name: 'Contributor', email: 'contributor@example.test', timestamp: '2026-10-13T00:00:00.000Z' };
const facts: GitReceiveFacts = { repositoryId: 'R1', objectFormat: 'sha1', phase: 'pre', requestId: 'trusted-event-1', pusherId: 'alice', inspectionComplete: true, updates: [{ refName: 'refs/heads/main', oldId: a, newId: b, oldCommitId: a, newCommitId: b, forced: false, commits: [{ inspectionComplete: true, commit: { id: b, treeId: c, parentIds: [a], author: person, committer: person, message: 'Add credentials\n\nReview this commit.', messageTruncated: false }, files: [{ path: 'secrets.txt', content: '-old\n+secret-token\n', added: 'secret-token\n', removed: 'old\n' }] }] }] };
const authority = { isEnabledPrincipal: () => true, canManageGlobal: () => true, canEditObject: () => true };
const input: HeraldRuleInput = { name: 'Protect repository', contentType: 'push-content', ruleType: 'object', objectId: 'R1', enabled: true, match: 'all', repetition: 'every', conditions: [{ field: 'always', operator: 'true', value: null }], actions: [{ type: 'block-push', value: 'Remove secrets before pushing.' }] };
function fixture(path = ':memory:') {
  const db = new DatabaseSync(path); initializeHerald(db); initializeGitAutomation(db);
  db.exec('CREATE TABLE IF NOT EXISTS effects(value TEXT)'); const herald = new HeraldStore(db), store = new GitAutomationStore(db, herald);
  const hooks: GitAutomationHooks = { canReceive: value => value.pusherId === 'alice' && value.repositoryId === 'R1', projectIds: () => ['PROJ1'], canEvaluate: () => true, canApply: () => true, apply: (rule, action, snapshot) => { db.prepare('INSERT INTO effects(value) VALUES(?)').run(JSON.stringify([rule.id, action, store.commit(snapshot.objectId)])); return { changed: true, message: 'Build started.' }; } };
  return { db, herald, store, hooks, rule: (patch: Partial<HeraldRuleInput> = {}) => herald.create({ ...input, ...patch }, 'alice', authority) };
}

test('receive inspection validation rejects incomplete, contradictory and forged source facts', () => {
  assert.deepEqual(parseGitReceiveFacts(facts), facts);
  const variations: unknown[] = [];
  for (const patch of [{ inspectionComplete: false }, { objectFormat: 'sha256' }, { pusherId: '' }, { updates: [] }, { ignored: true }]) variations.push({ ...facts, ...patch });
  for (const patch of [{ refName: 'refs/heads/../../escape' }, { refName: 'refs/heads/a.lock' }, { refName: 'refs/heads/a\nb' }, { refName: 'refs/remotes/origin/main' }, { oldId: null }, { newId: '0'.repeat(40) }, { newId: b.toUpperCase() }, { forced: 'false' }]) variations.push({ ...facts, updates: [{ ...facts.updates[0], ...patch }] });
  for (const mutate of [(value: GitReceiveFacts) => { value.updates[0].commits[0].commit.messageTruncated = true; }, (value: GitReceiveFacts) => { value.updates[0].commits[0].files[0].path = '../outside'; }, (value: GitReceiveFacts) => { value.updates[0].commits[0].files[0].added = '\ud800'; }, (value: GitReceiveFacts) => { value.updates.push(structuredClone(value.updates[0])); }, (value: GitReceiveFacts) => { value.updates[0].commits.push(structuredClone(value.updates[0].commits[0])); }]) { const changed = structuredClone(facts); mutate(changed); variations.push(changed); }
  for (const value of variations) assert.throws(() => parseGitReceiveFacts(value), { code: 'GIT_RECEIVE_INVALID' });
  const conflicting = structuredClone(facts); conflicting.updates.push({ ...structuredClone(conflicting.updates[0]), refName: 'refs/heads/second' }); conflicting.updates[1].commits[0].files[0].added = 'different'; assert.throws(() => parseGitReceiveFacts(conflicting), /inconsistent inspection/);
  const tag = { ...facts, updates: [{ refName: 'refs/tags/blob', oldId: null, newId: b, oldCommitId: null, newCommitId: null, forced: false, commits: [] }] }; assert.equal(parseGitReceiveFacts(tag).updates[0].newCommitId, null);
});

test('ref and content rules block whole pushes using exact facts and repository project scope', () => {
  const f = fixture(); try {
    f.rule({ contentType: 'push-ref', objectId: 'PROJ1', conditions: [{ field: 'refName', operator: 'is', value: 'refs/heads/main' }, { field: 'refType', operator: 'is', value: 'branch' }, { field: 'refChange', operator: 'is', value: 'update' }, { field: 'forced', operator: 'false', value: null }], actions: [{ type: 'block-push', value: 'Protected branch.' }] });
    f.rule({ conditions: [{ field: 'body', operator: 'contains', value: 'credentials' }, { field: 'commitId', operator: 'is', value: b }, { field: 'branches', operator: 'contains', value: 'main' }, { field: 'authorRaw', operator: 'contains', value: person.email }, { field: 'committerRaw', operator: 'contains', value: person.name }, { field: 'isMerge', operator: 'false', value: null }, { field: 'diffAdded', operator: 'regexp-pair', value: '["/secrets\\\\.txt$/", "/secret-token/"]' }, { field: 'diffRemoved', operator: 'contains', value: 'old' }] });
    const receipt = f.store.receive(facts, f.hooks); assert.equal(receipt.allowed, false); assert.deepEqual(receipt.reasons, ['Protected branch.', 'Remove secrets before pushing.']); assert.equal(receipt.transcriptIds.length, 2); assert.deepEqual(receipt.commitIds, []);
    const transcripts = receipt.transcriptIds.map(id => f.herald.transcript(id, objectId => f.store.policyObjectId(objectId) === 'R1'));
    assert.deepEqual(transcripts.map(value => value.contentType), ['push-ref', 'push-content']); assert.equal(transcripts[1].rules[0].conditions.length, 8); assert.deepEqual(transcripts[1].snapshot.git?.branches, ['main']);
    assert.equal(heraldPolicyObjectId(transcripts[1].snapshot), 'R1'); assert.equal(transcripts[1].snapshot.authorId, null, 'raw Git identity never impersonates an account'); assert.equal(f.db.prepare('SELECT * FROM effects').all().length, 0);
  } finally { f.db.close(); }
});

test('push errors fail closed, forbidden effects reject, and nonmatching rules permit a push', () => {
  const f = fixture(); try {
    const rule = f.rule({ conditions: [{ field: 'rule', operator: 'conditions', value: 'H999' }] });
    const error = f.store.receive(facts, f.hooks); assert.equal(error.allowed, false); assert.match(error.reasons[0], /could not be safely evaluated/);
    f.herald.update(rule.id, 1, input, 'alice', authority);
    const denied = f.store.receive({ ...facts, requestId: 'denied' }, { ...f.hooks, canApply: () => false }); assert.equal(denied.allowed, false);
    f.herald.update(rule.id, 2, { ...input, conditions: [{ field: 'body', operator: 'contains', value: 'unrelated phrase' }] }, 'alice', authority);
    assert.equal(f.store.receive({ ...facts, requestId: 'safe' }, f.hooks).allowed, true);
    assert.equal(f.store.receive({ ...facts, requestId: 'inactive-author' }, { ...f.hooks, canEvaluate: () => false }).allowed, true, 'inactive author rules are skipped under current authority policy');
  } finally { f.db.close(); }
});

test('receive decisions are immutable and retries recheck authority without repeating effects', () => {
  const f = fixture(); try {
    f.rule(); const receipt = f.store.receive(facts, f.hooks);
    assert.deepEqual(f.store.receive(facts, f.hooks), receipt); assert.equal(f.herald.transcripts({}, () => true).transcripts.length, 2);
    assert.throws(() => f.store.receive({ ...facts, pusherId: 'bob' }, f.hooks), { status: 403 });
    assert.throws(() => f.store.receive(facts, { ...f.hooks, canReceive: () => false }), { status: 403 });
    const changed = structuredClone(facts); changed.updates[0].commits[0].commit.message = 'Different'; assert.throws(() => f.store.receive(changed, f.hooks), { code: 'GIT_RECEIVE_CHANGED' });
    for (const table of ['git_receive_records', 'git_automation_objects']) { assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/); assert.throws(() => f.db.exec(`UPDATE ${table} SET data=data`), /immutable/); }
    assert.throws(() => f.store.receipt(receipt.id, () => false), { status: 404 }); assert.deepEqual(f.store.receipts({}, () => false).receipts, []);
  } finally { f.db.close(); }
});

test('post-receive observes each immutable commit once across refs and pushes and builds verified stored source', () => {
  const f = fixture(); try {
    f.rule({ contentType: 'commit', repetition: 'first', actions: [{ type: 'run-build-plans', targets: ['BP1'] }] });
    const post = { ...structuredClone(facts), phase: 'post' as const }; post.updates.push({ ...structuredClone(post.updates[0]), refName: 'refs/heads/release' });
    const first = f.store.receive(post, f.hooks); assert.equal(first.allowed, true); assert.equal(first.commitIds.length, 1); assert.equal(first.transcriptIds.length, 1); assert.equal(f.db.prepare('SELECT * FROM effects').all().length, 1);
    const source = f.store.commit(first.commitIds[0]); assert.deepEqual(source.commit, facts.updates[0].commits[0].commit); assert.equal(source.repositoryId, 'R1'); assert.deepEqual(f.store.snapshot(first.commitIds[0]).git?.branches, ['main', 'release']);
    const second = f.store.receive({ ...post, requestId: 'another-push', updates: [post.updates[0]] }, f.hooks); assert.deepEqual(second.commitIds, first.commitIds); assert.equal(second.transcriptIds.length, 0); assert.equal(f.db.prepare('SELECT * FROM effects').all().length, 1);
    const changed = structuredClone(post); changed.requestId = 'inconsistent'; changed.updates[0].commits[0].files[0].content = 'corrupt'; changed.updates = [changed.updates[0]]; assert.throws(() => f.store.receive(changed, f.hooks), { code: 'GIT_RECEIVE_CHANGED' });
    const next = structuredClone(post); next.requestId = 'new-commit'; next.updates = [next.updates[0]]; next.updates[0].newId = next.updates[0].newCommitId = 'd'.repeat(40); next.updates[0].commits[0].commit.id = 'd'.repeat(40);
    f.store.receive(next, f.hooks); assert.equal(f.db.prepare('SELECT * FROM effects').all().length, 2, 'first repetition is per commit, never repository-wide');
  } finally { f.db.close(); }
});

test('stored event dry runs do not reject anew, build or consume repetition; authoring limits actions by content type', () => {
  const f = fixture(); try {
    f.rule(); const receipt = f.store.receive(facts, f.hooks), stored = f.herald.transcript(receipt.transcriptIds[1], () => true).snapshot;
    const dry = f.herald.evaluate({ ...stored, eventId: 'dry-inspection' }, f.hooks, true); assert.equal(dry.actions[0].status, 'dry-run'); assert.equal(f.store.receipts({}, () => true).receipts.length, 1); assert.equal(f.db.prepare('SELECT * FROM effects').all().length, 0);
    assert.equal(parseHeraldRuleInput(input).actions[0].type, 'block-push');
    for (const changes of [{ ruleType: 'personal', objectId: null }, { actions: [{ type: 'run-build-plans', targets: ['BP1'] }] }, { actions: [{ type: 'add-self-subscriber' }] }, { contentType: 'commit' }, { contentType: 'revision' }]) assert.throws(() => parseHeraldRuleInput({ ...input, ...changes }));
  } finally { f.db.close(); }
});

test('outer transaction rollback removes receive evidence and per-action failures roll back their partial effects', () => {
  const f = fixture(); try {
    f.rule({ contentType: 'commit', actions: [{ type: 'run-build-plans', targets: ['BP1'] }] });
    f.db.exec('BEGIN'); f.store.receive({ ...facts, phase: 'post' }, f.hooks); f.db.exec('ROLLBACK'); assert.equal(f.store.receipts({}, () => true).receipts.length, 0); assert.equal(f.db.prepare('SELECT * FROM git_automation_objects').all().length, 0); assert.equal(f.db.prepare('SELECT * FROM effects').all().length, 0);
    const receipt = f.store.receive({ ...facts, phase: 'post' }, { ...f.hooks, apply: () => { f.db.prepare('INSERT INTO effects(value) VALUES(?)').run('partial'); throw new Error('provider private details'); } });
    assert.equal(f.db.prepare('SELECT * FROM effects').all().length, 0); const transcript = f.herald.transcript(receipt.transcriptIds[0], () => true); assert.equal(transcript.actions[0].status, 'error'); assert.equal(transcript.actions[0].message.includes('private'), false);
    let checks = 0; assert.throws(() => f.store.receive({ ...facts, requestId: 'revoked' }, { ...f.hooks, canReceive: () => ++checks === 1 }), { status: 403 }); assert.equal(f.store.receipts({}, () => true).receipts.length, 1);
  } finally { f.db.close(); }
});

test('durable receive history survives reopen, paginates with current repository visibility, and rejects schema collisions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'git-automation-')), path = join(directory, 'db.sqlite'); let f = fixture(path);
  try {
    f.rule(); const first = f.store.receive(facts, f.hooks); f.store.receive({ ...facts, requestId: 'second' }, f.hooks); f.db.close(); f = fixture(path);
    assert.deepEqual(f.store.receive(facts, f.hooks), first); assert.deepEqual(f.store.receipt(first.id, id => id === 'R1'), first);
    const page = f.store.receipts({ limit: 1 }, () => true); assert.ok(page.nextBefore); assert.equal(f.store.receipts({ before: page.nextBefore!, limit: 1 }, () => true).receipts[0].id, first.id); assert.deepEqual(f.store.receipts({}, () => false).receipts, []);
  } finally { f.db.close(); rmSync(directory, { recursive: true, force: true }); }
  const db = new DatabaseSync(':memory:'); try { db.exec('CREATE TABLE git_automation_objects(unexpected TEXT)'); assert.throws(() => initializeGitAutomation(db)); assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['git_automation_objects']); } finally { db.close(); }
});
