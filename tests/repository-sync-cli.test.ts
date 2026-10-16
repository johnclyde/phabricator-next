import test from 'node:test';
import assert from 'node:assert/strict';
import { repositorySyncCommand } from '../cli/repository-sync.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import type { RepositoryOperations } from '../shared/repository-sync.ts';

const configuration = 'a'.repeat(64);
const status = (patch: Partial<RepositoryOperations> = {}): RepositoryOperations => ({ snapshot: { repositoryId: 'R1', mode: 'observe', configuration, intervalSeconds: 300, targets: [{ key: 'upstream', direction: 'fetch', state: 'idle', lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, consecutiveFailures: 0, lastError: null, attempts: 0 }], recentAttempts: [] }, canSync: true, cloneUrl: null, accessEpoch: 1, ...patch });
const base = (request: PaperCLI['request'], patch: Partial<PaperCLI> = {}): PaperCLI => ({ command: 'repository-sync', args: ['R1'], options: {}, optionNames: [], download: async () => new Uint8Array(), request, ...patch });
async function output(run: (out: string[], errors: string[]) => Promise<void>) {
  const original = console.log, originalError = console.error, out: string[] = [], errors: string[] = [];
  console.log = value => { out.push(String(value)); }; console.error = value => { errors.push(String(value)); };
  try { await run(out, errors); } finally { console.log = original; console.error = originalError; }
}

test('repository-sync reads status without scheduling and validates identity before printing', async () => output(async (out, errors) => {
  const calls: unknown[][] = [];
  assert.equal(await repositorySyncCommand(base(async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); return status() as T; }, { options: { json: true }, optionNames: ['json'] })), true);
  assert.deepEqual(calls, [['/api/repositories/R1/operations']]);
  assert.equal(JSON.parse(out[0]!).snapshot.mode, 'observe'); assert.equal(errors.length, 0);
  out.length = 0;
  await assert.rejects(repositorySyncCommand(base(async <T>() => status({ snapshot: { ...status().snapshot, repositoryId: 'R2' } }) as T)), /different repository/);
  assert.deepEqual(out, []);
}));

test('fresh sync reads configuration once and prints the exact retry before writing', async () => output(async (out, errors) => {
  const calls: unknown[][] = [];
  await repositorySyncCommand(base(async <T>(...args: Parameters<PaperCLI['request']>) => {
    calls.push(args);
    if (calls.length === 1) return status() as T;
    assert.equal(errors.length, 1, 'retry is available before an uncertain write');
    assert.equal(args[0], '/api/repositories/R1/operations/sync'); assert.equal(args[1], 'POST');
    assert.deepEqual(args[2], { expectedConfiguration: configuration, expectedAccessEpoch: 1 });
    assert.equal(typeof args[3], 'string');
    return status({ receipt: { requestId: args[3]!, configuration, replayed: false } }) as T;
  }, { command: 'sync-repository', options: { json: true }, optionNames: ['json'] }));
  assert.equal(calls.length, 2); assert.equal(JSON.parse(out[0]!).receipt.replayed, false);
  assert.match(errors[0]!, new RegExp(`arc sync-repository R1 --configuration ${configuration} --access-epoch 1 --request-id`));
}));

test('unknown sync outcomes retry the original request without selecting a newer configuration', async () => output(async (out, errors) => {
  const calls: unknown[][] = [], options = { 'request-id': 'retry-same', configuration, 'access-epoch': '1' };
  const context = base(async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); throw new Error('Lost result'); }, { command: 'sync-repository', options, optionNames: Object.keys(options) });
  await assert.rejects(repositorySyncCommand(context), /Lost result/); await assert.rejects(repositorySyncCommand(context), /Lost result/);
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ['/api/repositories/R1/operations/sync', 'POST', { expectedConfiguration: configuration, expectedAccessEpoch: 1 }, 'retry-same']));
  assert.deepEqual(out, []); assert.equal(errors[0], errors[1]);
  await repositorySyncCommand({ ...context, request: async <T>() => status({ receipt: { requestId: 'retry-same', configuration, replayed: true } }) as T });
  assert.match(out[0]!, /Observed externally/); assert.match(out.at(-1)!, /Recovered synchronization request retry-same/);
}));

test('sync rejects invalid or ambiguous arguments and mismatched receipts without accepting work', async () => output(async out => {
  let calls = 0;
  const request = async <T>() => { calls++; return status() as T; };
  for (const patch of [
    { args: ['R0'] }, { args: ['R1', 'R2'] }, { optionNames: ['json', 'json'] }, { optionNames: ['title'] },
    { command: 'sync-repository', options: { 'request-id': 'retained' }, optionNames: ['request-id'] },
    { command: 'sync-repository', options: { configuration, 'access-epoch': '-1' }, optionNames: ['configuration', 'access-epoch'] },
    { command: 'sync-repository', options: { configuration }, optionNames: ['configuration'] },
  ]) await assert.rejects(repositorySyncCommand(base(request, patch)));
  assert.equal(calls, 0);
  const input = { command: 'sync-repository', options: { configuration, 'access-epoch': '1', 'request-id': 'expected' }, optionNames: ['configuration', 'access-epoch', 'request-id'] };
  for (const wrong of [status(), status({ receipt: { requestId: 'other', configuration, replayed: false } }), status({ receipt: { requestId: 'expected', configuration: 'b'.repeat(64), replayed: false } }), status({ accessEpoch: 2, receipt: { requestId: 'expected', configuration, replayed: false } })]) await assert.rejects(repositorySyncCommand(base(async <T>() => wrong as T, input)), /receipt does not match/);
  assert.deepEqual(out, []);
  assert.equal(await repositorySyncCommand(base(request, { command: 'unrelated' })), false);
}));

test('read-only or unconfigured sync cannot schedule, and control characters are escaped', async () => output(async out => {
  let writes = 0;
  await assert.rejects(repositorySyncCommand(base(async <T>(_path: string, method?: string) => { if (method) writes++; return status({ canSync: false }) as T; }, { command: 'sync-repository' })), /not available/);
  assert.equal(writes, 0);
  const snapshot = status().snapshot; snapshot.targets[0]!.lastError = 'Problem\u001b[31m\u202e';
  await repositorySyncCommand(base(async <T>() => status({ snapshot }) as T));
  assert.equal(out.join('\n').includes('\u001b'), false); assert.equal(out.join('\n').includes('\u202e'), false);
}));
