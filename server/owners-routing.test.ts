import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ActorAttribution, RevisionDetail, RevisionVersion } from '../shared/types.ts';
import type { PublicAccount } from '../shared/auth.ts';
import type { OwnersDefinition } from '../shared/owners.ts';
import { ownersAuditNeeded } from '../shared/owners-routing.ts';
import type { GitReceiveFacts } from '../shared/git-automation.ts';
import { createApp } from './app.ts';
import { createOwnersStore } from './owners.ts';
import { initializeOwnersRouting, ownersRevisionPaths } from './owners-routing.ts';

async function setup() {
  const app = createApp({ databasePath: ':memory:', seed: false });
  const accounts: PublicAccount[] = [];
  for (const username of ['alice', 'bob', 'carol']) accounts.push(await app.auth.createAccount({ username, displayName: username, password: `Long fixture password for ${username}` }));
  const actor = (principalId: string): ActorAttribution => ({ principalId, displayName: accounts.find(account => account.id === principalId)?.displayName ?? 'Local', credentialId: null, requestId: randomUUID() });
  const local = actor(`local:${app.auth.workspaceId}`), alice = actor(accounts[0]!.id), bob = actor(accounts[1]!.id), carol = actor(accounts[2]!.id);
  const buildActor = (person = local) => ({ principalId: person.principalId, displayName: person.displayName, workspaceId: app.auth.workspaceId });
  const repo = app.store.createRepository({ name: 'Routing source', remoteUrl: 'https://example.test/source.git' }, local);
  const packages = createOwnersStore(app.store, app.auth, app.policies);
  const definition = (patch: Partial<OwnersDefinition> = {}): OwnersDefinition => ({ name: 'Library owners', description: '', status: 'active', visibility: 'workspace', owners: [{ kind: 'person', id: alice.principalId }, { kind: 'person', id: bob.principalId }], paths: [{ repositoryId: repo.id, path: '/src', excluded: false }], dominion: 'strong', autoReview: 'review', auditing: 'none', ...patch });
  const pkg = (patch: Partial<OwnersDefinition> = {}) => packages.create(local.principalId, local.displayName, definition(patch));
  const create = (files = [{ path: 'src/old.ts', content: 'old\n' }], by = local, access?: unknown) => app.store.mutate(undefined, randomUUID(), () => {
    const detail = app.store.createRevision({ kind: 'code', title: 'Owners source', testPlan: 'Check immutable routing.', repositoryId: repo.id, files }, by);
    app.policies.configureNew(detail.revision.id, access, by.principalId);
    return { status: 201, body: detail };
  }).body as RevisionDetail;
  const update = (id: string, files: {path: string; content: string}[], by = local) => app.store.mutate(undefined, randomUUID(), () => ({ status: 201, body: app.store.createVersion(id, { expectedVersion: app.store.detail(id).revision.currentVersion, files, message: 'New source' }, by) })).body as RevisionDetail;
  const decide = (id: string, by: ActorAttribution, action: 'accept' | 'resign') => {
    const state = app.store.revisionReviewers.snapshot(id, by.principalId);
    return app.store.revisionReviewers.mutate(id, { action, message: '', expectedReviewerVersion: state.reviewers.version, expectedLifecycleVersion: state.lifecycle.version, expectedAuthorVersion: state.authorship.version, expectedVersion: state.head.number, expectedVersionId: state.head.versionId, expectedContentHash: state.head.contentHash, expectedAccessEpoch: app.policies.epoch(), expectedConfigId: state.configId, expectedEvidenceSha256: state.evidence.sha256 }, by);
  };
  const facts = (patch: Partial<GitReceiveFacts> = {}): GitReceiveFacts => ({ repositoryId: repo.id, objectFormat: 'sha1', phase: 'post', requestId: randomUUID(), pusherId: local.principalId, inspectionComplete: true, updates: [{ refName: 'refs/heads/main', oldId: null, oldCommitId: null, newId: 'b'.repeat(40), newCommitId: 'b'.repeat(40), forced: false, commits: [{ inspectionComplete: true, commit: { id: 'b'.repeat(40), treeId: 'c'.repeat(40), parentIds: [], author: { name: 'Untrusted Alice', email: 'alice@example.test', timestamp: '2026-01-01T00:00:00Z' }, committer: { name: 'Committer', email: 'committer@example.test', timestamp: '2026-01-01T00:00:00Z' }, message: 'Exact change', messageTruncated: false }, files: [{ path: 'src/new.bin', content: '', added: '', removed: '', inspection: { kind: 'binary', old: null, new: { id: 'd'.repeat(40), mode: '100644', bytes: 15 } } }] }] }], ...patch });
  const receive = (input = facts()) => app.automation.landingReceive(input, buildActor());
  const history = (id: string, by = local) => app.automation.ownersRouting.history(id, by.principalId);
  return { ...app, accounts, local, alice, bob, carol, actor, buildActor, repo, packages, definition, pkg, create, update, decide, facts, receive, history };
}

