export const REVISION_STATUSES = ['draft', 'needs_review', 'changes_requested', 'changes_planned', 'accepted', 'closed', 'abandoned'] as const;
export type RevisionStatus = typeof REVISION_STATUSES[number];
export const isRevisionStatus = (value: unknown): value is RevisionStatus => typeof value === 'string' && (REVISION_STATUSES as readonly string[]).includes(value);
export const revisionStatusLabel = (status: RevisionStatus): string => ({ draft: 'Draft', needs_review: 'Needs Review', changes_requested: 'Changes Requested', changes_planned: 'Changes Planned', accepted: 'Accepted', closed: 'Closed', abandoned: 'Abandoned' })[status];
export const revisionIsClosed = (status: RevisionStatus, closeOnAccept = false): boolean => status === 'closed' || status === 'abandoned' || closeOnAccept && status === 'accepted';
