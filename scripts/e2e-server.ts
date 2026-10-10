import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { createStore } from '../server/store';
import { createAuth } from '../server/auth';
import { authAccounts } from '../tests/auth-fixture';

const directory = mkdtempSync(join(tmpdir(), 'phabricator-e2e-'));
const app = createApp({ databasePath: join(directory, 'workspace.sqlite'), port: 4311, basePath: process.env.APP_BASE_PATH, distPath: process.env.E2E_DIST_PATH, aiConfiguration: () => ({ configured: false, model: null, localConfigured: false, localModel: null }) });
const passwordStore = createStore({ path: join(directory, 'password-workspace.sqlite') });
const provisioner = createAuth({ database: passwordStore.database, mode: 'local', basePath: process.env.APP_BASE_PATH ?? '/', provisioning: true });
for (const account of authAccounts) await provisioner.createAccount(account);
const passwordApp = createApp({ store: passwordStore, authMode: 'password', seed: false, port: 4312, basePath: process.env.APP_BASE_PATH, distPath: process.env.E2E_DIST_PATH, aiConfiguration: () => ({ configured: false, model: null, localConfigured: false, localModel: null }) });
app.server.listen(4311, '127.0.0.1');
passwordApp.server.listen(4312, '127.0.0.1');
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void Promise.all([app.close(), passwordApp.close()]).finally(() => { passwordStore.close(); rmSync(directory, { recursive: true, force: true }); process.exit(); });
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