test('Owners source routing adds nonblocking people once, records exact package and source, and invalidates old acceptance on new source', async () => {
  const f = await setup();
  try {
    const pkg = f.pkg(), created = f.create(), id = created.revision.id;
    assert.deepEqual(f.store.revisionReviewers.state(id).members.map(member => [member.principalId, member.status]).sort(), [[f.alice.principalId, 'added'], [f.bob.principalId, 'added']].sort());
    const first = f.history(id).records[0]!;
    assert.equal(first.source.versionId, created.versions[0]!.id); assert.equal(first.packages[0]!.package.id, pkg.id); assert.equal(first.packages[0]!.package.version, 1); assert.equal(first.packages[0]!.status, 'applied');
    const reviewerVersion = f.store.revisionReviewers.state(id).version;
    f.automation.ownersRouting.revision(id, 'another-delivery', f.local.principalId);
    assert.equal(f.history(id).records.length, 1); assert.equal(f.store.revisionReviewers.state(id).version, reviewerVersion);
    f.decide(id, f.alice, 'accept'); assert.equal(f.store.detail(id).revision.status, 'accepted', 'one owner can accept ordinary nonblocking review');
    f.update(id, [{ path: 'src/renamed.ts', content: 'changed\n' }]);
    assert.equal(f.store.detail(id).revision.status, 'needs_review');
    assert.deepEqual(f.history(id).records[0]!.source.paths, ['src/old.ts', 'src/renamed.ts']);
    assert.equal(f.history(id).records[0]!.packages[0]!.status, 'unchanged');
    assert.ok(f.store.revisionReviewers.state(id).members.find(member => member.principalId === f.alice.principalId)?.decision?.invalidated);
    assert.throws(() => f.store.database.prepare('UPDATE owners_routing_records SET data=data').run(), /immutable/);
  } finally { await f.close(); }
});

test('Owners ordinary and always review modes respect author membership, resignation, and current source visibility', async () => {
  const f = await setup();
  try {
    const pkg = f.pkg(); const owned = f.create(undefined, f.alice);
    assert.equal(f.store.revisionReviewers.state(owned.revision.id).members.length, 0); assert.equal(f.history(owned.revision.id).records[0]!.packages[0]!.reason, 'owner-author');
    f.packages.update(f.local.principalId, 'Local', pkg.id, f.definition({ autoReview: 'review-always' }), 1);
    const always = f.create(undefined, f.alice), id = always.revision.id;
    assert.deepEqual(f.store.revisionReviewers.state(id).members.map(member => member.principalId), [f.bob.principalId]);
    f.decide(id, f.bob, 'resign'); f.update(id, [{ path: 'src/new.ts', content: 'next' }], f.alice);
    assert.equal(f.store.revisionReviewers.state(id).members[0]!.status, 'resigned');
    const privateSource = f.create(undefined, f.local, { spaceId: 'S1', view: { kind: 'principals', principalIds: [f.local.principalId] }, edit: { kind: 'principals', principalIds: [f.local.principalId] }, interact: { kind: 'principals', principalIds: [f.local.principalId] } });
    assert.equal(f.store.revisionReviewers.state(privateSource.revision.id).members.length, 0); assert.equal(f.history(privateSource.revision.id).records[0]!.packages[0]!.reason, 'no-eligible-owners');
  } finally { await f.close(); }
});

