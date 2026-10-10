import type { WikiHistory } from '../shared/types';

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
