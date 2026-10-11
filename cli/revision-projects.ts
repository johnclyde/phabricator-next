import { createHash, randomUUID } from 'node:crypto';
import type { PaperCLI } from './paper-builds';
import { readRequestIntent } from './request-intent';
import { isRevisionId } from '../shared/revision-dependencies';
import { revisionProjectInput, isRevisionProjectSnapshot, isRevisionProjectHistory, validRevisionProjectResult } from '../shared/revision-projects';

const commands = new Set(['revision-projects', 'revision-project-history', 'edit-revision-projects']);
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
export async function revisionProjectsCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const edit = command === 'edit-revision-projects', history = command === 'revision-project-history';
  const allowed = ['server', 'json', 'help', ...(edit ? ['intent', 'request-id'] : history ? ['before', 'limit', 'project-version'] : [])];
  if (optionNames.some(name => !allowed.includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Use unique supported revision project-tag options.');
  const id = args[0]; if (args.length !== 1 || !isRevisionId(id)) throw new Error('Provide one revision ID such as D1, P2 or L3.');
  const path = `/api/revisions/${id}/projects`;
  if (edit) {
    if (typeof options.intent !== 'string' || !options.intent) throw new Error('Provide --intent REQUEST.json with the exact tag action, selected project IDs, project version and access epoch.');
    const input = revisionProjectInput(await readRequestIntent(options.intent, 'Revision project-tag request'));
    const requestId = options['request-id'] ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
    const inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    console.error(safeJson({ path, requestId, intentPath: options.intent, inputSha256, recovery: 'Retain this exact request file and ID to retry an uncertain project-tag change. Project versions and selected IDs are never refreshed automatically.' }));
    const result = await request<unknown>(path, 'POST', input, requestId);
    if (!validRevisionProjectResult(result, id, input) || result.inputSha256 !== inputSha256) throw new Error('The project-tag receipt does not match the exact request. Retain it for an explicit retry.');
    console.log(safeJson(result)); return true;
  }
  const query = new URLSearchParams();
  for (const [name, key, minimum, maximum] of [['before', 'before', 1, Number.MAX_SAFE_INTEGER], ['limit', 'limit', 1, 100], ['project-version', 'expectedProjectVersion', 0, Number.MAX_SAFE_INTEGER]] as const) {
    const value = options[name]; if (value === undefined) continue;
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}.`);
    query.set(key, value);
  }
  const result = await request<unknown>(`${path}${history ? '/history' : ''}${query.size ? `?${query}` : ''}`);
  if (history) {
    if (!isRevisionProjectHistory(result, id) || result.transactions.length > Number(options.limit ?? 25)
      || options['project-version'] !== undefined && result.projectVersion !== Number(options['project-version'])
      || options.before !== undefined && result.transactions.some(row => row.projectVersion >= Number(options.before))) throw new Error('The project-tag history does not match the requested page and version.');
  } else if (!isRevisionProjectSnapshot(result, id)) throw new Error('The project-tag snapshot does not match the requested revision.');
  console.log(safeJson(result)); return true;
}
