export type PaperBuildConcurrency = 1 | 2;

export function validatePaperBuildConcurrency(value: unknown = 2): PaperBuildConcurrency {
  if (value !== 1 && value !== 2) throw new Error('Paper compiler concurrency must be 1 or 2.');
  return value;
}

/** Keep the existing maximum while allowing small servers to serialize builds. */
export function paperBuildConcurrencyFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): PaperBuildConcurrency {
  const value = environment.PHABRICATOR_TEX_CONCURRENCY;
  if (value === undefined) return 2;
  if (value !== '1' && value !== '2') throw new Error('PHABRICATOR_TEX_CONCURRENCY must be exactly 1 or 2.');
  return value === '1' ? 1 : 2;
}
