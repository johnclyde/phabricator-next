import type { ActorAttribution, RevisionStatus } from './types';
import type { ObjectAccess } from './policy';
import { isRevisionId } from './revision-dependencies';

export interface RevisionAuthor { principalId: string; displayName: string }
export interface RevisionAuthorHead { versionId: string; number: number; contentHash: string }
export interface RevisionAuthorship {
  revisionId: string;
  version: number;
  author: RevisionAuthor | null;
  originalAuthor: RevisionAuthor | null;
  updatedAt: string | null;
}
export interface RevisionAuthorPins {
  expectedAuthorVersion: number;
  expectedVersion: number;
  expectedVersionId: string;
  expectedContentHash: string;
  expectedAccessEpoch: number;
}
export type RevisionAuthorInput = RevisionAuthorPins & { message: string } & (
  { action: 'assign'; authorId: string } | { action: 'commandeer' }
);
export interface RevisionAuthorTransaction {
  id: string;
  revisionId: string;
  operationId: string;
  authorVersion: number;
  action: RevisionAuthorInput['action'];
  previousAuthor: RevisionAuthor | null;
  author: RevisionAuthor;
  head: RevisionAuthorHead;
  message: string;
  attribution: ActorAttribution;
  createdAt: string;
}
export interface RevisionAuthorHistory {
  revisionId: string;
  authorVersion: number;
  transactions: RevisionAuthorTransaction[];
  nextBefore: number | null;
  accessEpoch: number;
}
export interface RevisionAuthorshipSnapshot {
  authorship: RevisionAuthorship;
  head: RevisionAuthorHead;
  status: RevisionStatus;
  access: ObjectAccess;
  accessEpoch: number;
}
export interface RevisionAuthorReceipt {
  revisionId: string;
  operationId: string;
  inputSha256: string;
  transaction: RevisionAuthorTransaction;
  accessEpoch: number;
}
export interface RevisionAuthorAccessLost {
  revisionId: string;
  operationId: string;
  inputSha256: string;
  saved: true;
  accessLost: true;
  accessEpoch: number;
}
export type RevisionAuthorResult = RevisionAuthorReceipt | RevisionAuthorAccessLost;
export const REVISION_AUTHOR_LIMITS = { message: 10_000, page: 100 } as const;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));
export const isRevisionAuthorId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
export const isRevisionAuthor = (value: unknown): value is RevisionAuthor => object(value) && keys(value, ['principalId', 'displayName']) && isRevisionAuthorId(value.principalId) && text(value.displayName, 240);
export const isRevisionAuthorHead = (value: unknown): value is RevisionAuthorHead => object(value) && keys(value, ['versionId', 'number', 'contentHash']) && text(value.versionId, 240) && integer(value.number, 1) && hash(value.contentHash);

/** Pure canonical input validation, shared by browser, CLI and server. */
export function revisionAuthorInput(value: unknown): RevisionAuthorInput {
  if (!object(value) || !keys(value, ['action', 'message', 'expectedAuthorVersion', 'expectedVersion', 'expectedVersionId', 'expectedContentHash', 'expectedAccessEpoch', ...(value.action === 'assign' ? ['authorId'] : [])])
    || !['assign', 'commandeer'].includes(String(value.action)) || typeof value.action !== 'string'
    || !integer(value.expectedAuthorVersion) || !integer(value.expectedVersion, 1) || !text(value.expectedVersionId, 240) || !hash(value.expectedContentHash) || !integer(value.expectedAccessEpoch)
    || typeof value.message !== 'string' || value.message.length > REVISION_AUTHOR_LIMITS.message || value.message.includes('\0')
    || value.action === 'assign' && !isRevisionAuthorId(value.authorId)) throw new Error('Provide an exact author action, source identity, author version and access epoch.');
  const pins: RevisionAuthorPins = { expectedAuthorVersion: value.expectedAuthorVersion, expectedVersion: value.expectedVersion, expectedVersionId: value.expectedVersionId, expectedContentHash: value.expectedContentHash, expectedAccessEpoch: value.expectedAccessEpoch };
  return value.action === 'assign' ? { action: 'assign', authorId: value.authorId as string, ...pins, message: value.message } : { action: 'commandeer', ...pins, message: value.message };
}

