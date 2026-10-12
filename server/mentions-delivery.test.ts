import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from './store.ts';
import { createAuth } from './auth.ts';
import { isStoredMentionProof, mentionRequestHash } from './mentions.ts';
import { REVISION_SUBSCRIPTION_LIMITS } from '../shared/revision-subscriptions.ts';
import { OBJECT_SUBSCRIPTION_LIMITS } from '../shared/object-subscriptions.ts';
import type { ActorAttribution, ReviewComment } from '../shared/types.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

const actor = (principalId: string): ActorAttribution => ({ principalId, displayName: principalId.toUpperCase(), credentialId: null, requestId: `request-${principalId}` });
const alice = actor('alice'), bob = actor('bob'), carol = actor('carol');
const epoch = (store: Store) => Number(store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value);
const raw = (store: Store, table: string) => store.database.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).all();
function fixture(notify = true) {
  const store = new Store({ path: ':memory:' }), hidden = new Set<string>(), resolutions: string[] = [];
  createAuth({ database: store.database, mode: 'local', basePath: '/' });
  for (const person of [alice, bob, carol]) store.database.prepare("INSERT INTO auth_accounts(id,username,display_name,salt,password_hash) VALUES(?,?,?,'fixture','fixture')").run(person.principalId, person.principalId, person.displayName);
  const enabled = (id: string) => Boolean(store.database.prepare('SELECT 1 FROM auth_accounts WHERE id=? AND disabled=0').get(id));
  store.configureMentions({ resolve: (id, username, by) => {
    resolutions.push(username);
    if (!enabled(by.principalId)) return null;
    const person = store.database.prepare('SELECT id,display_name FROM auth_accounts WHERE username=? AND disabled=0').get(username) as { id: string; display_name: string } | undefined;
    return person && !hidden.has(`${id}:${person.id}`) ? { principalId: person.id, displayName: person.display_name } : null;
  } });
  if (notify) store.notifications.configure({ eligible: enabled, canView: (id, person) => !hidden.has(`${id}:${person}`) });
  const inbox = (person = bob) => store.notifications.list(person.principalId, { limit: 100 }, epoch(store));
  const revision = (draft = false) => store.createRevision({ title: 'Manuscript', testPlan: 'Read the exact text.', kind: 'paper', draft, files: [{ path: 'paper.tex', content: 'Original passage\n' }] }, alice);
  const follow = (id: string, action: 'subscribe' | 'unsubscribe' | 'mute' | 'unmute', person = bob) => {
    const s = store.revisionSubscriptions.snapshot(id, person.principalId), common = { action, principalId: person.principalId, expectedAuthorVersion: s.authorVersion, expectedReviewerVersion: s.reviewerVersion, expectedAccessEpoch: epoch(store) };
    return store.revisionSubscriptions.mutate(id, action === 'subscribe' || action === 'unsubscribe' ? { ...common, action, expectedSubscriptionVersion: s.viewer.version } : { ...common, action, expectedMuteVersion: s.mute.version }, person);
  };
  const pasteFollow = (id: string, action: 'subscribe' | 'unsubscribe' | 'mute' | 'unmute', person = bob) => {
    const s = store.objectSubscriptions.snapshot(id, person.principalId), common = { principalId: person.principalId, expectedAccessEpoch: epoch(store) };
    return store.objectSubscriptions.mutate(id, action === 'subscribe' || action === 'unsubscribe' ? { ...common, action, expectedSubscriptionVersion: s.viewer.version } : { ...common, action, expectedMuteVersion: s.mute.version }, person);
  };
  return { store, hidden, resolutions, inbox, revision, follow, pasteFollow };
}

