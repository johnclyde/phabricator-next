import { isRevisionStatus } from '../shared/revision-status';
import { isRevisionId, revisionDependencyInput, type RevisionDependencyDirection, type RevisionDependencyHistory, type RevisionDependencyInput, type RevisionDependencyPage } from '../shared/revision-dependencies';

export const DEPENDENCY_DISPLAY_LIMIT = 500;
export interface DependencySnapshot {
  revisionId: string;
  relationshipVersion: number;
  accessEpoch: number;
  parents: RevisionDependencyPage;
  children: RevisionDependencyPage;
  history: RevisionDependencyHistory;
}
/** Deliberately ID-only: labels are resolved under current viewing authority. */
export interface DependencyDraft extends RevisionDependencyInput {}
export interface DependencyIntent { id: string; revisionId: string; body: RevisionDependencyInput; draft: DependencyDraft }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function dependencyPage(value: unknown, id: string, direction: RevisionDependencyDirection): value is RevisionDependencyPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as RevisionDependencyPage;
  return page.revisionId === id && page.direction === direction && integer(page.relationshipVersion) && integer(page.accessEpoch)
    && (page.nextAfter === null || isRevisionId(page.nextAfter))
    && Array.isArray(page.revisions) && page.revisions.length <= DEPENDENCY_DISPLAY_LIMIT && new Set(page.revisions.map(item => item?.id)).size === page.revisions.length
    && (page.nextAfter === null || page.nextAfter === page.revisions.at(-1)?.id)
    && page.revisions.every((item, index) => item && isRevisionId(item.id) && item.id !== id && (!index || item.id > page.revisions[index - 1]!.id) && typeof item.title === 'string' && item.title.length <= 1000
      && ['code', 'paper', 'document'].includes(item.kind) && isRevisionStatus(item.status)
      && integer(item.currentVersion) && item.currentVersion > 0 && date(item.updatedAt));
}
export function dependencyHistory(value: unknown, id: string): value is RevisionDependencyHistory {
  if (!value || typeof value !== 'object') return false;
  const page = value as RevisionDependencyHistory;
  return page.revisionId === id && integer(page.relationshipVersion) && integer(page.accessEpoch) && (page.nextBefore === null || (integer(page.nextBefore) && page.nextBefore > 0))
    && Array.isArray(page.transactions) && page.transactions.length <= DEPENDENCY_DISPLAY_LIMIT && new Set(page.transactions.map(item => item?.id)).size === page.transactions.length
    && (page.nextBefore === null || page.nextBefore === page.transactions.at(-1)?.sequence)
    && page.transactions.every((item, index) => item && item.revisionId === id && uuid(item.id) && uuid(item.operationId) && integer(item.sequence) && item.sequence > 0 && (!index || item.sequence < page.transactions[index - 1]!.sequence)
      && integer(item.relationshipVersion) && item.relationshipVersion > 0 && item.relationshipVersion <= page.relationshipVersion && typeof item.actor === 'string' && date(item.createdAt)
      && item.change && ['parents', 'children'].includes(item.change.direction) && ['added', 'removed'].includes(item.change.action) && isRevisionId(item.change.revisionId) && item.change.revisionId !== id);
}
export function dependencySnapshot(value: unknown, id: string): DependencySnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as DependencySnapshot;
  return snapshot.revisionId === id && integer(snapshot.relationshipVersion) && integer(snapshot.accessEpoch)
    && dependencyPage(snapshot.parents, id, 'parents') && dependencyPage(snapshot.children, id, 'children') && dependencyHistory(snapshot.history, id)
    && [snapshot.parents, snapshot.children, snapshot.history].every(page => page.relationshipVersion === snapshot.relationshipVersion && page.accessEpoch === snapshot.accessEpoch) ? snapshot : null;
}
export function mergeDependencyPage(previous: RevisionDependencyPage, next: RevisionDependencyPage): RevisionDependencyPage {
  if (!dependencyPage(previous, previous.revisionId, previous.direction) || !dependencyPage(next, previous.revisionId, previous.direction) || !previous.nextAfter || next.relationshipVersion !== previous.relationshipVersion || next.accessEpoch !== previous.accessEpoch || next.revisions.some(item => item.id <= previous.nextAfter!)) throw new Error('Related revisions changed. Reload Related Revisions before continuing.');
  const revisions = [...previous.revisions, ...next.revisions];
  if (revisions.length > DEPENDENCY_DISPLAY_LIMIT) throw new Error('The loaded relationship limit was reached. Reload to begin again.');
  return { ...next, revisions };
}
export function mergeDependencyHistory(previous: RevisionDependencyHistory, next: RevisionDependencyHistory): RevisionDependencyHistory {
  if (!dependencyHistory(previous, previous.revisionId) || !dependencyHistory(next, previous.revisionId) || previous.nextBefore === null || next.relationshipVersion !== previous.relationshipVersion || next.accessEpoch !== previous.accessEpoch || next.transactions.some(item => item.sequence >= previous.nextBefore! || previous.transactions.some(old => old.id === item.id))) throw new Error('Relationship history changed. Reload Related Revisions before continuing.');
  const transactions = [...previous.transactions, ...next.transactions];
  if (transactions.length > DEPENDENCY_DISPLAY_LIMIT) throw new Error('The loaded history limit was reached. Reload to begin again.');
  return { ...next, transactions };
}
export function emptyDependencyDraft(snapshot: DependencySnapshot, direction: RevisionDependencyDirection): DependencyDraft {
  return { direction, add: [], remove: [], expectedRelationshipVersion: snapshot.relationshipVersion, expectedAccessEpoch: snapshot.accessEpoch };
}
export function dependencyDraft(value: unknown): DependencyDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as DependencyDraft;
  if (Array.isArray(draft.add) && Array.isArray(draft.remove) && !draft.add.length && !draft.remove.length) {
    if (Object.keys(draft).length === 5 && ['parents', 'children'].includes(draft.direction) && integer(draft.expectedAccessEpoch) && integer(draft.expectedRelationshipVersion)) return { ...draft, add: [], remove: [] };
    return null;
  }
  try { return revisionDependencyInput(value); } catch { return null; }
}
export function dependencyIntent(value: unknown, revisionId: string): DependencyIntent | null {
  if (!value || typeof value !== 'object') return null;
  const intent = value as DependencyIntent;
  if (intent.revisionId !== revisionId || !uuid(intent.id) || Object.keys(intent).some(key => !['id', 'revisionId', 'body', 'draft'].includes(key))) return null;
  try {
    const body = revisionDependencyInput(intent.body), draft = dependencyDraft(intent.draft);
    if (!draft || JSON.stringify(body) !== JSON.stringify(revisionDependencyInput(draft))) return null;
    return { ...intent, body, draft: intent.draft };
  } catch { return null; }
}