export function isRevisionAuthorship(value: unknown, id?: string): value is RevisionAuthorship {
  return object(value) && keys(value, ['revisionId', 'version', 'author', 'originalAuthor', 'updatedAt']) && isRevisionId(value.revisionId) && (id === undefined || id === value.revisionId)
    && integer(value.version) && (value.author === null || isRevisionAuthor(value.author)) && (value.originalAuthor === null || isRevisionAuthor(value.originalAuthor))
    && (value.version === 0 ? value.updatedAt === null && value.author?.principalId === value.originalAuthor?.principalId && value.author?.displayName === value.originalAuthor?.displayName : value.author !== null && text(value.updatedAt, 64) && Number.isFinite(Date.parse(value.updatedAt)));
}
export function isRevisionAuthorTransaction(value: unknown, id?: string): value is RevisionAuthorTransaction {
  if (!object(value) || !keys(value, ['id', 'revisionId', 'operationId', 'authorVersion', 'action', 'previousAuthor', 'author', 'head', 'message', 'attribution', 'createdAt'])
    || !text(value.id, 240) || !text(value.operationId, 240) || !isRevisionId(value.revisionId) || id !== undefined && id !== value.revisionId || !integer(value.authorVersion, 1)
    || value.action !== 'assign' && value.action !== 'commandeer' || value.previousAuthor !== null && !isRevisionAuthor(value.previousAuthor) || !isRevisionAuthor(value.author) || !isRevisionAuthorHead(value.head)
    || typeof value.message !== 'string' || value.message.length > REVISION_AUTHOR_LIMITS.message || value.message.includes('\0') || !text(value.createdAt, 64) || !Number.isFinite(Date.parse(value.createdAt))
    || !object(value.attribution) || !keys(value.attribution, ['principalId', 'displayName', 'credentialId', 'requestId']) || !isRevisionAuthorId(value.attribution.principalId)
    || !text(value.attribution.displayName, 240) || !(value.attribution.credentialId === null || text(value.attribution.credentialId, 240)) || !text(value.attribution.requestId, 240)) return false;
  return value.previousAuthor?.principalId !== value.author.principalId && (value.action !== 'commandeer' || value.author.principalId === value.attribution.principalId);
}
export function validRevisionAuthorResult(value: unknown, id: string, input: RevisionAuthorInput, principalId?: string): value is RevisionAuthorResult {
  if (!object(value) || value.revisionId !== id || !text(value.operationId, 240) || !integer(value.accessEpoch)) return false;
  if (value.accessLost === true) return input.action === 'assign' && (principalId === undefined || input.authorId !== principalId)
    && keys(value, ['revisionId', 'operationId', 'inputSha256', 'saved', 'accessLost', 'accessEpoch']) && value.saved === true && hash(value.inputSha256);
  if (!keys(value, ['revisionId', 'operationId', 'inputSha256', 'transaction', 'accessEpoch']) || !hash(value.inputSha256) || !isRevisionAuthorTransaction(value.transaction, id)) return false;
  const transaction = value.transaction;
  return transaction.operationId === value.operationId && transaction.action === input.action && transaction.authorVersion === input.expectedAuthorVersion + 1 && transaction.message === input.message
    && transaction.head.number === input.expectedVersion && transaction.head.versionId === input.expectedVersionId && transaction.head.contentHash === input.expectedContentHash
    && (input.action !== 'assign' || transaction.author.principalId === input.authorId) && (principalId === undefined || transaction.attribution.principalId === principalId);
}

export function isRevisionAuthorshipSnapshot(value: unknown, id: string): value is RevisionAuthorshipSnapshot {
  if (!(object(value) && keys(value, ['authorship', 'head', 'status', 'access', 'accessEpoch']) && isRevisionAuthorship(value.authorship, id) && isRevisionAuthorHead(value.head)
    && typeof value.status === 'string' && ['draft', 'needs_review', 'changes_requested', 'accepted', 'closed'].includes(value.status) && integer(value.accessEpoch)
    && object(value.access) && object(value.access.policy) && value.access.policy.objectId === id && object(value.access.capabilities))) return false;
  const capabilities = value.access.capabilities;
  return ['view', 'edit', 'interact', 'managePolicy'].every(key => typeof capabilities[key] === 'boolean');
}
export function isRevisionAuthorHistory(value: unknown, id: string): value is RevisionAuthorHistory {
  if (!object(value) || !keys(value, ['revisionId', 'authorVersion', 'transactions', 'nextBefore', 'accessEpoch']) || value.revisionId !== id || !integer(value.authorVersion) || !integer(value.accessEpoch)
    || !Array.isArray(value.transactions) || value.transactions.length > REVISION_AUTHOR_LIMITS.page || !(value.nextBefore === null || integer(value.nextBefore, 1))) return false;
  let previous = value.authorVersion + 1;
  const operations = new Set<string>(), ids = new Set<string>();
  for (const transaction of value.transactions) {
    if (!isRevisionAuthorTransaction(transaction, id) || transaction.authorVersion >= previous || operations.has(transaction.operationId) || ids.has(transaction.id)) return false;
    previous = transaction.authorVersion; operations.add(transaction.operationId); ids.add(transaction.id);
  }
  return value.nextBefore === null || value.transactions.length > 0 && value.nextBefore === value.transactions.at(-1)!.authorVersion;
}
