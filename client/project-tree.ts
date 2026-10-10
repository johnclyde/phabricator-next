import type { Project } from '../shared/types';
import { visibleProjectScope } from '../shared/project-hierarchy';

/** Use only verified hierarchy fields; older snapshots cannot imply a root relationship. */
export function visibleProjectTreeIds(projects: readonly Project[], id: string): Set<string> {
  return new Set(visibleProjectScope(id, projects));
}