test('Owners subscriptions preserve an explicit unfollow and disabled configuration creates no membership side effects', async () => {
  const f = await setup();
  try {
    const pkg = f.pkg({ autoReview: 'subscribe-always' }), detail = f.create(), id = detail.revision.id;
    assert.equal(f.store.revisionSubscriptions.person(id, f.alice.principalId).status.state, 'subscribed');
    const state = f.store.revisionSubscriptions.person(id, f.alice.principalId);
    f.store.revisionSubscriptions.mutate(id, { action: 'unsubscribe', principalId: f.alice.principalId, expectedSubscriptionVersion: state.status.version, expectedAuthorVersion: state.authorVersion, expectedReviewerVersion: state.reviewerVersion, expectedAccessEpoch: f.policies.epoch() }, f.alice, { principalId: f.alice.principalId, displayName: f.alice.displayName });
    f.update(id, [{ path: 'src/old.ts', content: 'new' }]); assert.equal(f.store.revisionSubscriptions.person(id, f.alice.principalId).status.state, 'unsubscribed');
    f.packages.update(f.local.principalId, 'Local', pkg.id, f.definition({ autoReview: 'none' }), 1);
    const next = f.create(); assert.equal(f.store.revisionReviewers.state(next.revision.id).members.length, 0); assert.equal(f.history(next.revision.id).records[0]!.packages[0]!.reason, 'disabled');
  } finally { await f.close(); }
});

test('Owners collective audit accepts one eligible owner, never expands every owner into required individual votes, and never replays requests', async () => {
  const f = await setup();
  try {
    const pkg = f.pkg({ auditing: 'all', autoReview: 'none' }); const input = f.facts(), receipt = f.receive(input), id = receipt.commitIds[0]!;
    let detail = f.automation.audit.detail(id, f.buildActor());
    assert.equal(detail.audit.auditors.length, 0); assert.equal(detail.audit.ownerPackages?.length, 1); assert.equal(detail.audit.status, 'needs-audit'); assert.equal(detail.audit.ownerPackages?.[0]!.packageId, pkg.id);
    assert.equal(f.automation.audit.list(f.buildActor(f.alice), { auditorId: f.alice.principalId }).audits.length, 1);
    assert.equal(f.history(id).records[0]!.source.basis, 'receive'); assert.deepEqual(f.history(id).records[0]!.source.paths, ['src/new.bin']);
    detail = f.automation.audit.command(id, { expectedVersion: detail.audit.version, command: 'accept' }, f.buildActor(f.alice));
    assert.equal(detail.audit.status, 'audited'); assert.equal(detail.audit.ownerPackages?.[0]!.status, 'accepted'); assert.deepEqual(detail.audit.auditors.map(person => person.principalId), [f.alice.principalId]);
    const version = detail.audit.version; f.receive(input); f.receive({ ...input, requestId: randomUUID() });
    assert.equal(f.automation.audit.detail(id, f.buildActor()).audit.version, version); assert.equal(f.history(id).records.length, 1);
    detail = f.automation.audit.command(id, { expectedVersion: version, command: 'resign' }, f.buildActor(f.alice)); assert.equal(detail.audit.status, 'needs-audit');
  } finally { await f.close(); }
});