test('paper mentions bind repeated tokens once, override opt-out, preserve mute and acceptance, and group delivery', () => {
  const f = fixture(), { store } = f;
  try {
    const detail = f.revision(), id = detail.revision.id, version = detail.versions[0]!;
    store.saveReview(id, 1, { provider: 'local', model: 'test', summary: 'Read.', findings: [] }, alice);
    lifecycleAction(store, id, 'accept_reviewed', alice);
    f.follow(id, 'unsubscribe'); f.follow(id, 'mute');
    const source = raw(store, 'versions'), lifecycle = raw(store, 'revision_lifecycle'), evidence = raw(store, 'reviews'), entity = store.detail(id).revision;
    const beforeEvents = raw(store, 'notification_events').length;
    const body = 'Ask @BOB and @bob, then @carol; @alice already follows. `@ignored`';
    const comment = store.createComment(id, { body, versionId: version.id, filePath: 'paper.tex', passage: { start: 0, end: 8, quote: 'Original' } }, alice);
    assert.ok(isStoredMentionProof(comment.mentions, body));
    assert.equal(f.resolutions.filter(name => name === 'bob').length, 1);
    assert.deepEqual(comment.mentions!.tokens.map(token => token.principalId), ['bob', 'bob', 'carol', 'alice']);
    assert.equal(store.revisionSubscriptions.status(id, 'bob').state, 'subscribed');
    assert.equal(store.revisionSubscriptions.snapshot(id, 'bob').mute.muted, true);
    assert.equal(f.inbox().items.length, 0); assert.equal(f.inbox(carol).items.length, 1);
    assert.equal(f.inbox(carol).items[0]!.event.cause.id, comment.id);
    assert.equal(raw(store, 'notification_events').length, beforeEvents + 1);
    const mentions = store.revisionSubscriptions.history(id).transactions.filter(t => t.reason === 'mention');
    assert.equal(mentions.length, 2); assert.ok(mentions.every(t => t.commentId === null && t.mentionCommentId === comment.id));
    assert.deepEqual(mentions.find(t => t.principalId === 'bob')?.before, 'unsubscribed');
    assert.deepEqual(raw(store, 'versions'), source); assert.deepEqual(raw(store, 'reviews'), evidence); assert.deepEqual(raw(store, 'revision_lifecycle'), lifecycle); assert.deepEqual(store.detail(id).revision, entity);
  } finally { store.close(); }
});

test('historical replies retain original anchors and mention roles remain verifiable after author handoff', () => {
  const f = fixture(), { store } = f;
  try {
    const detail = f.revision(), id = detail.revision.id, first = detail.versions[0]!;
    const root = store.createComment(id, { body: 'Question.', versionId: first.id, filePath: 'paper.tex', line: 1 }, alice);
    const current = store.createVersion(id, { expectedVersion: 1, files: [{ path: 'paper.tex', content: 'Revised passage' }], message: 'Revision' }, alice).versions.at(-1)!;
    const reply = store.createReply(id, root.threadId!, { body: '@bob please inspect the original.', viewedVersionId: current.id }, alice);
    assert.equal(reply.versionId, first.id); assert.equal(reply.viewedVersionId, current.id); assert.equal(reply.line, root.line);
    const event = f.inbox().items[0]!.event; assert.equal(event.context.kind, 'revision'); if (event.context.kind === 'revision') assert.equal(event.context.head!.versionId, first.id);
    const s = store.revisionAuthorship.snapshot(id);
    store.revisionAuthorship.mutate(id, { action: 'assign', authorId: 'bob', message: '', expectedAuthorVersion: s.authorship.version, expectedReviewerVersion: s.reviewerVersion, expectedLifecycleVersion: s.lifecycleVersion, expectedVersion: s.head.number, expectedVersionId: s.head.versionId, expectedContentHash: s.head.contentHash, expectedAccessEpoch: epoch(store) }, alice, { principalId: 'bob', displayName: bob.displayName });
    assert.ok(store.revisionSubscriptions.status(id, 'bob').automatic.includes('author'));
    assert.equal(store.revisionSubscriptions.history(id).transactions.find(t => t.reason === 'mention')!.mentionCommentId, reply.id);
    const before = store.revisionSubscriptions.history(id).transactions.length;
    store.createReply(id, root.threadId!, { body: '@bob now owns this revision.', viewedVersionId: current.id }, alice);
    assert.equal(store.revisionSubscriptions.history(id).transactions.length, before, 'automatic author is not explicitly subscribed again');
  } finally { store.close(); }
});

test('task mentions preserve task version and verify their immutable cause after later owner changes', () => {
  const f = fixture(), { store } = f;
  try {
    const task = store.createTask({ title: 'Argument review', ownerId: 'bob' }, alice);
    store.updateTaskSubscription(task.id, { principalId: 'carol', action: 'unsubscribe', expectedMembershipVersion: 0 }, carol);
    store.taskNotifications.mutate(task.id, 'carol', { action: 'mute', expectedMuteVersion: 0, expectedAccessEpoch: epoch(store) }, carol);
    const before = raw(store, 'notification_events').length;
    const comment = store.createTaskComment(task.id, { body: '@bob owns this; @carol and @CAROL please review.' }, alice);
    assert.ok(isStoredMentionProof(comment.mentions, comment.comment!));
    const history = store.taskHistory(task.id).transactions;
    const effect = history.find(t => t.subscription?.reason === 'mentioned')!;
    assert.equal(effect.subscription!.commentId, comment.id); assert.equal(effect.subscription!.principalId, 'carol'); assert.equal(effect.taskVersion, task.version);
    assert.equal(store.taskDetail(task.id).task.version, task.version); assert.equal(store.subscriptionStatus(task.id, 'carol').subscribed, true);
    assert.equal(raw(store, 'notification_events').length, before + 1);
    assert.equal(f.inbox(carol).items.length, 0); assert.equal(f.inbox().items[0]!.event.kind, 'task_commented');
    store.updateTask(task.id, { expectedVersion: task.version, ownerId: 'carol' }, alice);
    assert.equal(store.taskHistory(task.id).transactions.find(t => t.id === effect.id)!.subscription!.commentId, comment.id);
  } finally { store.close(); }
});

