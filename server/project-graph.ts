import type { DatabaseSync } from 'node:sqlite';
import type { ProjectKind, ProjectMembershipMode } from '../shared/projects.ts';
import { HttpError } from './validation.ts';

export interface ProjectHierarchyRow { projectId: string; parentId: string | null; kind: ProjectKind; milestoneNumber: number | null; hierarchyVersion: number; depth: number }
const invalid = () => new HttpError(409, 'The project hierarchy is incomplete or invalid.');
export function hierarchy(database: DatabaseSync, id: string): ProjectHierarchyRow | null {
  const row = database.prepare('SELECT project_id AS projectId, parent_id AS parentId, kind, milestone_number AS milestoneNumber, hierarchy_version AS hierarchyVersion, depth FROM project_hierarchy WHERE project_id = ?').get(id) as ProjectHierarchyRow | undefined;
  return row ?? null;
}
/** Immediate parent first, root last. Invalid or incomplete graphs fail closed. */
export function ancestorIds(database: DatabaseSync, id: string): string[] {
  let node = hierarchy(database, id); if (!node) throw invalid();
  const result: string[] = []; const seen = new Set([id]);
  while (node.parentId !== null) {
    if (result.length >= 15 || seen.has(node.parentId)) throw invalid();
    const parent = hierarchy(database, node.parentId);
    if (!parent || parent.kind !== 'project' || parent.depth !== node.depth - 1) throw invalid();
    result.push(parent.projectId); seen.add(parent.projectId); node = parent;
  }
  if (node.depth !== 0 || node.kind !== 'project') throw invalid();
  return result;
}
export function children(database: DatabaseSync, id: string, kind?: ProjectKind): ProjectHierarchyRow[] {
  ancestorIds(database, id);
  const rows = database.prepare('SELECT project_id FROM project_hierarchy WHERE parent_id = ? AND (? IS NULL OR kind = ?) ORDER BY milestone_number, project_id').all(id, kind ?? null, kind ?? null) as { project_id: string }[];
  return rows.map(row => { ancestorIds(database, row.project_id); return hierarchy(database, row.project_id)!; });
}
export function descendantIds(database: DatabaseSync, id: string): string[] {
  const result: string[] = [];
  const visit = (current: string) => { for (const child of children(database, current)) { result.push(child.projectId); visit(child.projectId); } };
  visit(id); return result;
}
export function membershipMode(database: DatabaseSync, id: string): ProjectMembershipMode {
  ancestorIds(database, id); const node = hierarchy(database, id)!;
  return node.kind === 'milestone' ? 'inherited' : children(database, id, 'project').length ? 'descendants' : 'direct';
}
/** Ordinary leaf sources of effective membership; milestones delegate to their parent. */
export function membershipSources(database: DatabaseSync, id: string): string[] {
  ancestorIds(database, id); const node = hierarchy(database, id)!;
  if (node.kind === 'milestone') return membershipSources(database, node.parentId!);
  const direct = children(database, id, 'project');
  return direct.length ? direct.flatMap(child => membershipSources(database, child.projectId)).sort() : [id];
}
export function effectiveMembers(database: DatabaseSync, id: string): string[] {
  const result = new Set<string>();
  const query = database.prepare("SELECT principal_id FROM project_relations WHERE project_id = ? AND relation = 'member' AND active = 1");
  for (const source of membershipSources(database, id)) for (const row of query.all(source) as { principal_id: string }[]) result.add(row.principal_id);
  return [...result].sort();
}
export function effectiveMember(database: DatabaseSync, id: string, principalId: string): boolean {
  const query = database.prepare("SELECT 1 FROM project_relations WHERE project_id = ? AND principal_id = ? AND relation = 'member' AND active = 1");
  return membershipSources(database, id).some(source => !!query.get(source, principalId));
}
export function initializeProjectHierarchy(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE project_hierarchy (project_id TEXT PRIMARY KEY REFERENCES entities(id), parent_id TEXT REFERENCES entities(id), kind TEXT NOT NULL CHECK(kind IN ('project','milestone')), milestone_number INTEGER, hierarchy_version INTEGER NOT NULL CHECK(hierarchy_version > 0), depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 15), CHECK((kind = 'project' AND milestone_number IS NULL) OR (kind = 'milestone' AND parent_id IS NOT NULL AND milestone_number > 0)), UNIQUE(parent_id, milestone_number));
    CREATE INDEX project_hierarchy_parent ON project_hierarchy(parent_id, kind, project_id);
    INSERT INTO project_hierarchy(project_id,parent_id,kind,milestone_number,hierarchy_version,depth) SELECT project_id,NULL,'project',NULL,1,0 FROM project_profiles;
    CREATE TRIGGER project_hierarchy_identity_immutable BEFORE UPDATE OF project_id,parent_id,kind,milestone_number,depth ON project_hierarchy BEGIN SELECT RAISE(ABORT, 'Project ancestry is immutable'); END;
    CREATE TRIGGER project_hierarchy_no_delete BEFORE DELETE ON project_hierarchy BEGIN SELECT RAISE(ABORT, 'Project ancestry is immutable'); END;
  `);
}
