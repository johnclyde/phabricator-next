import type { ActorAttribution } from './types';
import type { ObjectAccess } from './policy';
import { isRevisionId } from './revision-dependencies';
import { isRevisionAuthor, isRevisionAuthorHead, type RevisionAuthorHead } from './revision-authorship';
import { validateRevisionMessageCorpus } from './revision-message-corpus';

export const REVISION_METADATA_LIMITS = { titleBytes: 255, corpus: 100_000, message: 10_000, page: 100 } as const;
export interface RevisionMetadataConfig { requireTestPlan: boolean }
export const DEFAULT_REVISION_METADATA_CONFIG: Readonly<RevisionMetadataConfig> = Object.freeze({ requireTestPlan: true });
export interface RevisionMetadataFields { title: string; summary: string; testPlan: string }
/** Null means that the pre-metadata database never recorded a test plan. */
export interface RevisionMetadataState { revisionId: string; version: number; title: string; summary: string; testPlan: string | null; updatedAt: string | null }
export interface RevisionMetadataSnapshot { metadata: RevisionMetadataState; head: RevisionAuthorHead; config: RevisionMetadataConfig; configId: string; access: ObjectAccess; accessEpoch: number }
export interface RevisionMetadataInput extends RevisionMetadataFields { message: string; expectedMetadataVersion: number; expectedVersion: number; expectedVersionId: string; expectedContentHash: string; expectedAccessEpoch: number; expectedConfigId: string }
export interface RevisionMetadataTransaction { id: string; revisionId: string; operationId: string; metadataVersion: number; head: RevisionAuthorHead; before: RevisionMetadataState; after: RevisionMetadataState; message: string; attribution: ActorAttribution; createdAt: string }
export interface RevisionMetadataReceipt { revisionId: string; operationId: string; inputSha256: string; changed: boolean; metadata: RevisionMetadataState; transaction: RevisionMetadataTransaction | null; accessEpoch: number }
export interface RevisionMetadataHistory { revisionId: string; metadataVersion: number; transactions: RevisionMetadataTransaction[]; nextBefore: number | null; accessEpoch: number }

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum && !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value);
// Legacy string() admitted isolated UTF-16 surrogates. Preserve those exact
// baseline strings, but require well-formed Unicode for every fresh edit.
const legacyText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum && !value.includes('\0');
const identifier = (value: unknown): value is string => text(value, 240) && value.length > 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));
export const isRevisionMetadataTitle = (value: unknown): value is string => text(value, REVISION_METADATA_LIMITS.titleBytes) && value.length > 0 && new TextEncoder().encode(value).byteLength <= REVISION_METADATA_LIMITS.titleBytes;
export const isRevisionMetadataCorpus = (value: unknown): value is string => text(value, REVISION_METADATA_LIMITS.corpus);
export const isRevisionMetadataConfig = (value: unknown): value is RevisionMetadataConfig => object(value) && keys(value, ['requireTestPlan']) && typeof value.requireTestPlan === 'boolean';
/** Fresh creation/full edit validation. Preserve submitted strings exactly. */
export function revisionMetadataFields(value: { title: unknown; summary?: unknown; testPlan?: unknown }, requireTestPlan: boolean): RevisionMetadataFields {
  const summary = value.summary === undefined ? '' : value.summary, testPlan = value.testPlan === undefined ? '' : value.testPlan;
  if (!isRevisionMetadataTitle(value.title)) throw new Error('Title must be nonempty valid text of at most 255 UTF-8 bytes.');
  if (!isRevisionMetadataCorpus(summary) || !isRevisionMetadataCorpus(testPlan)) throw new Error('Summary and test plan must be valid text of at most 100,000 characters.');
  if (requireTestPlan && testPlan.length === 0) throw new Error('A test plan is required. Describe the actions performed to verify this change.');
  validateRevisionMessageCorpus(summary, 'Summary'); validateRevisionMessageCorpus(testPlan, 'Test Plan');
  return { title: value.title, summary, testPlan };
}
export function isRevisionMetadataAttribution(value: unknown): value is ActorAttribution { return object(value) && keys(value, ['principalId', 'displayName', 'credentialId', 'requestId']) && isRevisionAuthor({ principalId: value.principalId, displayName: value.displayName }) && (value.credentialId === null || identifier(value.credentialId)) && identifier(value.requestId); }
export function revisionMetadataInput(value: unknown): RevisionMetadataInput {
  if (!object(value) || !keys(value, ['title', 'summary', 'testPlan', 'message', 'expectedMetadataVersion', 'expectedVersion', 'expectedVersionId', 'expectedContentHash', 'expectedAccessEpoch', 'expectedConfigId'])
    || !isRevisionMetadataTitle(value.title) || !isRevisionMetadataCorpus(value.summary) || !isRevisionMetadataCorpus(value.testPlan) || !text(value.message, REVISION_METADATA_LIMITS.message)
    || !integer(value.expectedMetadataVersion) || !integer(value.expectedVersion, 1) || !identifier(value.expectedVersionId) || !hash(value.expectedContentHash) || !integer(value.expectedAccessEpoch) || !hash(value.expectedConfigId)) throw new Error('Provide complete revision metadata and exact metadata, source, configuration and access pins.');
  return { title: value.title, summary: value.summary, testPlan: value.testPlan, message: value.message, expectedMetadataVersion: value.expectedMetadataVersion, expectedVersion: value.expectedVersion, expectedVersionId: value.expectedVersionId, expectedContentHash: value.expectedContentHash, expectedAccessEpoch: value.expectedAccessEpoch, expectedConfigId: value.expectedConfigId };
}
export function isRevisionMetadataState(value: unknown, id?: string): value is RevisionMetadataState {
  if (!object(value) || !keys(value, ['revisionId', 'version', 'title', 'summary', 'testPlan', 'updatedAt']) || !isRevisionId(value.revisionId) || id !== undefined && value.revisionId !== id || !integer(value.version) || !(isRevisionMetadataCorpus(value.summary) || value.version === 0 && legacyText(value.summary, REVISION_METADATA_LIMITS.corpus))) return false;
  // Existing titles were limited to 240 UTF-16 units rather than UTF-8 bytes.
  const title = isRevisionMetadataTitle(value.title) || value.version === 0 && legacyText(value.title, 240) && value.title.length > 0;
  return title && (value.testPlan === null ? value.version === 0 : isRevisionMetadataCorpus(value.testPlan)) && (value.version === 0 ? value.updatedAt === null : date(value.updatedAt));
}
export function isRevisionMetadataTransaction(value: unknown, id?: string): value is RevisionMetadataTransaction {
  if (!object(value) || !keys(value, ['id', 'revisionId', 'operationId', 'metadataVersion', 'head', 'before', 'after', 'message', 'attribution', 'createdAt']) || !identifier(value.id) || !isRevisionId(value.revisionId) || id !== undefined && value.revisionId !== id || !identifier(value.operationId) || !integer(value.metadataVersion, 1) || !isRevisionAuthorHead(value.head)
    || !isRevisionMetadataState(value.before, value.revisionId) || !isRevisionMetadataState(value.after, value.revisionId) || value.before.version + 1 !== value.metadataVersion || value.after.version !== value.metadataVersion || !text(value.message, REVISION_METADATA_LIMITS.message) || !isRevisionMetadataAttribution(value.attribution) || !date(value.createdAt) || value.after.updatedAt !== value.createdAt) return false;
  return value.before.title !== value.after.title || value.before.summary !== value.after.summary || value.before.testPlan !== value.after.testPlan;
}
export function validRevisionMetadataResult(value: unknown, id: string, input: RevisionMetadataInput, principalId?: string): value is RevisionMetadataReceipt {
  if (!object(value) || !keys(value, ['revisionId', 'operationId', 'inputSha256', 'changed', 'metadata', 'transaction', 'accessEpoch']) || value.revisionId !== id || !identifier(value.operationId) || !hash(value.inputSha256) || typeof value.changed !== 'boolean' || !integer(value.accessEpoch) || !isRevisionMetadataState(value.metadata, id)
    || value.metadata.title !== input.title || value.metadata.summary !== input.summary || value.metadata.testPlan !== input.testPlan || value.metadata.version !== input.expectedMetadataVersion + Number(value.changed)) return false;
  if (!value.changed) return value.transaction === null;
  const t = value.transaction;
  return isRevisionMetadataTransaction(t, id) && t.operationId === value.operationId && t.message === input.message && t.head.versionId === input.expectedVersionId && t.head.number === input.expectedVersion && t.head.contentHash === input.expectedContentHash && t.before.version === input.expectedMetadataVersion && JSON.stringify(t.after) === JSON.stringify(value.metadata) && (principalId === undefined || t.attribution.principalId === principalId);
}
export function isRevisionMetadataSnapshot(value: unknown, id: string): value is RevisionMetadataSnapshot {
  return object(value) && keys(value, ['metadata', 'head', 'config', 'configId', 'access', 'accessEpoch']) && isRevisionMetadataState(value.metadata, id) && isRevisionAuthorHead(value.head) && isRevisionMetadataConfig(value.config) && hash(value.configId) && integer(value.accessEpoch)
    && object(value.access) && object(value.access.policy) && value.access.policy.objectId === id && object(value.access.capabilities) && ['view', 'edit', 'interact', 'managePolicy'].every(key => typeof (value.access as ObjectAccess).capabilities[key as keyof ObjectAccess['capabilities']] === 'boolean');
}
export function isRevisionMetadataHistory(value: unknown, id: string): value is RevisionMetadataHistory {
  if (!object(value) || !keys(value, ['revisionId', 'metadataVersion', 'transactions', 'nextBefore', 'accessEpoch']) || value.revisionId !== id || !integer(value.metadataVersion) || !integer(value.accessEpoch) || !Array.isArray(value.transactions) || value.transactions.length > REVISION_METADATA_LIMITS.page || !(value.nextBefore === null || integer(value.nextBefore, 1))) return false;
  let previous = value.metadataVersion + 1; const ids = new Set<string>(), operations = new Set<string>();
  for (const t of value.transactions) { if (!isRevisionMetadataTransaction(t, id) || t.metadataVersion >= previous || ids.has(t.id) || operations.has(t.operationId)) return false; previous = t.metadataVersion; ids.add(t.id); operations.add(t.operationId); }
  return value.nextBefore === null || value.transactions.length > 0 && value.nextBefore === value.transactions.at(-1)!.metadataVersion;
}