test('Paste mentions use normalized comment bytes and the historical content version, with author auto-follow intact', () => {
  const f = fixture(), { store } = f;
  try {
    const paste = store.pastes.create({ title: 'Quoted evidence', content: 'old\r\n' }, alice);
    store.pastes.update(paste.id, { expectedVersion: 1, content: 'new' }, alice);
    f.pasteFollow(paste.id, 'unsubscribe'); f.pasteFollow(paste.id, 'mute');
    const before = raw(store, 'notification_events').length, versions = raw(store, 'paste_versions');
    const comment = store.pastes.comment(paste.id, { contentVersion: 1, body: '  @bob @carol @alice\n ' }, alice);
    assert.equal(comment.comment, '@bob @carol @alice'); assert.ok(isStoredMentionProof(comment.mentions, comment.comment!));
    assert.equal(comment.contentHash, createHash('sha256').update('old\r\n').digest('hex')); assert.equal(comment.pasteVersion, 2);
    const history = store.objectSubscriptions.history(paste.id).transactions;
    assert.equal(history.filter(t => t.reason === 'mention').length, 2); assert.ok(history.filter(t => t.reason === 'mention').every(t => t.commentId === null && t.mentionCommentId === comment.id));
    assert.equal(store.objectSubscriptions.status(paste.id, 'alice').state, null);
    assert.equal(f.inbox().items.length, 0); assert.equal(f.inbox(carol).items.length, 1);
    assert.deepEqual(f.inbox(carol).items[0]!.event.context, { kind: 'paste', pasteVersion: 2, contentVersion: 1, contentHash: comment.contentHash });
    assert.equal(raw(store, 'notification_events').length, before + 1); assert.deepEqual(raw(store, 'paste_versions'), versions);
  } finally { store.close(); }
});

test('unknown, disabled and inaccessible people stay unresolved; retries never reinterpret them', () => {
  const f = fixture(), { store } = f;
  try {
    const detail = f.revision(), id = detail.revision.id;
    f.hidden.add(`${id}:bob`); store.database.prepare('UPDATE auth_accounts SET disabled=1 WHERE id=?').run('carol');
    const input = { body: '@bob @carol @future', versionId: detail.versions[0]!.id }, key = 'same-original-comment', fingerprint = 'exact-comment';
    const response = store.mutate(key, fingerprint, () => ({ status: 201, body: store.createComment(id, input, alice) }));
    assert.deepEqual((response.body as ReviewComment).mentions!.tokens.map(t => t.principalId), [null, null, null]);
    f.hidden.clear(); store.database.prepare('UPDATE auth_accounts SET disabled=0').run();
    store.database.prepare("INSERT INTO auth_accounts(id,username,display_name,salt,password_hash) VALUES('future','future','Future','fixture','fixture')").run();
    const resolved = f.resolutions.length, events = raw(store, 'notification_events');
    assert.deepEqual(store.mutate(key, fingerprint, () => { throw new Error('Must never run'); }), response);
    assert.equal(f.resolutions.length, resolved); assert.deepEqual(raw(store, 'notification_events'), events);
    assert.equal(store.revisionSubscriptions.effective(id, 'bob'), false); assert.equal(store.revisionSubscriptions.effective(id, 'future'), false);
    const next = store.createComment(id, input, alice); assert.deepEqual(next.mentions!.tokens.map(t => t.principalId), ['bob', 'carol', 'future']);
  } finally { store.close(); }
});