test('Owners collective audit requires captured and current ownership; private package evidence is projected out', async () => {
  const f = await setup();
  try {
    const pkg = f.pkg({ auditing: 'all', autoReview: 'none', visibility: 'private' }); const id = f.receive().commitIds[0]!;
    const privateRead = f.automation.audit.detail(id, f.buildActor(f.carol)); assert.deepEqual(privateRead.audit.ownerPackages, []); assert.equal(privateRead.audit.status, 'needs-audit'); assert.deepEqual(f.history(id, f.carol).records[0]!.packages, []);
    assert.ok(!JSON.stringify(privateRead).includes(pkg.id)); assert.ok(!JSON.stringify(privateRead).includes(pkg.name));
    assert.equal(f.automation.audit.list(f.buildActor(f.carol), { auditorId: f.alice.principalId }).audits.length, 0, 'auditor filters do not reveal private package membership');
    f.packages.update(f.local.principalId, 'Local', pkg.id, f.definition({ auditing: 'all', autoReview: 'none', owners: [{ kind: 'person', id: f.bob.principalId }, { kind: 'person', id: f.carol.principalId }] }), 1);
    let detail = f.automation.audit.detail(id, f.buildActor());
    detail = f.automation.audit.command(id, { expectedVersion: detail.audit.version, command: 'accept' }, f.buildActor(f.alice)); assert.equal(detail.audit.status, 'partially-audited', 'a removed captured owner cannot resolve package');
    detail = f.automation.audit.command(id, { expectedVersion: detail.audit.version, command: 'accept' }, f.buildActor(f.carol)); assert.equal(detail.audit.status, 'partially-audited', 'a newly added owner cannot approve earlier captured responsibility');
    detail = f.automation.audit.command(id, { expectedVersion: detail.audit.version, command: 'accept' }, f.buildActor(f.bob)); assert.equal(detail.audit.status, 'audited');
    assert.equal(detail.audit.ownerPackages?.[0]!.packageVersion, 1);
  } finally { await f.close(); }
});

test('Owners audit with no active owners stays pending; author email/pusher cannot spoof owner involvement', async () => {
  const f = await setup();
  try {
    f.pkg({ auditing: 'audit', autoReview: 'none', owners: [] });
    const id = f.receive().commitIds[0]!, detail = f.automation.audit.detail(id, f.buildActor());
    assert.equal(detail.audit.status, 'needs-audit'); assert.deepEqual(detail.audit.ownerPackages?.[0]!.ownerIds, []); assert.equal(f.history(id).records[0]!.packages[0]!.reason, 'no-eligible-owners');
    const changed = f.automation.audit.command(id, { expectedVersion: detail.audit.version, command: 'accept' }, f.buildActor(f.local)); assert.equal(changed.audit.status, 'partially-audited');
  } finally { await f.close(); }
});

test('Owners delta records a verified baseline and both removed and renamed source paths including binary assets', () => {
  const version = (number: number, files: RevisionVersion['files']): RevisionVersion => ({ id: `version-${number}`, revisionId: 'D1', number, files, contentHash: String(number).repeat(64), message: '', createdAt: '2026-01-01T00:00:00Z' });
  const base = version(1, [{ path: 'old.ts', content: 'old' }, { path: 'unchanged.ts', content: 'same' }]);
  base.gitSource = { kind: 'git', repositoryId: 'R1', objectFormat: 'sha1', commitId: 'a'.repeat(40), treeId: 'b'.repeat(40), scope: 'complete-text-tree', manifest: base.files.map(file => ({ path: file.path, mode: '100644', objectId: 'c'.repeat(40) })) };
  const second = version(2, [{ path: 'new.ts', content: 'old' }, { path: 'unchanged.ts', content: 'same' }]), third = version(3, second.files);
  assert.deepEqual(ownersRevisionPaths('R1', [base, second, third], third), { basis: 'git-baseline', baseVersionId: base.id, paths: ['new.ts', 'old.ts'] });
  const asset = { path: 'figures/old.png', fileId: 'F1', sha256: 'e'.repeat(64), bytes: 10, mediaType: 'image/png' as const };
  second.assets = [asset]; third.assets = [{ ...asset, path: 'figures/new.png' }]; delete base.gitSource;
  assert.deepEqual(ownersRevisionPaths('R1', [base, second, third], third).paths, ['figures/new.png', 'figures/old.png']);
});

