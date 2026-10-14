import type { OwnersAuditing, OwnersPackage } from './owners';

/** Upstream's combined mode is an OR: either missing review or missing owner
 * involvement triggers an audit. Unknown authors are never assumed involved. */
export function ownersAuditNeeded(mode: OwnersAuditing, reviewed: boolean, ownerInvolved: boolean): boolean {
  return mode === 'all' || mode === 'unreviewed' && !reviewed || mode === 'audit' && !ownerInvolved || mode === 'uninvolved-unreviewed' && (!reviewed || !ownerInvolved);
}

/** Routing records are immutable observations, not current ownership claims. */
export interface OwnersRoutingSource {
  kind: 'revision' | 'commit'; objectId: string; repositoryId: string;
  versionId: string; contentHash: string; eventId: string;
  basis: 'submitted-files' | 'previous-version' | 'git-baseline' | 'receive';
  baseVersionId: string | null; paths: string[];
}
export interface OwnersRoutingResult {
  package: OwnersPackage; paths: string[]; ownerIds: string[]; eligibleIds: string[]; appliedIds: string[];
  mode: string; status: 'applied' | 'unchanged' | 'skipped' | 'unavailable';
  reason: 'disabled' | 'owner-author' | 'no-audit-needed' | 'already-present' | 'routed' | 'no-eligible-owners' | 'authority-unavailable' | 'membership-unavailable';
}
export interface OwnersRoutingRecord {
  id: string; source: OwnersRoutingSource; actorId: string; createdAt: string;
  packages: OwnersRoutingResult[];
}
export interface OwnersRoutingHistory { records: OwnersRoutingRecord[]; nextBefore: number | null; accessEpoch: number }
