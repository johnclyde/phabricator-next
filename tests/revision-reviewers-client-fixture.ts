import { DEFAULT_REVISION_LIFECYCLE_CONFIG } from '../shared/revision-lifecycle.ts';
import { revisionReviewerActions, type RevisionReviewerSnapshot, type RevisionReviewerHistory } from '../shared/revision-reviewers.ts';
export const base: Omit<RevisionReviewerSnapshot, 'actions'> = {
  reviewers: { revisionId: 'P1', version: 0, members: [], acceptance: null, updatedAt: null },
  lifecycle: { revisionId: 'P1', version: 0, status: 'needs_review', reviewStarted: true, closedFromAccepted: null, resumeAcceptanceHead: null, updatedAt: null },
  head: { versionId: 'source-1', number: 1, contentHash: 'a'.repeat(64) }, authorship: { version: 0, author: { principalId: 'U1', displayName: 'Current Author' } },
  evidence: { sha256: 'b'.repeat(64), reviewIds: [], errorCount: 0 }, config: { ...DEFAULT_REVISION_LIFECYCLE_CONFIG, allowSelfAccept: false }, configId: 'c'.repeat(64), accessEpoch: 5,
  access: { policy: { objectId: 'P1', spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: false, interact: true, managePolicy: false }, viewLabel: 'Workspace', editLabel: 'Author', interactLabel: 'Workspace' },
};
export const snapshot: RevisionReviewerSnapshot = { ...base, actions: revisionReviewerActions(base, 'U2') };
export const history: RevisionReviewerHistory = { revisionId: 'P1', reviewerVersion: 0, transactions: [], nextBefore: null, accessEpoch: 5 };
