import { resolve } from 'node:path';
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const app = createApp({ port, databasePath: process.env.DATABASE_PATH ?? resolve('.data/phabricator.sqlite'), seed: process.env.SEED_DEMO !== 'false' && process.env.SEED_DEMO !== '0' });
app.server.listen(port, '127.0.0.1', () => console.log(`Phabricator Next is running at http://127.0.0.1:${port} (local single-user mode).`));
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void app.close().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
