import type { BuildStatus } from './harbormaster';

/** Server-derived evidence captured with an immutable Git receive decision. */
export interface GitReviewRevision {
  revisionId: string; versionId: string; versionNumber: number; contentHash: string; targetTreeId: string;
  accepted: boolean; lifecycleVersion: number; reviewerVersion: number; evidenceSha256: string;
}
export interface GitReviewBuildPlan {
  planId: string; planVersion: number; enabled: boolean;
  status: BuildStatus | 'missing' | 'stale' | 'disabled';
  builds: { id: string; version: number; planVersion: number; status: BuildStatus; sourceKind: 'revision' | 'commit' }[];
}
export interface GitReviewEvidence {
  association: 'none' | 'verified' | 'ambiguous' | 'mismatch';
  revision: GitReviewRevision | null;
  builds: GitReviewBuildPlan[];
}

/** Historical snapshots without this evidence cannot answer a gate safely. */
export function requireGitReviewEvidence(evidence: GitReviewEvidence | undefined): GitReviewEvidence {
  if (!evidence) throw new Error('Exact reviewed revision and build evidence is unavailable.');
  return evidence;
}

/** Missing plans, disabled plans and old plan versions never satisfy a gate.
 * Messages intentionally omit linked revision identities and build details. */
export function requiredBuildFailures(evidence: GitReviewEvidence | undefined, planIds: readonly string[]): string[] {
  if (!evidence) return ['Required build evidence is unavailable.'];
  return [...new Set(planIds)].flatMap(id => {
    const plan = evidence.builds.find(plan => plan.planId === id);
    const status = !plan ? 'missing' : !plan.enabled ? 'disabled' : plan.status;
    return status === 'passed' ? [] : [`A required build plan is ${status}. All required plans must pass on this exact source and current plan version.`];
  });
}
