import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';

const directory = mkdtempSync(join(tmpdir(), 'phabricator-e2e-'));
const app = createApp({ databasePath: join(directory, 'workspace.sqlite'), port: 4311, basePath: process.env.APP_BASE_PATH, aiConfiguration: () => ({ configured: false, model: null, localConfigured: false, localModel: null }) });
app.server.listen(4311, '127.0.0.1');
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void app.close().finally(() => { rmSync(directory, { recursive: true, force: true }); process.exit(); });
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
