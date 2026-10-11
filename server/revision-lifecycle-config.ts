import type { RevisionLifecycleConfig } from '../shared/revision-lifecycle.ts';

/** Strict operator configuration; misspellings must not silently enable actions. */
export function revisionLifecycleFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): RevisionLifecycleConfig {
  const boolean = (name: string): boolean => {
    const value = environment[name];
    if (value === undefined) return false;
    if (value !== 'true' && value !== 'false') throw new Error(`${name} must be exactly true or false.`);
    return value === 'true';
  };
  return {
    allowReopen: boolean('REVISION_ALLOW_REOPEN'),
    alwaysAllowClose: boolean('REVISION_ALWAYS_ALLOW_CLOSE'),
    alwaysAllowAbandon: boolean('REVISION_ALWAYS_ALLOW_ABANDON'),
    closeOnAccept: boolean('REVISION_CLOSE_ON_ACCEPT'),
  };
}