test('mention proofs bind only the original request work, with context restored after success, replay and failure', () => {
  const f = fixture(), { store } = f;
  try {
    const detail = f.revision(), id = detail.revision.id, input = { body: '@bob', versionId: detail.versions[0]!.id };
    const direct = () => store.createComment(id, input, alice);
    assert.equal(direct().mentions!.requestSha256, undefined);
    const key = 'scoped-comment-key', fingerprint = 'original-input';
    const result = store.mutate(key, fingerprint, () => ({ status: 201, body: direct() }), undefined, (value, replayed) => {
      assert.equal(replayed, false);
      assert.equal(direct().mentions!.requestSha256, undefined, 'presentation is outside the request resolution context');
      return value;
    });
    assert.equal((result.body as ReviewComment).mentions!.requestSha256, mentionRequestHash(key, fingerprint));
    assert.equal(direct().mentions!.requestSha256, undefined);
    const resolutionCount = f.resolutions.length;
    assert.deepEqual(store.mutate(key, fingerprint, () => { throw new Error('Replay must not resolve or write'); }), result);
    assert.equal(f.resolutions.length, resolutionCount);
    assert.equal(direct().mentions!.requestSha256, undefined);
    const second = store.mutate('other-scoped-key', fingerprint, () => ({ status: 201, body: direct() }));
    assert.notEqual((second.body as ReviewComment).mentions!.requestSha256, (result.body as ReviewComment).mentions!.requestSha256);
    const unkeyed = store.mutate(undefined, fingerprint, () => ({ status: 201, body: direct() }));
    assert.equal((unkeyed.body as ReviewComment).mentions!.requestSha256, mentionRequestHash(undefined, fingerprint));
    assert.equal(direct().mentions!.requestSha256, undefined);
    assert.throws(() => store.mutate('work-failed', fingerprint, () => { direct(); throw new Error('work failed'); }), /work failed/);
    assert.equal(direct().mentions!.requestSha256, undefined, 'a failed work callback cannot leak its request context');
    assert.equal(store.replay('work-failed', fingerprint), undefined);
    assert.throws(() => store.mutate('present-failed', fingerprint, () => ({ status: 201, body: direct() }), undefined, () => { throw new Error('present failed'); }), /present failed/);
    assert.equal(direct().mentions!.requestSha256, undefined, 'a failed presentation cannot leak its request context');
    assert.equal(store.replay('present-failed', fingerprint), undefined);
  } finally { store.close(); }
});

test('one request context reaches revision replies, task comments and Paste comments without changing direct-call shapes', () => {
  const f = fixture(), { store } = f;
  try {
    const detail = f.revision(), root = store.createComment(detail.revision.id, { body: 'Original question.', versionId: detail.versions[0]!.id }, alice);
    const task = store.createTask({ title: 'Review mentions' }, alice), paste = store.pastes.create({ content: 'Source' }, alice);
    const writes = [
      () => store.createReply(detail.revision.id, root.threadId!, { body: '@bob', viewedVersionId: detail.versions[0]!.id }, alice),
      () => store.createTaskComment(task.id, { body: '@bob' }, alice),
      () => store.pastes.comment(paste.id, { body: ' @bob ', contentVersion: 1 }, alice),
    ];
    for (const [index, write] of writes.entries()) {
      const key = `comment-kind-${index}`, fingerprint = `input-kind-${index}`;
      const response = store.mutate(key, fingerprint, () => ({ status: 201, body: write() }));
      assert.equal((response.body as ReviewComment).mentions!.requestSha256, mentionRequestHash(key, fingerprint));
      assert.equal(write().mentions!.requestSha256, undefined);
    }
  } finally { store.close(); }
});

test('no configuration or attribution preserves legacy comment JSON; configured machine actors do not add people', () => {
  const unconfigured = new Store({ path: ':memory:' });
  try {
    const detail = unconfigured.createRevision({ title: 'Legacy', testPlan: 'Read.', kind: 'code', files: [{ path: 'a', content: 'x' }] }, alice);
    assert.equal(unconfigured.createComment(detail.revision.id, { body: '@bob', versionId: detail.versions[0]!.id }, alice).mentions, undefined);
  } finally { unconfigured.close(); }
  const f = fixture(); try {
    const detail = f.revision(), input = { body: '@bob', versionId: detail.versions[0]!.id };
    assert.equal(f.store.createComment(detail.revision.id, input).mentions, undefined);
    assert.equal(f.store.createComment(detail.revision.id, input, actor('application:review')).mentions!.tokens[0]!.principalId, null);
    assert.equal(f.store.revisionSubscriptions.effective(detail.revision.id, 'bob'), false);
    assert.throws(() => f.store.configureMentions({ resolve: () => null }), /already configured/);
  } finally { f.store.close(); }
});

