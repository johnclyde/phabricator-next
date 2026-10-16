import { randomUUID } from 'node:crypto';
import { isRepositoryOperations, validRepositorySyncReceipt, type RepositoryOperations, type RepositorySyncInput } from '../shared/repository-sync';
import type { PaperCLI } from './paper-builds';

const safe = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const json = (value: unknown): string => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function print(value: RepositoryOperations, asJson: boolean) {
  if (asJson) { console.log(json(value)); return; }
  const snapshot = value.snapshot;
  console.log(`${snapshot.repositoryId}: ${snapshot.mode === 'host' ? 'Hosted here' : snapshot.mode === 'observe' ? 'Observed externally' : 'Not configured'}`);
  if (value.cloneUrl) console.log(`HTTPS clone: ${safe(value.cloneUrl)}`);
  if (snapshot.configuration) console.log(`Configuration: ${snapshot.configuration}\nAccess epoch: ${value.accessEpoch}`);
  if (snapshot.intervalSeconds) console.log(`Automatic synchronization: every ${snapshot.intervalSeconds} seconds`);
  for (const target of snapshot.targets) {
    console.log(`${safe(target.key)} (${target.direction === 'fetch' ? 'upstream' : 'mirror'}): ${target.state}; last successful sync ${safe(target.lastSuccessAt ?? 'never')}`);
    if (target.nextAttemptAt) console.log(`  Next attempt: ${safe(target.nextAttemptAt)}`);
    if (target.lastError) console.log(`  ${safe(target.lastError)}`);
  }
  if (value.receipt) console.log(`${value.receipt.replayed ? 'Recovered' : 'Recorded'} synchronization request ${safe(value.receipt.requestId)}. Inspect repository-sync for worker progress.`);
}

/** Manual synchronization pins operator configuration before scheduling work. */
export async function repositorySyncCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (command !== 'repository-sync' && command !== 'sync-repository') return false;
  const syncing = command === 'sync-repository';
  const allowed = ['server', 'json', 'help', ...(syncing ? ['request-id', 'configuration', 'access-epoch'] : [])];
  if (optionNames.some(name => !allowed.includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Use unique supported repository synchronization options.');
  const repositoryId = args[0];
  if (args.length !== 1 || !/^R[1-9]\d{0,14}$/.test(repositoryId ?? '')) throw new Error('Provide one exact repository ID, such as R1.');
  const path = `/api/repositories/${repositoryId}/operations`;
  const status = async () => {
    const value = await request<unknown>(path);
    if (!isRepositoryOperations(value, repositoryId)) throw new Error('The synchronization status is invalid or belongs to a different repository.');
    return value;
  };
  if (!syncing) { print(await status(), options.json === true); return true; }
  const providedConfiguration = options.configuration, providedEpoch = options['access-epoch'], providedRequest = options['request-id'];
  let input: RepositorySyncInput;
  if (providedConfiguration !== undefined || providedEpoch !== undefined) {
    if (typeof providedConfiguration !== 'string' || !/^[a-f0-9]{64}$/.test(providedConfiguration) || typeof providedEpoch !== 'string' || !/^(?:0|[1-9]\d*)$/.test(providedEpoch) || !Number.isSafeInteger(Number(providedEpoch))) throw new Error('Provide both --configuration SHA256 and --access-epoch N from the exact original request.');
    input = { expectedConfiguration: providedConfiguration, expectedAccessEpoch: Number(providedEpoch) };
  } else {
    if (providedRequest !== undefined) throw new Error('Retrying with --request-id also requires its original --configuration and --access-epoch. Without these options, a new request reads the current configuration first.');
    const value = await status();
    if (!value.canSync || !value.snapshot.configuration) throw new Error('Synchronization is not available with your current access and this repository configuration.');
    input = { expectedConfiguration: value.snapshot.configuration, expectedAccessEpoch: value.accessEpoch };
  }
  const requestId = providedRequest ?? randomUUID();
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('--request-id must contain 1–200 letters, numbers, dots, underscores, colons, or hyphens.');
  const server = typeof options.server === 'string' ? ` --server ${quote(options.server)}` : '';
  console.error(`Synchronization request ${requestId}. If its result is uncertain, retry exactly:\narc sync-repository ${repositoryId} --configuration ${input.expectedConfiguration} --access-epoch ${input.expectedAccessEpoch} --request-id ${quote(requestId)}${server}${options.json ? ' --json' : ''}`);
  const result = await request<unknown>(`${path}/sync`, 'POST', input, requestId);
  if (!validRepositorySyncReceipt(result, repositoryId, requestId, input)) throw new Error('The synchronization receipt does not match the exact request. Retain the original configuration, access epoch and request ID for recovery.');
  print(result, options.json === true); return true;
}
