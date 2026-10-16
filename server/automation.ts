import { readManiphestConfig } from './maniphest.ts';
import { resolveRevisionPatch, revisionPatchIdentity } from './revision-patch.ts';
import type { RevisionPatchPayload } from '../shared/revision-patch.ts';
import { DrydockStore } from './drydock.ts';
import { GitAutomationStore, parseGitReceiveFacts } from './git-automation.ts';
import { AuditStore } from './audit.ts';
import { createOwnersStore } from './owners.ts';
import { OwnersRouting } from './owners-routing.ts';
import type { AuditDetail, AuditStatus } from '../shared/audit.ts';
import { deriveGitReviewEvidence, type GitReviewCandidate } from './git-review-gates.ts';
import { revisionPatchBaseline } from '../shared/revision-patch.ts';
import { heraldPolicyObjectId } from '../shared/git-automation.ts';
import type { GitReceiveFacts, GitReceiveReceipt } from '../shared/git-automation.ts';
import { visibleHeraldRule, presentHeraldTranscript, presentGitReceiveReceipt } from './automation-projection.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DrydockBinding, DrydockBlueprint, DrydockLeaseDetail, DrydockAuthorization, DrydockClaim } from '../shared/drydock.ts';
import type { AuthContext } from '../shared/auth.ts';
import type { Activity, RevisionVersion, WikiVersion } from '../shared/types.ts';
import type { BuildClaim, Buildable } from '../shared/harbormaster.ts';
import type { HeraldRule, HeraldSnapshot, HeraldTranscript } from '../shared/herald.ts';
import type { GitCommitResult } from '../shared/repositories.ts';
import type { Auth } from './auth.ts';
import type { Store, MutationResponse } from './store.ts';
import type { PolicyStore } from './policy.ts';
import { HeraldStore, type HeraldAuthority } from './herald.ts';
import { HarbormasterStore, type BuildAuthority, type BuildActor } from './harbormaster.ts';
import { applyHeraldAction, canApplyHeraldAction } from './herald-effects.ts';
import { HttpError, object, string, integer } from './validation.ts';

