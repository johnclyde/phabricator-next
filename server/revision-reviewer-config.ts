import type { RevisionReviewerConfig } from '../shared/revision-reviewers.ts';

/** Invalid operator spelling must never silently enable self acceptance. */
export function revisionReviewersFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): RevisionReviewerConfig {
  const value = environment.REVISION_ALLOW_SELF_ACCEPT;
  if (value !== undefined && value !== 'true' && value !== 'false') throw new Error('REVISION_ALLOW_SELF_ACCEPT must be exactly true or false.');
  return { allowSelfAccept: value === 'true' };
}