test('Owners routing migration is atomic and refuses conflicting schema', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE owners_routing_records(id TEXT)');
    assert.throws(() => initializeOwnersRouting(db), /Unexpected owners_routing_records/);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['owners_routing_records']);
  } finally { db.close(); }
});

test('Owners auditing mode combinations preserve OR semantics', () => {
  for (const reviewed of [false, true]) for (const involved of [false, true]) {
    assert.equal(ownersAuditNeeded('none', reviewed, involved), false);
    assert.equal(ownersAuditNeeded('all', reviewed, involved), true);
    assert.equal(ownersAuditNeeded('audit', reviewed, involved), !involved);
    assert.equal(ownersAuditNeeded('unreviewed', reviewed, involved), !reviewed);
    assert.equal(ownersAuditNeeded('uninvolved-unreviewed', reviewed, involved), !reviewed || !involved);
  }
});

test('Owners project owner membership is rechecked without giving new members earlier audit authority', async () => {
  const f = await setup();
  try {
    const project = f.store.createProject({ name: 'Review team', memberIds: [f.alice.principalId, f.bob.principalId] }, f.local);
    f.pkg({ auditing: 'all', owners: [{ kind: 'project', id: project.id }] });
    const id = f.receive().commitIds[0]!;
    const version = f.store.projectDetail(project.id, f.local.principalId).membersVersion;
    f.store.updateProjectMembers(project.id, { action: 'set', principalIds: [f.bob.principalId, f.carol.principalId], expectedCollectionVersion: version }, f.local);
    let detail = f.automation.audit.detail(id, f.buildActor());
    for (const by of [f.alice, f.carol]) { detail = f.automation.audit.command(id, { expectedVersion: detail.audit.version, command: 'accept' }, f.buildActor(by)); assert.equal(detail.audit.status, 'partially-audited'); }
    detail = f.automation.audit.command(id, { expectedVersion: detail.audit.version, command: 'accept' }, f.buildActor(f.bob)); assert.equal(detail.audit.status, 'audited');
    const revision = f.create(); assert.deepEqual(f.store.revisionReviewers.state(revision.revision.id).members.map(member => member.principalId).sort(), [f.bob.principalId, f.carol.principalId].sort());
  } finally { await f.close(); }
});

test('Owners routing keeps complete changed paths for unusual Git names and refused incomplete receives leave no evidence', async () => {
  const f = await setup();
  try {
    f.pkg({ auditing: 'all', autoReview: 'none' });
    const facts = f.facts(); facts.updates[0]!.commits[0]!.files[0]!.path = 'src/line\nbreak\tfile.bin';
    const id = f.receive(facts).commitIds[0]!;
    assert.equal(f.automation.audit.detail(id, f.buildActor()).audit.status, 'needs-audit'); assert.deepEqual(f.history(id).records[0]!.source.paths, ['src/line\nbreak\tfile.bin']);
    const count = f.store.database.prepare('SELECT count(*) AS n FROM owners_routing_records').get()!.n;
    assert.throws(() => f.receive({ ...facts, inspectionComplete: false } as unknown as GitReceiveFacts), /complete receive-hook inspection/);
    assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM owners_routing_records').get()!.n, count);
  } finally { await f.close(); }
});

test('Owners routing rolls back a failed membership batch rather than partially assigning a package', async () => {
  const f = await setup();
  try {
    f.pkg();
    let calls = 0; const original = f.store.revisionReviewers.mutate.bind(f.store.revisionReviewers);
    f.store.revisionReviewers.mutate = (...args) => { if (++calls === 2) throw new Error('Injected reviewer write failure'); return original(...args); };
    const count = f.store.database.prepare("SELECT count(*) AS n FROM entities WHERE kind='revision'").get()!.n;
    assert.throws(() => f.create(), /Injected reviewer write failure/);
    assert.equal(f.store.database.prepare("SELECT count(*) AS n FROM entities WHERE kind='revision'").get()!.n, count);
    assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM owners_routing_records').get()!.n, 0);
    assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM revision_reviewer_transactions').get()!.n, 0);
  } finally { await f.close(); }
});

