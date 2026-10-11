import { createHash, randomUUID } from 'node:crypto';
import type { PaperCLI } from './paper-builds';
import { readRequestIntent } from './request-intent';
import { isRevisionId } from '../shared/revision-dependencies';
import { isRevisionMetadataHistory, isRevisionMetadataSnapshot, revisionMetadataInput, validRevisionMetadataResult } from '../shared/revision-metadata';

const commands = new Set(['revision-metadata', 'revision-metadata-history', 'edit-revision-metadata']);
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
export async function revisionMetadataCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const edit = command === 'edit-revision-metadata', history = command === 'revision-metadata-history';
  const allowed = ['server', 'json', 'help', ...(edit ? ['intent', 'request-id'] : history ? ['before', 'limit', 'metadata-version'] : [])];
  if (optionNames.some(name => !allowed.includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Use unique supported revision metadata options.');
  const id = args[0]; if (args.length !== 1 || !isRevisionId(id)) throw new Error('Provide one revision ID such as D1, P2 or L3.');
  const path = `/api/revisions/${id}/metadata`;
  if (edit) {
    if (typeof options.intent !== 'string' || !options.intent) throw new Error('Provide --intent REQUEST.json with the exact metadata edit and inspected versions.');
    const input = revisionMetadataInput(await readRequestIntent(options.intent, 'Revision metadata request', 2 * 1024 * 1024));
    const requestId = options['request-id'] ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
    const inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    console.error(safeJson({ path, requestId, intentPath: options.intent, inputSha256, recovery: 'Retain this exact request file and ID to retry an uncertain metadata edit. Source versions and acceptance are unchanged.' }));
    const result = await request<unknown>(path, 'POST', input, requestId);
    if (!validRevisionMetadataResult(result, id, input) || result.inputSha256 !== inputSha256) throw new Error('The metadata receipt does not match the exact request. Retain it for an explicit retry.');
    console.log(safeJson(result)); return true;
  }
  const query = new URLSearchParams();
  for (const [name, key, minimum, maximum] of [['before', 'before', 1, Number.MAX_SAFE_INTEGER], ['limit', 'limit', 1, 100], ['metadata-version', 'expectedMetadataVersion', 0, Number.MAX_SAFE_INTEGER]] as const) {
    const value = options[name]; if (value === undefined) continue;
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}.`);
    query.set(key, value);
  }
  const result = await request<unknown>(`${path}${history ? '/history' : ''}${query.size ? `?${query}` : ''}`);
  if (history ? !isRevisionMetadataHistory(result, id) || options['metadata-version'] !== undefined && result.metadataVersion !== Number(options['metadata-version'])
    || options.before !== undefined && result.transactions.some(transaction => transaction.metadataVersion >= Number(options.before)) || result.transactions.length > Number(options.limit ?? 25)
    : !isRevisionMetadataSnapshot(result, id)) throw new Error('The metadata response does not match the requested revision snapshot.');
  console.log(safeJson(result)); return true;
}
