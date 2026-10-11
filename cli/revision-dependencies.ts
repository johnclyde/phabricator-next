import { createHash, randomUUID } from 'node:crypto';
import type { PaperCLI } from './paper-builds';
import { readRequestIntent } from './request-intent';
import { isRevisionId, revisionDependencyInput, validRevisionDependencyReceipt, type RevisionDependencyPage, type RevisionDependencyHistory } from '../shared/revision-dependencies';

const commands = new Set(['revision-dependencies', 'revision-dependency-history', 'edit-revision-dependencies']);
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export async function revisionDependenciesCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const editing = command === 'edit-revision-dependencies', history = command === 'revision-dependency-history';
  const allowed = ['server', 'json', 'help', ...(editing ? ['intent', 'request-id'] : ['limit', 'relationship-version', ...(history ? ['before'] : ['direction', 'after'])])];
  if (optionNames.some(name => !allowed.includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Use unique supported options for this revision dependency command.');
  const id = args[0];
  if (args.length !== 1 || !isRevisionId(id)) throw new Error('Provide one revision ID such as D1, P2 or L3.');
  const root = `/api/revisions/${id}/dependencies`;
  if (editing) {
    if (typeof options.intent !== 'string' || !options.intent) throw new Error('Provide --intent REQUEST.json with the exact relationship and access versions.');
    const input = revisionDependencyInput(await readRequestIntent(options.intent, 'Revision dependency request'));
    if ([...input.add, ...input.remove].includes(id)) throw new Error('A revision cannot depend on itself.');
    const requestId = options['request-id'] ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
    console.error(safeJson({ path: root, requestId, intentPath: options.intent, intentSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), recovery: 'Retain this exact request and ID for an uncertain-result retry.' }));
    const receipt = await request<unknown>(root, 'POST', input, requestId);
    if (!validRevisionDependencyReceipt(receipt, id, input)) throw new Error('The dependency receipt did not match the retained intent. Retry the same request to confirm its outcome.');
    console.log(safeJson(receipt));
    return true;
  }
  const query = new URLSearchParams();
  for (const [name, key, min, max] of [['limit', 'limit', 1, 100], ['relationship-version', 'expectedRelationshipVersion', 0, Number.MAX_SAFE_INTEGER], ['before', 'before', 1, Number.MAX_SAFE_INTEGER]] as const) {
    const value = options[name]; if (value === undefined) continue;
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
    query.set(key, value);
  }
  if (!history) {
    if (options.direction !== 'parents' && options.direction !== 'children') throw new Error('Choose --direction parents or --direction children.');
    query.set('direction', options.direction);
    if (options.after !== undefined) { if (!isRevisionId(options.after)) throw new Error('--after must identify a revision from the previous page.'); query.set('after', options.after); }
  }
  const page = await request<RevisionDependencyPage | RevisionDependencyHistory>(`${root}${history ? '/history' : ''}${query.size ? `?${query}` : ''}`);
  if (page.revisionId !== id || !Number.isSafeInteger(page.relationshipVersion) || page.relationshipVersion < 0 || !Number.isSafeInteger(page.accessEpoch) || page.accessEpoch < 0
    || (options['relationship-version'] !== undefined && page.relationshipVersion !== Number(options['relationship-version']))
    || (history ? !('transactions' in page && Array.isArray(page.transactions)) : !('revisions' in page && Array.isArray(page.revisions) && page.direction === options.direction))) throw new Error('The dependency page did not match the requested snapshot.');
  console.log(safeJson(page));
  return true;
}
