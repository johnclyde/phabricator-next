import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { normalizeBasePath } from '../shared/mount.ts';
import { parseGitRepositories } from './git.ts';
import { texRunnerFromEnvironment } from './tex-runner.ts';
import { revisionLifecycleFromEnvironment } from './revision-lifecycle-config.ts';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const basePath = normalizeBasePath(process.env.APP_BASE_PATH ?? '/');
const authMode = process.env.APP_AUTH_MODE ?? 'local';
if (authMode !== 'local' && authMode !== 'password') throw new Error('APP_AUTH_MODE must be local or password.');
const gitRepositories = parseGitRepositories(process.env.APP_GIT_REPOSITORIES);
const app = createApp({ revisionLifecycle: revisionLifecycleFromEnvironment(), paperRunner: texRunnerFromEnvironment(), port, basePath, authMode, gitRepositories, databasePath: process.env.DATABASE_PATH ?? resolve('.data/phabricator.sqlite'), seed: process.env.SEED_DEMO !== 'false' && process.env.SEED_DEMO !== '0' });
app.server.listen(port, '127.0.0.1', () => console.log(`Phabricator Next is running at http://127.0.0.1:${port}${basePath} (${authMode === 'local' ? 'local single-user' : 'password-authenticated shared workspace'} mode; loopback only).`));
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void app.close().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
