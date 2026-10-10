import type { AuthContext } from '../shared/auth.ts';
import type { ProjectChildPreview, ProjectDetail, ProjectHistory, ProjectKind, ProjectMembersPage, ProjectWatchersPage, ProjectPreferences } from '../shared/projects.ts';
import { isValidProjectSlug, normalizeProjectSlug } from '../shared/projects.ts';
import type { AppState, RevisionDetail, ReviewThread, SpaceSummary, TaskDetail, TaskHistory, TaskSubscriptionPage, TaskSubscriptionStatus, TaskTransaction, WikiDetail } from '../shared/types.ts';
import type { ProjectCapability, ObjectAccess, Space } from '../shared/policy.ts';
import { WORKBOARD_BULK_MOVE_LIMIT } from '../shared/workboards.ts';
import type { WorkboardBulkMovePreview, WorkboardBulkMoveQuery, WorkboardCardPage, WorkboardCardsQuery, WorkboardColumn, WorkboardDetail, WorkboardHistory, WorkboardImportPreview, WorkboardQuery } from '../shared/workboards.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import type { MutationResponse, Store } from './store.ts';
import { HttpError, integer, object } from './validation.ts';

const CREATES = new Set(['/api/projects', '/api/repositories', '/api/tasks', '/api/documents', '/api/revisions']);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** One request's immutable principal. No process-global current user or policy bypass. */
export class AccessLayer {
  constructor(private store: Store, private auth: Auth, readonly policies: PolicyStore, readonly context: AuthContext) {}
  private get principal(): string { return this.context.principalId; }
  canView(id: string): boolean { return this.policies.access(id, this.principal).view; }
  require(id: string, capability: ProjectCapability = 'view'): void { this.policies.require(id, this.principal, capability); }
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
    state.currentPrincipalId = this.principal;
    state.followingTaskIds = state.tasks.filter(task => this.store.subscriptionStatus(task.id, this.principal).subscribed).map(task => task.id);
    state.joinedProjectIds = state.projects.filter(project => this.store.projectPreferences(project.id, this.principal).membership.active).map(project => project.id);
    state.watchingProjectIds = state.projects.filter(project => this.store.projectPreferences(project.id, this.principal).watching.active).map(project => project.id);
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
  project(id: string): ProjectDetail {
    this.require(id); const detail = this.store.projectDetail(id, this.principal);
    detail.history = this.projectHistory(id); return this.projectSnapshot(detail);
  }
  projectChildPreview(id: string, kind: ProjectKind): ProjectChildPreview {
    this.require(id, 'edit'); return { ...this.store.projectChildPreview(id, kind), accessEpoch: this.policies.epoch() };
  }
  resolveProject(slug: string): ProjectDetail {
    if (slug.length > 1_024 || !isValidProjectSlug(slug)) throw new HttpError(400, 'Provide a valid project name or alias of at most 128 normalized characters.');
    const row = this.store.database.prepare('SELECT project_id FROM project_aliases WHERE slug = ?').get(normalizeProjectSlug(slug)) as { project_id: string } | undefined;
    if (!row) throw new HttpError(404, 'Object was not found.', 'OBJECT_UNAVAILABLE');
    return this.project(row.project_id);
  }
  projectHistory(id: string, before?: number, limit?: number): ProjectHistory { this.require(id); return { ...this.store.projectHistory(id, before, limit, related => this.canView(related)), accessEpoch: this.policies.epoch() }; }
  projectMembers(id: string, after?: string, limit?: number): ProjectMembersPage {
    this.require(id); const page = this.store.projectMembers(id, this.principal, after, limit);
    return { ...page, members: page.members.map(member => ({ ...member, sourceProjectIds: member.sourceProjectIds.filter(source => this.canView(source)) })), viewer: this.projectPreferenceSnapshot(page.viewer), accessEpoch: this.policies.epoch() };
  }
  projectWatchers(id: string, after?: string, limit?: number): ProjectWatchersPage { this.require(id); const page = this.store.projectWatchers(id, this.principal, after, limit); return { ...page, viewer: this.projectPreferenceSnapshot(page.viewer), accessEpoch: this.policies.epoch() }; }
  projectPreferences(id: string): ProjectPreferences { this.require(id); return this.projectPreferenceSnapshot(this.store.projectPreferences(id, this.principal)); }
  private workboardVisibility() {
    const canWrite = this.context.scopes.includes('write');
    return { canViewProject: (id: string) => this.canView(id), canViewTask: (id: string) => this.canView(id),
      canEditTask: (id: string) => canWrite && this.policies.access(id, this.principal).edit,
      canEditProject: (id: string) => canWrite && this.policies.access(id, this.principal).edit };
  }
  private workboardQuery(query: WorkboardQuery): void {
    if (query.ownerId === undefined || query.ownerId === null) return;
    const id = query.ownerId;
    if (typeof id !== 'string' || id.length > 200 || !id || id.includes('\0')) throw new HttpError(400, 'Selected member is unavailable.');
    if (this.auth.listAccounts().some(account => account.id === id) || (this.context.kind === 'local' && id === this.principal)) return;
    // Historical identities (including a former local owner) remain valid
    // filters only when already visible on an accessible task.
    const tasks = this.store.database.prepare("SELECT id FROM entities WHERE kind = 'task' AND json_extract(data, '$.ownerId') = ?").all(id) as { id: string }[];
    if (!tasks.some(task => this.canView(task.id))) throw new HttpError(400, 'Selected member is unavailable.');
  }
  workboard(id: string, query: WorkboardQuery): WorkboardDetail {
    this.require(id); this.workboardQuery(query);
    const detail = this.store.workboard(id, query, this.workboardVisibility());
    const accessEpoch = this.policies.epoch();
    return this.redact({ ...detail, columns: detail.columns.map(column => ({ ...column, cards: { ...column.cards, accessEpoch } })), accessEpoch });
  }
  workboardCards(id: string, columnId: string, query: WorkboardCardsQuery): WorkboardCardPage {
    this.require(id); this.workboardColumnReference(id, columnId); this.workboardQuery(query);
    return this.redact({ ...this.store.workboardCards(id, columnId, query, this.workboardVisibility()), accessEpoch: this.policies.epoch() });
  }
  workboardHistory(id: string, before?: number, limit?: number): WorkboardHistory {
    this.require(id);
    return { ...this.store.workboardHistory(id, before, limit, related => this.canView(related)), accessEpoch: this.policies.epoch() };
  }
  workboardImportPreview(id: string, sourceId: unknown): WorkboardImportPreview {
    this.require(id, 'edit'); const source = this.workboardProjectReference(sourceId);
    return { ...this.store.workboardImportPreview(id, source), accessEpoch: this.policies.epoch() };
  }
  workboardBulkMovePreview(id: string, query: WorkboardBulkMoveQuery): WorkboardBulkMovePreview {
    this.require(id); this.workboardColumnReference(id, query.sourceColumnId);
    const destinationId = this.workboardProjectReference(query.destinationProjectId);
    this.workboardColumnReference(destinationId, query.destinationColumnId); this.workboardQuery(query);
    // Preview is a read. The selected principal's task permissions determine
    // its contents even when a read-only token cannot submit that selection.
    const visibility = { ...this.workboardVisibility(), canEditTask: (taskId: string) => this.policies.access(taskId, this.principal).edit };
    return { ...this.store.workboardBulkMovePreview(id, query, visibility), accessEpoch: this.policies.epoch() };
  }
  /** Child failures must not be mistaken for revocation of a visible board. */
  private workboardProjectReference(value: unknown): string {
    if (typeof value !== 'string' || !/^PROJ[1-9]\d*$/.test(value) || !this.canView(value)) throw new HttpError(404, 'Project reference was not found.', 'PROJECT_REFERENCE_UNAVAILABLE');
    return value;
  }
  private workboardColumnReference(projectId: string, value: unknown): WorkboardColumn {
    const unavailable = () => new HttpError(404, 'Workboard column was not found.', 'COLUMN_UNAVAILABLE');
    if (typeof value !== 'string' || !/^COL[1-9]\d*$/.test(value)) throw unavailable();
    const column = this.store.workboardColumn(projectId, value);
    if (column.proxyProjectId && (!this.canView(column.proxyProjectId) || this.store.getProject(column.proxyProjectId).kind !== 'milestone')) throw unavailable();
    return column;
  }
  private workboardTaskReference(value: unknown, edit = false): string {
    if (typeof value !== 'string' || !/^T[1-9]\d*$/.test(value) || !this.canView(value)) throw new HttpError(404, 'Task reference was not found.', 'TASK_REFERENCE_UNAVAILABLE');
    if (edit) this.require(value, 'edit');
    return value;
  }
  private projectPreferenceSnapshot(preferences: ProjectPreferences): ProjectPreferences {
    return { ...preferences, membership: { ...preferences.membership, sourceProjectIds: preferences.membership.sourceProjectIds.filter(id => this.canView(id)) }, watchingInheritedFrom: preferences.watchingInheritedFrom.filter(id => this.canView(id)), accessEpoch: this.policies.epoch() };
  }
  private projectSnapshot(detail: ProjectDetail): ProjectDetail {
    const transactions = detail.history.transactions.filter(item => !item.hierarchy || this.canView(item.hierarchy.childId));
    return { ...detail,
      hierarchy: { ancestors: detail.hierarchy.ancestors.filter(item => this.canView(item.id)), subprojects: detail.hierarchy.subprojects.filter(item => this.canView(item.id)), milestones: detail.hierarchy.milestones.filter(item => this.canView(item.id)), descendantProjectIds: detail.hierarchy.descendantProjectIds.filter(id => this.canView(id)) },
      viewer: this.projectPreferenceSnapshot(detail.viewer),
      history: { ...detail.history, transactions, nextBefore: detail.history.nextBefore === null ? null : transactions.at(-1)?.sequence ?? null, firstAvailableSequence: detail.history.firstAvailableSequence !== null && detail.history.transactions.some(item => item.sequence === detail.history.firstAvailableSequence) && !transactions.some(item => item.sequence === detail.history.firstAvailableSequence) ? null : detail.history.firstAvailableSequence, accessEpoch: this.policies.epoch() },
      access: this.describe(detail.project.id), accessEpoch: this.policies.epoch() };
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
  taskSubscriptions(id: string, after?: string, limit?: number): TaskSubscriptionPage {
    this.require(id);
    return { ...this.store.taskSubscriptions(id, this.principal, after, limit), accessEpoch: this.policies.epoch() };
  }
  taskSubscriptionStatus(id: string, principalId: string): TaskSubscriptionStatus {
    this.require(id); this.principalReference(principalId, false, id);
    return { ...this.store.subscriptionStatus(id, principalId), accessEpoch: this.policies.epoch() };
  }
  private visibleTaskTransaction(transaction: TaskTransaction): boolean {
    const related = transaction.dependency?.taskId ?? transaction.dependencyStatus?.taskId ?? transaction.merge?.taskId ?? transaction.project?.projectId;
    if (related && !this.canView(related)) return false;
    const column = transaction.column;
    return !column || (this.canView(column.projectId) && [...column.fromColumns, column.toColumn].every(item => !item.proxyProjectId || this.canView(item.proxyProjectId))
      && (!column.bulkSource || (this.canView(column.bulkSource.projectId) && (!column.bulkSource.column.proxyProjectId || this.canView(column.bulkSource.column.proxyProjectId)))));
  }
  /** Filter only this response's evidence; retries must never borrow live history. */
  private taskSnapshot(detail: TaskDetail): TaskDetail {
    const transactions = detail.history.transactions.filter(transaction => this.visibleTaskTransaction(transaction));
    const first = detail.history.firstAvailableSequence;
    return this.redact({
      ...detail,
      dependsOn: detail.dependsOn.filter(task => this.canView(task.id)),
      blocks: detail.blocks.filter(task => this.canView(task.id)),
      duplicateOf: detail.duplicateOf.filter(task => this.canView(task.id)),
      duplicates: detail.duplicates.filter(task => this.canView(task.id)),
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
        key === 'projectIds' && Array.isArray(child) ? child.filter(id => typeof id === 'string' && this.canView(id))
          : (key === 'projectId' || key === 'repositoryId') && typeof child === 'string' && !this.canView(child) ? null : visit(child),
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
  private projectReferences(value: unknown): void {
    if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'Choose at most 100 project tags.');
    for (const id of value) if (typeof id !== 'string' || !/^PROJ[1-9]\d*$/.test(id) || !this.canView(id)) throw new HttpError(400, 'Reference unavailable.');
  }
  private principalReference(value: unknown, active = true, taskId?: string): string {
    const account = typeof value === 'string' ? this.auth.listAccounts().find(item => item.id === value) : undefined;
    let local = this.context.kind === 'local' && value === this.principal;
    if (!active && taskId && value === `local:${this.context.workspaceId}`) {
      const membership = this.store.subscriptionStatus(taskId, value);
      local ||= membership.version > 0 || membership.automatic;
    }
    if (!local && (!account || (active && account.disabled))) throw new HttpError(400, 'Selected member is unavailable.');
    return value as string;
  }
  private projectPrincipal(value: unknown, active: boolean, projectId?: string, relation: 'member' | 'watcher' = 'member'): string {
    if (!active && typeof value === 'string' && projectId && value === `local:${this.context.workspaceId}` && this.store.database.prepare('SELECT 1 FROM project_relations WHERE project_id = ? AND principal_id = ? AND relation = ?').get(projectId, value, relation)) return value;
    return this.principalReference(value, active);
  }
  private target(method: string, path: string): { id: string; capability: ProjectCapability } | null {
    const policy = /^\/api\/policies\/((?:PROJ|R|T|W|[DPL])\d+)$/.exec(path);
    if (policy) return { id: policy[1]!, capability: method === 'GET' ? 'view' : 'edit' };
    const space = /^\/api\/spaces\/(S\d+)$/.exec(path);
    if (space) return { id: space[1]!, capability: method === 'GET' ? 'view' : 'edit' };
    const object = /^\/api\/(?:projects|repositories|tasks|documents|revisions)\/((?:PROJ|R|T|W|[DPL])\d+)(?:\/(.*))?$/.exec(path);
    if (!object) return null;
    const discussionReply = method === 'POST' && /^threads\/[^/]+\/replies$/.test(object[2] ?? '');
    const selfProject = object[1]!.startsWith('PROJ') && ['membership', 'watchers', 'silence'].includes(object[2] ?? '');
    const boardMove = method === 'POST' && object[1]!.startsWith('PROJ') && ['workboard/moves', 'workboard/bulk-moves'].includes(object[2] ?? '');
    return { id: object[1]!, capability: method === 'GET' || object[2] === 'subscriptions' || selfProject || boardMove ? 'view' : discussionReply || ['comments', 'reviews'].includes(object[2] ?? '') ? 'interact' : 'edit' };
  }
  authorize(method: string, path: string, input: unknown): void {
    const target = this.target(method, path);
    if (target) this.require(target.id, target.capability);
    const workboard = /^\/api\/projects\/(PROJ\d+)\/workboard(?:\/(moves|bulk-moves|columns|import)(?:\/([^/]+)(\/reorder)?)?)?$/.exec(path);
    if (workboard && method !== 'GET') {
      const id = workboard[1]!; const data = record(input);
      if (workboard[2] === 'bulk-moves') {
        const bulk = object(input, ['sourceColumnId', 'destinationProjectId', 'destinationColumnId', 'expectedBoardVersion', 'expectedDestinationBoardVersion', 'tasks']);
        integer(bulk.expectedBoardVersion, 'expectedBoardVersion'); integer(bulk.expectedDestinationBoardVersion, 'expectedDestinationBoardVersion');
        if (!Array.isArray(bulk.tasks) || bulk.tasks.length < 1 || bulk.tasks.length > WORKBOARD_BULK_MOVE_LIMIT) throw new HttpError(400, `Choose between 1 and ${WORKBOARD_BULK_MOVE_LIMIT} tasks from the reviewed preview.`);
        const taskIds = new Set<string>();
        // Bound and validate the entire list before any per-task policy work.
        for (const value of bulk.tasks) {
          const task = object(value, ['taskId', 'expectedTaskVersion']);
          if (typeof task.taskId !== 'string' || task.taskId.length > 50 || !/^T[1-9]\d*$/.test(task.taskId) || taskIds.has(task.taskId)) throw new HttpError(400, 'Choose unique valid task IDs from the reviewed preview.');
          integer(task.expectedTaskVersion, 'expectedTaskVersion'); taskIds.add(task.taskId);
        }
        this.workboardColumnReference(id, bulk.sourceColumnId);
        const destinationId = this.workboardProjectReference(bulk.destinationProjectId);
        this.workboardColumnReference(destinationId, bulk.destinationColumnId);
        for (const taskId of taskIds) this.workboardTaskReference(taskId, true);
      } else if (workboard[2] === 'import') {
        this.workboardProjectReference(data?.sourceProjectId);
      } else if (workboard[2] === 'moves') {
        this.workboardTaskReference(data?.taskId, true);
        this.workboardColumnReference(id, data?.columnId);
        const position = record(data?.position);
        for (const name of ['beforeTaskId', 'afterTaskId']) if (position && Object.hasOwn(position, name)) this.workboardTaskReference(position[name]);
      } else if (workboard[3]) {
        this.workboardColumnReference(id, workboard[3]);
        if (workboard[4]) {
          const position = record(data?.position);
          for (const name of ['beforeColumnId', 'afterColumnId']) if (position && Object.hasOwn(position, name)) this.workboardColumnReference(id, position[name]);
        }
      }
      // Versions, enabled/hidden state and current anchor placement belong to
      // the fresh operation. Saved retries still recheck all current authority.
    }
    if (method === 'POST' && path === '/api/projects') {
      const data = record(input);
      if (data?.parentId !== undefined && data.parentId !== null) {
        if (typeof data.parentId !== 'string' || !/^PROJ[1-9]\d*$/.test(data.parentId) || !this.canView(data.parentId)) throw new HttpError(400, 'Reference unavailable.');
        this.require(data.parentId, 'edit');
      }
      if (data?.kind === 'milestone' && ['access', 'memberIds', 'icon', 'color', 'colorKey'].some(key => Object.hasOwn(data, key))) throw new HttpError(400, 'Milestones inherit access, membership, icon and color from their parent.');
    }
    if (method === 'POST' && CREATES.has(path)) this.references(input);
    if (method === 'POST' && path === '/api/tasks' && record(input)?.projectIds !== undefined) this.projectReferences(record(input)!.projectIds);
    if (method === 'POST' && /^\/api\/tasks\/T\d+\/projects$/.test(path)) this.projectReferences(record(input)?.projectIds);
    if (method === 'POST' && path === '/api/projects' && record(input)?.memberIds !== undefined) {
      const ids = record(input)!.memberIds;
      if (!Array.isArray(ids) || ids.length > 100) throw new HttpError(400, 'Choose at most 100 initial project members.');
      for (const id of ids) this.projectPrincipal(id, true);
    }
    const projectAction = method === 'POST' ? /^\/api\/projects\/(PROJ\d+)\/(members|membership|watchers|silence)$/.exec(path) : null;
    if (projectAction) {
      const id = projectAction[1]!; const action = projectAction[2]; const data = record(input);
      if ((action === 'members' || action === 'membership') && this.store.getProject(id).membershipMode !== 'direct') throw new HttpError(403, 'Membership is inherited. Change membership in an ordinary leaf project.', 'ACTION_FORBIDDEN');
      if (action === 'members') {
        if (!Array.isArray(data?.principalIds) || data.principalIds.length > 100) throw new HttpError(400, 'Choose at most 100 project members.');
        for (const member of data.principalIds) {
          const retained = typeof member === 'string' && Boolean(this.store.database.prepare("SELECT 1 FROM project_relations WHERE project_id = ? AND principal_id = ? AND relation = 'member' AND active = 1").get(id, member));
          this.projectPrincipal(member, data.action !== 'remove' && !retained, id);
        }
      } else if (action === 'membership') {
        if (data?.action === 'join') this.require(id, 'join');
        else if (data?.action === 'leave' && this.store.getProject(id).membershipLocked) this.require(id, 'edit');
      } else if (action === 'watchers') {
        const principalId = this.projectPrincipal(data?.principalId, data?.action !== 'unwatch', id, 'watcher');
        const preferences = this.store.projectPreferences(id, this.principal);
        if (principalId === this.principal && !preferences.watching.active && preferences.watchingInheritedFrom.length) throw new HttpError(409, 'Watching is inherited from an ancestor. Change that ancestor\'s watch preference.');
        if (principalId !== this.principal) {
          if (data?.action !== 'unwatch') throw new HttpError(403, 'Only a member may choose to watch a project for themselves.', 'ACTION_FORBIDDEN');
          this.require(id, 'edit');
        }
      } else if (!this.store.projectPreferences(id, this.principal).membership.active) throw new HttpError(403, 'Only current project members can change member-mail preferences.', 'ACTION_FORBIDDEN');
    }
    if ((method === 'POST' && path === '/api/tasks') || (method === 'PATCH' && /^\/api\/tasks\/T\d+$/.test(path))) {
      const ownerId = record(input)?.ownerId;
      const current = method === 'PATCH' ? this.store.database.prepare("SELECT json_extract(data, '$.ownerId') AS ownerId FROM entities WHERE id = ?").get(target!.id) as { ownerId: unknown } | undefined : undefined;
      if (ownerId !== undefined && ownerId !== null && ownerId !== current?.ownerId) this.principalReference(ownerId);
    }
    if (method === 'POST' && /^\/api\/tasks\/T\d+\/subscriptions$/.test(path)) {
      const data = record(input);
      const principalId = this.principalReference(data?.principalId, data?.action !== 'unsubscribe', target!.id);
      if (data?.action !== 'subscribe' && data?.action !== 'unsubscribe') throw new HttpError(400, 'Choose subscribe or unsubscribe.');
      if (principalId !== this.principal) {
        const capabilities = this.policies.access(target!.id, this.principal);
        if (data.action === 'unsubscribe' || !capabilities.edit) this.require(target!.id, data.action === 'unsubscribe' ? 'edit' : 'interact');
      }
    }
    if (method === 'POST' && /^\/api\/tasks\/T\d+\/dependencies$/.test(path)) {
      const id = record(input)?.taskId;
      if (typeof id !== 'string' || !/^T[1-9]\d*$/.test(id) || !this.canView(id)) throw new HttpError(400, 'Reference unavailable.');
    }
    if (method === 'POST' && /^\/api\/tasks\/T\d+\/(merge|merge-in)$/.test(path)) {
      const data = record(input);
      let selected: unknown[];
      if (path.endsWith('/merge-in')) {
        if (!Array.isArray(data?.sources) || data.sources.length < 1 || data.sources.length > 100) throw new HttpError(400, 'Choose between 1 and 100 tasks to merge.');
        selected = data.sources.map(source => record(source)?.taskId);
      } else selected = [data?.taskId];
      for (const id of selected) {
        if (typeof id !== 'string' || !/^T[1-9]\d*$/.test(id) || !this.canView(id)) throw new HttpError(400, 'Reference unavailable.');
        this.require(id, 'edit');
      }
    }
    if (method === 'POST' && CREATES.has(path)) {
      const data = record(input); const access = record(data?.access);
      const parentId = path === '/api/projects' && typeof data?.parentId === 'string' ? data.parentId : null;
      const id = access?.spaceId ?? (parentId ? this.policies.policy(parentId, this.principal).spaceId : 'S1');
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
  private legacyTaskMergeSnapshot(detail: Record<string, unknown>): void {
    if (Array.isArray(detail.duplicateOf) && Array.isArray(detail.duplicates)) return;
    const history = record(detail.history);
    if (detail.duplicateOf !== undefined || detail.duplicates !== undefined || !Array.isArray(history?.transactions)
      || history.transactions.some(transaction => !record(transaction) || record(transaction)!.kind === 'merge' || record(transaction)!.merge !== undefined)) {
      throw new HttpError(409, 'This saved task response cannot be safely replayed. Reload the task.');
    }
    // Schema 7/8 task details predate duplicate relations. Their empty graph
    // is historical evidence, not permission to fetch today's relationships.
    detail.duplicateOf = [];
    detail.duplicates = [];
  }
  private taskProjectSnapshot(task: Record<string, unknown>): Record<string, unknown> {
    const invalid = () => new HttpError(409, 'This saved task response cannot be safely replayed. Reload the task.');
    const validId = (id: unknown): id is string => typeof id === 'string' && /^PROJ[1-9]\d*$/.test(id);
    let projectIds: string[];
    if (task.projectIds !== undefined) {
      if (!Array.isArray(task.projectIds) || !task.projectIds.every(validId) || new Set(task.projectIds).size !== task.projectIds.length || task.projectId !== undefined) throw invalid();
      projectIds = [...task.projectIds];
    } else {
      if (!Object.hasOwn(task, 'projectId') || (task.projectId !== null && !validId(task.projectId))) throw invalid();
      projectIds = task.projectId === null ? [] : [task.projectId as string];
    }
    // Normalize only the response's task shape, never historical snapshots or
    // stored evidence. An old scalar says nothing about today's project tags.
    const { projectId: _legacy, ...snapshot } = task;
    return { ...snapshot, projectIds };
  }
  private projectNeedsRefresh(project: Record<string, unknown>, body: Record<string, unknown>): boolean {
    if (typeof project.id !== 'string') return true;
    const current = this.store.getProject(project.id);
    for (const field of ['kind', 'parentId', 'milestoneNumber', 'depth', 'hierarchyVersion', 'membershipMode'] as const) if (project[field] !== current[field]) return true;
    if (project.kind === 'milestone') {
      const parent = current.parentId ? this.store.getProject(current.parentId) : null;
      if (!parent || project.displayName !== `${parent.name} (${String(project.name)})` || project.icon !== current.icon || project.color !== current.color || project.colorKey !== current.colorKey) return true;
    }
    if (record(body.project)) {
      const detail = this.store.projectDetail(project.id, this.principal);
      if (JSON.stringify(body.hierarchy) !== JSON.stringify(detail.hierarchy) || body.membersVersion !== detail.membersVersion) return true;
      const saved = record(body.viewer);
      if (!saved) return true;
      const { accessEpoch: _epoch, ...preferences } = saved;
      if (JSON.stringify(preferences) !== JSON.stringify(detail.viewer)) return true;
    }
    return false;
  }
  /** Replayed bodies are evidence of an old write, never evidence of current access. */
  present(method: string, path: string, response: MutationResponse, freshTaskOwnershipChange = false, freshProjectChange = false): MutationResponse {
    let target = this.target(method, path);
    const body = record(response.body);
    if (method === 'POST' && (CREATES.has(path) || path === '/api/spaces')) {
      const id = body?.id ?? record(body?.revision)?.id;
      if (typeof id !== 'string') throw new HttpError(409, 'This saved response cannot be safely replayed.');
      target = { id, capability: 'edit' };
    }
    // The write was authorized under the same writer lock. Reassigning a task
    // may deliberately surrender automatic owner access; acknowledge that
    // commit without disclosing the now-hidden task. Replays never use this.
    if (freshTaskOwnershipChange && method === 'PATCH' && /^\/api\/tasks\/T\d+$/.test(path) && target) {
      if (!this.canView(target.id)) return { status: response.status, body: { id: target.id, saved: true, accessLost: true, accessEpoch: this.policies.epoch() } };
      this.require(target.id, 'view');
    } else if (freshProjectChange && target) {
      if (!this.canView(target.id)) return { status: response.status, body: { id: target.id, saved: true, accessLost: true, accessEpoch: this.policies.epoch() } };
      this.require(target.id);
    } else if (target) this.require(target.id, target.capability);
    if (path.startsWith('/api/policies/') && target) return { status: response.status, body: this.describe(target.id) };
    if ((path === '/api/spaces' || path.startsWith('/api/spaces/')) && target) return { status: response.status, body: this.space(this.policies.getSpace(target.id, this.principal)) };
    if (/^\/api\/projects\/PROJ\d+\/workboard(?:\/|$)/.test(path)) {
      if (!body || body.projectId !== target?.id || body.saved !== true || body.refreshRequired !== true || !Number.isSafeInteger(body.boardVersion) || Number(body.boardVersion) < 0) throw new HttpError(409, 'This saved workboard response cannot be safely replayed. Reload the board.');
      if (path.endsWith('/bulk-moves')) {
        if (typeof body.destinationProjectId !== 'string' || !/^PROJ[1-9]\d*$/.test(body.destinationProjectId) || !Number.isSafeInteger(body.destinationBoardVersion) || Number(body.destinationBoardVersion) < 1) throw new HttpError(409, 'This saved workboard response cannot be safely replayed. Reload the board.');
        this.workboardProjectReference(body.destinationProjectId);
        return { status: response.status, body: { projectId: body.projectId, saved: true, refreshRequired: true, boardVersion: body.boardVersion,
          destinationProjectId: body.destinationProjectId, destinationBoardVersion: body.destinationBoardVersion, accessEpoch: this.policies.epoch() } };
      }
      // A receipt never becomes a fresh layout or a new CAS baseline. Preserve
      // its historical pins while stamping only the current permission epoch.
      return { status: response.status, body: { projectId: body.projectId, saved: true, refreshRequired: true, boardVersion: body.boardVersion,
        ...(typeof body.columnId === 'string' ? { columnId: body.columnId } : {}), ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
        ...(typeof body.taskVersion === 'number' ? { taskVersion: body.taskVersion } : {}), accessEpoch: this.policies.epoch() } };
    }
    if (path.startsWith('/api/projects') && body) {
      const project = record(body.project) ?? (path === '/api/projects' ? body : null);
      if (project && typeof project.id === 'string' && /^PROJ[1-9]\d*$/.test(project.id) && (project.version === undefined || project.kind === undefined || project.hierarchyVersion === undefined || (body.project !== undefined && !record(body.hierarchy)) || this.projectNeedsRefresh(project, body))) return { status: response.status, body: { id: project.id, saved: true, refreshRequired: true, accessEpoch: this.policies.epoch() } };
      if (record(body.project)) return { status: response.status, body: this.projectSnapshot(body as unknown as ProjectDetail) };
      if (/^\/api\/projects\/PROJ\d+\/silence$/.test(path)) {
        const { accessEpoch: _epoch, ...preferences } = body;
        if (JSON.stringify(preferences) !== JSON.stringify(this.store.projectPreferences(target!.id, this.principal))) return { status: response.status, body: { id: target!.id, saved: true, refreshRequired: true, accessEpoch: this.policies.epoch() } };
        return { status: response.status, body: this.projectPreferenceSnapshot(body as unknown as ProjectPreferences) };
      }
    }
    const normalized = body && record(body.task) ? { ...body, task: this.taskProjectSnapshot(record(body.task)!) }
      : body && typeof body.id === 'string' && /^T[1-9]\d*$/.test(body.id) && path.startsWith('/api/tasks') ? this.taskProjectSnapshot(body) : response.body;
    const taskDetail = record(normalized);
    if (taskDetail && record(taskDetail.task)) {
      this.legacyTaskMergeSnapshot(taskDetail);
      // Filter whole relationship events before scalar redaction can replace
      // their project identity and accidentally retain a hidden placeholder.
      return { status: response.status, body: this.taskSnapshot(normalized as TaskDetail) };
    }
    const result = this.redact(normalized);
    const detail = record(result);
    if (detail && /^\/api\/tasks\/T\d+\/subscriptions$/.test(path)) return { status: response.status, body: { ...detail, accessEpoch: this.policies.epoch() } };
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
