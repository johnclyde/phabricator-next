import { createHash } from 'node:crypto';
import type { HeraldAction, HeraldRule, HeraldSnapshot } from '../shared/herald.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionAuthor } from '../shared/revision-authorship.ts';
import type { RevisionReviewerInput } from '../shared/revision-reviewers.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import type { Store } from './store.ts';
import type { HarbormasterStore } from './harbormaster.ts';
import { HttpError } from './validation.ts';

export interface HeraldAppliedAction { changed: boolean; message: string; references?: string[] }
function person(auth: Auth, principalId: string): RevisionAuthor {
  if (auth.mode === 'local' && principalId === `local:${auth.workspaceId}`) return { principalId, displayName: 'You' };
  const account = auth.listAccounts().find(account => account.id === principalId && !account.disabled);
  if (!account) throw new HttpError(404, 'An active automation participant is unavailable.');
  return { principalId, displayName: account.displayName };
}
export function heraldActor(auth: Auth, rule: HeraldRule, snapshot: HeraldSnapshot): ActorAttribution {
  const owner = person(auth, rule.authorId);
  return { ...owner, credentialId: null, requestId: `herald:${createHash('sha256').update(`${snapshot.eventId}:${rule.id}:${rule.version}`).digest('hex')}` };
}
/** Automation operates with current owner authority; it never bypasses Spaces
 * or grants source visibility as a side effect of a rule match. */
