import type { Activity, ActorAttribution } from './types';
import type { NewProjectAccessInput, ObjectAccess } from './policy';

export const PROJECT_ICONS = ['project', 'tag', 'policy', 'group', 'folder', 'timeline', 'goal', 'release', 'bugs', 'cleanup', 'umbrella', 'communication', 'organization', 'infrastructure', 'account', 'experimental'] as const;
export type ProjectIcon = typeof PROJECT_ICONS[number] | 'milestone';
export const PROJECT_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet', 'pink', 'grey', 'checkered'] as const;
export type ProjectColorKey = typeof PROJECT_COLORS[number];
export const PROJECT_COLOR_HEX: Readonly<Record<ProjectColorKey, string>> = {
  red: '#c0392b', orange: '#d9822b', yellow: '#b7950b', green: '#2e8b57', blue: '#2980b9',
  indigo: '#5665a8', violet: '#8e5ba6', pink: '#ba5b8a', grey: '#7b8794', checkered: '#59636f',
};
export type ProjectStatus = 'active' | 'archived';
export type ProjectKind = 'project' | 'milestone';
export type ProjectMembershipMode = 'direct' | 'descendants' | 'inherited';
export interface Project {
  id: string; name: string; description: string; color: string;
  displayName: string; kind: ProjectKind; parentId: string | null; milestoneNumber: number | null;
  depth: number; hierarchyVersion: number; membershipMode: ProjectMembershipMode;
  version: number; status: ProjectStatus; icon: ProjectIcon; colorKey: ProjectColorKey | null;
  primarySlug: string | null; primarySlugSource: 'name' | 'generated' | null; aliases: string[];
  authorId: string | null; createdAt: string | null; updatedAt: string | null; membershipLocked: boolean;
}
export type ProjectSnapshot = Pick<Project, 'id' | 'name' | 'description' | 'color'> & Partial<Omit<Project, 'id' | 'name' | 'description' | 'color'>>;
export type ProjectField = 'name' | 'description' | 'status' | 'icon' | 'color' | 'colorKey' | 'primarySlug' | 'aliases';
export interface ProjectFieldChange { field: ProjectField; oldValue: string | string[] | null; newValue: string | string[] | null }
export type ProjectRelation = 'member' | 'watcher' | 'silenced';
export interface ProjectRelationStatus { projectId: string; principalId: string; relation: ProjectRelation; active: boolean; version: number; updatedAt: string | null }
/** Derived membership has no writable row or compare-and-swap version. Sources are filtered for the viewer. */
export interface ProjectMembershipStatus extends Omit<ProjectRelationStatus, 'relation' | 'version'> { relation: 'member'; version: number | null; source: ProjectMembershipMode; sourceProjectIds: string[] }
export interface ProjectPreferences { projectId: string; membership: ProjectMembershipStatus; watching: ProjectRelationStatus; watchingInheritedFrom: string[]; effectiveWatching: boolean; silence: ProjectRelationStatus; accessEpoch?: number }
export interface ProjectTransaction {
  id: string; projectId: string; sequence: number; projectVersion: number;
  kind: 'create' | 'legacy' | 'edit' | 'member' | 'watcher' | 'hierarchy'; actor: string | null; createdAt: string | null; attribution?: ActorAttribution;
  snapshot?: ProjectSnapshot; changes?: ProjectFieldChange[];
  hierarchy?: { action: 'created_child' | 'converted_membership'; childId: string; hierarchyVersion: number; membersVersion: number; operationId: string };
  relation?: { principalId: string; relation: 'member' | 'watcher'; oldActive: boolean; active: boolean; version: number; membersVersion?: number; operationId: string; reason: 'explicit' | 'joined' | 'left' | 'initial' | 'transferred' };
}
export interface ProjectHistory { transactions: ProjectTransaction[]; nextBefore: number | null; firstAvailableSequence: number | null; accessEpoch?: number }
export interface ProjectMembersPage { members: ProjectMembershipStatus[]; collectionVersion: number; nextAfter: string | null; viewer: ProjectPreferences; accessEpoch?: number }
export interface ProjectWatchersPage { watchers: ProjectRelationStatus[]; nextAfter: string | null; viewer: ProjectPreferences; accessEpoch?: number }
export type ProjectReference = Pick<Project, 'id' | 'name' | 'displayName' | 'kind' | 'parentId' | 'milestoneNumber' | 'status' | 'icon' | 'color' | 'colorKey' | 'version' | 'hierarchyVersion' | 'depth'>;
export interface ProjectHierarchy { ancestors: ProjectReference[]; subprojects: ProjectReference[]; milestones: ProjectReference[]; descendantProjectIds: string[] }
export interface ProjectChildPreview { parent: ProjectReference; kind: ProjectKind; expectedParentVersion: number; expectedHierarchyVersion: number; expectedParentMembersVersion: number; conversionRequired: boolean; transferMemberCount: number; accessEpoch?: number }
export interface ProjectDetail { project: Project; hierarchy: ProjectHierarchy; history: ProjectHistory; viewer: ProjectPreferences; membersVersion: number; activity: Activity[]; access?: ObjectAccess; accessEpoch?: number }
export interface ProjectAccessLostAcknowledgement { id: string; saved: true; accessLost: true; accessEpoch: number }
export interface ProjectLegacyAcknowledgement { id: string; saved: true; refreshRequired: true; accessEpoch: number }
export type ProjectUpdateResult = ProjectDetail | ProjectAccessLostAcknowledgement | ProjectLegacyAcknowledgement;
export interface ProjectInput { access?: NewProjectAccessInput; name: string; description?: string; color?: string; colorKey?: ProjectColorKey; icon?: ProjectIcon; aliases?: string[]; memberIds?: string[]; parentId?: string | null; kind?: ProjectKind; expectedParentVersion?: number; expectedHierarchyVersion?: number; expectedParentMembersVersion?: number; confirmMembershipConversion?: boolean }
export type UpdateProjectInput = Partial<Pick<ProjectInput, 'name' | 'description' | 'color' | 'colorKey' | 'icon' | 'aliases'>> & { expectedVersion: number; status?: ProjectStatus };
export interface ProjectMembersInput { action: 'add' | 'remove' | 'set'; principalIds: string[]; expectedCollectionVersion: number }
export interface ProjectMembershipInput { action: 'join' | 'leave'; expectedVersion: number }
export interface ProjectWatcherInput { principalId: string; action: 'watch' | 'unwatch'; expectedVersion: number }
export interface ProjectSilenceInput { silenced: boolean; expectedVersion: number }