test('failed presenter and mention bounds roll back comment, threads, following, notification and retry rows', () => {
  const f = fixture(), { store } = f;
  try {
    const detail = f.revision(), id = detail.revision.id;
    const tables = ['comments', 'review_threads', 'revision_subscriptions', 'revision_subscription_transactions', 'notification_events', 'notification_deliveries', 'idempotency', 'activity'];
    const before = tables.map(table => raw(store, table));
    assert.throws(() => store.mutate('failed', 'fixed', () => ({ status: 201, body: store.createComment(id, { body: '@bob @carol', versionId: detail.versions[0]!.id }, alice) }), undefined, () => { throw new Error('presentation failed'); }), /presentation failed/);
    assert.deepEqual(tables.map(table => raw(store, table)), before);
    assert.throws(() => store.createComment(id, { body: Array.from({ length: 101 }, () => '@bob').join(' '), versionId: detail.versions[0]!.id }, alice), { code: 'MENTION_LIMIT', status: 400 });
    assert.deepEqual(tables.map(table => raw(store, table)), before);
  } finally { store.close(); }
});

for (const kind of ['revision', 'paste'] as const) test(`${kind} full preference capacity rejects mention additions atomically, including an earlier opt-out reversal`, () => {
  const f = fixture(false), { store } = f;
  try {
    const detail = kind === 'revision' ? f.revision() : null, paste = kind === 'paste' ? store.pastes.create({ content: 'source' }, alice) : null, id = detail?.revision.id ?? paste!.id;
    if (kind === 'revision') f.follow(id, 'unsubscribe'); else f.pasteFollow(id, 'unsubscribe');
    const limit = kind === 'revision' ? REVISION_SUBSCRIPTION_LIMITS.people : OBJECT_SUBSCRIPTION_LIMITS.people;
    for (let n = 1; n < limit; n++) {
      const person = actor(`person${n}`);
      if (kind === 'revision') f.follow(id, 'subscribe', person); else f.pasteFollow(id, 'subscribe', person);
    }
    const tables = kind === 'revision' ? ['comments', 'review_threads', 'revision_subscriptions', 'revision_subscription_transactions', 'activity'] : ['paste_transactions', 'object_subscriptions', 'object_subscription_transactions', 'activity'];
    const before = tables.map(table => raw(store, table));
    const write = () => kind === 'revision' ? store.createComment(id, { body: '@bob @carol', versionId: detail!.versions[0]!.id }, alice) : store.pastes.comment(id, { body: '@bob @carol', contentVersion: 1 }, alice);
    assert.throws(write, { code: kind === 'revision' ? 'REVISION_SUBSCRIPTION_LIMIT' : 'OBJECT_SUBSCRIPTION_LIMIT' });
    assert.deepEqual(tables.map(table => raw(store, table)), before);
  } finally { store.close(); }
});

test('mention subscription reads reject changed immutable comment bodies/proofs across all three discussion types', () => {
  const f = fixture(), { store } = f;
  try {
    const detail = f.revision(), id = detail.revision.id;
    const revision = store.createComment(id, { body: '@bob', versionId: detail.versions[0]!.id }, alice);
    store.database.exec('DROP TRIGGER comments_no_update');
    store.database.prepare("UPDATE comments SET data=json_set(data,'$.body','unrelated') WHERE id=?").run(revision.id);
    assert.throws(() => store.revisionSubscriptions.history(id), { code: 'REVISION_SUBSCRIPTION_INVALID_RECEIPT' });
    const task = store.createTask({ title: 'Review' }, alice), comment = store.createTaskComment(task.id, { body: '@bob' }, alice);
    store.database.exec('DROP TRIGGER task_transactions_no_update');
    store.database.prepare("UPDATE task_transactions SET data=json_set(data,'$.mentions.bodySha256',?) WHERE id=?").run('0'.repeat(64), comment.id);
    assert.throws(() => store.taskHistory(task.id), { code: 'MENTION_INVALID' });
    const paste = store.pastes.create({ content: 'source' }, alice), pasted = store.pastes.comment(paste.id, { contentVersion: 1, body: '@bob' }, alice);
    store.database.exec('DROP TRIGGER paste_transactions_no_update');
    store.database.prepare("UPDATE paste_transactions SET data=json_set(data,'$.mentions.tokens[0].principalId','carol') WHERE id=?").run(pasted.id);
    assert.throws(() => store.objectSubscriptions.status(paste.id, 'bob'), { code: 'OBJECT_SUBSCRIPTION_INVALID_RECEIPT' });
  } finally { store.close(); }
});
