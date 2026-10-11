export type Capability = 'view' | 'edit' | 'interact';
export type ProjectCapability = Capability | 'join';
export type Audience = { kind: 'workspace' } | { kind: 'principals'; principalIds: string[] };
export type ProjectAudience = Audience | { kind: 'project-members' };
export interface PolicyRules { view: Audience; edit: Audience; interact: Audience }
export interface ProjectPolicyRules { view: ProjectAudience; edit: ProjectAudience; interact: ProjectAudience; join: ProjectAudience }
export interface OrdinaryObjectPolicy { kind?: 'object'; objectId: string; spaceId: string; version: number; rules: PolicyRules }
export interface ProjectPolicy { kind: 'project'; objectId: string; spaceId: string; version: number; rules: ProjectPolicyRules }
export type ObjectPolicy = OrdinaryObjectPolicy | ProjectPolicy;
export interface Space { id: string; name: string; description: string; version: number; isDefault: boolean; archived: boolean; view: Audience; edit: Audience }
export interface EffectiveAccess { view: boolean; edit: boolean; interact: boolean; managePolicy: boolean; join?: boolean }
export interface ObjectAccess { policy: ObjectPolicy; capabilities: EffectiveAccess; viewLabel: string; editLabel: string; interactLabel: string; joinLabel?: string; inheritedFrom?: { projectId: string; policyVersion: number }; automatic?: { kind: 'task-owner' | 'file-author'; principalId: string } | { kind: 'project-member'; parentEditProjectId?: string } }
export interface NewObjectAccessInput { spaceId: string; view?: Audience; edit?: Audience; interact?: Audience }
export interface NewProjectAccessInput { spaceId: string; view?: ProjectAudience; edit?: ProjectAudience; interact?: ProjectAudience; join?: ProjectAudience }
export interface CreateSpaceInput { name: string; description?: string; view?: Audience; edit?: Audience }
export interface UpdateSpaceInput { expectedVersion: number; name?: string; description?: string; view?: Audience; edit?: Audience; archived?: boolean }
export interface SetPolicyInput { expectedVersion: number; spaceId: string; view: Audience; edit: Audience; interact: Audience }
export interface SetProjectPolicyInput { expectedVersion: number; spaceId: string; view: ProjectAudience; edit: ProjectAudience; interact: ProjectAudience; join: ProjectAudience }

/** Membership is established by the caller; an empty identity is never a member. */
export function audienceAllows(audience: ProjectAudience, principalId: string, projectMember = false): boolean {
  return Boolean(principalId) && (audience.kind === 'workspace' || (audience.kind === 'project-members' ? projectMember : audience.principalIds.includes(principalId)));
}

export function effectiveAccess(policy: ObjectPolicy, space: Space, principalId: string, automatic = false, projectMember = false, parent?: Pick<EffectiveAccess, 'view' | 'edit'>): EffectiveAccess {
  const project = policy.kind === 'project';
  const owner = !project && automatic;
  const member = project && projectMember;
  const view = (!project || !parent || parent.view) && policy.spaceId === space.id && audienceAllows(space.view, principalId) && (owner || member || audienceAllows(policy.rules.view, principalId, member));
  const edit = view && (owner || (project && parent?.edit === true) || audienceAllows(policy.rules.edit, principalId, member));
  return { view, edit, interact: view && (owner || audienceAllows(policy.rules.interact, principalId, member)), managePolicy: edit, ...(project ? { join: view && (edit || audienceAllows(policy.rules.join, principalId, member)) } : {}) };
}

export function spaceAccess(space: Space, principalId: string): EffectiveAccess {
  const view = audienceAllows(space.view, principalId);
  const edit = view && audienceAllows(space.edit, principalId);
  return { view, edit, interact: view, managePolicy: edit };
}

/** Describes an explicit rule, never infers privacy from a Space's name. */
export function audienceLabel(audience: ProjectAudience): string {
  if (audience.kind === 'workspace') return 'Workspace members';
  if (audience.kind === 'project-members') return 'Project members';
  const count = audience.principalIds.length;
  return count === 0 ? 'No one' : count === 1 ? '1 selected member' : `${count} selected members`;
}
