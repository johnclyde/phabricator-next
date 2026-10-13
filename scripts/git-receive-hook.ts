import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, mkdir, writeFile, rename, readdir, readFile, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { inspectReceive } from '../server/git-receive-inspection.ts';

interface Configuration { serverUrl: string; repositoryId: string; repositoryPath: string; tokenFile: string; pusherId: string; spoolDirectory: string }
async function privateText(path: string, maximum: number): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Hook configuration and token paths must be absolute.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await file.stat(); if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > maximum) throw new Error('Hook configuration and tokens must be private regular files.'); return await file.readFile('utf8'); } finally { await file.close(); }
}
async function main(): Promise<void> {
  const phase = process.argv[2];
  if (!['pre', 'post', 'retry'].includes(phase ?? '') || process.argv.length !== 3) throw new Error('Use git-receive-hook.ts pre, post, or retry with PHABRICATOR_RECEIVE_CONFIG.');
  const configPath = process.env.PHABRICATOR_RECEIVE_CONFIG;
  if (!configPath) throw new Error('The receive hook has no operator configuration.');
  const config: Configuration = JSON.parse(await privateText(configPath, 20_000)) as Configuration;
  if (Object.keys(config).some(key => !['serverUrl', 'repositoryId', 'repositoryPath', 'tokenFile', 'pusherId', 'spoolDirectory'].includes(key)) || !Object.values(config).every(value => typeof value === 'string' && value.length > 0) || !/^R[1-9]\d*$/.test(config.repositoryId) || !isAbsolute(config.repositoryPath) || !isAbsolute(config.spoolDirectory) || !config.pusherId) throw new Error('Invalid receive hook configuration.');
  const url = new URL(config.serverUrl);
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('The receive API requires HTTPS or an explicit loopback server.');
  const endpoint = new URL(`${url.pathname.replace(/\/$/, '')}/api/herald/receive`, url.origin);
  const token = (await privateText(config.tokenFile, 256)).trim();
  if (!/^phab_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid receiver API credential.');
  await mkdir(config.spoolDirectory, { recursive: true, mode: 0o700 });
  const spool = await realpath(config.spoolDirectory);
  const directory = await open(spool, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await directory.stat(); if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('Receive retry storage must be a private directory.'); } finally { await directory.close(); }
  const send = async (serialized: string, key: string) => {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body: serialized });
    const raw = await response.text(); if (Buffer.byteLength(raw) > 1_000_000) throw new Error('Receive API response exceeds its limit.');
    const result = JSON.parse(raw) as { receive?: { allowed?: boolean; reasons?: string[]; id?: string }; error?: string };
    if (!response.ok) throw new Error('The receive API refused the observation; check receiver permissions and server logs.');
    if (typeof result.receive?.allowed !== 'boolean') throw new Error('The receive API returned an invalid decision.');
    if (!result.receive.allowed) {
      for (const reason of result.receive.reasons ?? []) process.stderr.write(`Herald: ${JSON.stringify(reason)}\n`);
      throw new Error('Herald rejected this push.');
    }
    process.stderr.write(`Herald recorded ${result.receive.id ?? 'the receive decision'}.\n`);
  };
  if (phase === 'retry') {
    for (const name of (await readdir(spool)).sort()) {
      if (!/^post-[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = join(spool, name), serialized = await privateText(file, 24 * 1024 * 1024);
      const fact = JSON.parse(serialized) as { repositoryId?: string; phase?: string; requestId?: string };
      if (fact.repositoryId !== config.repositoryId || fact.phase !== 'post' || typeof fact.requestId !== 'string') throw new Error('Retry observation does not match the configured receiver.');
      await send(serialized, `receive:${fact.requestId}`); await unlink(file);
    }
    return;
  }
  if (await realpath(process.cwd()) !== await realpath(config.repositoryPath)) throw new Error('The hook must run inside its configured bare repository.');
  const chunks: Buffer[] = []; let inputBytes = 0; for await (const chunk of process.stdin) { const data = Buffer.from(chunk as Uint8Array); inputBytes += data.length; if (inputBytes > 128_000) throw new Error('Receive input exceeds its limit.'); chunks.push(data); }
  const stdin = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const inspection = await inspectReceive(config.repositoryPath, stdin, phase as 'pre' | 'post');
  const requestId = randomUUID();
  const facts = { repositoryId: config.repositoryId, phase, requestId, pusherId: process.env.PHABRICATOR_PUSHER_ID ?? config.pusherId, objectFormat: inspection.objectFormat, inspectionComplete: true, updates: inspection.updates.map(({ commitIds, ...update }) => ({ ...update, commits: commitIds.map(id => (() => { const { branches: _branches, ...fact } = inspection.commits.find(item => item.commit.id === id)!; return fact; })()) })) };
  const serialized = JSON.stringify(facts);
  if (Buffer.byteLength(serialized) > 24 * 1024 * 1024) throw new Error('Receive observation exceeds the API limit.');
  let pending: string | undefined;
  if (phase === 'post') {
    pending = join(spool, `post-${createHash('sha256').update(serialized).digest('hex')}.json`);
    const temporary = `${pending}.${randomUUID()}.tmp`;
    await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' }); await rename(temporary, pending);
  }
  await send(serialized, `receive:${requestId}`);
  if (pending) await unlink(pending);
}
main().catch(() => { console.error('Receive hook failed. The pre-receive hook denies the push; a post-receive failure cannot undo accepted refs. Retained post observations can be retried by the operator.'); process.exitCode = 1; });
