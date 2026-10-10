import type { ProjectKind } from './projects';

/** The complete graph is required when normalizing writes; read filters use only visible nodes. */
export interface ProjectTagNode { id: string; parentId: string | null; kind: ProjectKind }
export const MAX_PROJECT_DEPTH = 15;

function graphIndex(projects: readonly ProjectTagNode[]): Map<string, ProjectTagNode> {
  const graph = new Map(projects.map(project => [project.id, project]));
  if (graph.size !== projects.length) throw new Error('Project hierarchy contains duplicate identities.');
  return graph;
}

function ancestors(id: string, graph: ReadonlyMap<string, ProjectTagNode>): string[] {
  const seen = new Set<string>(); const result: string[] = [];
  let current = graph.get(id);
  if (!current) throw new Error('Project hierarchy is incomplete.');
  while (current.parentId !== null) {
    if (seen.has(current.id) || result.length >= MAX_PROJECT_DEPTH) throw new Error('Project hierarchy is invalid.');
    seen.add(current.id);
    const parent = graph.get(current.parentId);
    if (!parent || parent.kind === 'milestone') throw new Error('Project hierarchy is incomplete or invalid.');
    result.push(parent.id); current = parent;
  }
  if (current.kind === 'milestone') throw new Error('A milestone must have a parent.');
  return result;
}

/** Upstream transaction order matters: each later tag replaces conflicting earlier tags. */
export function normalizeProjectTags(ids: readonly string[], projects: readonly ProjectTagNode[]): string[] {
  const graph = graphIndex(projects);
  const paths = new Map<string, readonly string[]>();
  for (const id of ids) if (!paths.has(id)) paths.set(id, ancestors(id, graph));
  let result: string[] = [];
  for (const id of ids) {
    const next = graph.get(id)!;
    result = result.filter(previousId => {
      const previous = graph.get(previousId)!;
      return previousId !== id && !paths.get(id)!.includes(previousId) && !paths.get(previousId)!.includes(id)
        && !(next.kind === 'milestone' && previous.kind === 'milestone' && next.parentId === previous.parentId);
    });
    result.push(id);
  }
  return result;
}

/** Includes the selected project and visible descendants whose entire ancestry is present. */
export function visibleProjectScope(id: string, projects: readonly ProjectTagNode[]): string[] {
  const graph = graphIndex(projects);
  if (!graph.has(id)) return [];
  const result: string[] = [];
  for (const project of projects) {
    try {
      const path = ancestors(project.id, graph);
      if (project.id === id || path.includes(id)) result.push(project.id);
    } catch { /* A partial or obsolete snapshot must not infer relationships through hidden nodes. */ }
  }
  return result;
}
