import type { GitCommitResult } from './repositories';

export type AuditRequestStatus = 'requested' | 'concerned' | 'accepted' | 'resigned';
export type AuditStatus = 'none' | 'needs-audit' | 'concern-raised' | 'partially-audited' | 'audited';
export type AuditCommand = 'comment' | 'concern' | 'accept' | 'resign';
export interface Auditor {
  principalId: string;
  displayName: string;
  status: AuditRequestStatus;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
}
/** One collective request. A current owner captured in ownerIds can satisfy it;
 * ownerIds are never expanded into unanimous individual audit requests. */
export interface AuditOwnerPackage {
  packageId: string;
  packageVersion: number;
  packageName: string;
  ownerIds: string[];
  status: 'requested' | 'concerned' | 'accepted';
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  decisionBy: string | null;
}
/** The identity is the saved post-receive Git commit subject, never a branch. */
export interface AuditRecord {
  id: string;
  version: number;
  source: GitCommitResult;
  auditors: Auditor[];
  ownerPackages?: AuditOwnerPackage[];
  status: AuditStatus;
  createdAt: string;
  updatedAt: string;
}
export interface AuditChange {
  principalId: string;
  displayName: string;
  before: AuditRequestStatus | null;
  after: AuditRequestStatus;
}
export interface AuditEvent {
  id: string;
  sequence: number;
  auditId: string;
  auditVersion: number;
  action: 'observed' | 'request' | AuditCommand;
  origin: 'manual' | 'herald' | 'receive' | 'owners';
  actorId: string;
  actorName: string;
  comment: string;
  changes: AuditChange[];
  status: AuditStatus;
  createdAt: string;
}
export interface AuditHistory { events: AuditEvent[]; nextBefore: number | null }
export interface AuditDetail { audit: AuditRecord; history: AuditHistory; canEdit: boolean; canInteract: boolean }
export interface AuditList { audits: AuditRecord[]; nextBefore: number | null }
export interface AuditHistoryQuery { before?: number; limit?: number }
export interface AuditListQuery extends AuditHistoryQuery { repositoryId?: string; status?: AuditStatus; auditorId?: string }
export interface AuditRequestInput { expectedVersion: number; auditorIds: string[]; comment?: string }
export interface AuditCommandInput { expectedVersion: number; command: AuditCommand; comment?: string }

export const AUDIT_STATUS_LABELS: Record<AuditStatus, string> = {
  none: 'No audits', 'needs-audit': 'Audit required', 'concern-raised': 'Concern raised',
  'partially-audited': 'Partially audited', audited: 'Audited',
};
export const AUDIT_REQUEST_STATUS_LABELS: Record<AuditRequestStatus, string> = {
  requested: 'Audit requested', concerned: 'Concern raised', accepted: 'Accepted', resigned: 'Resigned',
};

/** Matches the original individual-auditor aggregate: concerns take precedence,
 * partial acceptance remains open, and resigned auditors have no active vote. */
export function auditStatus(auditors: readonly Pick<Auditor, 'status'>[], ownerPackages: readonly Pick<AuditOwnerPackage, 'status'>[] = []): AuditStatus {
  const requests = [...auditors, ...ownerPackages];
  if (requests.some(auditor => auditor.status === 'concerned')) return 'concern-raised';
  const pending = requests.some(auditor => auditor.status === 'requested');
  if (requests.some(auditor => auditor.status === 'accepted')) return pending ? 'partially-audited' : 'audited';
  return pending ? 'needs-audit' : 'none';
}
