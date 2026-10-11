import type { RevisionMuteHistory, RevisionSubscriptionHistory, RevisionSubscriptionSnapshot, RevisionSubscriptionStatus } from '../shared/revision-subscriptions.ts';
import type { ObjectAccess } from '../shared/policy.ts';
export const access = (id = 'P1', edit = true, interact = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
export const person = (principalId = 'U1'): RevisionSubscriptionStatus => ({ revisionId: 'P1', principalId, displayName: principalId, version: 0, state: null, automatic: [], following: false, updatedAt: null });
export const snapshot: RevisionSubscriptionSnapshot = { revisionId: 'P1', subscriptionVersion: 0, authorVersion: 0, reviewerVersion: 0, roleDigest: 'a'.repeat(64), subscribers: [], viewer: person(), mute: { revisionId: 'P1', principalId: 'U1', version: 0, muted: false, updatedAt: null }, nextAfter: null, access: access(), accessEpoch: 1 };
export const history: RevisionSubscriptionHistory = { revisionId: 'P1', subscriptionVersion: 0, transactions: [], nextBefore: null, accessEpoch: 1 };
export const muteHistory: RevisionMuteHistory = { revisionId: 'P1', principalId: 'U1', muteVersion: 0, transactions: [], nextBefore: null, accessEpoch: 1 };
export const reading = { snapshot, history, muteHistory };
