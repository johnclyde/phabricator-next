import { visibleHeraldRule, presentHeraldTranscript } from './automation-projection.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthContext } from '../shared/auth.ts';
import type { Activity, RevisionVersion, WikiVersion } from '../shared/types.ts';
import type { HeraldRule, HeraldSnapshot, HeraldTranscript } from '../shared/herald.ts';
import type { GitCommitResult } from '../shared/repositories.ts';
import type { Auth } from './auth.ts';
import type { Store, MutationResponse } from './store.ts';
import type { PolicyStore } from './policy.ts';
import { HeraldStore, type HeraldAuthority } from './herald.ts';
import { HarbormasterStore, type BuildAuthority, type BuildActor } from './harbormaster.ts';
import { applyHeraldAction, canApplyHeraldAction } from './herald-effects.ts';
import { HttpError, object, string, integer } from './validation.ts';

export interface AutomationConfiguration { managers?: string[]; workers?: string[]; httpOrigins?: string[]; httpWorker?: string }
export function automationFromEnvironment(env: Record<string, string | undefined> = process.env): AutomationConfiguration {
  const list = (name: string) => (env[name] ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const httpOrigins = list('APP_HARBORMASTER_HTTP_ORIGINS');
  for (const value of httpOrigins) { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value) throw new Error('Harbormaster HTTP origins must be exact HTTP(S) origins without paths or credentials.'); }
  return { managers: list('APP_AUTOMATION_MANAGERS'), workers: list('APP_HARBORMASTER_WORKERS'), httpOrigins, httpWorker: env.APP_HARBORMASTER_HTTP_WORKER };
}
/** Connects the portable rule engine and build runner to current workspace authority. */
export class Automation {
  readonly herald: HeraldStore;
  readonly harbormaster: HarbormasterStore;
  readonly authority: HeraldAuthority;
  private timer?: ReturnType<typeof setInterval>;
  private pumping?: Promise<void>;
  private stopping = false;
  constructor(private readonly store: Store, private readonly auth: Auth, private readonly policies: PolicyStore, private readonly config: AutomationConfiguration = {}) {
    this.authority = { canManageGlobal: id => this.manager(id), canEditObject: (id, target) => this.enabled(id) && this.policies.access(target, id).edit, isEnabledPrincipal: id => this.enabled(id) };
    this.herald = new HeraldStore(store.database);
    this.harbormaster = new HarbormasterStore(store.database, {
      authorize: (actor, id, write) => this.authorize(actor, id, write),
      mayManagePlan: actor => this.manager(actor.principalId),
      source: (id, versionId, contentHash) => {
        const detail = store.detail(id), version = detail.versions.find(version => version.id === versionId && version.contentHash === contentHash);
        if (!version) throw new HttpError(409, 'The selected immutable source version is unavailable.');
        return { version, kind: detail.revision.kind };
      },
      allowHttp: endpoint => { if (!config.httpOrigins?.includes(new URL(endpoint).origin)) throw new HttpError(403, 'This HTTP build origin is not configured by the operator.'); this.httpActor(); },
      httpActor: () => this.httpActor(),
    });
    store.configureAutomation(events => this.capture(events));
  }
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
  private hooks() { return {
    canEvaluate: (rule: HeraldRule, snapshot: HeraldSnapshot) => this.enabled(rule.authorId) && this.policies.access(snapshot.objectId, rule.authorId).view && (rule.ruleType !== 'global' || this.manager(rule.authorId)) && (rule.ruleType !== 'object' || Boolean(rule.objectId && this.policies.access(rule.objectId, rule.authorId).edit)),
    canApply: (rule: HeraldRule, action: Parameters<typeof canApplyHeraldAction>[5], snapshot: HeraldSnapshot) => canApplyHeraldAction(this.store, this.auth, this.policies, this.harbormaster, rule, action, snapshot),
    apply: (rule: HeraldRule, action: Parameters<typeof applyHeraldAction>[5], snapshot: HeraldSnapshot) => applyHeraldAction(this.store, this.auth, this.policies, this.harbormaster, rule, action, snapshot),
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
    const enabledTypes = new Set((this.store.database.prepare("SELECT DISTINCT content_type FROM herald_rules WHERE json_extract(data,'$.enabled')=1").all() as { content_type: string }[]).map(row => row.content_type));
    if (!enabledTypes.size) return;
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
  }
  read(path: string, query: URLSearchParams, context: AuthContext): unknown {
    this.auth.revalidate(context, 'read'); const accessEpoch = this.policies.epoch(), canManage = this.manager(context.principalId) && context.scopes.includes('write');
    const number = (name: string) => query.has(name) ? integer(Number(query.get(name)), name) : undefined;
    const allowed = path === '/api/herald/rules' ? ['before', 'limit', 'contentType', 'enabled'] : path === '/api/herald/transcripts' ? ['before', 'limit', 'objectId'] : path.endsWith('/history') ? ['before', 'limit'] : path === '/api/harbormaster/builds' ? ['revisionId', 'objectId'] : [];
    if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1)) throw new HttpError(400, 'Unsupported automation query parameters.');
    if (path === '/api/herald/rules') {
      const enabled = query.get('enabled'); if (enabled !== null && enabled !== 'true' && enabled !== 'false') throw new HttpError(400, 'Invalid enabled filter.');
      const page = this.herald.list({ before: number('before'), limit: number('limit'), ...(enabled === null ? {} : { enabled: enabled === 'true' }), ...(query.has('contentType') ? { contentType: query.get('contentType') as HeraldSnapshot['contentType'] } : {}) });
      return { ...page, rules: this.rulesForReader(page.rules, context), accessEpoch, canManage };
    }
    const rule = /^\/api\/herald\/rules\/(H\d+)(\/history)?$/.exec(path);
    if (rule) { const item = this.herald.get(rule[1]!); if (!this.canViewRule(item, context.principalId)) throw new HttpError(404, 'Rule not found.'); const history = rule[2] ? this.herald.history(item.id, number('before'), number('limit')) : null; return history ? { ...history, versions: history.versions.filter(version => this.canViewRule(version.rule, context.principalId)), accessEpoch } : { rule: { ...item, canEdit: this.canEdit(item, context.principalId) && context.scopes.includes('write') }, accessEpoch, canManage }; }
    const visible = (id: string) => this.policies.access(id, context.principalId).view;
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
    if (build) { const detail = this.harbormaster.detail(build[1]!, context); return { ...detail, accessEpoch, canManage: context.scopes.includes('write') && this.policies.access((detail.buildable.revisionId ?? detail.buildable.repositoryId)!, context.principalId).edit }; }
    throw new HttpError(404, 'Automation endpoint not found.');
  }
  mutate(method: string, path: string, input: unknown, rawKey: string | undefined, context: AuthContext, commit?: GitCommitResult): MutationResponse {
    if (!rawKey) throw new HttpError(400, 'Automation changes require an Idempotency-Key.');
    const key = context.kind === 'local' ? rawKey : `${context.workspaceId}:${context.principalId}:${rawKey}`, fingerprint = createHash('sha256').update(JSON.stringify([method, path, input])).digest('hex');
    const authorize = () => { this.auth.revalidate(context, 'write'); if (path.includes('/targets/') && !this.worker(context.principalId)) throw new HttpError(403, 'This account is not configured as a build worker.'); };
    return this.store.mutate(key, fingerprint, () => {
      const accessEpoch = this.policies.epoch(), canManage = this.manager(context.principalId);
      if (method === 'POST' && path === '/api/herald/rules') return { status: 201, body: { rule: this.herald.create(input, context.principalId, this.authority), accessEpoch, canManage } };
      const rule = /^\/api\/herald\/rules\/(H\d+)$/.exec(path);
      if (method === 'PUT' && rule) { const { expectedVersion, ...fields } = object(input, ['expectedVersion', 'name', 'contentType', 'ruleType', 'objectId', 'enabled', 'match', 'repetition', 'conditions', 'actions']); return { status: 200, body: { rule: this.herald.update(rule[1]!, integer(expectedVersion, 'Expected rule version'), fields, context.principalId, this.authority), accessEpoch, canManage } }; }
      if (method === 'POST' && path === '/api/herald/test') {
        const data = object(input, ['objectId']), id = string(data.objectId, 'Object ID', 100); this.policies.require(id, context.principalId, 'view');
        return { status: 200, body: { transcript: this.herald.evaluate(this.snapshot(id, `test:${randomUUID()}`, context.principalId), this.hooks(), true), accessEpoch } };
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
      const value = response.body as { transcript?: HeraldTranscript; buildable?: { revisionId: string | null; repositoryId: string | null }; source?: RevisionVersion; rule?: HeraldRule };
      const id = value.transcript?.objectId ?? value.buildable?.revisionId ?? value.buildable?.repositoryId ?? value.source?.revisionId;
      if (id) this.policies.require(id, context.principalId, 'view');
      if (value.rule && !this.canViewRule(value.rule, context.principalId)) throw new HttpError(404, 'Rule not found.');
      return { ...response, body: { ...value, ...(value.transcript ? { transcript: presentHeraldTranscript(value.transcript, context.principalId, this.herald, this.policies) } : {}), accessEpoch: this.policies.epoch() } };
    });
  }
  start(): void { if (!this.timer) { this.timer = setInterval(() => this.pump(), 1_000); this.timer.unref(); this.pump(); } }
  private pump(): void { if (!this.stopping && !this.pumping) this.pumping = this.harbormaster.dispatchPendingHttp(undefined, () => this.stopping).catch(error => { console.error('Build dispatch failed:', error instanceof HttpError ? error.message : 'unexpected error'); }).finally(() => { this.pumping = undefined; }); }
  async close(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); await this.pumping; }
}
