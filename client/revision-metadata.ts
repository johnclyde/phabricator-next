import { isRevisionMetadataSnapshot, isRevisionMetadataTransaction, revisionMetadataFields, revisionMetadataInput, validRevisionMetadataResult, type RevisionMetadataHistory, type RevisionMetadataInput, type RevisionMetadataReceipt, type RevisionMetadataSnapshot } from '../shared/revision-metadata';

export const METADATA_HISTORY_LIMIT = 500;
export interface MetadataReading { snapshot: RevisionMetadataSnapshot; history: RevisionMetadataHistory }
export type MetadataDraft = RevisionMetadataInput;
export interface MetadataIntent { id: string; revisionId: string; body: RevisionMetadataInput; draft: MetadataDraft }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function metadataSnapshot(value: unknown, id: string): value is RevisionMetadataSnapshot { return isRevisionMetadataSnapshot(value, id) && value.access.capabilities.view && typeof value.access.policy.spaceId === 'string' && integer(value.access.policy.version, 1); }
export function metadataHistory(value: unknown, id: string): value is RevisionMetadataHistory {
  if (!record(value) || Object.keys(value).length !== 5 || value.revisionId !== id || !integer(value.metadataVersion) || !integer(value.accessEpoch) || !Array.isArray(value.transactions) || value.transactions.length > METADATA_HISTORY_LIMIT || !(value.nextBefore === null || integer(value.nextBefore, 1))) return false;
  let previous = value.metadataVersion + 1;
  const ids = new Set<string>(), operations = new Set<string>();
  for (const item of value.transactions) {
    if (!isRevisionMetadataTransaction(item, id) || item.metadataVersion >= previous || ids.has(item.id) || operations.has(item.operationId)) return false;
    previous = item.metadataVersion; ids.add(item.id); operations.add(item.operationId);
  }
  return value.nextBefore === null || value.nextBefore === value.transactions.at(-1)?.metadataVersion;
}
export function metadataReading(value: unknown, id: string): MetadataReading | null { return record(value) && Object.keys(value).length === 2 && metadataSnapshot(value.snapshot, id) && metadataHistory(value.history, id) && value.snapshot.metadata.version === value.history.metadataVersion && value.snapshot.accessEpoch === value.history.accessEpoch ? { snapshot: value.snapshot, history: value.history } : null; }
export function mergeMetadataHistory(before: RevisionMetadataHistory, next: RevisionMetadataHistory): RevisionMetadataHistory {
  if (!metadataHistory(before, before.revisionId) || !metadataHistory(next, before.revisionId) || before.nextBefore === null || before.metadataVersion !== next.metadataVersion || before.accessEpoch !== next.accessEpoch || next.transactions.some(item => item.metadataVersion >= before.nextBefore! || before.transactions.some(old => old.id === item.id || old.operationId === item.operationId)) || before.transactions.length + next.transactions.length > METADATA_HISTORY_LIMIT) throw new Error('Revision detail history changed. Reload Revision Details before continuing.');
  return { ...next, transactions: [...before.transactions, ...next.transactions] };
}
/** Incomplete authored fields remain recoverable while the exact base stays pinned. */
export function metadataDraft(value: unknown): MetadataDraft | null {
  if (!record(value) || !['title', 'summary', 'testPlan', 'message'].every(key => typeof value[key] === 'string' && value[key].length <= (key === 'message' ? 10000 : 100000))) return null;
  try { revisionMetadataInput({ ...value, title: 'Draft', summary: '', testPlan: '', message: '' }); return value as unknown as MetadataDraft; } catch { return null; }
}
export function metadataIntent(value: unknown, id: string): MetadataIntent | null {
  if (!record(value) || Object.keys(value).length !== 4 || value.revisionId !== id || !uuid(value.id)) return null;
  try { const body = revisionMetadataInput(value.body), draft = metadataDraft(value.draft); return draft && JSON.stringify(body) === JSON.stringify(draft) ? { id: value.id, revisionId: id, body, draft } : null; } catch { return null; }
}
export function prepareMetadataDraft(snapshot: RevisionMetadataSnapshot): MetadataDraft { return { title: snapshot.metadata.title, summary: snapshot.metadata.summary, testPlan: snapshot.metadata.testPlan ?? '', message: '', expectedMetadataVersion: snapshot.metadata.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: snapshot.accessEpoch, expectedConfigId: snapshot.configId }; }
export function metadataDraftMatches(draft: MetadataDraft, snapshot: RevisionMetadataSnapshot): boolean { return draft.expectedMetadataVersion === snapshot.metadata.version && draft.expectedVersion === snapshot.head.number && draft.expectedVersionId === snapshot.head.versionId && draft.expectedContentHash === snapshot.head.contentHash && draft.expectedAccessEpoch === snapshot.accessEpoch && draft.expectedConfigId === snapshot.configId; }
export function metadataDraftError(draft: MetadataDraft, requireTestPlan: boolean): string | null { try { revisionMetadataFields(draft, requireTestPlan); revisionMetadataInput(draft); return null; } catch (error) { return error instanceof Error ? error.message : 'Check the revision details before saving.'; } }
export function metadataReadingCurrent(reading: MetadataReading, known?: { currentVersion: number; metadataVersion?: number }): boolean { return !known || reading.snapshot.head.number >= known.currentVersion && reading.snapshot.metadata.version >= (known.metadataVersion ?? 0); }
export async function verifiedMetadataResult(value: unknown, id: string, input: RevisionMetadataInput, principalId: string): Promise<RevisionMetadataReceipt> {
  if (!validRevisionMetadataResult(value, id, input, principalId)) throw new Error('The revision detail receipt does not match this exact request. Keep it for explicit retry.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(revisionMetadataInput(input))))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (value.inputSha256 !== hash) throw new Error('The revision detail receipt belongs to a different request. Keep this request for recovery.');
  return value;
}