/** Historical snapshots retain the names recorded at the time. */
export function projectDisplayName(project: Pick<Project, 'name'> & Partial<Pick<Project, 'displayName'>>): string { return project.displayName ?? project.name; }

/** Upstream project hashtag normalization: preserve Unicode and hyphens, use underscores for separators. */
export function normalizeProjectSlug(value: string): string {
  let slug = value.replaceAll('/', ' ').toLowerCase().replace(/[\u0000-\u0019#%&+=? \\<>{}\[\]'"`~!@$^*,:;(|)]+/gu, '_').replace(/_+/g, '_');
  if (slug !== '_') slug = slug.replace(/^_+|_+$/g, '');
  return slug === '.' ? 'dot' : slug === '..' ? 'dotdot' : slug;
}
export function isValidProjectSlug(value: string): boolean {
  const slug = normalizeProjectSlug(value);
  // Lone UTF-16 surrogates cannot round-trip through SQLite text or URLs.
  return slug !== '' && slug !== '_' && !/[\uD800-\uDFFF]/u.test(slug) && [...slug].length <= 128;
}
export function projectColor(project: Pick<Project, 'color'> & Partial<Pick<Project, 'status' | 'colorKey'>>): string {
  return project.status === 'archived' ? PROJECT_COLOR_HEX.grey : project.colorKey ? PROJECT_COLOR_HEX[project.colorKey] : project.color;
}