test('Owners no-owner and unreviewed audit modes consult exact server-derived reviewer decisions', async () => {
  const f = await setup();
  try {
    const pkg = f.pkg({ auditing: 'uninvolved-unreviewed' }), revision = f.create(), revisionId = revision.revision.id;
    f.decide(revisionId, f.alice, 'accept');
    const accepted = f.store.revisionReviewers.snapshot(revisionId, f.local.principalId);
    const observe = (facts: GitReceiveFacts, head = accepted.head, reviewerVersion = accepted.reviewers.version) => f.automation.git.receive(facts, {
      canReceive: () => true, projectIds: () => [], canEvaluate: () => false, canApply: () => false,
      apply: () => ({ changed: false, message: '' }),
      reviewEvidence: () => ({ association: 'verified', revision: { revisionId, versionId: head.versionId, versionNumber: head.number, contentHash: head.contentHash, targetTreeId: facts.updates[0]!.commits[0]!.commit.treeId, accepted: true, lifecycleVersion: accepted.lifecycle.version, reviewerVersion, evidenceSha256: accepted.evidence.sha256 }, builds: [] }),
      observeCommit: id => { f.automation.audit.observe(id, f.buildActor()); f.automation.ownersRouting.commit(id, f.buildActor()); },
    });
    const id = observe(f.facts()).commitIds[0]!;
    assert.equal(f.automation.audit.detail(id, f.buildActor()).audit.status, 'none'); assert.equal(f.history(id).records[0]!.packages[0]!.reason, 'no-audit-needed');
    f.update(revisionId, [{ path: 'src/old.ts', content: 'new content' }]);
    f.packages.update(f.local.principalId, 'Local', pkg.id, f.definition({ auditing: 'audit' }), 1);
    const facts = f.facts(); facts.updates[0]!.newId = facts.updates[0]!.newCommitId = facts.updates[0]!.commits[0]!.commit.id = 'e'.repeat(40);
    const current = f.store.revisionReviewers.snapshot(revisionId, f.local.principalId);
    const changedId = observe(facts, current.head, current.reviewers.version).commitIds[0]!;
    assert.equal(f.automation.audit.detail(changedId, f.buildActor()).audit.status, 'needs-audit', 'even an accepted evidence flag cannot turn an older owner decision into current owner involvement');
  } finally { await f.close(); }
});

test('Owners collective audit resignation preserves another eligible owner acceptance and permits withdrawing a former owner vote', async () => {
  const f = await setup();
  try {
    const pkg = f.pkg({ auditing: 'all', autoReview: 'none' }), id = f.receive().commitIds[0]!;
    const command = (by: ActorAttribution, action: 'accept' | 'resign') => f.automation.audit.command(id, { expectedVersion: f.automation.audit.detail(id, f.buildActor()).audit.version, command: action }, f.buildActor(by));
    command(f.alice, 'accept'); command(f.bob, 'accept');
    let detail = command(f.bob, 'resign'); assert.equal(detail.audit.status, 'audited'); assert.equal(detail.audit.ownerPackages?.[0]!.decisionBy, f.alice.principalId);
    f.packages.update(f.local.principalId, 'Local', pkg.id, f.definition({ auditing: 'all', autoReview: 'none', owners: [{ kind: 'person', id: f.bob.principalId }] }), 1);
    detail = command(f.alice, 'resign'); assert.equal(detail.audit.status, 'needs-audit'); assert.equal(detail.audit.ownerPackages?.[0]!.decisionBy, null);
  } finally { await f.close(); }
});
