import type { WikiHistory } from '../shared/types';
import type { WikiLifecycleHistory } from '../shared/wiki';

/** Merge immutable summaries while keeping gaps below the current head pageable. */
export function mergeWikiHistory(head: number, fresh: WikiHistory, retained?: WikiHistory): WikiHistory {
  const firstAvailableVersion = fresh.firstAvailableVersion;
  const rows = new Map([...(retained?.versions || []), ...fresh.versions]
    .filter(version => version.number >= firstAvailableVersion && version.number <= head)
    .map(version => [version.number, version]));
  let missing = head;
  while (missing >= firstAvailableVersion && rows.has(missing)) missing--;
  return {
    firstAvailableVersion,
    versions: [...rows.values()].sort((a, b) => b.number - a.number),
    nextBefore: missing < firstAvailableVersion ? null : missing + 1,
  };
}
export function mergeWikiLifecycle(head: number, fresh: WikiLifecycleHistory, retained?: WikiLifecycleHistory): WikiLifecycleHistory {
  const first = fresh.firstAvailableSequence;
  if (first === null) return fresh;
  const rows = new Map([...(retained?.transactions || []), ...fresh.transactions].filter(item => item.sequence >= first && item.sequence <= head).map(item => [item.sequence, item]));
  let missing = head;
  while (missing >= first && rows.has(missing)) missing--;
  return { ...fresh, transactions: [...rows.values()].sort((a, b) => b.sequence - a.sequence), nextBefore: missing < first ? null : missing + 1 };
}
