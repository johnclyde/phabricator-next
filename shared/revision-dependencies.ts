import type { ActorAttribution, Revision } from './types';

export type RevisionDependencyDirection = 'parents' | 'children';
export type RevisionDependencyReference = Pick<Revision, 'id' | 'title' | 'kind' | 'status' | 'currentVersion' | 'updatedAt'>;
export interface RevisionDependencyInput {
  direction: RevisionDependencyDirection;
  add: string[];
  remove: string[];
  expectedRelationshipVersion: number;
  expectedAccessEpoch: number;
}
export interface RevisionDependencyQuery {
  direction: RevisionDependencyDirection;
  after?: string;
  limit?: number;
  expectedRelationshipVersion?: number;
}
export interface RevisionDependencyPage {
  revisionId: string;
  direction: RevisionDependencyDirection;
  relationshipVersion: number;
  revisions: RevisionDependencyReference[];
  nextAfter: string | null;
  accessEpoch: number;
}
export interface RevisionDependencyChange { direction: RevisionDependencyDirection; action: 'added' | 'removed'; revisionId: string }
export interface RevisionDependencyTransaction {
  id: string;
  revisionId: string;
  sequence: number;
  relationshipVersion: number;
  operationId: string;
  change: RevisionDependencyChange;
  actor: string;
  attribution: ActorAttribution;
  createdAt: string;
}
export interface RevisionDependencyHistoryQuery { before?: number; limit?: number; expectedRelationshipVersion?: number }
export interface RevisionDependencyHistory {
  revisionId: string;
  relationshipVersion: number;
  transactions: RevisionDependencyTransaction[];
  nextBefore: number | null;
  accessEpoch: number;
}
export interface RevisionDependencyReceipt {
  revisionId: string;
  relationshipVersion: number;
  operationId: string;
  changes: RevisionDependencyChange[];
  createdAt: string;
  accessEpoch: number;
}
export const REVISION_DEPENDENCY_LIMITS = { changes: 64, page: 100, graphNodes: 10_000, graphEdges: 50_000 } as const;
export const isRevisionId = (id: unknown): id is string => typeof id === 'string' && /^[DPL][1-9]\d{0,14}$/.test(id);
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Normalize retained intent without selecting a newer graph or discarding hidden edges. */
export function revisionDependencyInput(value: unknown): RevisionDependencyInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError('Provide an explicit revision dependency change.');
  const input = value as Partial<RevisionDependencyInput>;
  if (Object.keys(value).some(key => !['direction', 'add', 'remove', 'expectedRelationshipVersion', 'expectedAccessEpoch'].includes(key))
    || !['parents', 'children'].includes(input.direction ?? '') || !Array.isArray(input.add) || !Array.isArray(input.remove)
    || !input.add.every(isRevisionId) || !input.remove.every(isRevisionId)
    || !nonnegative(input.expectedRelationshipVersion) || !nonnegative(input.expectedAccessEpoch)) throw new RangeError('Choose parent or child revisions and exact relationship and access versions.');
  const all = [...input.add, ...input.remove];
  if (!all.length || all.length > REVISION_DEPENDENCY_LIMITS.changes || new Set(all).size !== all.length) throw new RangeError('Choose 1–64 distinct revisions to add or remove.');
  return { direction: input.direction!, add: [...input.add].sort(), remove: [...input.remove].sort(), expectedRelationshipVersion: input.expectedRelationshipVersion, expectedAccessEpoch: input.expectedAccessEpoch };
}

export function revisionDependencyChanges(input: RevisionDependencyInput): RevisionDependencyChange[] {
  return [...input.remove.map(revisionId => ({ direction: input.direction, action: 'removed' as const, revisionId })), ...input.add.map(revisionId => ({ direction: input.direction, action: 'added' as const, revisionId }))];
}

export function validRevisionDependencyReceipt(value: unknown, revisionId: string, input: RevisionDependencyInput): value is RevisionDependencyReceipt {
  if (!value || typeof value !== 'object' || !isRevisionId(revisionId)) return false;
  let expected: RevisionDependencyInput;
  try { expected = revisionDependencyInput(input); } catch { return false; }
  const receipt = value as Partial<RevisionDependencyReceipt>, changes = revisionDependencyChanges(expected);
  return receipt.revisionId === revisionId && receipt.relationshipVersion === expected.expectedRelationshipVersion + 1 && Number.isSafeInteger(receipt.relationshipVersion)
    && typeof receipt.operationId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(receipt.operationId)
    && typeof receipt.createdAt === 'string' && Number.isFinite(Date.parse(receipt.createdAt))
    && nonnegative(receipt.accessEpoch) && receipt.accessEpoch >= expected.expectedAccessEpoch
    && Array.isArray(receipt.changes) && receipt.changes.length === changes.length
    && receipt.changes.every((change, index) => Boolean(change && change.direction === changes[index]!.direction && change.action === changes[index]!.action && change.revisionId === changes[index]!.revisionId));
}
