import type { RepositorySyncInput } from '../shared/repository-sync';

export interface RepositorySyncIntent { repositoryId: string; requestId: string; input: RepositorySyncInput }

/** Only exact, source-free synchronization requests may be recovered. */
export function repositorySyncIntent(value: unknown, repositoryId: string): RepositorySyncIntent | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<RepositorySyncIntent>, input = item.input;
  if (item.repositoryId !== repositoryId || !/^R[1-9]\d*$/.test(repositoryId) || typeof item.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(item.requestId) || !input || typeof input !== 'object' || typeof input.expectedConfiguration !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedConfiguration) || !Number.isSafeInteger(input.expectedAccessEpoch) || input.expectedAccessEpoch < 0) return null;
  return { repositoryId, requestId: item.requestId, input: { expectedConfiguration: input.expectedConfiguration, expectedAccessEpoch: input.expectedAccessEpoch } };
}
