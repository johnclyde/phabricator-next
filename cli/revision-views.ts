import { createHash, randomUUID } from 'node:crypto';
import type { AppState } from '../shared/types';
import { evaluateRevisionView, isRevisionViewId, isRevisionViewSnapshot, isRevisionViewsSnapshot, revisionViewInput, validRevisionViewResult, type RevisionViewAction } from '../shared/revision-views';
import type { PaperCLI } from './paper-builds';
import { readRequestIntent } from './request-intent';

const commands = new Set(['revision-views', 'open-revision-view', 'create-revision-view', 'edit-revision-view', 'delete-revision-view']);
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

export async function revisionViewsCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const action: RevisionViewAction | null = command === 'create-revision-view' ? 'create' : command === 'edit-revision-view' ? 'edit' : command === 'delete-revision-view' ? 'delete' : null;
  const allowed = ['server', 'json', 'help', ...(action ? ['intent', 'request-id'] : [])];
  if (optionNames.some(name => !allowed.includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Use unique supported saved revision-view options.');
  const id = args[0];
  if (action === 'create' ? args.length !== 0 : command === 'revision-views' ? args.length > 1 || id !== undefined && !isRevisionViewId(id) : args.length !== 1 || !isRevisionViewId(id)) throw new Error('Provide an exact saved-view ID such as RV1, except when listing or creating views.');
  const path = `/api/revision-views${id ? `/${id}` : ''}${action === 'delete' ? '/delete' : ''}`;
  if (action) {
    if (typeof options.intent !== 'string' || !options.intent) throw new Error('Provide --intent REQUEST.json with the exact saved-view change and its observed versions.');
    const input = revisionViewInput(action, await readRequestIntent(options.intent, 'Saved revision-view request', 16 * 1024));
    const requestId = options['request-id'] ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
    const inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    console.error(safeJson({ path, requestId, intentPath: options.intent, inputSha256, recovery: 'Retain this exact request file and ID to retry an uncertain saved-view change. Filters, view versions and access versions are never refreshed automatically.' }));
    const result = await request<unknown>(path, action === 'edit' ? 'PUT' : 'POST', input, requestId);
    if (!validRevisionViewResult(result, action, input, id)) throw new Error('The saved-view receipt does not match the exact request. Retain it for an explicit retry.');
    console.log(safeJson(result)); return true;
  }
  const result = await request<unknown>(path);
  if (!id) {
    if (!isRevisionViewsSnapshot(result)) throw new Error('The saved-view inventory is invalid or incomplete.');
    console.log(safeJson(result)); return true;
  }
  if (!isRevisionViewSnapshot(result) || result.view.id !== id) throw new Error('The saved view does not match the requested identity.');
  if (command === 'revision-views') { console.log(safeJson(result)); return true; }
  const state = await request<AppState>('/api/state');
  if (!state || state.accessEpoch !== result.accessEpoch || !Array.isArray(state.revisions) || !Array.isArray(state.projects)
    || !Array.isArray(state.followingRevisionIds) || typeof state.currentPrincipalId !== 'string' || !state.currentPrincipalId) throw new Error('The authorized workspace snapshot is unavailable or access changed. Open the saved view again.');
  console.log(safeJson({ ...result, revisions: evaluateRevisionView(result.view.filters, state), projectUnavailable: result.view.filters.projectId !== null && !state.projects.some(project => project.id === result.view.filters.projectId), evaluation: 'Authorized workspace snapshot; no server pagination.' }));
  return true;
}
