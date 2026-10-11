import type { RevisionMetadataConfig } from '../shared/revision-metadata.ts';

export function revisionMetadataFromEnvironment(env: Record<string, string | undefined> = process.env): RevisionMetadataConfig {
  const value = env.REVISION_REQUIRE_TEST_PLAN;
  if (value !== undefined && value !== 'true' && value !== 'false') throw new Error('REVISION_REQUIRE_TEST_PLAN must be exactly true or false.');
  return { requireTestPlan: value !== 'false' };
}
