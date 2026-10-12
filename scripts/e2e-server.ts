import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app';
import { createStore } from '../server/store';
import { createAuth } from '../server/auth';
import { authAccounts } from '../tests/auth-fixture';
import { createGitFixture, createGitComparisonFixture } from '../tests/git-fixture';
import { createGitBlameFixture } from '../tests/git-blame-fixture';
import { texRunnerFromEnvironment } from '../server/tex-runner';

const directory = mkdtempSync(join(tmpdir(), 'phabricator-e2e-'));
const gitFixture = await createGitFixture();
const comparisonFixture = await createGitComparisonFixture(gitFixture);
const blameFixture = await createGitBlameFixture(gitFixture);
const fixturePath = resolve('.data/e2e-repository-fixture.json');
const findingFixturePath = resolve('.data/e2e-finding-fixture.json');
const paperRunner = process.env.E2E_REAL_TEX === '1' ? texRunnerFromEnvironment() : null;
if (process.env.E2E_REAL_TEX === '1' && !paperRunner) throw new Error('Real TeX browser verification requires a configured isolated compiler.');
const transcriptionModelDirectory = process.env.E2E_REAL_TRANSCRIPTION === '1' ? process.env.APP_TRANSCRIPTION_MODEL_DIR : undefined;
if (process.env.E2E_REAL_TRANSCRIPTION === '1' && !transcriptionModelDirectory) throw new Error('Real transcription verification requires a staged, pinned public model.');
mkdirSync(resolve('.data'), { recursive: true });
writeFileSync(fixturePath, JSON.stringify({ barePath: gitFixture.barePath, head: gitFixture.head, base: gitFixture.base, feature: gitFixture.feature, emptyCommit: gitFixture.emptyCommit, importCommit: gitFixture.importCommit, importNextCommit: gitFixture.importNextCommit, importEqualCommit: gitFixture.importEqualCommit, comparisonBase: comparisonFixture.base, comparisonTarget: comparisonFixture.target, blame: blameFixture }));
const app = createApp({ transcriptionModelDirectory, paperRunner, databasePath: join(directory, 'workspace.sqlite'), gitRepositories: { R1: gitFixture.barePath }, port: 4311, basePath: process.env.APP_BASE_PATH, distPath: process.env.E2E_DIST_PATH, aiConfiguration: () => ({ configured: false, model: null, localConfigured: false, localModel: null }) });
if (process.env.E2E_FINDING_FIXTURE === '1') {
  // Stored test evidence verifies presentation only. No adapter or model is run.
  const author = { principalId: `local:${app.auth.workspaceId}`, displayName: 'Test fixture', credentialId: null, requestId: 'finding-provenance-fixture' };
  const detail = app.store.createRevision({ title: 'Test-only stored AI evidence fixture', kind: 'document', testPlan: 'Verify stored provenance without invoking an AI provider.', files: [{ path: 'fixture.txt', content: 'Test-only source; no provider invoked.\nOriginal fixture evidence.\n' }] }, author);
  const hosted = app.store.saveReview(detail.revision.id, 1, { provider: 'openai', model: 'test-only-hosted-model', summary: 'Static test fixture. No hosted model was called.', findings: [{ id: 'ai-1', severity: 'warning', filePath: 'fixture.txt', line: 1, title: 'Static hosted finding', body: 'Test-only hosted provenance content.', source: 'ai' }] }, author);
  const local = app.store.saveReview(detail.revision.id, 1, { provider: 'ollama', model: 'test-only-local-model', summary: 'Static test fixture. No local model was called.', findings: [{ id: 'ai-1', severity: 'info', filePath: 'fixture.txt', line: 2, title: 'Static local-model finding', body: 'Test-only local-model provenance content.', source: 'ai' }] }, author);
  writeFileSync(findingFixturePath, JSON.stringify({ revisionId: detail.revision.id, hostedReviewId: hosted.id, localReviewId: local.id }));
}
if (process.env.E2E_NOTIFICATION_FIXTURE === '1') {
  const author = { principalId: `local:${app.auth.workspaceId}`, displayName: 'Local reader', credentialId: null, requestId: 'notification-offline-fixture' };
  const contributor = await app.auth.createAccount({ username: 'notification-fixture', displayName: 'Fixture Contributor', password: 'test-only-local-notification-password' });
  const revision = app.store.createRevision({ title: 'Local durable notification fixture', kind: 'paper', testPlan: 'Verify cached inbox reads without sending an offline read action.', files: [{ path: 'paper.txt', content: 'Offline notification source.\n' }] }, author);
  app.store.createComment(revision.revision.id, { versionId: revision.versions[0]!.id, body: 'A disposable contributor comment.' }, { ...author, principalId: contributor.id, displayName: contributor.displayName, requestId: 'notification-offline-comment' });
  const task = app.store.createTask({ title: 'Local durable task notification fixture', description: 'Offline task notification source.' }, { ...author, requestId: 'task-notification-offline-fixture' });
  app.store.createTaskComment(task.id, { body: 'A disposable task contributor comment.' }, { ...author, principalId: contributor.id, displayName: contributor.displayName, requestId: 'task-notification-offline-comment' });
}
if (process.env.E2E_OBJECT_NOTIFICATION_FIXTURE === '1') {
  const author = { principalId: `local:${app.auth.workspaceId}`, displayName: 'Local reader', credentialId: null, requestId: 'object-notification-offline-fixture' };
  const contributor = await app.auth.createAccount({ username: 'object-notification-fixture', displayName: 'Object Fixture Contributor', password: 'test-only-local-object-notification-password' });
  const actor = { ...author, principalId: contributor.id, displayName: contributor.displayName, requestId: 'object-notification-offline-update' };
  const document = app.store.createDocument({ title: 'Local durable wiki notification fixture', slug: 'notification-fixture', content: 'First local wiki source.' }, author);
  app.store.objectSubscriptions.mutate(document.id, { action: 'subscribe', principalId: author.principalId, expectedSubscriptionVersion: 0, expectedAccessEpoch: app.policies.epoch() }, author);
  app.store.updateDocument(document.id, { title: document.title, slug: document.slug, content: 'Updated local wiki source.', expectedVersion: document.version }, actor);
  const paste = app.store.pastes.create({ title: 'Local durable Paste notification fixture', content: 'Exact local paste source.\n' }, author);
  app.store.pastes.comment(paste.id, { body: 'A disposable Paste comment.', contentVersion: paste.contentVersion }, actor);
}
const passwordStore = createStore({ path: join(directory, 'password-workspace.sqlite') });
const provisioner = createAuth({ database: passwordStore.database, mode: 'local', basePath: process.env.APP_BASE_PATH ?? '/', provisioning: true });
for (const account of authAccounts) await provisioner.createAccount(account);
passwordStore.createRepository({ name: 'Fixture repository', description: 'Disposable committed source for browser verification.', remoteUrl: 'https://example.invalid/fixture.git', defaultBranch: 'main' });
const passwordApp = createApp({ transcriptionModelDirectory, paperRunner, store: passwordStore, gitRepositories: { R1: gitFixture.barePath }, authMode: 'password', seed: false, port: 4312, basePath: process.env.APP_BASE_PATH, distPath: process.env.E2E_DIST_PATH, aiConfiguration: () => ({ configured: false, model: null, localConfigured: false, localModel: null }) });
app.server.listen(4311, '127.0.0.1');
passwordApp.server.listen(4312, '127.0.0.1');
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void Promise.all([app.close(), passwordApp.close()]).finally(async () => { passwordStore.close(); rmSync(directory, { recursive: true, force: true }); rmSync(fixturePath, { force: true }); if (process.env.E2E_FINDING_FIXTURE === '1') rmSync(findingFixturePath, { force: true }); await gitFixture.close(); process.exit(); });
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