export function canApplyHeraldAction(_store: Store, auth: Auth, policies: PolicyStore, _harbormaster: HarbormasterStore, rule: HeraldRule, action: HeraldAction, snapshot: HeraldSnapshot): boolean {
  try { person(auth, rule.authorId); } catch { return false; }
  const capabilities = policies.access(snapshot.objectId, rule.authorId);
  if (action.type === 'nothing') return capabilities.view;
  // Assignment grants owner access, and reviewer membership is editor-managed.
  // Selecting oneself must not turn a personal rule into an Edit-policy bypass.
  const self = ['add-self-subscriber', 'remove-self-subscriber'].includes(action.type);
  return capabilities.view && (self ? capabilities.interact : capabilities.edit);
}
export function applyHeraldAction(store: Store, auth: Auth, policies: PolicyStore, harbormaster: HarbormasterStore, rule: HeraldRule, action: HeraldAction, snapshot: HeraldSnapshot): HeraldAppliedAction {
  return store.notifications.batch(() => applyAction(store, auth, policies, harbormaster, rule, action, snapshot));
}
function applyAction(store: Store, auth: Auth, policies: PolicyStore, harbormaster: HarbormasterStore, rule: HeraldRule, action: HeraldAction, snapshot: HeraldSnapshot): HeraldAppliedAction {
  if (!canApplyHeraldAction(store, auth, policies, harbormaster, rule, action, snapshot)) throw new HttpError(403, 'Current rule-owner permissions do not allow this action.');
  const actor = heraldActor(auth, rule, snapshot), id = snapshot.objectId;
  if (action.type === 'nothing') return { changed: false, message: 'Rule requested no action.' };
  if (['add-self-subscriber', 'remove-self-subscriber', 'add-subscribers', 'remove-subscribers'].includes(action.type)) {
    const targets = 'targets' in action ? action.targets : [actor.principalId], subscribe = action.type.startsWith('add-'); let changed = false, automatic = 0;
    // Resolve the whole participant set before applying the first edit.
    const people = targets.map(target => person(auth, target));
    if (subscribe) for (const target of people) policies.require(id, target.principalId, 'view');
    for (const target of people) {
      if (snapshot.contentType === 'task') {
        const current = store.subscriptionStatus(id, target.principalId);
        if (current.automatic) { automatic++; continue; }
        if (current.state === (subscribe ? 'subscribed' : 'unsubscribed')) continue;
        const result = store.updateTaskSubscription(id, { principalId: target.principalId, action: subscribe ? 'subscribe' : 'unsubscribe', expectedMembershipVersion: current.version }, actor); changed ||= result.version !== current.version;
      } else if (snapshot.contentType === 'revision') {
        const current = store.revisionSubscriptions.person(id, target.principalId);
        if (current.status.automatic.length) { automatic++; continue; }
        if (current.status.state === (subscribe ? 'subscribed' : 'unsubscribed')) continue;
        const result = store.revisionSubscriptions.mutate(id, { action: subscribe ? 'subscribe' : 'unsubscribe', principalId: target.principalId, expectedSubscriptionVersion: current.status.version, expectedAuthorVersion: current.authorVersion, expectedReviewerVersion: current.reviewerVersion, expectedAccessEpoch: policies.epoch() }, actor, target); changed ||= result.changed;
      } else {
        const current = store.objectSubscriptions.person(id, target.principalId);
        if (current.status.automatic.length) { automatic++; continue; }
        if (current.status.state === (subscribe ? 'subscribed' : 'unsubscribed')) continue;
        const result = store.objectSubscriptions.mutate(id, { action: subscribe ? 'subscribe' : 'unsubscribe', principalId: target.principalId, expectedSubscriptionVersion: current.status.version, expectedAccessEpoch: policies.epoch() }, actor, target); changed ||= result.changed;
      }
    }
    return { changed, message: `${changed ? 'Updated' : 'Kept'} subscriber preferences.${automatic ? ' Automatic following through authorship, ownership, or reviewing was preserved.' : ''}`, references: targets };
  }
  if (action.type === 'add-self-reviewer' || action.type === 'add-reviewers') {
    if (snapshot.contentType !== 'revision') throw new HttpError(400, 'Reviewer actions require a revision.');
    const people = ('targets' in action ? action.targets : [actor.principalId]).map(target => person(auth, target)); let changed = false;
    for (const target of people) policies.require(id, target.principalId, 'view');
    const apply = (target: RevisionAuthor, action: 'add' | 'remove' | 'block') => {
      const current = store.revisionReviewers.snapshot(id, actor.principalId);
      if (current.head.versionId !== snapshot.versionId || current.head.contentHash !== snapshot.contentHash) throw new HttpError(409, 'Source changed during Herald evaluation.');
      const request: RevisionReviewerInput = { action, reviewerId: target.principalId, message: `Herald ${rule.id}: ${rule.name}`, expectedReviewerVersion: current.reviewers.version, expectedLifecycleVersion: current.lifecycle.version, expectedAuthorVersion: current.authorship.version, expectedVersion: current.head.number, expectedVersionId: current.head.versionId, expectedContentHash: current.head.contentHash, expectedAccessEpoch: policies.epoch(), expectedConfigId: current.configId, expectedEvidenceSha256: current.evidence.sha256 };
      store.revisionReviewers.mutate(id, request, actor, target); changed = true;
    };
    for (const target of people) {
      let member = store.revisionReviewers.state(id).members.find(member => member.principalId === target.principalId);
      if (member?.status === 'resigned') { apply(target, 'remove'); member = undefined; }
      if (!member) apply(target, 'add');
      if (action.type === 'add-reviewers' && action.required && store.revisionReviewers.state(id).members.find(member => member.principalId === target.principalId)?.status !== 'blocking') apply(target, 'block');
    }
    return { changed, message: changed ? 'Updated revision reviewers.' : 'The selected reviewers are already present.', references: people.map(person => person.principalId) };
  }
  if (action.type === 'add-projects' || action.type === 'remove-projects') {
    for (const projectId of action.targets) { if (!/^PROJ[1-9]\d{0,14}$/.test(projectId)) throw new HttpError(400, 'Choose project identities for tags.'); policies.require(projectId, actor.principalId, 'view'); }
    if (snapshot.contentType === 'revision') {
      const state = store.revisionProjects.state(id), result = store.revisionProjects.mutate(id, { action: action.type === 'add-projects' ? 'add' : 'remove', projectIds: action.targets, expectedProjectVersion: state.version, expectedAccessEpoch: policies.epoch() }, actor);
      return { changed: result.changed, message: result.changed ? 'Updated revision project tags.' : 'Project tags already match.', references: action.targets };
    }
    if (snapshot.contentType !== 'task') throw new HttpError(400, 'Project tags require a revision or task.');
    const current = store.taskDetail(id).task, result = store.updateTaskProjects(id, { action: action.type === 'add-projects' ? 'add' : 'remove', projectIds: action.targets, expectedVersion: current.version }, actor);
    return { changed: current.version !== result.task.version, message: current.version !== result.task.version ? 'Updated task project tags.' : 'Project tags already match.', references: action.targets };
  }
  if (action.type === 'task-status' || action.type === 'task-priority' || action.type === 'assign' || action.type === 'assign-self') {
    if (snapshot.contentType !== 'task') throw new HttpError(400, 'This action requires a task.');
    const current = store.taskDetail(id).task, field = action.type === 'task-status' ? 'status' : action.type === 'task-priority' ? 'priority' : 'ownerId', value = 'value' in action ? action.value : actor.principalId;
    if (field === 'ownerId' && value !== null) { person(auth, value); policies.require(id, value, 'view'); }
    const result = store.updateTask(id, { expectedVersion: current.version, [field]: value }, actor);
    return { changed: result.version !== current.version, message: result.version !== current.version ? 'Updated task fields.' : 'Task fields already match.' };
  }
  if (action.type === 'comment') {
    let commentId: string;
    if (snapshot.contentType === 'revision') { if (!snapshot.versionId) throw new HttpError(409, 'Revision source is unavailable.'); commentId = store.createComment(id, { body: action.value, versionId: snapshot.versionId }, actor).id; }
    else if (snapshot.contentType === 'task') commentId = store.createTaskComment(id, { body: action.value }, actor).id;
    else if (snapshot.contentType === 'paste') commentId = store.pastes.comment(id, { contentVersion: snapshot.version, body: action.value }, actor).id;
    else throw new HttpError(400, 'Wiki comments are not supported.');
    return { changed: true, message: `Added a comment through ${rule.id}.`, references: [commentId] };
  }
  if (action.type === 'run-build-plans') {
    if (snapshot.contentType !== 'revision' || !snapshot.versionId || !snapshot.contentHash) throw new HttpError(400, 'Build plans require an immutable revision source.');
    const buildActor = { principalId: actor.principalId, displayName: actor.displayName, workspaceId: auth.workspaceId }, plans = action.targets.map(id => harbormaster.plan(id, buildActor));
    const references = plans.map(plan => harbormaster.run(id, { planId: plan.id, planVersion: plan.version, versionId: snapshot.versionId, contentHash: snapshot.contentHash }, buildActor).build.id);
    return { changed: references.length > 0, message: 'Queued build plans against the exact event source.', references };
  }
  throw new HttpError(400, 'Herald action is unavailable.');
}
