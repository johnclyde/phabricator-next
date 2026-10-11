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
const paperRunner = process.env.E2E_REAL_TEX === '1' ? texRunnerFromEnvironment() : null;
if (process.env.E2E_REAL_TEX === '1' && !paperRunner) throw new Error('Real TeX browser verification requires a configured isolated compiler.');
mkdirSync(resolve('.data'), { recursive: true });
writeFileSync(fixturePath, JSON.stringify({ barePath: gitFixture.barePath, head: gitFixture.head, base: gitFixture.base, feature: gitFixture.feature, emptyCommit: gitFixture.emptyCommit, importCommit: gitFixture.importCommit, importNextCommit: gitFixture.importNextCommit, importEqualCommit: gitFixture.importEqualCommit, comparisonBase: comparisonFixture.base, comparisonTarget: comparisonFixture.target, blame: blameFixture }));
const app = createApp({ paperRunner, databasePath: join(directory, 'workspace.sqlite'), gitRepositories: { R1: gitFixture.barePath }, port: 4311, basePath: process.env.APP_BASE_PATH, distPath: process.env.E2E_DIST_PATH, aiConfiguration: () => ({ configured: false, model: null, localConfigured: false, localModel: null }) });
if (process.env.E2E_NOTIFICATION_FIXTURE === '1') {
  const author = { principalId: `local:${app.auth.workspaceId}`, displayName: 'Local reader', credentialId: null, requestId: 'notification-offline-fixture' };
  const contributor = await app.auth.createAccount({ username: 'notification-fixture', displayName: 'Fixture Contributor', password: 'test-only-local-notification-password' });
  const revision = app.store.createRevision({ title: 'Local durable notification fixture', kind: 'paper', testPlan: 'Verify cached inbox reads without sending an offline read action.', files: [{ path: 'paper.txt', content: 'Offline notification source.\n' }] }, author);
  app.store.createComment(revision.revision.id, { versionId: revision.versions[0]!.id, body: 'A disposable contributor comment.' }, { ...author, principalId: contributor.id, displayName: contributor.displayName, requestId: 'notification-offline-comment' });
}
const passwordStore = createStore({ path: join(directory, 'password-workspace.sqlite') });
const provisioner = createAuth({ database: passwordStore.database, mode: 'local', basePath: process.env.APP_BASE_PATH ?? '/', provisioning: true });
for (const account of authAccounts) await provisioner.createAccount(account);
passwordStore.createRepository({ name: 'Fixture repository', description: 'Disposable committed source for browser verification.', remoteUrl: 'https://example.invalid/fixture.git', defaultBranch: 'main' });
const passwordApp = createApp({ paperRunner, store: passwordStore, gitRepositories: { R1: gitFixture.barePath }, authMode: 'password', seed: false, port: 4312, basePath: process.env.APP_BASE_PATH, distPath: process.env.E2E_DIST_PATH, aiConfiguration: () => ({ configured: false, model: null, localConfigured: false, localModel: null }) });
app.server.listen(4311, '127.0.0.1');
passwordApp.server.listen(4312, '127.0.0.1');
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void Promise.all([app.close(), passwordApp.close()]).finally(async () => { passwordStore.close(); rmSync(directory, { recursive: true, force: true }); rmSync(fixturePath, { force: true }); await gitFixture.close(); process.exit(); });
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