export interface AutomationConfiguration { managers?: string[]; workers?: string[]; httpOrigins?: string[]; httpWorker?: string; gitReceivers?: Record<string, string[]>; drydockBindings?: DrydockBinding[]; drydockWorkers?: Record<string, string[]> }
export function automationFromEnvironment(env: Record<string, string | undefined> = process.env): AutomationConfiguration {
  const list = (name: string) => (env[name] ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const httpOrigins = list('APP_HARBORMASTER_HTTP_ORIGINS');
  for (const value of httpOrigins) { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value) throw new Error('Harbormaster HTTP origins must be exact HTTP(S) origins without paths or credentials.'); }
  const mapping = (name: string): Record<string, string[]> => {
    let value: unknown; try { value = JSON.parse(env[name] ?? '{}'); } catch { throw new Error(`${name} must be a JSON mapping to account lists.`); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, entries]) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(key) || !Array.isArray(entries) || !entries.length || entries.some(entry => typeof entry !== 'string' || !entry || entry.length > 200))) throw new Error(`${name} must be a JSON mapping to account lists.`);
    return value as Record<string, string[]>;
  };
  const gitReceivers = mapping('APP_GIT_RECEIVERS');
  if (Object.keys(gitReceivers).some(id => !/^R[1-9]\d*$/.test(id))) throw new Error('Git receivers must be bound to repository IDs.');
  const drydockWorkers = mapping('APP_DRYDOCK_WORKERS');
  let bindings: unknown; try { bindings = JSON.parse(env.APP_DRYDOCK_BINDINGS ?? '[]'); } catch { throw new Error('APP_DRYDOCK_BINDINGS must be a JSON list.'); }
  if (!Array.isArray(bindings) || bindings.some(value => !value || typeof value !== 'object' || Object.keys(value).some(key => !['key', 'worker', 'repositoryIds'].includes(key)) || typeof value.key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value.key) || typeof value.worker !== 'string' || !Object.hasOwn(drydockWorkers, value.worker) || !Array.isArray(value.repositoryIds) || !value.repositoryIds.length || value.repositoryIds.some((id: unknown) => typeof id !== 'string' || !/^R[1-9]\d*$/.test(id))) || new Set(bindings.map(value => value.key)).size !== bindings.length) throw new Error('Drydock bindings require distinct keys, configured workers and repository IDs.');
  return { gitReceivers, drydockBindings: bindings as DrydockBinding[], drydockWorkers, managers: list('APP_AUTOMATION_MANAGERS'), workers: list('APP_HARBORMASTER_WORKERS'), httpOrigins, httpWorker: env.APP_HARBORMASTER_HTTP_WORKER };
}
/** Connects the portable rule engine and build runner to current workspace authority. */
export class Automation {
  readonly herald: HeraldStore;
  readonly git: GitAutomationStore;
  readonly audit: AuditStore;
  readonly ownersRouting: OwnersRouting;
  readonly drydock: DrydockStore;
  readonly harbormaster: HarbormasterStore;
  readonly authority: HeraldAuthority;
  private timer?: ReturnType<typeof setInterval>;
  private pumping?: Promise<void>;
  private stopping = false;
  constructor(private readonly store: Store, private readonly auth: Auth, private readonly policies: PolicyStore, private readonly config: AutomationConfiguration = {}) {
    this.authority = { canManageGlobal: id => this.manager(id), canEditObject: (id, target) => this.enabled(id) && this.policies.access(target, id).edit, isEnabledPrincipal: id => this.enabled(id) };
    this.authority.validateTaskAction = action => {
      if (action.type !== 'task-status' && action.type !== 'task-priority') return;
      const config = readManiphestConfig(store.database);
      const choices = action.type === 'task-status' ? config.statuses : config.priorities;
      if (!choices.some(item => item.key === action.value && !item.disabled)) throw new HttpError(400, 'Choose an enabled task status or priority from the task configuration.');
    };
    this.herald = new HeraldStore(store.database);
    this.git = new GitAutomationStore(store.database, this.herald);
    this.audit = new AuditStore(store.database, {
      authorize: (actor, id, write) => this.authorize(actor, id, write),
      interact: (actor, id) => { this.authorize(actor, null, true); this.policies.require(id, actor.principalId, 'interact'); },
      source: id => this.git.commit(id),
      principal: (id, repositoryId) => {
        if (!this.enabled(id) || !this.policies.access(repositoryId, id).view) return null;
        return { id, displayName: this.auth.listAccounts().find(account => account.id === id)?.displayName ?? 'You' };
      },
      canViewOwnerPackage: (id, actor, version) => this.ownersRouting.canViewPackage(id, actor.principalId, version),
      canResolveOwnerPackage: (id, actor) => this.ownersRouting.canResolvePackage(id, actor.principalId),
    });
    this.ownersRouting = new OwnersRouting(store, auth, policies, createOwnersStore(store, auth, policies), this.audit, this.git);
    this.drydock = new DrydockStore(store.database, {
      authorize: (actor, id, write) => this.authorize(actor, id, write),
      revisionPatch: (id, versionId, contentHash, actor) => this.revisionPatch(id, versionId, contentHash, actor),
      mayManage: (actor, blueprint) => this.drydockManager(actor, blueprint),
      allowBinding: blueprint => { const binding = this.config.drydockBindings?.find(item => item.key === blueprint.binding && item.worker === blueprint.worker && item.repositoryIds.includes(blueprint.repositoryId)); if (!binding || !this.config.drydockWorkers?.[binding.worker]?.length) throw new HttpError(403, 'This Drydock binding is not configured by the operator.'); },
      worker: (actor, label) => { const allowed = this.config.drydockWorkers?.[label]; if (!allowed || !this.boundListed(actor.principalId, allowed)) throw new HttpError(403, 'This account is not configured as this Drydock worker.'); },
      subject: (actor, kind, id) => { this.authorize(actor, null, true); if (kind === 'principal') { if (!this.enabled(id) || id !== actor.principalId && !this.manager(actor.principalId)) throw new HttpError(403, 'Request authorization for your own active account.'); } else this.harbormaster.plan(id, actor); },
    });
    this.harbormaster = new HarbormasterStore(store.database, {
      authorize: (actor, id, write) => this.authorize(actor, id, write),
      revisionPatch: (id, versionId, contentHash, actor) => this.revisionPatch(id, versionId, contentHash, actor),
      mayManagePlan: actor => this.manager(actor.principalId),
      source: (id, versionId, contentHash) => {
        const detail = store.detail(id), version = detail.versions.find(version => version.id === versionId && version.contentHash === contentHash);
        if (!version) throw new HttpError(409, 'The selected immutable source version is unavailable.');
        return { version, kind: detail.revision.kind };
      },
      allowHttp: endpoint => { if (!config.httpOrigins?.includes(new URL(endpoint).origin)) throw new HttpError(403, 'This HTTP build origin is not configured by the operator.'); this.httpActor(); },
      httpActor: () => this.httpActor(),
      checkWorkingCopy: (step, actor) => this.drydock.checkStep(step, actor),
      workingCopy: (build, source, target, step, actor) => this.drydock.forBuild(build, source, target, step, actor),
      workingCopies: (id, actor, targetIds) => this.drydock.buildWorkingCopies(id, actor, targetIds),
      releaseWorkingCopies: (id, actor) => this.drydock.releaseBuild(id, actor),
    });
    store.configureAutomation(events => this.capture(events));
  }
  revisionPatch(id:string,versionId:string,contentHash:string,actor:BuildAuthority,write=true):RevisionPatchPayload {
    this.authorize(actor,id,write);const detail=this.store.detail(id),repositoryId=detail.revision.repositoryId;
    if(!repositoryId)throw new HttpError(409,'Import a complete Git text tree before requesting a revision working copy.');
    this.authorize(actor,repositoryId,write);return resolveRevisionPatch(repositoryId,detail.versions,versionId,contentHash);
  }
  private drydockManager(actor: BuildAuthority, blueprint: DrydockBlueprint | null): boolean { return this.enabled(actor.principalId) && (this.manager(actor.principalId) || blueprint?.ownerId === actor.principalId); }
  private canManageLease(detail: DrydockLeaseDetail, context: AuthContext): boolean { return context.scopes.includes('write') && this.policies.access(detail.lease.source.repositoryId, context.principalId).edit && (!detail.lease.source.revisionPatch || this.policies.access(detail.lease.source.revisionPatch.revisionId, context.principalId).edit) && (detail.lease.holderId === context.principalId || this.drydockManager(context, this.drydock.blueprint(detail.lease.blueprintId, context))); }
  private httpActor(): BuildActor {
    const selected = this.config.httpWorker;
    const account = selected ? this.store.database.prepare('SELECT id,display_name FROM auth_accounts WHERE (id=? OR username=?) AND disabled=0').get(selected, selected) as { id: string; display_name: string } | undefined : undefined;
    const principalId = account?.id ?? (selected === 'local' && this.auth.mode === 'local' ? `local:${this.auth.workspaceId}` : null);
    if (!principalId || !this.worker(principalId)) throw new HttpError(403, 'An active HTTP worker account must be configured by the operator.');
    return { principalId, displayName: account?.display_name ?? 'You', workspaceId: this.auth.workspaceId };
  }
  private enabled(id: string): boolean { return this.auth.mode === 'local' && id === `local:${this.auth.workspaceId}` || Boolean(this.store.database.prepare('SELECT 1 FROM auth_accounts WHERE id=? AND disabled=0').get(id)); }
  private listed(id: string, list: string[] = []): boolean {
    if (!this.enabled(id)) return false;
    if (this.auth.mode === 'local' && id === `local:${this.auth.workspaceId}`) return true;
    const account = this.store.database.prepare('SELECT username FROM auth_accounts WHERE id=? AND disabled=0').get(id) as { username: string } | undefined;
    return list.includes(id) || Boolean(account && list.includes(account.username));
  }
  private boundListed(id: string, list: string[]): boolean { return this.auth.mode === 'local' && id === `local:${this.auth.workspaceId}` ? list.includes('local') || list.includes(id) : this.listed(id, list); }
  manager(id: string): boolean { return this.listed(id, this.config.managers); }
  private worker(id: string): boolean { return this.listed(id, this.config.workers); }
  private authorize(actor: BuildAuthority, id: string | null, write: boolean): void {
    if ('kind' in actor) this.auth.revalidate(actor, write ? 'write' : 'read');
    if (actor.workspaceId !== this.auth.workspaceId || !this.enabled(actor.principalId)) throw new HttpError(403, 'This automation principal is no longer active.');
    if (id) this.policies.require(id, actor.principalId, write ? 'edit' : 'view');
  }
  private canEdit(rule: HeraldRule, principalId: string): boolean { return this.enabled(principalId) && (rule.ruleType === 'personal' ? rule.authorId === principalId : rule.ruleType === 'global' ? this.manager(principalId) : Boolean(rule.objectId && this.policies.access(rule.objectId, principalId).edit)); }
  private canViewRule(rule: HeraldRule, principalId: string): boolean { return visibleHeraldRule(rule, principalId, this.herald, this.policies); }
  private rulesForReader(rules: HeraldRule[], context: AuthContext) { return rules.filter(rule => this.canViewRule(rule, context.principalId)).map(rule => ({ ...rule, canEdit: context.scopes.includes('write') && this.canEdit(rule, context.principalId) })); }
  private receiveAuthority(facts: GitReceiveFacts, context: AuthContext): boolean {
    this.auth.revalidate(context, 'write');
    const allowed = this.config.gitReceivers?.[facts.repositoryId];
    if (!allowed || !this.boundListed(context.principalId, allowed) || !this.enabled(facts.pusherId)) throw new HttpError(403, 'This account is not a configured receiver for this repository and pusher.');
    this.policies.require(facts.repositoryId, context.principalId, 'edit'); this.policies.require(facts.repositoryId, facts.pusherId, 'edit'); return true;
  }
  private policyObject(id: string): string { return this.git.policyObjectId(id) ?? id; }
  /** Review associations are reconstructed from current immutable workspace
   * source under the receive transaction, never supplied by the Git caller. */
  private receiveHooks() {
    const candidates = new Map<string, GitReviewCandidate[]>();
    return { ...this.hooks(),
      reviewEvidence: (facts: GitReceiveFacts, commit: GitReceiveFacts['updates'][number]['commits'][number]) => {
        if (!candidates.has(facts.repositoryId)) {
          const values: GitReviewCandidate[] = [];
          const rows = this.store.database.prepare("SELECT id FROM entities WHERE kind='revision' AND json_extract(data,'$.repositoryId')=? ORDER BY id").all(facts.repositoryId) as { id: string }[];
          for (const row of rows) {
            const detail = this.store.detail(row.id), lifecycle = this.store.revisionLifecycle.snapshot(row.id);
            if (revisionPatchBaseline(facts.repositoryId, detail.versions, lifecycle.head.versionId).reason) continue;
            try { values.push({ patch: resolveRevisionPatch(facts.repositoryId, detail.versions, lifecycle.head.versionId, lifecycle.head.contentHash), lifecycle }); }
            catch (error) { if (!(error instanceof HttpError) || error.code !== 'REVISION_PATCH_INVALID') throw error; }
          }
          candidates.set(facts.repositoryId, values);
        }
        const source = { repositoryId: facts.repositoryId, objectFormat: facts.objectFormat, commit: commit.commit };
        return deriveGitReviewEvidence(source, candidates.get(facts.repositoryId)!, revision => this.harbormaster.reviewGateBuilds(source, revision));
      },
      observeCommit: (id: string, facts: GitReceiveFacts) => {
        const actor = { principalId: facts.pusherId, displayName: this.auth.listAccounts().find(account => account.id === facts.pusherId)?.displayName ?? 'You', workspaceId: this.auth.workspaceId };
        this.audit.observe(id, actor); this.ownersRouting.commit(id, actor);
      },
    };
  }
  /** Trusted local landing facts, collected by the configured Git transport. */
  landingReceive(facts:GitReceiveFacts,actor:BuildActor):GitReceiveReceipt {
    return this.git.receive(facts,{...this.receiveHooks(),canReceive:value=>{this.authorize(actor,value.repositoryId,true);if(value.pusherId!==actor.principalId)throw new HttpError(403,'The landing pusher changed.');return true;},projectIds:()=>[]});
  }
  /** Only the server's authenticated Git transport may supply these inspected facts. */
  hostedReceive(facts: GitReceiveFacts, context: AuthContext): GitReceiveReceipt {
    const receipt = this.git.receive(facts, {
      ...this.receiveHooks(),
      canReceive: value => {
        if (context.kind !== 'token') throw new HttpError(401, 'Hosted Git requires an access token.');
        this.auth.revalidate(context, 'read'); this.auth.revalidate(context, 'write');
        if (value.pusherId !== context.principalId) throw new HttpError(403, 'The authenticated Git pusher changed.');
        this.policies.require(value.repositoryId, context.principalId, 'view');
        this.policies.require(value.repositoryId, context.principalId, 'edit');
        return true;
      },
      projectIds: id => {
        const row = this.store.database.prepare("SELECT data FROM entities WHERE id=? AND kind='repository'").get(id) as { data: string } | undefined;
        const repository = row ? JSON.parse(row.data) as { projectId?: string | null } : null;
        return repository?.projectId ? [repository.projectId] : [];
      },
    });
    return presentGitReceiveReceipt(receipt, context.principalId, this.herald, this.policies);
  }
  private hooks() { return {
    canReadGitReview: (_rule: HeraldRule, snapshot: HeraldSnapshot) => !snapshot.git?.review?.revision || this.policies.access(snapshot.git.review.revision.revisionId, _rule.authorId).view,
    canEvaluate: (rule: HeraldRule, snapshot: HeraldSnapshot) => this.enabled(rule.authorId) && this.policies.access(heraldPolicyObjectId(snapshot), rule.authorId).view && (!snapshot.git || rule.actions.every(action => action.type === 'nothing') || this.policies.access(heraldPolicyObjectId(snapshot), rule.authorId).edit) && (rule.ruleType !== 'global' || this.manager(rule.authorId)) && (rule.ruleType !== 'object' || Boolean(rule.objectId && this.policies.access(rule.objectId, rule.authorId).edit)),
    canApply: (rule: HeraldRule, action: Parameters<typeof canApplyHeraldAction>[5], snapshot: HeraldSnapshot) => snapshot.git ? this.enabled(rule.authorId) && this.policies.access(heraldPolicyObjectId(snapshot), rule.authorId)[action.type === 'nothing' ? 'view' : 'edit'] : canApplyHeraldAction(this.store, this.auth, this.policies, this.harbormaster, rule, action, snapshot),
    apply: (rule: HeraldRule, action: Parameters<typeof applyHeraldAction>[5], snapshot: HeraldSnapshot) => {
      if (!snapshot.git) return applyHeraldAction(this.store, this.auth, this.policies, this.harbormaster, rule, action, snapshot);
      if (action.type === 'nothing') return { changed: false, message: 'Rule requested no action.' };
      if (action.type === 'block-push') return { changed: true, message: action.value };
      if ((action.type === 'add-auditors' || action.type === 'audit-self') && snapshot.contentType === 'commit') {
        const actor = { principalId: rule.authorId, displayName: this.auth.listAccounts().find(account => account.id === rule.authorId)?.displayName ?? 'You', workspaceId: this.auth.workspaceId };
        const before = this.audit.detail(snapshot.objectId, actor).audit.version;
        const result = this.audit.requestFromHerald(snapshot.objectId, 'targets' in action ? action.targets : [rule.authorId], actor);
        return { changed: result.audit.version !== before, message: 'Requested post-commit audit.', references: [snapshot.objectId] };
      }
      if (action.type !== 'run-build-plans' || snapshot.contentType !== 'commit') throw new HttpError(400, 'Unsupported Git automation action.');
      const actor = { principalId: rule.authorId, displayName: this.auth.listAccounts().find(account => account.id === rule.authorId)?.displayName ?? 'You', workspaceId: this.auth.workspaceId };
      const source = this.git.commit(snapshot.objectId), plans = action.targets.map(id => this.harbormaster.plan(id, actor));
      const builds = plans.map(plan => this.harbormaster.runCommit(source, { planId: plan.id, planVersion: plan.version }, actor));
      return { changed: builds.length > 0, message: `Started ${builds.length} commit build(s).`, references: builds.map(detail => detail.build.id) };
    },
  }; }
  snapshot(id: string, eventId: string, actorId: string, isNew = false, comment = ''): HeraldSnapshot {
    const base: HeraldSnapshot = { objectId: id, eventId, actorId, isNew, comment, contentType: 'revision', title: '', body: '', status: '', priority: null, authorId: null, ownerId: null, repositoryId: null, projectIds: [], subscriberIds: [], reviewerIds: [], files: [], version: 0, versionId: null, contentHash: null };
    if (/^[DPL][1-9]\d*$/.test(id)) {
      const { revision, versions } = this.store.detail(id), source = versions.find(version => version.number === revision.currentVersion)!;
      return { ...base, title: revision.title, body: revision.summary, status: revision.status, authorId: revision.authorId ?? null, repositoryId: revision.repositoryId, projectIds: revision.projectIds ?? (revision.projectId ? [revision.projectId] : []), subscriberIds: this.store.revisionSubscriptions.deliveryPreferences(id).recipients, reviewerIds: this.store.revisionReviewers.state(id).members.filter(member => member.status !== 'resigned').map(member => member.principalId), files: source.files, version: source.number, versionId: source.id, contentHash: source.contentHash };
    }
    if (/^T[1-9]\d*$/.test(id)) {
      const { task } = this.store.taskDetail(id);
      const explicit = this.store.database.prepare("SELECT principal_id AS id FROM task_subscriptions WHERE task_id=? AND state='subscribed'").all(id) as { id: string }[];
      return { ...base, contentType: 'task', title: task.title, body: task.description, status: task.status, priority: task.priority, authorId: task.authorId, ownerId: task.ownerId, projectIds: task.projectIds, subscriberIds: [...new Set([...explicit.map(item => item.id), ...(task.ownerId ? [task.ownerId] : [])])], version: task.version };
    }
    if (/^W[1-9]\d*$/.test(id)) {
      const { document } = this.store.documentDetail(id);
      const row = this.store.database.prepare('SELECT v.data FROM wiki_publication p JOIN wiki_versions v ON v.id=p.published_version_id WHERE p.document_id=?').get(id) as { data: string };
      const published = JSON.parse(row.data) as WikiVersion;
      return { ...base, contentType: 'wiki', title: published.title, body: published.content, status: document.location?.status ?? 'active', version: published.number, versionId: published.id, contentHash: createHash('sha256').update(published.content).digest('hex'), subscriberIds: this.store.objectSubscriptions.deliveryPreferences(id).recipients };
    }
    if (/^PA[1-9]\d*$/.test(id)) {
      const { paste, version } = this.store.pastes.detail(id);
      return { ...base, contentType: 'paste', title: paste.title, body: version.content, status: paste.status, authorId: paste.authorId, version: version.number, versionId: `${id}:${version.number}`, contentHash: version.sha256, subscriberIds: this.store.objectSubscriptions.deliveryPreferences(id).recipients };
    }
    throw new HttpError(400, 'Select a revision, task, wiki document or paste.');
  }
  private capture(events: Activity[]): void {
    const sources = new Map<string, Activity>();
    for (const event of events) if (/^[DPL][1-9]\d*$/.test(event.objectId) && ['created', 'version_created'].includes(event.action)) sources.set(event.objectId, event);
    const routeOwners = () => { for (const event of sources.values()) this.ownersRouting.revision(event.objectId, event.id, event.attribution?.principalId ?? `local:${this.auth.workspaceId}`); };
    const enabledTypes = new Set((this.store.database.prepare("SELECT DISTINCT content_type FROM herald_rules WHERE json_extract(data,'$.enabled')=1").all() as { content_type: string }[]).map(row => row.content_type));
    if (!enabledTypes.size) { routeOwners(); return; }
    const groups = new Map<string, Activity[]>();
    for (const event of events) if (/^(?:[DPLTW]|PA)[1-9]\d*$/.test(event.objectId) && event.action !== 'draft_saved' && enabledTypes.has(event.objectId.startsWith('PA') ? 'paste' : event.objectId.startsWith('T') ? 'task' : event.objectId.startsWith('W') ? 'wiki' : 'revision')) { const group = groups.get(event.objectId) ?? []; group.push(event); groups.set(event.objectId, group); }
    // Freeze all input before any rule mutates another object. Effects do not recurse.
    const snapshots = [...groups].map(([id, group]) => {
      const event = group.at(-1)!; let comment = '';
      const commentEvents = group.filter(item => item.action === 'commented' || item.action === 'replied');
      if (commentEvents.length) {
        const table = /^T/.test(id) ? 'task_transactions' : /^PA/.test(id) ? 'paste_transactions' : 'comments';
        const key = /^T/.test(id) ? 'task_id' : /^PA/.test(id) ? 'paste_id' : 'revision_id';
        const requests = [...new Set(commentEvents.flatMap(item => item.attribution ? [item.attribution.requestId] : []))];
        if (requests.length) {
          const rows = this.store.database.prepare(`SELECT data FROM ${table} WHERE ${key}=? ${table === 'comments' ? '' : "AND json_extract(data,'$.kind')='comment'"} AND json_extract(data,'$.attribution.requestId') IN (${requests.map(() => '?').join(',')}) ORDER BY rowid`).all(id, ...requests) as { data: string }[];
          comment = rows.map(row => { const data = JSON.parse(row.data) as { comment?: string; body?: string }; return data.comment ?? data.body ?? ''; }).join('\n');
        }
      }
      return this.snapshot(id, event.id, event.attribution?.principalId ?? `local:${this.auth.workspaceId}`, group.some(item => item.action === 'created'), comment);
    });
    for (const snapshot of snapshots) this.herald.evaluate(snapshot, this.hooks());
    routeOwners();
  }
  read(path: string, query: URLSearchParams, context: AuthContext): unknown {
    this.auth.revalidate(context, 'read'); const accessEpoch = this.policies.epoch(), canManage = this.manager(context.principalId) && context.scopes.includes('write');
    const number = (name: string) => query.has(name) ? integer(Number(query.get(name)), name) : undefined;
    const routing = /^\/api\/owners-routing\/([^/]+)$/.exec(path);
    if (routing) {
      if ([...query.keys()].some(key => !['before', 'limit'].includes(key) || query.getAll(key).length !== 1)) throw new HttpError(400, 'Unsupported routing query parameters.');
      return { ...this.ownersRouting.history(routing[1]!, context.principalId, number('before'), number('limit')), accessEpoch };
    }
    const patch=/^\/api\/drydock\/revision-patches\/([DPL][1-9]\d*)$/.exec(path);
    if(patch){if([...query.keys()].some(key=>!['versionId','contentHash'].includes(key)||query.getAll(key).length!==1))throw new HttpError(400,'Unsupported revision patch query parameters.');const payload=this.revisionPatch(patch[1]!,string(query.get('versionId'),'Version ID',100),string(query.get('contentHash'),'Content hash',64),context,false);return {revisionPatch:revisionPatchIdentity(payload),repositoryId:payload.repositoryId,accessEpoch};}
    const allowed = path === '/api/audit/commits' ? ['repositoryId', 'status', 'auditorId', 'before', 'limit'] : /^\/api\/audit\/commits\/[^/]+$/.test(path) ? ['before', 'limit'] : path === '/api/drydock/worker/jobs' ? ['worker'] : path === '/api/herald/receives' ? ['repositoryId', 'before', 'limit'] : path === '/api/herald/rules' ? ['before', 'limit', 'contentType', 'enabled'] : path === '/api/herald/transcripts' ? ['before', 'limit', 'objectId'] : path.endsWith('/history') ? ['before', 'limit'] : path === '/api/harbormaster/builds' ? ['revisionId', 'objectId'] : [];
    if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1)) throw new HttpError(400, 'Unsupported automation query parameters.');
    if (path.startsWith('/api/audit/')) {
      if (path === '/api/audit/commits') return { ...this.audit.list(context, { repositoryId: query.get('repositoryId') ?? undefined, status: (query.get('status') ?? undefined) as AuditStatus | undefined, auditorId: query.get('auditorId') ?? undefined, before: number('before'), limit: number('limit') }), accessEpoch };
      const detail = /^\/api\/audit\/commits\/([^/]+)(\/files)?$/.exec(path);
      if (detail) {
        const result = this.audit.detail(detail[1]!, context, { before: number('before'), limit: number('limit') });
        return detail[2] ? { files: this.git.commitFiles(detail[1]!), accessEpoch } : { ...result, canEdit: context.scopes.includes('write') && result.canEdit, canInteract: context.scopes.includes('write') && result.canInteract, accessEpoch };
      }
      throw new HttpError(404, 'Audit endpoint not found.');
    }
    if (path.startsWith('/api/drydock/')) {
      if (path === '/api/drydock/blueprints') return { blueprints: this.drydock.blueprints(context).map(blueprint => ({ ...blueprint, canEdit: context.scopes.includes('write') && this.drydockManager(context, blueprint) && this.policies.access(blueprint.repositoryId, context.principalId).edit })), bindings: (this.config.drydockBindings ?? []).map(binding => ({ ...binding, repositoryIds: binding.repositoryIds.filter(id => this.policies.access(id, context.principalId).view) })).filter(binding => binding.repositoryIds.length), accessEpoch, canManage };
      const blueprint = /^\/api\/drydock\/blueprints\/([^/]+)$/.exec(path);
      if (blueprint) { const detail = this.drydock.blueprintDetail(blueprint[1]!, context); return { ...detail, accessEpoch, canManage: context.scopes.includes('write') && this.drydockManager(context, detail.blueprint) && this.policies.access(detail.blueprint.repositoryId, context.principalId).edit }; }
      if (path === '/api/drydock/authorizations') return { authorizations: this.drydock.authorizations(context), accessEpoch, canManage };
      const authorization = /^\/api\/drydock\/authorizations\/([^/]+)$/.exec(path);
      if (authorization) { const item = this.drydock.authorization(authorization[1]!, context), blueprint = this.drydock.blueprint(item.blueprintId, context); return { authorization: item, accessEpoch, canManage: context.scopes.includes('write') && this.drydockManager(context, blueprint) && this.policies.access(blueprint.repositoryId, context.principalId).edit }; }
      if (path === '/api/drydock/leases') return { leases: this.drydock.leases(context), accessEpoch };
      if (path === '/api/drydock/resources') return { resources: this.drydock.resources(context), accessEpoch };
      const detail = /^\/api\/drydock\/(leases|resources)\/([^/]+)$/.exec(path);
      if (detail) { const result = detail[1] === 'leases' ? this.drydock.detail(detail[2]!, context) : this.drydock.resourceDetail(detail[2]!, context); return { ...result, accessEpoch, canManage: this.canManageLease(result, context) }; }
      if (path === '/api/drydock/worker/jobs') { if (!context.scopes.includes('write')) throw new HttpError(403, 'Worker polling requires write scope.'); return { jobs: this.drydock.jobs(string(query.get('worker'), 'Worker label', 100), context), accessEpoch }; }
      throw new HttpError(404, 'Drydock endpoint not found.');
    }
    if (path === '/api/herald/rules') {
      const enabled = query.get('enabled'); if (enabled !== null && enabled !== 'true' && enabled !== 'false') throw new HttpError(400, 'Invalid enabled filter.');
      const page = this.herald.list({ before: number('before'), limit: number('limit'), ...(enabled === null ? {} : { enabled: enabled === 'true' }), ...(query.has('contentType') ? { contentType: query.get('contentType') as HeraldSnapshot['contentType'] } : {}) });
      return { ...page, rules: this.rulesForReader(page.rules, context), accessEpoch, canManage };
    }
    const rule = /^\/api\/herald\/rules\/(H\d+)(\/history)?$/.exec(path);
    if (rule) { const item = this.herald.get(rule[1]!); if (!this.canViewRule(item, context.principalId)) throw new HttpError(404, 'Rule not found.'); const history = rule[2] ? this.herald.history(item.id, number('before'), number('limit')) : null; return history ? { ...history, versions: history.versions.filter(version => this.canViewRule(version.rule, context.principalId)), accessEpoch } : { rule: { ...item, canEdit: this.canEdit(item, context.principalId) && context.scopes.includes('write') }, accessEpoch, canManage }; }
    const visible = (id: string) => this.policies.access(this.policyObject(id), context.principalId).view;
    if (path === '/api/herald/receives') { const page = this.git.receipts({ repositoryId: query.get('repositoryId') ?? undefined, before: number('before'), limit: number('limit') }, visible); return { receives: page.receipts.map(receipt => presentGitReceiveReceipt(receipt, context.principalId, this.herald, this.policies)), nextBefore: page.nextBefore, accessEpoch }; }
    const receive = /^\/api\/herald\/receives\/([^/]+)$/.exec(path);
    if (receive) return { receive: presentGitReceiveReceipt(this.git.receipt(receive[1]!, visible), context.principalId, this.herald, this.policies), accessEpoch };
    if (path === '/api/herald/transcripts') { const page = this.herald.transcripts({ before: number('before'), limit: number('limit'), objectId: query.get('objectId') ?? undefined }, visible); return { ...page, transcripts: page.transcripts.map(value => presentHeraldTranscript(value, context.principalId, this.herald, this.policies)), accessEpoch }; }
    const transcript = /^\/api\/herald\/transcripts\/([^/]+)$/.exec(path);
    if (transcript) return { transcript: presentHeraldTranscript(this.herald.transcript(transcript[1]!, visible), context.principalId, this.herald, this.policies), accessEpoch };
    if (path === '/api/harbormaster/plans') return { plans: this.harbormaster.plans(context).map(plan => ({ ...plan, canEdit: context.scopes.includes('write') && (canManage || plan.ownerId === context.principalId) })), accessEpoch, canManage };
    const plan = /^\/api\/harbormaster\/plans\/([^/]+)$/.exec(path);
    if (plan) return { plan: this.harbormaster.plan(plan[1]!, context), accessEpoch, canManage };
    if (path === '/api/harbormaster/builds') {
      const builds = this.harbormaster.list(context, query.get('objectId') ?? query.get('revisionId') ?? undefined);
      const buildables = Object.fromEntries(builds.map(build => { const source = this.harbormaster.detail(build.id, context).buildable; return [source.id, source]; }));
      return { builds, buildables, accessEpoch };
    }
    const build = /^\/api\/harbormaster\/builds\/([^/]+)$/.exec(path);
    if (build) { const detail = this.harbormaster.detail(build[1]!, context); return { ...detail, accessEpoch, canManage: context.scopes.includes('write') && this.policies.access((detail.buildable.revisionId ?? detail.buildable.repositoryId)!, context.principalId).edit && (!detail.buildable.revisionPatch || this.policies.access(detail.buildable.repositoryId!, context.principalId).edit) }; }
    throw new HttpError(404, 'Automation endpoint not found.');
  }
  mutate(method: string, path: string, input: unknown, rawKey: string | undefined, context: AuthContext, commit?: GitCommitResult): MutationResponse {
    if (!rawKey) throw new HttpError(400, 'Automation changes require an Idempotency-Key.');
    const key = context.kind === 'local' ? rawKey : `${context.workspaceId}:${context.principalId}:${rawKey}`, fingerprint = createHash('sha256').update(JSON.stringify([method, path, input])).digest('hex');
    const authorize = () => { this.auth.revalidate(context, 'write'); if (path === '/api/herald/receive') this.receiveAuthority(parseGitReceiveFacts(input), context); if (path.includes('/targets/') && !this.worker(context.principalId)) throw new HttpError(403, 'This account is not configured as a build worker.'); };
    return this.store.mutate(key, fingerprint, () => {
      const accessEpoch = this.policies.epoch(), canManage = this.manager(context.principalId);
      if (path.startsWith('/api/audit/')) {
        const target = /^\/api\/audit\/commits\/([^/]+)\/(request|command)$/.exec(path);
        if (method === 'POST' && target) return { status: 200, body: { ...(target[2] === 'request' ? this.audit.request(target[1]!, input, context) : this.audit.command(target[1]!, input, context)), accessEpoch } };
        throw new HttpError(404, 'Audit endpoint not found.');
      }
      if (path.startsWith('/api/drydock/')) {
        if (method === 'POST' && path === '/api/drydock/blueprints') return { status: 201, body: { blueprint: this.drydock.createBlueprint(input, context), accessEpoch, canManage: true } };
        const blueprint = /^\/api\/drydock\/blueprints\/([^/]+)(\/authorizations)?$/.exec(path);
        if (method === 'PUT' && blueprint && !blueprint[2]) return { status: 200, body: { blueprint: this.drydock.updateBlueprint(blueprint[1]!, input, context), accessEpoch, canManage: true } };
        if (method === 'POST' && blueprint?.[2]) { const authorization = this.drydock.requestAuthorization(blueprint[1]!, input, context); return { status: 201, body: { authorization, accessEpoch, canManage: this.drydockManager(context, this.drydock.blueprint(authorization.blueprintId, context)) } }; }
        const authorization = /^\/api\/drydock\/authorizations\/([^/]+)\/commands$/.exec(path);
        if (method === 'POST' && authorization) return { status: 200, body: { authorization: this.drydock.authorizationCommand(authorization[1]!, input, context), accessEpoch, canManage: true } };
        if (method === 'POST' && path === '/api/drydock/leases' && input && typeof input === 'object' && 'revisionId' in input) {
          const {revisionId,versionId,contentHash,...data}=object(input,['revisionId','versionId','contentHash','blueprintId','blueprintVersion','durationSeconds']);
          const patch=this.revisionPatch(string(revisionId,'Revision ID',100),string(versionId,'Version ID',100),string(contentHash,'Content hash',64),context);
          const detail=this.drydock.requestRevision(patch,data,context);return {status:201,body:{...detail,accessEpoch,canManage:this.canManageLease(detail,context)}};
        }
        if (method === 'POST' && path === '/api/drydock/leases') { const { repositoryId, commitId, ...data } = object(input, ['repositoryId', 'commitId', 'blueprintId', 'blueprintVersion', 'durationSeconds']); if (!commit || commit.repositoryId !== repositoryId || commit.commit.id !== commitId) throw new HttpError(400, 'Select a verified immutable Git commit.'); const detail = this.drydock.request(commit, data, context); return { status: 201, body: { ...detail, accessEpoch, canManage: this.canManageLease(detail, context) } }; }
        const lease = /^\/api\/drydock\/leases\/([^/]+)\/(commands|claim|report)$/.exec(path);
        if (method === 'POST' && lease) { const result = lease[2] === 'commands' ? this.drydock.command(lease[1]!, input, context) : lease[2] === 'claim' ? this.drydock.claim(lease[1]!, input, context) : this.drydock.report(lease[1]!, input, context); return { status: 200, body: { ...result, accessEpoch, canManage: lease[2] === 'commands' } }; }
        throw new HttpError(404, 'Drydock endpoint not found.');
      }
      if (method === 'POST' && path === '/api/herald/receive') return { status: 200, body: { receive: this.git.receive(input, { ...this.receiveHooks(), canReceive: facts => this.receiveAuthority(facts, context), projectIds: id => { const row = this.store.database.prepare("SELECT data FROM entities WHERE id=? AND kind='repository'").get(id) as { data: string } | undefined; const repo = row ? JSON.parse(row.data) as { projectId?: string | null } : null; return repo?.projectId ? [repo.projectId] : []; } }), accessEpoch } };
      if (method === 'POST' && path === '/api/herald/rules') return { status: 201, body: { rule: this.herald.create(input, context.principalId, this.authority), accessEpoch, canManage } };
      const rule = /^\/api\/herald\/rules\/(H\d+)$/.exec(path);
      if (method === 'PUT' && rule) { const { expectedVersion, ...fields } = object(input, ['expectedVersion', 'name', 'contentType', 'ruleType', 'objectId', 'enabled', 'match', 'repetition', 'conditions', 'actions']); return { status: 200, body: { rule: this.herald.update(rule[1]!, integer(expectedVersion, 'Expected rule version'), fields, context.principalId, this.authority), accessEpoch, canManage } }; }
      if (method === 'POST' && path === '/api/herald/test') {
        const data = object(input, ['objectId', 'transcriptId']);
        if (Object.keys(data).length !== 1) throw new HttpError(400, 'Select one object or stored transcript.');
        let snapshot: HeraldSnapshot;
        if (data.transcriptId !== undefined) { const saved = this.herald.transcript(string(data.transcriptId, 'Transcript ID', 100), id => this.policies.access(this.policyObject(id), context.principalId).view); snapshot = { ...saved.snapshot, eventId: `test:${randomUUID()}` }; }
        else { const id = string(data.objectId, 'Object ID', 100); this.policies.require(this.policyObject(id), context.principalId, 'view'); snapshot = this.git.policyObjectId(id) ? { ...this.git.snapshot(id), eventId: `test:${randomUUID()}` } : this.snapshot(id, `test:${randomUUID()}`, context.principalId); }
        return { status: 200, body: { transcript: this.herald.evaluate(snapshot, this.hooks(), true), accessEpoch } };
      }
      if (method === 'POST' && path === '/api/harbormaster/plans') return { status: 201, body: { plan: this.harbormaster.createPlan(input, context), accessEpoch, canManage } };
      const plan = /^\/api\/harbormaster\/plans\/([^/]+)$/.exec(path);
      if (method === 'PUT' && plan) return { status: 200, body: { plan: this.harbormaster.updatePlan(plan[1]!, input, context), accessEpoch, canManage } };
      if (method === 'POST' && path === '/api/harbormaster/builds') {
        const data = object(input, ['revisionId', 'repositoryId', 'commitId', 'planId', 'planVersion', 'versionId', 'contentHash']);
        const { revisionId, repositoryId, commitId, ...fields } = data;
        if (commit) { if (revisionId !== undefined || commit.repositoryId !== repositoryId || commit.commit.id !== commitId) throw new HttpError(400, 'Select one exact source.'); }
        else if (repositoryId !== undefined || commitId !== undefined) throw new HttpError(400, 'The commit must be verified before starting a build.');
        const detail = commit ? this.harbormaster.runCommit(commit, fields, context) : this.harbormaster.run(string(revisionId, 'Revision ID', 100), fields, context);
        return { status: 201, body: { ...detail, accessEpoch, canManage: true } };
      }
      const command = /^\/api\/harbormaster\/builds\/([^/]+)\/commands$/.exec(path);
      if (method === 'POST' && command) return { status: 200, body: { ...this.harbormaster.command(command[1]!, input, context), accessEpoch, canManage: true } };
      const target = /^\/api\/harbormaster\/targets\/([^/]+)\/(claim|report)$/.exec(path);
      if (method === 'POST' && target) {
        if (target[2] === 'claim') { const data = object(input, ['expectedVersion', 'worker']); return { status: 200, body: { ...this.harbormaster.claim({ ...data, targetId: target[1]! }, context), accessEpoch } }; }
        return { status: 200, body: { ...this.harbormaster.report(target[1]!, input, context), accessEpoch, canManage: true } };
      }
      throw new HttpError(404, 'Automation endpoint not found.');
    }, authorize, response => {
      // A replay is private to its principal, but object access may have changed.
      const value = response.body as Partial<DrydockLeaseDetail & DrydockClaim & AuditDetail> & { blueprint?: DrydockBlueprint; authorization?: DrydockAuthorization; transcript?: HeraldTranscript; buildable?: Buildable; source?: RevisionVersion; target?: BuildClaim['target']; leaseToken?: string; rule?: HeraldRule; receive?: GitReceiveReceipt };
      if (value.audit) { const current = this.audit.detail(value.audit.id, context); value.canEdit = context.scopes.includes('write') && current.canEdit; value.canInteract = context.scopes.includes('write') && current.canInteract; }
      const id = value.transcript?.objectId ?? value.buildable?.revisionId ?? value.buildable?.repositoryId ?? value.source?.revisionId;
      if (id) this.policies.require(this.policyObject(id), context.principalId, 'view');
      if (value.buildable?.revisionPatch) this.policies.require(value.buildable.repositoryId!, context.principalId, 'view');
      if (value.target && value.leaseToken && path.endsWith('/claim')) this.harbormaster.revalidateClaim(value as unknown as BuildClaim, context);
      if (value.receive) this.policies.require(value.receive.repositoryId, context.principalId, 'view');
      if (value.blueprint) this.drydock.blueprint(value.blueprint.id, context);
      if (value.authorization) this.drydock.authorization(value.authorization.id, context);
      if (value.lease) {
        if (value.operation === 'provision') this.drydock.revalidateProvisionClaim(value as DrydockClaim, context);
        // Cleanup replies may remain readable only to the resource's assigned
        // worker after source access is revoked. They carry no source contents.
        const cleanup = value.resource?.workerPrincipalId === context.principalId && (value.operation === 'release' || path.endsWith('/report') && ['releasing', 'released'].includes(value.lease.status));
        if (!cleanup) this.drydock.detail(value.lease.id, context);
      }
      if (value.rule && !this.canViewRule(value.rule, context.principalId)) throw new HttpError(404, 'Rule not found.');
      return { ...response, body: { ...value, ...(value.receive ? { receive: presentGitReceiveReceipt(presentGitReceiveReceipt(value.receive, context.principalId, this.herald, this.policies), path === '/api/herald/receive' ? parseGitReceiveFacts(input).pusherId : context.principalId, this.herald, this.policies) } : {}), ...(value.transcript ? { transcript: presentHeraldTranscript(value.transcript, context.principalId, this.herald, this.policies) } : {}), accessEpoch: this.policies.epoch() } };
    });
  }
  start(): void { if (!this.timer) { this.timer = setInterval(() => this.pump(), 1_000); this.timer.unref(); this.pump(); } }
  private pump(): void { if (!this.stopping && !this.pumping) this.pumping = Promise.resolve().then(() => { if (!this.stopping) { this.drydock.sweep(); this.harbormaster.reconcileWorkingCopies(() => this.stopping); } }).then(() => this.harbormaster.dispatchPendingHttp(undefined, () => this.stopping)).catch(error => { console.error('Build dispatch failed:', error instanceof HttpError ? error.message : 'unexpected error'); }).finally(() => { this.pumping = undefined; }); }
  async close(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); await this.pumping; }
}
