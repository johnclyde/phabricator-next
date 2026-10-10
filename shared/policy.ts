export type Capability = 'view' | 'edit' | 'interact';
export type Audience = { kind: 'workspace' } | { kind: 'principals'; principalIds: string[] };
export interface PolicyRules { view: Audience; edit: Audience; interact: Audience }
export interface ObjectPolicy { objectId: string; spaceId: string; version: number; rules: PolicyRules }
export interface Space { id: string; name: string; description: string; version: number; isDefault: boolean; archived: boolean; view: Audience; edit: Audience }
export interface EffectiveAccess { view: boolean; edit: boolean; interact: boolean; managePolicy: boolean }
export interface ObjectAccess { policy: ObjectPolicy; capabilities: EffectiveAccess; viewLabel: string; editLabel: string; interactLabel: string }
export interface NewObjectAccessInput { spaceId: string; view?: Audience; edit?: Audience; interact?: Audience }
export interface CreateSpaceInput { name: string; description?: string; view?: Audience; edit?: Audience }
export interface UpdateSpaceInput { expectedVersion: number; name?: string; description?: string; view?: Audience; edit?: Audience; archived?: boolean }
export interface SetPolicyInput { expectedVersion: number; spaceId: string; view: Audience; edit: Audience; interact: Audience }

/** Membership is established by the caller; an empty identity is never a member. */
export function audienceAllows(audience: Audience, principalId: string): boolean {
  return Boolean(principalId) && (audience.kind === 'workspace' || audience.principalIds.includes(principalId));
}

export function effectiveAccess(policy: ObjectPolicy, space: Space, principalId: string): EffectiveAccess {
  const view = policy.spaceId === space.id && audienceAllows(space.view, principalId) && audienceAllows(policy.rules.view, principalId);
  const edit = view && audienceAllows(policy.rules.edit, principalId);
  return { view, edit, interact: view && audienceAllows(policy.rules.interact, principalId), managePolicy: edit };
}

export function spaceAccess(space: Space, principalId: string): EffectiveAccess {
  const view = audienceAllows(space.view, principalId);
  const edit = view && audienceAllows(space.edit, principalId);
  return { view, edit, interact: view, managePolicy: edit };
}

/** Describes an explicit rule, never infers privacy from a Space's name. */
export function audienceLabel(audience: Audience): string {
  if (audience.kind === 'workspace') return 'Workspace members';
  const count = audience.principalIds.length;
  return count === 0 ? 'No one' : count === 1 ? '1 selected member' : `${count} selected members`;
}
