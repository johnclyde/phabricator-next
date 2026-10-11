import type { Revision } from '../shared/types';
import { isRevisionProjectSnapshot, isRevisionProjectTransaction, revisionProjectInput, validRevisionProjectResult, type RevisionProjectHistory, type RevisionProjectInput, type RevisionProjectReceipt, type RevisionProjectSnapshot } from '../shared/revision-projects';

export const REVISION_PROJECT_HISTORY_LIMIT = 500;
export interface RevisionProjectReading { snapshot: RevisionProjectSnapshot; history: RevisionProjectHistory }
export type RevisionProjectDraft = RevisionProjectInput;
export interface RevisionProjectIntent { id: string; revisionId: string; body: RevisionProjectInput; draft: RevisionProjectDraft }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min;
export function revisionProjectIds(value: Pick<Revision, 'projectId'> & { projectIds?: string[] }): string[] { return value.projectIds ?? (value.projectId ? [value.projectId] : []); }
export function projectTagSnapshot(value: unknown, id: string): value is RevisionProjectSnapshot { return isRevisionProjectSnapshot(value, id) && value.access.capabilities.view; }
export function projectTagHistory(value: unknown, id: string): value is RevisionProjectHistory {
  if (!record(value) || Object.keys(value).length !== 5 || value.revisionId !== id || !integer(value.projectVersion) || !integer(value.accessEpoch) || !Array.isArray(value.transactions) || value.transactions.length > REVISION_PROJECT_HISTORY_LIMIT || !(value.nextBefore === null || integer(value.nextBefore, 1))) return false;
  let previous = value.projectVersion + 1; const ids = new Set<string>(), operations = new Set<string>();
  for (const item of value.transactions) { if (!isRevisionProjectTransaction(item, id) || item.projectVersion >= previous || ids.has(item.id) || operations.has(item.operationId)) return false; previous = item.projectVersion; ids.add(item.id); operations.add(item.operationId); }
  return value.nextBefore === null || value.nextBefore === value.transactions.at(-1)?.projectVersion;
}
export function projectTagReading(value: unknown, id: string): RevisionProjectReading | null { return record(value) && Object.keys(value).length === 2 && projectTagSnapshot(value.snapshot, id) && projectTagHistory(value.history, id) && value.snapshot.tags.version === value.history.projectVersion && value.snapshot.accessEpoch === value.history.accessEpoch ? { snapshot: value.snapshot, history: value.history } : null; }
export function mergeProjectTagHistory(before: RevisionProjectHistory, next: RevisionProjectHistory): RevisionProjectHistory {
  if (!projectTagHistory(before, before.revisionId) || !projectTagHistory(next, before.revisionId) || before.nextBefore === null || before.projectVersion !== next.projectVersion || before.accessEpoch !== next.accessEpoch || next.transactions.some(item => item.projectVersion >= before.nextBefore! || before.transactions.some(old => old.id === item.id || old.operationId === item.operationId)) || before.transactions.length + next.transactions.length > REVISION_PROJECT_HISTORY_LIMIT) throw new Error('Project tag history changed. Reload Project Tags before continuing.');
  return { ...next, transactions: [...before.transactions, ...next.transactions] };
}
export function projectTagDraft(value: unknown): RevisionProjectDraft | null { try { return revisionProjectInput(value); } catch { return null; } }
export function projectTagIntent(value: unknown, id: string): RevisionProjectIntent | null {
  if (!record(value) || Object.keys(value).length !== 4 || value.revisionId !== id || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.id)) return null;
  const body = projectTagDraft(value.body), draft = projectTagDraft(value.draft); return body && draft && JSON.stringify(body) === JSON.stringify(draft) ? { id: value.id, revisionId: id, body, draft } : null;
}
export function prepareProjectTagDraft(snapshot: RevisionProjectSnapshot, action: RevisionProjectInput['action']): RevisionProjectDraft { return { action, projectIds: [], expectedProjectVersion: snapshot.tags.version, expectedAccessEpoch: snapshot.accessEpoch }; }
export function projectTagDraftMatches(draft: RevisionProjectDraft, snapshot: RevisionProjectSnapshot): boolean { return draft.expectedProjectVersion === snapshot.tags.version && draft.expectedAccessEpoch === snapshot.accessEpoch; }
export async function verifiedProjectTagResult(value: unknown, id: string, input: RevisionProjectInput, principalId: string): Promise<RevisionProjectReceipt> {
  if (!validRevisionProjectResult(value, id, input, principalId)) throw new Error('The project tag receipt does not match this request. Retain it for explicit retry.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(revisionProjectInput(input))))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (value.inputSha256 !== hash) throw new Error('The project tag receipt belongs to a different request. Retain this exact request for recovery.');
  return value;
}
