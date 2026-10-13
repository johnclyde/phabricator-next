import type { GitCommitResult } from '../shared/repositories.ts';
import type { RevisionPatchPayload } from '../shared/revision-patch.ts';
import type { RevisionLifecycleSnapshot } from '../shared/revision-lifecycle.ts';
import { sameHead } from '../shared/revision-lifecycle.ts';
import type { GitReviewBuildPlan, GitReviewEvidence, GitReviewRevision } from '../shared/git-review-gates.ts';
import { verifyRevisionPatch } from './revision-patch.ts';

export interface GitReviewCandidate { patch: RevisionPatchPayload; lifecycle: Omit<RevisionLifecycleSnapshot, 'access' | 'accessEpoch'> }

/** Only the terminal trailer block can select among verified sources. Quoted
 * body paragraphs are ordinary prose, including trailers in a revision summary. */
function revisionHint(message: string): { present: boolean; revisionId: string | null } {
  const lines = message.split(/\r?\n/);
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  let start = lines.length;
  while (start > 0 && lines[start - 1]!.trim()) start--;
  const trailers: { key: string; value: string }[] = [];
  for (const line of lines.slice(start)) {
    const entry = /^([A-Za-z][A-Za-z0-9 -]*):[ \t]*(.*)$/.exec(line);
    if (entry) trailers.push({ key: entry[1]!.trim().toLowerCase(), value: entry[2]! });
    else if (/^[ \t]+\S/.test(line) && trailers.length) trailers.at(-1)!.value += `\n${line.trim()}`;
    else return { present: false, revisionId: null };
  }
  const values = trailers.filter(entry => entry.key === 'differential revision').map(entry => entry.value.trim());
  if (!values.length) return { present: false, revisionId: null };
  const ids = values.map(value => {
    if (/^[DPL][1-9]\d{0,14}$/.test(value)) return value;
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && /^\/[DPL][1-9]\d{0,14}\/?$/.test(url.pathname) ? url.pathname.replaceAll('/', '') : null; }
    catch { return null; }
  });
  return { present: true, revisionId: ids.every(id => id !== null && id === ids[0]) ? ids[0]! : null };
}

/** Call within the receive writer transaction with current server-owned
 * candidates. Rebuild the patch's tree/hash before associating any commit. */
export function deriveGitReviewEvidence(source: GitCommitResult, candidates: readonly GitReviewCandidate[], builds: (revision: GitReviewRevision | null) => GitReviewBuildPlan[]): GitReviewEvidence {
  const hint = revisionHint(source.commit.message);
  const matches: GitReviewCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.patch.repositoryId !== source.repositoryId || candidate.patch.objectFormat !== source.objectFormat || candidate.patch.targetTreeId !== source.commit.treeId) continue;
    const patch = verifyRevisionPatch(candidate.patch), snapshot = candidate.lifecycle;
    if (snapshot.lifecycle.revisionId !== patch.revisionId || snapshot.head.versionId !== patch.versionId || snapshot.head.contentHash !== patch.contentHash || snapshot.head.number !== patch.versionNumber) continue;
    matches.push({ patch, lifecycle: snapshot });
  }
  const selected = hint.present ? matches.filter(candidate => candidate.patch.revisionId === hint.revisionId) : matches;
  const association: GitReviewEvidence['association'] = hint.present && (!hint.revisionId || selected.length === 0) ? 'mismatch' : selected.length > 1 ? 'ambiguous' : selected.length === 1 ? 'verified' : 'none';
  let revision: GitReviewRevision | null = null;
  if (association === 'verified') {
    const { patch, lifecycle: snapshot } = selected[0]!, basis = snapshot.reviewers.acceptance;
    const accepted = (snapshot.lifecycle.status === 'accepted' || snapshot.lifecycle.status === 'closed' && snapshot.lifecycle.closedFromAccepted === true)
      && Boolean(basis?.head && sameHead(basis.head, snapshot.head)) && snapshot.evidence.errorCount === 0
      && snapshot.reviewers.rejecting === 0 && snapshot.reviewers.olderRejecting === 0 && snapshot.reviewers.blocking === 0;
    revision = { revisionId: patch.revisionId, versionId: patch.versionId, versionNumber: patch.versionNumber, contentHash: patch.contentHash, targetTreeId: patch.targetTreeId, accepted, lifecycleVersion: snapshot.lifecycle.version, reviewerVersion: snapshot.reviewers.version, evidenceSha256: snapshot.evidence.sha256 };
  }
  return { association, revision, builds: builds(revision) };
}
