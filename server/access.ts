import type { AuthContext } from '../shared/auth.ts';
import type { AppState, RevisionDetail, ReviewThread, SpaceSummary, TaskDetail, TaskHistory, TaskTransaction, WikiDetail } from '../shared/types.ts';
import type { Capability, ObjectAccess, Space } from '../shared/policy.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import type { MutationResponse, Store } from './store.ts';
import { HttpError } from './validation.ts';

const CREATES = new Set(['/api/projects', '/api/repositories', '/api/tasks', '/api/documents', '/api/revisions']);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** One request's immutable principal. No process-global current user or policy bypass. */
export class AccessLayer {
  constructor(private store: Store, private auth: Auth, readonly policies: PolicyStore, readonly context: AuthContext) {}
  private get principal(): string { return this.context.principalId; }
  canView(id: string): boolean { return this.policies.access(id, this.principal).view; }
  require(id: string, capability: Capability = 'view'): void { this.policies.require(id, this.principal, capability); }
  describe(id: string): ObjectAccess { return this.policies.describe(id, this.principal); }
  space(space: Space): SpaceSummary { return { ...space, capabilities: this.policies.access(space.id, this.principal) }; }
  state(ai: AppState['ai']): AppState {
    const state = this.store.state(ai, this.auth.mode === 'local' ? 'local-single-user' : 'authenticated-workspace');
    state.projects = state.projects.filter(item => this.canView(item.id));
    state.repositories = state.repositories.filter(item => this.canView(item.id));
    state.tasks = state.tasks.filter(item => this.canView(item.id));
    state.documents = state.documents.filter(item => this.canView(item.id));
    state.revisions = state.revisions.filter(item => this.canView(item.id));
    state.activity = this.store.activities(undefined, id => this.canView(id));
    state.spaces = this.policies.spaces(this.principal).map(space => this.space(space));
    state.access = Object.fromEntries([...state.projects, ...state.repositories, ...state.tasks, ...state.documents, ...state.revisions].map(item => [item.id, this.describe(item.id)]));
    state.accessEpoch = this.policies.epoch();
    state.canCreate = this.context.scopes.includes('write');
    // This is the member directory, not an administrative credential listing.
    state.principals = this.auth.listAccounts().filter(account => !account.disabled);
    if (this.context.kind === 'local') state.principals.unshift({ id: this.principal, username: 'local', displayName: 'You', disabled: false });
    return this.redact(state);
  }
  revision(id: string): RevisionDetail {
    this.require(id);
    return this.redact({ ...this.store.detail(id), access: this.describe(id), accessEpoch: this.policies.epoch() });
  }
  document(id: string): WikiDetail {
    this.require(id);
    return { ...this.store.documentDetail(id), access: this.describe(id), accessEpoch: this.policies.epoch() };
  }
  task(id: string): TaskDetail {
    this.require(id);
    const detail = this.store.taskDetail(id);
    detail.history = this.taskHistory(id);
    return this.taskSnapshot(detail);
  }
  taskHistory(id: string, before?: number, limit?: number): TaskHistory {
    this.require(id);
    return this.redact({ ...this.store.taskHistory(id, before, limit, related => this.canView(related)), accessEpoch: this.policies.epoch() });
  }
  private visibleTaskTransaction(transaction: TaskTransaction): boolean {
    const related = transaction.dependency?.taskId ?? transaction.dependencyStatus?.taskId;
    return !related || this.canView(related);
  }
  /** Filter only this response's evidence; retries must never borrow live history. */
  private taskSnapshot(detail: TaskDetail): TaskDetail {
    const transactions = detail.history.transactions.filter(transaction => this.visibleTaskTransaction(transaction));
    const first = detail.history.firstAvailableSequence;
    return this.redact({
      ...detail,
      dependsOn: detail.dependsOn.filter(task => this.canView(task.id)),
      blocks: detail.blocks.filter(task => this.canView(task.id)),
      history: {
        ...detail.history, transactions, accessEpoch: this.policies.epoch(),
        nextBefore: detail.history.nextBefore === null ? null : transactions.at(-1)?.sequence ?? null,
        firstAvailableSequence: first !== null && detail.history.transactions.some(transaction => transaction.sequence === first && !this.visibleTaskTransaction(transaction)) ? null : first,
      },
      access: this.describe(detail.task.id), accessEpoch: this.policies.epoch(),
    });
  }
  /** Structured references are hidden without modifying the stored relationship. */
  redact<T>(value: T): T {
    const visit = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(visit);
      const object = record(item);
      if (!object) return item;
      if (object.field === 'projectId') {
        const change = { ...object };
        for (const name of ['oldValue', 'newValue'] as const) {
          if (typeof change[name] === 'string' && !this.canView(change[name] as string)) {
            change[name] = null; change[`${name}Hidden`] = true;
          }
        }
        return change;
      }
      return Object.fromEntries(Object.entries(object).map(([key, child]) => [key,
        (key === 'projectId' || key === 'repositoryId') && typeof child === 'string' && !this.canView(child) ? null : visit(child),
      ]));
    };
    return visit(value) as T;
  }
  private references(input: unknown): void {
    const value = record(input);
    if (!value) return;
    for (const key of ['projectId', 'repositoryId']) {
      const id = value[key];
      if (id === undefined || id === null) continue;
      const valid = typeof id === 'string' && (key === 'projectId' ? /^PROJ[1-9]\d*$/ : /^R[1-9]\d*$/).test(id);
      if (!valid || !this.canView(id as string)) throw new HttpError(400, 'Reference unavailable.');
    }
  }
  private target(method: string, path: string): { id: string; capability: Capability } | null {
    const policy = /^\/api\/policies\/((?:PROJ|R|T|W|[DPL])\d+)$/.exec(path);
    if (policy) return { id: policy[1]!, capability: method === 'GET' ? 'view' : 'edit' };
    const space = /^\/api\/spaces\/(S\d+)$/.exec(path);
    if (space) return { id: space[1]!, capability: method === 'GET' ? 'view' : 'edit' };
    const object = /^\/api\/(?:projects|repositories|tasks|documents|revisions)\/((?:PROJ|R|T|W|[DPL])\d+)(?:\/(.*))?$/.exec(path);
    if (!object) return null;
    const discussionReply = method === 'POST' && /^threads\/[^/]+\/replies$/.test(object[2] ?? '');
    return { id: object[1]!, capability: method === 'GET' ? 'view' : discussionReply || ['comments', 'reviews'].includes(object[2] ?? '') ? 'interact' : 'edit' };
  }
  authorize(method: string, path: string, input: unknown): void {
    const target = this.target(method, path);
    if (target) this.require(target.id, target.capability);
    if ((method === 'POST' && CREATES.has(path)) || (method === 'PATCH' && path.startsWith('/api/tasks/'))) this.references(input);
    if (method === 'POST' && /^\/api\/tasks\/T\d+\/dependencies$/.test(path)) {
      const id = record(input)?.taskId;
      if (typeof id !== 'string' || !/^T[1-9]\d*$/.test(id) || !this.canView(id)) throw new HttpError(400, 'Reference unavailable.');
    }
    if (method === 'POST' && CREATES.has(path)) {
      const access = record(record(input)?.access);
      const id = access?.spaceId ?? 'S1';
      if (typeof id !== 'string') throw new HttpError(400, 'Choose an available Space.');
      this.require(id);
      if (this.policies.getSpace(id, this.principal).archived) throw new HttpError(409, 'This Space is archived. Choose another destination.');
    }
  }
  creationInput(input: unknown): { content: unknown; access: unknown } {
    const value = record(input);
    if (!value) return { content: input, access: undefined };
    const { access, ...content } = value;
    return { content, access };
  }
  configureCreated(response: MutationResponse, input: unknown): MutationResponse {
    const body = record(response.body);
    const id = body?.id ?? record(body?.revision)?.id;
    if (typeof id !== 'string') throw new Error('A created object must have an identity.');
    this.policies.configureNew(id, record(input)?.access, this.principal);
    return response;
  }
  private legacyDiscussionSnapshot(detail: Record<string, unknown>, revisionId: string): void {
    if (detail.threads !== undefined) return;
    const invalid = () => new HttpError(409, 'This saved discussion response cannot be safely replayed. Reload the revision.');
    if (!Array.isArray(detail.comments) || !Array.isArray(detail.versions) || (detail.threadEvents !== undefined && (!Array.isArray(detail.threadEvents) || detail.threadEvents.length !== 0))) throw invalid();
    const versionIds = new Set<string>();
    for (const value of detail.versions) {
      const version = record(value);
      if (!version || typeof version.id !== 'string' || !version.id || version.revisionId !== revisionId || versionIds.has(version.id)) throw invalid();
      versionIds.add(version.id);
    }
    const rootIds = new Set<string>();
    const threads: ReviewThread[] = [];
    for (const value of detail.comments) {
      const comment = record(value);
      // Schema 4 had only root comments, with no passage/reply metadata. Never
      // reinterpret a newer or malformed response as a historical snapshot.
      if (!comment || comment.threadId !== undefined || comment.viewedVersionId !== undefined || comment.anchor !== undefined || comment.suggestion !== undefined
        || typeof comment.id !== 'string' || !comment.id || rootIds.has(comment.id) || comment.revisionId !== revisionId
        || typeof comment.versionId !== 'string' || !versionIds.has(comment.versionId)
        || (comment.filePath !== null && typeof comment.filePath !== 'string')
        || (comment.line !== null && (typeof comment.line !== 'number' || !Number.isSafeInteger(comment.line) || comment.line < 1))
        || typeof comment.body !== 'string' || typeof comment.author !== 'string'
        || typeof comment.createdAt !== 'string' || !Number.isFinite(Date.parse(comment.createdAt))) throw invalid();
      rootIds.add(comment.id);
      threads.push({ id: comment.id, rootCommentId: comment.id, revisionId, status: 'open', version: 1, createdAt: comment.createdAt, updatedAt: comment.createdAt });
    }
    detail.threads = threads;
    detail.threadEvents = [];
  }
  private legacySuggestionSnapshot(detail: Record<string, unknown>): void {
    if (detail.suggestionApplications !== undefined) return;
    if (!Array.isArray(detail.comments) || !Array.isArray(detail.versions) || !Array.isArray(detail.threads) || !Array.isArray(detail.threadEvents)
      || detail.comments.some(comment => !record(comment) || record(comment)!.suggestion !== undefined)) {
      throw new HttpError(409, 'This saved suggestion response cannot be safely replayed. Reload the revision.');
    }
    // Schema 4/5 snapshots predate suggestions. Preserve that historical state
    // without borrowing newer application records from the live revision.
    detail.suggestionApplications = [];
  }
  /** Replayed bodies are evidence of an old write, never evidence of current access. */
  present(method: string, path: string, response: MutationResponse): MutationResponse {
    let target = this.target(method, path);
    const body = record(response.body);
    if (method === 'POST' && (CREATES.has(path) || path === '/api/spaces')) {
      const id = body?.id ?? record(body?.revision)?.id;
      if (typeof id !== 'string') throw new HttpError(409, 'This saved response cannot be safely replayed.');
      target = { id, capability: 'edit' };
    }
    if (target) this.require(target.id, target.capability);
    if (path.startsWith('/api/policies/') && target) return { status: response.status, body: this.describe(target.id) };
    if ((path === '/api/spaces' || path.startsWith('/api/spaces/')) && target) return { status: response.status, body: this.space(this.policies.getSpace(target.id, this.principal)) };
    const result = this.redact(response.body);
    const detail = record(result);
    if (detail && record(detail.task)) return { status: response.status, body: this.taskSnapshot(result as TaskDetail) };
    const revisionId = record(detail?.revision)?.id;
    const id = revisionId ?? record(detail?.document)?.id;
    if (detail && typeof id === 'string') {
      if (typeof revisionId === 'string') {
        this.legacyDiscussionSnapshot(detail, revisionId);
        this.legacySuggestionSnapshot(detail);
      }
      detail.access = this.describe(id); detail.accessEpoch = this.policies.epoch();
    }
    return { status: response.status, body: result };
  }
}
