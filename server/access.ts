import type { AuthContext } from '../shared/auth.ts';
import { isDeepStrictEqual } from 'node:util';
import { revisionDependencyInputHash } from './revision-dependencies.ts';
import { type RevisionAuthorInput, type RevisionAuthorshipSnapshot, type RevisionAuthorHistory } from '../shared/revision-authorship.ts';
import { revisionAuthorInputHash } from './revision-authorship.ts';
import type { RevisionLifecycleInput, RevisionLifecycleSnapshot, RevisionLifecycleHistory } from '../shared/revision-lifecycle.ts';
import { revisionLifecycleInputHash } from './revision-lifecycle.ts';
import { revisionReviewerPermission, type RevisionReviewerInput, type RevisionReviewerSnapshot, type RevisionReviewerHistory } from '../shared/revision-reviewers.ts';
import { revisionReviewerInputHash } from './revision-reviewers.ts';
import type { RevisionMetadataInput, RevisionMetadataSnapshot, RevisionMetadataHistory } from '../shared/revision-metadata.ts';
import { revisionSubscriptionInputHash } from './revision-subscriptions.ts';
import type { RevisionSubscriptionInput, RevisionSubscriptionSnapshot, RevisionSubscriptionHistory, RevisionMuteHistory, RevisionSubscriptionPerson } from '../shared/revision-subscriptions.ts';
import { revisionMetadataInputHash } from './revision-metadata.ts';
import { revisionProjectInputHash } from './revision-projects.ts';
import type { RevisionProjectInput, RevisionProjectSnapshot, RevisionProjectHistory } from '../shared/revision-projects.ts';
import type { NotificationReadInput, NotificationInbox, NotificationSummary } from '../shared/notifications.ts';
import { notificationReadObjectId } from '../shared/notifications.ts';
import type { TaskMuteInput, TaskMuteSnapshot, TaskMuteHistory } from '../shared/task-notifications.ts';
import { parseRevisionDependencyInput } from './store.ts';
import { createHash } from 'node:crypto';
import { parseCreatePasteInput, parseUpdatePasteInput, parsePasteCommentInput } from './pastes.ts';
import type { ProjectChildPreview, ProjectDetail, ProjectHistory, ProjectKind, ProjectMembersPage, ProjectWatchersPage, ProjectPreferences } from '../shared/projects.ts';
import { isValidProjectSlug, normalizeProjectSlug } from '../shared/projects.ts';
import type { AppState, RevisionDetail, ReviewThread, SpaceSummary, TaskDetail, TaskHistory, TaskSubscriptionPage, TaskSubscriptionStatus, TaskTransaction, WikiDetail, WikiDocument, WikiHistory, WikiVersion } from '../shared/types.ts';
import { canonicalWikiPath, wikiAncestors, wikiReference, WIKI_WRITE_PATH_MAX_LENGTH, type WikiHierarchy, type WikiPathResult, type WikiMovePreview, type WikiMoveReceipt, type WikiLifecycleHistory, type WikiLifecycleReceipt } from '../shared/wiki.ts';
import type { ProjectCapability, ObjectAccess, Space } from '../shared/policy.ts';
import { WORKBOARD_BULK_MOVE_LIMIT } from '../shared/workboards.ts';
import type { WorkboardBulkMovePreview, WorkboardBulkMoveQuery, WorkboardCardPage, WorkboardCardsQuery, WorkboardColumn, WorkboardDetail, WorkboardHistory, WorkboardImportPreview, WorkboardQuery } from '../shared/workboards.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import { docxOperationHash, gitImportInput, gitVersionImportInput, parseDocxImportInput, parseDocxReimportInput, parseDocxReplaceInput, parseWikiMoveInput, wikiMoveInputHash, parseWikiDraftInput, parseWikiPublishInput, parseWikiDeleteInput, parseWikiEditInput, parseWikiRestoreInput, wikiLifecycleInputHash, threadPreferenceInput, type MutationResponse, type Store } from './store.ts';
import { HttpError, integer, object } from './validation.ts';
import { validatePasteContent, type PasteDetail, type PasteListQuery, type PastePage } from '../shared/pastes.ts';
import type { FileDetail, FileListQuery, FilePage } from '../shared/files.ts';
import type { CitationEvidenceRecord } from '../shared/citation-evidence.ts';
import { parseCitationEvidenceInput } from './citation-evidence.ts';
import type { WikiContentSearchPage, WikiContentSearchQuery, WikiDocumentSearchPage, WikiDocumentSearchQuery } from '../shared/wiki-search.ts';

const CREATES = new Set(['/api/projects', '/api/repositories', '/api/tasks', '/api/documents', '/api/revisions', '/api/revisions/docx', '/api/files', '/api/pastes']);
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
    state.pastes = (state.pastes ?? []).filter(item => this.canView(item.id));
    state.files = (state.files ?? []).filter(item => this.canView(item.id));
    state.activity = this.store.activities(undefined, id => this.canView(id));
    state.spaces = this.policies.spaces(this.principal).map(space => this.space(space));
    state.access = Object.fromEntries([...state.projects, ...state.repositories, ...state.tasks, ...state.documents, ...state.revisions, ...state.files, ...state.pastes].map(item => [item.id, this.describe(item.id)]));
    state.accessEpoch = this.policies.epoch();
    state.canCreate = this.context.scopes.includes('write');
    state.currentPrincipalId = this.principal;
    state.followingRevisionIds = state.revisions.filter(revision => this.store.revisionSubscriptions.effective(revision.id, this.principal)).map(revision => revision.id);
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
  notifications(query: { filter?: 'all' | 'unread' | 'read'; before?: string; limit?: number }): NotificationInbox {
    return this.store.notifications.list(this.principal, query, this.policies.epoch());
  }
  notificationSummary(): NotificationSummary { return this.store.notifications.summary(this.principal, this.policies.epoch()); }
  taskMute(id: string): TaskMuteSnapshot { this.require(id); return { ...this.store.taskNotifications.snapshot(id, this.principal), accessEpoch: this.policies.epoch() }; }
  taskMuteHistory(id: string, query: { before?: number; limit?: number; expectedMuteVersion?: number }): TaskMuteHistory { this.require(id); return { ...this.store.taskNotifications.history(id, this.principal, query), accessEpoch: this.policies.epoch() }; }
  presentTaskMute(id: string, input: TaskMuteInput, response: MutationResponse, retryKeySha256: string): MutationResponse {
    this.require(id);
    const invalid = (): never => { throw new HttpError(409, 'This saved task mute receipt does not match the requested operation.', 'TASK_MUTE_INVALID_RECEIPT'); };
    const body = record(response.body);
    if (!body || response.status !== 200 || body.taskId !== id || typeof body.operationId !== 'string') return invalid();
    let operation;
    try {
      if (this.store.taskNotifications.operationPrincipalId(body.operationId) !== this.principal || this.store.taskNotifications.operationTaskId(body.operationId) !== id) return invalid();
      operation = this.store.taskNotifications.operation(body.operationId);
    } catch { return invalid(); }
    if (operation.taskId !== id || operation.principalId !== this.principal || operation.attribution.principalId !== this.principal || operation.retryKeySha256 !== retryKeySha256
      || operation.inputSha256 !== createHash('sha256').update(JSON.stringify(input)).digest('hex') || !isDeepStrictEqual(operation.input, input) || !isDeepStrictEqual(body, operation.receipt)) return invalid();
    return { status: 200, body: { ...operation.receipt, accessEpoch: this.policies.epoch() } };
  }
  private requireNotificationObject(id: string): void {
    if (!this.canView(id)) throw new HttpError(404, 'Notification is unavailable.', 'NOTIFICATION_UNAVAILABLE');
  }
  requireNotificationAction(input: NotificationReadInput): void {
    if (input.action === 'read' || input.action === 'unread') this.requireNotificationObject(this.store.notifications.notificationObjectId(this.principal, input.notificationId));
    else if (input.action === 'read_object') this.requireNotificationObject(notificationReadObjectId(input));
  }
  presentNotificationRead(input: NotificationReadInput, response: MutationResponse, retryKeySha256: string): MutationResponse {
    this.requireNotificationAction(input);
    const invalid = (): never => { throw new HttpError(409, 'This saved notification receipt does not match the requested operation.', 'NOTIFICATION_INVALID_RECEIPT'); };
    const body = record(response.body);
    if (!body || response.status !== 200 || typeof body.operationId !== 'string') return invalid();
    let operation;
    try {
      if (this.store.notifications.operationPrincipalId(body.operationId) !== this.principal) return invalid();
      operation = this.store.notifications.operation(body.operationId);
    } catch { return invalid(); }
    if (operation.principalId !== this.principal || operation.attribution.principalId !== this.principal || operation.retryKeySha256 !== retryKeySha256
      || operation.inputSha256 !== createHash('sha256').update(JSON.stringify(input)).digest('hex') || !isDeepStrictEqual(operation.input, input) || !isDeepStrictEqual(body, operation.receipt)) return invalid();
    for (const id of operation.affectedObjectIds) this.requireNotificationObject(id);
    return { status: 200, body: { ...operation.receipt, accessEpoch: this.policies.epoch() } };
  }
  revisionProjects(id: string): RevisionProjectSnapshot {
    this.require(id);
    return this.redact({ ...this.store.revisionProjects.snapshot(id), access: this.describe(id), accessEpoch: this.policies.epoch() });
  }
  revisionProjectHistory(id: string, query: { before?: number; limit?: number; expectedProjectVersion?: number }): RevisionProjectHistory {
    this.require(id);
    return this.redact({ ...this.store.revisionProjects.history(id, query), accessEpoch: this.policies.epoch() });
  }
  private revisionProjectReferences(value: unknown): void {
    if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'Choose at most 100 project tags.');
    for (const id of value) if (typeof id !== 'string' || !/^PROJ[1-9]\d{0,14}$/.test(id) || !this.canView(id)) throw new HttpError(404, 'Project reference is unavailable.', 'REVISION_PROJECT_UNAVAILABLE');
  }
  requireRevisionProjectAction(id: string, input: RevisionProjectInput): void {
    this.require(id, 'edit'); this.revisionProjectReferences(input.projectIds);
  }
  presentRevisionProject(id: string, input: RevisionProjectInput, response: MutationResponse, retryKeySha256: string): MutationResponse {
    this.requireRevisionProjectAction(id, input);
    const invalid = (): never => { throw new HttpError(409, 'This saved project-tag receipt does not match the requested operation.', 'REVISION_PROJECT_INVALID_RECEIPT'); };
    const body = record(response.body);
    if (!body || response.status !== 200 || body.revisionId !== id || typeof body.operationId !== 'string') return invalid();
    let operation;
    try {
      if (this.store.revisionProjects.operationRevisionId(body.operationId) !== id) return invalid();
      operation = this.store.revisionProjects.operation(body.operationId);
    } catch { return invalid(); }
    if (operation.revisionId !== id || operation.attribution.principalId !== this.principal || operation.retryKeySha256 !== retryKeySha256
      || operation.inputSha256 !== revisionProjectInputHash(input) || !isDeepStrictEqual(operation.input, input) || !isDeepStrictEqual(body, operation.receipt)) return invalid();
    return { status: 200, body: this.redact({ ...operation.receipt, accessEpoch: this.policies.epoch() }) };
  }
  private verifyRevisionProjectSnapshot(revision: Record<string, unknown>, id: string, creation: boolean, input: unknown): void {
    const invalid = (): never => { throw new HttpError(409, 'This saved revision has inconsistent historical project tags.', 'REVISION_PROJECT_INVALID_RECEIPT'); };
    const modern = Object.hasOwn(revision, 'projectIds') || Object.hasOwn(revision, 'projectVersion');
    // Legacy scalar receipts remain historical. A new array-form creation
    // cannot strip its modern fields and masquerade as a legacy response.
    if (!modern) { if (creation && Object.hasOwn(record(input) ?? {}, 'projectIds')) invalid(); return; }
    if (revision.id !== id || !Number.isSafeInteger(revision.projectVersion) || Number(revision.projectVersion) < 0 || creation && revision.projectVersion !== 0) return invalid();
    let historical;
    try { historical = this.store.revisionProjects.historicalState(id, Number(revision.projectVersion)); } catch { return invalid(); }
    if (!isDeepStrictEqual(revision.projectIds, historical.projectIds) || revision.projectId !== (historical.projectIds[0] ?? null)) invalid();
  }
  revisionLifecycle(id: string): RevisionLifecycleSnapshot {
    this.require(id);
    const access = this.describe(id), snapshot = this.store.revisionLifecycle.snapshot(id, this.principal);
    return { ...snapshot, actions: snapshot.actions.map(action => access.capabilities.edit ? action : { ...action, available: false, reason: 'Editing permission is required for lifecycle actions.', targetStatus: null }), access, accessEpoch: this.policies.epoch() };
  }
  revisionReviewers(id: string): RevisionReviewerSnapshot {
    this.require(id);
    const access = this.describe(id), snapshot = this.store.revisionReviewers.snapshot(id, this.principal);
    return { ...snapshot, actions: snapshot.actions.map(action => {
      const permission = revisionReviewerPermission(action.action);
      return access.capabilities[permission] ? action : { ...action, available: false, reason: `${permission === 'edit' ? 'Editing' : 'Interaction'} permission is required for this reviewer action.` };
    }), access, accessEpoch: this.policies.epoch() };
  }
  revisionSubscriptions(id: string, query: { after?: string; limit?: number; expectedSubscriptionVersion?: number; expectedAuthorVersion?: number; expectedReviewerVersion?: number }): RevisionSubscriptionSnapshot {
    this.require(id);
    return { ...this.store.revisionSubscriptions.snapshot(id, this.principal, query), access: this.describe(id), accessEpoch: this.policies.epoch() };
  }
  revisionSubscriptionPerson(id: string, principalId: string): RevisionSubscriptionPerson {
    this.require(id); this.revisionSubscriptionReference(id, principalId, false);
    return { ...this.store.revisionSubscriptions.person(id, principalId), accessEpoch: this.policies.epoch() };
  }
  revisionSubscriptionHistory(id: string, query: { before?: number; limit?: number; expectedSubscriptionVersion?: number }): RevisionSubscriptionHistory {
    this.require(id);
    return { ...this.store.revisionSubscriptions.history(id, query), accessEpoch: this.policies.epoch() };
  }
  revisionMuteHistory(id: string, query: { before?: number; limit?: number; expectedMuteVersion?: number }): RevisionMuteHistory {
    this.require(id);
    return { ...this.store.revisionSubscriptions.muteHistory(id, this.principal, query), accessEpoch: this.policies.epoch() };
  }
  requireRevisionSubscriptionAction(id: string, input: RevisionSubscriptionInput): void {
    this.require(id);
    if (input.action === 'mute' || input.action === 'unmute') {
      if (input.principalId !== this.principal) throw new HttpError(403, 'Mute preferences may only be changed for yourself.', 'ACTION_FORBIDDEN');
    } else if (input.principalId !== this.principal) {
      if (input.action === 'unsubscribe') this.require(id, 'edit');
      else if (!this.policies.access(id, this.principal).edit) this.require(id, 'interact');
    }
  }
  private revisionSubscriptionReference(id: string, principalId: string, active: boolean): { principalId: string; displayName: string } {
    if (!active) {
      const status = this.store.revisionSubscriptions.status(id, principalId);
      if ((status.version > 0 || status.automatic.length > 0) && status.displayName !== null) return { principalId, displayName: status.displayName };
    }
    const resolved = this.principalReference(principalId, active);
    return { principalId: resolved, displayName: resolved === this.principal ? this.context.displayName : this.auth.listAccounts().find(account => account.id === resolved)!.displayName };
  }
  revisionSubscriptionTarget(id: string, input: RevisionSubscriptionInput): { principalId: string; displayName: string } {
    this.requireRevisionSubscriptionAction(id, input);
    if (input.principalId === this.principal) return { principalId: this.principal, displayName: this.context.displayName };
    return this.revisionSubscriptionReference(id, input.principalId, input.action === 'subscribe');
  }
  presentRevisionSubscription(id: string, input: RevisionSubscriptionInput, response: MutationResponse, retryKeySha256: string): MutationResponse {
    this.requireRevisionSubscriptionAction(id, input);
    const invalid = (): never => { throw new HttpError(409, 'This saved following receipt does not match the requested operation.', 'REVISION_SUBSCRIPTION_INVALID_RECEIPT'); };
    const body = record(response.body);
    if (!body || response.status !== 200 || body.revisionId !== id || typeof body.operationId !== 'string') return invalid();
    let operation;
    try {
      if (this.store.revisionSubscriptions.operationRevisionId(body.operationId) !== id) return invalid();
      operation = this.store.revisionSubscriptions.operation(body.operationId);
    } catch { return invalid(); }
    if (operation.revisionId !== id || operation.attribution.principalId !== this.principal
      || operation.retryKeySha256 !== retryKeySha256
      || operation.inputSha256 !== revisionSubscriptionInputHash(input) || !isDeepStrictEqual(operation.input, input)
      || !isDeepStrictEqual(body, operation.receipt)) return invalid();
    return { status: 200, body: { ...operation.receipt, accessEpoch: this.policies.epoch() } };
  }
  revisionMetadata(id: string): RevisionMetadataSnapshot {
    this.require(id);
    return { ...this.store.revisionMetadata.snapshot(id), access: this.describe(id), accessEpoch: this.policies.epoch() };
  }
  revisionMetadataHistory(id: string, query: { before?: number; limit?: number; expectedMetadataVersion?: number }): RevisionMetadataHistory {
    this.require(id);
    return { ...this.store.revisionMetadata.history(id, query), accessEpoch: this.policies.epoch() };
  }
  presentRevisionMetadata(id: string, input: RevisionMetadataInput, response: MutationResponse): MutationResponse {
    this.require(id, 'edit');
    const invalid = (): never => { throw new HttpError(409, 'This saved metadata receipt does not match the requested operation.', 'REVISION_METADATA_INVALID_RECEIPT'); };
    const body = record(response.body);
    if (!body || response.status !== 200 || body.revisionId !== id || typeof body.operationId !== 'string') return invalid();
    let operation;
    try {
      if (this.store.revisionMetadata.operationRevisionId(body.operationId) !== id) return invalid();
      operation = this.store.revisionMetadata.operation(body.operationId);
    } catch { return invalid(); }
    if (operation.revisionId !== id || operation.attribution.principalId !== this.principal
      || operation.inputSha256 !== revisionMetadataInputHash(input) || !isDeepStrictEqual(operation.input, input)
      || !isDeepStrictEqual(body, operation.receipt)) return invalid();
    return { status: 200, body: { ...operation.receipt, accessEpoch: this.policies.epoch() } };
  }
  revisionReviewerHistory(id: string, query: { before?: number; limit?: number; expectedReviewerVersion?: number }): RevisionReviewerHistory {
    this.require(id);
    return { ...this.store.revisionReviewers.history(id, query), accessEpoch: this.policies.epoch() };
  }
  requireRevisionReviewerAction(id: string, input: RevisionReviewerInput): void {
    this.require(id, revisionReviewerPermission(input.action));
  }
  revisionReviewerTarget(id: string, input: RevisionReviewerInput): { principalId: string; displayName: string } | undefined {
    this.requireRevisionReviewerAction(id, input);
    if (!('reviewerId' in input)) return undefined;
    if (input.action === 'remove' || input.action === 'unblock') {
      const member = this.store.revisionReviewers.snapshot(id, this.principal).reviewers.members.find(item => item.principalId === input.reviewerId);
      if (!member) throw new HttpError(400, 'Selected reviewer is unavailable.');
      // Clearing an existing requirement must remain possible after the account
      // is disabled; keep the inspected immutable member identity.
      return { principalId: member.principalId, displayName: member.displayName };
    }
    const principalId = this.principalReference(input.reviewerId);
    return { principalId, displayName: principalId === this.principal ? this.context.displayName : this.auth.listAccounts().find(account => account.id === principalId)!.displayName };
  }
  presentRevisionReviewer(id: string, input: RevisionReviewerInput, response: MutationResponse): MutationResponse {
    this.requireRevisionReviewerAction(id, input);
    const invalid = (): never => { throw new HttpError(409, 'This saved reviewer receipt does not match the requested operation.', 'REVISION_REVIEWER_INVALID_RECEIPT'); };
    const body = record(response.body);
    if (!body || response.status !== 200 || body.revisionId !== id || typeof body.operationId !== 'string') return invalid();
    let operation;
    try {
      if (this.store.revisionReviewers.operationRevisionId(body.operationId) !== id) return invalid();
      operation = this.store.revisionReviewers.operation(body.operationId);
    } catch { return invalid(); }
    if (operation.revisionId !== id || operation.attribution.principalId !== this.principal
      || operation.inputSha256 !== revisionReviewerInputHash(input) || !isDeepStrictEqual(operation.input, input)
      || !isDeepStrictEqual(body, operation.receipt)) return invalid();
    return { status: 200, body: { ...operation.receipt, accessEpoch: this.policies.epoch() } };
  }
  revisionLifecycleHistory(id: string, query: { before?: number; limit?: number; expectedLifecycleVersion?: number }): RevisionLifecycleHistory {
    this.require(id);
    return { ...this.store.revisionLifecycle.history(id, query), accessEpoch: this.policies.epoch() };
  }
  presentRevisionLifecycle(id: string, input: RevisionLifecycleInput, response: MutationResponse): MutationResponse {
    this.require(id, 'edit');
    const invalid = (): never => { throw new HttpError(409, 'This saved lifecycle receipt does not match the requested operation.', 'REVISION_LIFECYCLE_INVALID_RECEIPT'); };
    const body = record(response.body);
    if (!body || response.status !== 200 || body.revisionId !== id || typeof body.operationId !== 'string') return invalid();
    let operation;
    try {
      if (this.store.revisionLifecycle.operationRevisionId(body.operationId) !== id) return invalid();
      operation = this.store.revisionLifecycle.operation(body.operationId);
    } catch { return invalid(); }
    if (operation.revisionId !== id || operation.attribution.principalId !== this.principal
      || operation.inputSha256 !== revisionLifecycleInputHash(input) || !isDeepStrictEqual(operation.input, input)
      || !isDeepStrictEqual(body, operation.receipt)) return invalid();
    return { status: 200, body: { ...operation.receipt, accessEpoch: this.policies.epoch() } };
  }
  revisionAuthorship(id: string): RevisionAuthorshipSnapshot {
    this.require(id);
    return { ...this.store.revisionAuthorship.snapshot(id), access: this.describe(id), accessEpoch: this.policies.epoch() };
  }
  revisionAuthorHistory(id: string, query: { before?: number; limit?: number; expectedAuthorVersion?: number }): RevisionAuthorHistory {
    this.require(id);
    return { ...this.store.revisionAuthorship.history(id, query), accessEpoch: this.policies.epoch() };
  }
  revisionAuthorTarget(id: string, input: RevisionAuthorInput): { principalId: string; displayName: string } {
    this.require(id, 'edit');
    const principalId = input.action === 'commandeer' ? this.principal : input.authorId;
    this.principalReference(principalId);
    return { principalId, displayName: principalId === this.principal ? this.context.displayName : this.auth.listAccounts().find(account => account.id === principalId)!.displayName };
  }
  /** Only a proven original self-handoff may be acknowledged after losing access.
   * Stored source or current revision metadata are never loaded for this path. */
  presentRevisionAuthor(id: string, input: RevisionAuthorInput, response: MutationResponse): MutationResponse {
    const invalid = (): never => { throw new HttpError(409, 'This saved authorship receipt does not match the requested operation.', 'REVISION_AUTHOR_INVALID_RECEIPT'); };
    const body = record(response.body);
    if (!body || response.status !== 200 || body.revisionId !== id || typeof body.operationId !== 'string') return invalid();
    let operation;
    try {
      if (this.store.revisionAuthorship.operationRevisionId(body.operationId) !== id) return invalid();
      operation = this.store.revisionAuthorship.operation(body.operationId);
    } catch { return invalid(); }
    if (operation.revisionId !== id || operation.attribution.principalId !== this.principal
      || operation.inputSha256 !== revisionAuthorInputHash(input) || !isDeepStrictEqual(operation.input, input)
      || !isDeepStrictEqual(body, operation.receipt)) return invalid();
    const capabilities = this.policies.access(id, this.principal);
    if (!capabilities.view || !capabilities.edit) {
      const transaction = operation.receipt.transaction;
      if (input.action !== 'assign' || transaction.previousAuthor?.principalId !== this.principal || transaction.author.principalId === this.principal) this.require(id, 'edit');
      return { status: 200, body: { revisionId: id, operationId: operation.id, inputSha256: operation.inputSha256, saved: true, accessLost: true, accessEpoch: this.policies.epoch() } };
    }
    return { status: 200, body: { ...operation.receipt, accessEpoch: this.policies.epoch() } };
  }
  pastes(query: PasteListQuery): PastePage { return { ...this.store.pastes.list(query, id => this.canView(id)), accessEpoch: this.policies.epoch() }; }
  paste(id: string): PasteDetail { this.require(id); return { ...this.store.pastes.detail(id), access: this.describe(id), accessEpoch: this.policies.epoch() }; }
  files(query: FileListQuery): FilePage { return { ...this.store.files.list(query, id => this.canView(id)), accessEpoch: this.policies.epoch() }; }
  file(id: string): FileDetail {
    this.require(id);
    return { file: this.store.files.get(id), history: { ...this.store.files.history(id, undefined, undefined, objectId => this.canView(objectId)), accessEpoch: this.policies.epoch() }, attachments: { ...this.store.files.attachments(id, {}, objectId => this.canView(objectId)), accessEpoch: this.policies.epoch() }, access: this.describe(id), accessEpoch: this.policies.epoch() };
  }
  citationSource(fileId: unknown): void {
    if (typeof fileId !== 'string' || !/^F[1-9]\d{0,14}$/.test(fileId) || !this.canView(fileId)) throw new HttpError(404, 'Citation source is unavailable.', 'CITATION_SOURCE_UNAVAILABLE');
  }
  citationEvidence(revisionId: string, evidenceId: string): CitationEvidenceRecord {
    this.require(revisionId);
    const evidence = this.store.citationEvidence.get(revisionId, evidenceId);
    this.citationSource(evidence.source.fileId);
    return { ...evidence, accessEpoch: this.policies.epoch() };
  }
  document(id: string): WikiDetail {
    this.require(id);
    const detail = this.store.documentDetail(id);
    return this.redact({ ...detail, hierarchy: this.wikiHierarchy(detail.document.location?.path ?? detail.document.slug), access: this.describe(id), accessEpoch: this.policies.epoch() });
  }
  searchWikiDocuments(query: WikiDocumentSearchQuery): WikiDocumentSearchPage {
    return { ...this.store.searchWikiDocuments(query, id => this.canView(id), this.principal), accessEpoch: this.policies.epoch() };
  }
  searchWikiContent(query: WikiContentSearchQuery): WikiContentSearchPage {
    return { ...this.store.searchWikiContent(query, id => this.canView(id), this.principal), accessEpoch: this.policies.epoch() };
  }
  documentHistory(id: string, options: { before?: number; limit?: number } = {}): WikiHistory {
    this.require(id); return this.redact({ ...this.store.documentHistory(id, options), accessEpoch: this.policies.epoch() });
  }
  documentVersion(id: string, version: number): WikiVersion {
    this.require(id); return this.redact({ ...this.store.documentVersion(id, version), accessEpoch: this.policies.epoch() });
  }
  documentTransactions(id: string, options: { before?: number; limit?: number } = {}): WikiLifecycleHistory {
    this.require(id); return this.redact({ ...this.store.documentTransactions(id, options), accessEpoch: this.policies.epoch() });
  }
  private wikiPath(value: unknown): string {
    if (typeof value !== 'string') throw new HttpError(400, 'Provide a wiki path.');
    try { return canonicalWikiPath(value); } catch { throw new HttpError(400, 'Provide a valid bounded wiki path.'); }
  }
  private wikiReferenceAccess(id: string, edit = false): void {
    if (!this.canView(id)) throw new HttpError(404, 'Wiki path is unavailable.', 'WIKI_PATH_UNAVAILABLE');
    if (edit && !this.policies.access(id, this.principal).edit) throw new HttpError(403, 'Editing this wiki destination requires edit access.', 'WIKI_DESTINATION_FORBIDDEN');
  }
  private wikiHierarchy(value: string, after?: string, limit?: number): WikiHierarchy {
    const path = this.wikiPath(value);
    const document = this.store.documentAtPath(path);
    if (document) this.wikiReferenceAccess(document.id);
    const ancestors = wikiAncestors(path).map(ancestor => {
      const item = this.store.documentAtPath(ancestor);
      if (item) this.wikiReferenceAccess(item.id);
      return { path: ancestor, document: item ? wikiReference(item) : null };
    });
    const movedId = document?.location?.movedToId;
    const movedTo = movedId && this.canView(movedId) ? wikiReference(this.store.documentDetail(movedId).document) : null;
    return { ancestors, children: this.store.documentChildren(path, id => this.canView(id), after, limit), movedTo };
  }
  private wikiCreationDestination(value: unknown): { path: string; parent: WikiDocument | null } {
    const path = this.wikiPath(value);
    let parent: WikiDocument | null = null;
    for (const ancestorPath of wikiAncestors(path)) {
      const ancestor = this.store.documentAtPath(ancestorPath);
      if (!ancestor) throw new HttpError(409, `Create the parent document at ${ancestorPath} before using this path.`, 'WIKI_ANCESTOR_MISSING');
      this.wikiReferenceAccess(ancestor.id);
      parent = ancestor;
    }
    if (parent) this.wikiReferenceAccess(parent.id, true);
    return { path, parent };
  }
  wikiPathResult(value: string, after?: string, limit?: number): WikiPathResult {
    const path = this.wikiPath(value); const hierarchy = this.wikiHierarchy(path, after, limit);
    const document = this.store.documentAtPath(path);
    let canCreate = !document && path.length <= WIKI_WRITE_PATH_MAX_LENGTH && this.context.scopes.includes('write');
    let creationBlockedReason: string | null = document ? 'A document already occupies this path.' : path.length > WIKI_WRITE_PATH_MAX_LENGTH ? 'New wiki paths must be at most 128 characters.' : canCreate ? null : 'This credential cannot create documents.';
    let defaultAccess: WikiPathResult['defaultAccess'] = null;
    try {
      const { parent } = this.wikiCreationDestination(path);
      const policy = parent ? this.policies.policy(parent.id, this.principal) : null;
      if (policy?.kind === 'project') throw new Error('Wiki parent must have document policy rules.');
      const spaceId = policy?.spaceId ?? 'S1';
      const space = this.policies.getSpace(spaceId, this.principal);
      if (space.archived) { canCreate = false; creationBlockedReason = 'The inherited Space is archived.'; }
      defaultAccess = { spaceId, ...(policy?.rules ?? { view: { kind: 'workspace' as const }, edit: { kind: 'workspace' as const }, interact: { kind: 'workspace' as const } }) };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      canCreate = false; creationBlockedReason = error.status === 404 ? 'The parent path is unavailable.' : error.message;
    }
    return { path, document: document ? wikiReference(document) : null, hierarchy, canCreate, creationBlockedReason, defaultAccess, accessEpoch: this.policies.epoch() };
  }
  wikiMovePreview(id: string, value: string): WikiMovePreview {
    this.require(id, 'edit');
    const source = this.store.documentDetail(id).document;
    if (source.location?.status !== 'active') throw new HttpError(409, 'Only an active document can be moved.', 'WIKI_SOURCE_INACTIVE');
    const { path, parent } = this.wikiCreationDestination(value);
    const destination = this.store.documentAtPath(path);
    if (destination) this.wikiReferenceAccess(destination.id, true);
    if (!destination && path.length > WIKI_WRITE_PATH_MAX_LENGTH) throw new HttpError(400, 'New wiki paths must be at most 128 characters.');
    if (path === source.location.path || destination?.location?.status === 'active') throw new HttpError(409, 'The destination already contains an active document.', 'WIKI_DESTINATION_OCCUPIED');
    const destinationSpaceId = destination ? this.policies.policy(destination.id, this.principal).spaceId : parent ? this.policies.policy(parent.id, this.principal).spaceId : 'S1';
    const space = this.policies.getSpace(destinationSpaceId, this.principal);
    if (!destination && space.archived) throw new HttpError(409, 'The destination Space is archived.');
    const sourceVersionId = this.store.documentVersion(id, source.version).id;
    const expectedAccessEpoch = this.policies.epoch();
    return { source: wikiReference(source), sourceVersionId, destination: destination ? wikiReference(destination) : null, destinationPath: path, destinationSpaceId, expectedAccessEpoch,
      defaultInput: { destinationPath: path, expectedVersion: source.version, expectedSourceVersionId: sourceVersionId, expectedDestinationId: destination?.id ?? null, expectedDestinationVersion: destination?.version ?? 0, expectedAccessEpoch,
        ...(source.publication ? { expectedPublicationRevision: source.publication.revision, expectedPublishedVersionId: source.publication.publishedVersionId } : {}),
        ...(destination?.publication ? { expectedDestinationPublicationRevision: destination.publication.revision, expectedDestinationPublishedVersionId: destination.publication.publishedVersionId } : {}), message: '' } };
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
      let hideWikiMoveDigest = false;
      if ((object.kind === 'move_to' || object.kind === 'move_away') && typeof object.inputSha256 === 'string') {
        try {
          const number = record(record(object.after)?.publication)?.headVersion;
          if (typeof object.documentId !== 'string' || typeof number !== 'number') throw new Error('Invalid move reference.');
          const move = this.store.documentVersion(object.documentId, number).move;
          hideWikiMoveDigest = !move || !this.canView(move.sourceId) || !this.canView(move.destinationId);
        } catch { hideWikiMoveDigest = true; }
      }
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
        key === 'inputSha256' && hideWikiMoveDigest ? null
          : key === 'movedToId' && typeof child === 'string' && !this.canView(child) ? null
          : key === 'move' && record(child) && typeof record(child)!.sourceId === 'string' && typeof record(child)!.destinationId === 'string' && (!this.canView(record(child)!.sourceId as string) || !this.canView(record(child)!.destinationId as string)) ? undefined
          : key === 'projectIds' && Array.isArray(child) ? child.filter(id => typeof id === 'string' && this.canView(id))
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
    const policy = /^\/api\/policies\/((?:PROJ|PA|R|T|W|F|[DPL])\d+)$/.exec(path);
    if (policy) return { id: policy[1]!, capability: method === 'GET' ? 'view' : 'edit' };
    const space = /^\/api\/spaces\/(S\d+)$/.exec(path);
    if (space) return { id: space[1]!, capability: method === 'GET' ? 'view' : 'edit' };
    const object = /^\/api\/(?:projects|repositories|tasks|documents|revisions|files|pastes)\/((?:PROJ|PA|R|T|W|F|[DPL])\d+)(?:\/(.*))?$/.exec(path);
    if (!object) return null;
    const discussionReply = method === 'POST' && /^threads\/[^/]+\/replies$/.test(object[2] ?? '');
    const citationEvidence = method === 'POST' && /^citation-evidence(?:\/[^/]+\/retract)?$/.test(object[2] ?? '');
    const personalDiscussion = method === 'PATCH' && /^threads\/[^/]+\/preference$/.test(object[2] ?? '');
    const selfProject = object[1]!.startsWith('PROJ') && ['membership', 'watchers', 'silence'].includes(object[2] ?? '');
    const boardMove = method === 'POST' && object[1]!.startsWith('PROJ') && ['workboard/moves', 'workboard/bulk-moves'].includes(object[2] ?? '');
    return { id: object[1]!, capability: method === 'GET' || object[2] === 'subscriptions' || selfProject || boardMove || personalDiscussion ? 'view' : discussionReply || citationEvidence || ['comments', 'reviews'].includes(object[2] ?? '') ? 'interact' : 'edit' };
  }
  authorize(method: string, path: string, input: unknown): void {
    const target = this.target(method, path);
    if (target) this.require(target.id, target.capability);
    if (method === 'POST' && /^\/api\/revisions\/[DPL][1-9]\d{0,14}\/dependencies$/.test(path)) {
      const change = parseRevisionDependencyInput(input);
      for (const id of [...change.add, ...change.remove]) if (!this.canView(id)) throw new HttpError(404, 'Revision reference is unavailable.', 'REVISION_DEPENDENCY_UNAVAILABLE');
    }
    if (method === 'POST' && path === '/api/documents') this.wikiCreationDestination(record(input)?.slug ?? record(input)?.title);
    if (method === 'POST' && /^\/api\/documents\/W\d+\/move$/.test(path)) {
      const data = parseWikiMoveInput(input);
      this.wikiCreationDestination(data.destinationPath);
      const destination = this.store.documentAtPath(data.destinationPath);
      if (destination) this.wikiReferenceAccess(destination.id, true);
      if (data.expectedDestinationId) this.wikiReferenceAccess(data.expectedDestinationId, true);
      // Identity/head/epoch equality is checked only for fresh writes. Saved
      // retries must remain recoverable after later content changes.
    }
    const docxImport = method === 'POST' && (path === '/api/revisions/docx' || /^\/api\/revisions\/[DPL]\d+\/docx\/import$/.test(path));
    if (docxImport) {
      const data = path === '/api/revisions/docx' ? parseDocxImportInput(input) : parseDocxReimportInput(input);
      if (!this.canView(data.sourceFile.fileId)) throw new HttpError(404, 'The original Word File is unavailable.', 'DOCX_SOURCE_UNAVAILABLE');
      // Reading a File may be sufficient to review it privately. Widening its
      // audience is always explicit and requires the File editor's authority.
      if (data.shareSource) this.require(data.sourceFile.fileId, 'edit');
    }
    if (method === 'POST' && /^\/api\/revisions\/[DPL]\d+\/docx\/replace$/.test(path)) parseDocxReplaceInput(input);
    const citation = method === 'POST' ? /^\/api\/revisions\/([DPL]\d+)\/citation-evidence(?:\/([^/]+)\/retract)?$/.exec(path) : null;
    if (citation) {
      if (citation[2]) {
        const evidence = this.citationEvidence(citation[1]!, citation[2]);
        if (evidence.attribution.principalId !== this.principal && !this.policies.access(citation[1]!, this.principal).edit) throw new HttpError(403, 'Only the original reviewer or a manuscript editor can retract this record.', 'CITATION_RETRACTION_FORBIDDEN');
      } else this.citationSource(parseCitationEvidenceInput(input).source.fileId);
    }
    if (method === 'POST' && /^\/api\/files\/F\d+\/attachments$/.test(path)) {
      const data = object(input, ['objectId', 'mode', 'expectedVersion', 'expectedAccessEpoch']);
      if (typeof data.objectId !== 'string' || !/^(?:PROJ|PA|R|T|W|[DPL])[1-9]\d{0,14}$/.test(data.objectId)) throw new HttpError(400, 'Choose an available object to attach.');
      this.require(data.objectId, 'edit');
      if (data.mode === 'attach') integer(data.expectedAccessEpoch, 'expectedAccessEpoch');
    }
    const assetWrite = method === 'POST' && (path === '/api/revisions' || /^\/api\/revisions\/[DPL]\d+\/versions$/.test(path));
    const assetData = assetWrite ? record(input) : null;
    if (assetData?.assets !== undefined) {
      if (!Array.isArray(assetData.assets) || assetData.assets.length > 100) throw new HttpError(400, 'Choose at most 100 versioned figures.');
      integer(assetData.expectedAccessEpoch, 'expectedAccessEpoch');
      const original = target ? this.store.detail(target.id).versions.find(version => version.number === assetData.expectedVersion) : undefined;
      const originalFiles = new Set(original?.assets?.map(asset => asset.fileId));
      for (const asset of assetData.assets) {
        const fileId = record(asset)?.fileId;
        if (typeof fileId !== 'string' || !/^F[1-9]\d{0,14}$/.test(fileId)) throw new HttpError(400, 'Choose an available File.');
        this.require(fileId);
        if (!originalFiles.has(fileId)) this.require(fileId, 'edit');
        // An existing direct grant needs no audience expansion. New grants
        // require the file editor's authority before any idempotent replay.
        if (!target || this.store.files.attachment(fileId, target.id)?.mode !== 'attach') {
          this.require(fileId, 'edit');
          if (assetData.shareAssets !== true) throw new HttpError(400, 'Explicitly share figures with the revision audience.');
        }
      }
    }
    const preference = method === 'PATCH' ? /^\/api\/revisions\/([DPL]\d+)\/threads\/([^/]+)\/preference$/.exec(path) : null;
    if (preference) {
      threadPreferenceInput(input);
      // Child identity and current view are checked even for saved retries;
      // the preference's optimistic version is checked only on fresh writes.
      this.store.threadPreference(preference[1]!, preference[2]!, this.principal);
    }
    if (method === 'POST' && /^\/api\/repositories\/R\d+\/import-revision$/.test(path)) this.references(gitImportInput(input));
    // The target's central policy already requires continuing repository view.
    // Pins are validated here, but their current-head match belongs after replay.
    if (method === 'POST' && /^\/api\/revisions\/[DPL]\d+\/import-git$/.test(path)) gitVersionImportInput(input);
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
    if (method === 'POST' && (path === '/api/revisions' || path === '/api/revisions/docx' || /^\/api\/repositories\/R\d+\/import-revision$/.test(path)) && record(input)?.projectIds !== undefined) this.revisionProjectReferences(record(input)!.projectIds);
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
      const wikiParent = path === '/api/documents' ? this.wikiCreationDestination(data?.slug ?? data?.title).parent : null;
      const id = access?.spaceId ?? (wikiParent ? this.policies.policy(wikiParent.id, this.principal).spaceId : parentId ? this.policies.policy(parentId, this.principal).spaceId : 'S1');
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
  present(method: string, path: string, response: MutationResponse, freshTaskOwnershipChange = false, freshProjectChange = false, mutationInput?: unknown): MutationResponse {
    let target = this.target(method, path);
    const body = record(response.body);
    const gitImport = method === 'POST' ? /^\/api\/repositories\/(R\d+)\/import-revision$/.exec(path) : null;
    if (method === 'POST' && (CREATES.has(path) || path === '/api/spaces' || gitImport)) {
      const id = body?.id ?? record(body?.revision)?.id;
      if (typeof id !== 'string') throw new HttpError(409, 'This saved response cannot be safely replayed.');
      if (gitImport) {
        if (!/^[DPL][1-9]\d*$/.test(id) || record(body?.revision)?.repositoryId !== gitImport[1]) throw new HttpError(409, 'This saved import cannot be safely replayed.');
        // This child denial must not invalidate the still-visible source repository.
        if (!this.canView(id)) throw new HttpError(404, 'Imported revision was not found.', 'REVISION_REFERENCE_UNAVAILABLE');
      }
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
    const revisionSnapshot = record(body?.revision);
    if (revisionSnapshot && target) this.verifyRevisionProjectSnapshot(revisionSnapshot, target.id, method === 'POST' && (path === '/api/revisions' || path === '/api/revisions/docx' || Boolean(gitImport)), mutationInput);
    const dependencies = method === 'POST' ? /^\/api\/revisions\/([DPL][1-9]\d{0,14})\/dependencies$/.exec(path) : null;
    if (dependencies) {
      this.authorize(method, path, mutationInput);
      const input = parseRevisionDependencyInput(mutationInput);
      const invalid = (): never => { throw new HttpError(409, 'This saved dependency receipt does not match the requested operation.', 'REVISION_DEPENDENCY_INVALID_RECEIPT'); };
      if (!body || response.status !== 200 || typeof body.operationId !== 'string' || body.revisionId !== dependencies[1]) return invalid();
      let operation;
      try {
        if (this.store.revisionDependencies.receiptRevisionId(body.operationId) !== dependencies[1]) return invalid();
        operation = this.store.revisionDependencies.receipt(body.operationId);
      } catch { return invalid(); }
      const { accessEpoch: _epoch, ...saved } = body;
      if (operation.revisionId !== dependencies[1] || operation.attribution.principalId !== this.principal
        || operation.inputSha256 !== revisionDependencyInputHash(input) || !isDeepStrictEqual(operation.input, input)
        || !isDeepStrictEqual(saved, operation.receipt)) return invalid();
      return { status: 200, body: { ...operation.receipt, accessEpoch: this.policies.epoch() } };
    }
    const wikiLifecycle = method === 'POST' ? /^\/api\/documents\/W\d+\/(drafts|publish|delete)$/.exec(path) : null;
    if (wikiLifecycle) {
      const invalid = (): never => { throw new HttpError(409, 'This saved wiki lifecycle receipt does not match the requested operation.', 'WIKI_RECEIPT_MISMATCH'); };
      const kind = wikiLifecycle[1] === 'drafts' ? 'draft' : wikiLifecycle[1] === 'publish' ? 'publish' : 'delete';
      const input = kind === 'draft' ? parseWikiDraftInput(mutationInput) : kind === 'publish' ? parseWikiPublishInput(mutationInput) : parseWikiDeleteInput(mutationInput);
      const transaction = record(body?.transaction);
      if (!target || !body || typeof transaction?.id !== 'string') return invalid();
      let expected: WikiLifecycleReceipt;
      try { expected = this.store.wikiLifecycleReceipt(target.id, transaction.id); } catch { return invalid(); }
      const { accessEpoch: _epoch, ...saved } = body;
      if (!isDeepStrictEqual(saved, expected) || expected.transaction.kind !== kind
        || expected.transaction.attribution?.principalId !== this.principal
        || expected.transaction.inputSha256 !== wikiLifecycleInputHash(kind, input)
        || expected.transaction.before?.publication.revision !== input.expectedPublicationRevision
        || expected.transaction.before.publication.headVersion !== input.expectedVersion
        || expected.transaction.before.publication.headVersionId !== input.expectedHeadVersionId
        || expected.transaction.before.publication.publishedVersionId !== input.expectedPublishedVersionId) return invalid();
      return { status: response.status, body: this.redact({ ...expected, accessEpoch: this.policies.epoch() }) };
    }
    const wikiWrite = method === 'POST' && path === '/api/documents' ? 'create'
      : method === 'PUT' && /^\/api\/documents\/W\d+$/.test(path) ? 'edit'
        : method === 'POST' && /^\/api\/documents\/W\d+\/restore$/.test(path) ? 'restore' : null;
    if (wikiWrite && target && body) {
      const invalid = (): never => { throw new HttpError(409, 'This saved wiki content receipt does not match the requested operation.', 'WIKI_RECEIPT_MISMATCH'); };
      const publication = record(body.publication);
      if (publication) {
        if (typeof publication.revision !== 'number') return invalid();
        let expected: WikiLifecycleReceipt;
        try {
          const transaction = this.store.documentTransaction(target.id, publication.revision);
          expected = this.store.wikiLifecycleReceipt(target.id, transaction.id);
        } catch { return invalid(); }
        const { accessEpoch: _epoch, ...saved } = body;
        const input = wikiWrite === 'create' ? this.creationInput(mutationInput).content
          : wikiWrite === 'edit' ? parseWikiEditInput(mutationInput) : parseWikiRestoreInput(mutationInput);
        if (!isDeepStrictEqual(saved, expected.document) || expected.transaction.attribution?.principalId !== this.principal
          || !(expected.transaction.kind === wikiWrite || wikiWrite === 'edit' && expected.transaction.kind === 'draft')
          || expected.transaction.inputSha256 !== wikiLifecycleInputHash(wikiWrite, input)) return invalid();
        return { status: response.status, body: this.redact({ ...expected.document, accessEpoch: this.policies.epoch() }) };
      }
      // Preserve pre-publication receipts without letting a new receipt strip
      // its publication evidence and fall back to the legacy presentation path.
      if (typeof body.version !== 'number') return invalid();
      let version: WikiVersion;
      try { version = this.store.documentVersion(target.id, body.version); } catch { return invalid(); }
      if (this.store.database.prepare("SELECT 1 FROM wiki_transactions WHERE document_id=? AND json_extract(data,'$.newVersionId')=? AND json_extract(data,'$.kind')<>'legacy'").get(target.id, version.id)) return invalid();
      const current = this.store.documentDetail(target.id).document;
      const canonical = { id: target.id, title: version.title, slug: version.slug, content: version.content, version: version.number,
        createdAt: current.createdAt, updatedAt: version.createdAt, ...(version.location ? { location: version.location } : {}) };
      const { accessEpoch: _epoch, ...saved } = body;
      const input = record(wikiWrite === 'create' ? this.creationInput(mutationInput).content : mutationInput);
      if (!isDeepStrictEqual(saved, canonical) || !input
        || (version.attribution && version.attribution.principalId !== this.principal)
        || (wikiWrite === 'create' ? version.number !== 1 : typeof input.expectedVersion !== 'number' || version.number !== input.expectedVersion + 1)
        || (wikiWrite === 'restore' && version.restoredFrom !== input.version)
        || (wikiWrite !== 'restore' && (typeof input.title !== 'string' || version.title !== input.title || version.content !== input.content))) return invalid();
    }
    if (method === 'POST' && /^\/api\/documents\/W\d+\/move$/.test(path)) {
      const invalid = (): never => { throw new HttpError(409, 'This saved wiki move receipt does not match the requested operation.', 'WIKI_RECEIPT_MISMATCH'); };
      const input = parseWikiMoveInput(mutationInput);
      if (!target || !body || typeof body.sourceVersionId !== 'string' || typeof body.destinationVersionId !== 'string') return invalid();
      let expected: WikiMoveReceipt;
      try { expected = this.store.wikiMoveReceipt(target.id, body.sourceVersionId, body.destinationVersionId); } catch { return invalid(); }
      const { accessEpoch: _epoch, ...saved } = body;
      if (!isDeepStrictEqual(saved, expected) || expected.source.version !== input.expectedVersion + 1
        || expected.destination.version !== input.expectedDestinationVersion + 1
        || (input.expectedDestinationId !== null && input.expectedDestinationId !== expected.destination.id)
        || expected.destination.location?.path !== input.destinationPath) return invalid();
      const previous = this.store.documentVersion(target.id, input.expectedVersion);
      const result = this.store.documentVersion(target.id, expected.source.version);
      const destination = this.store.documentVersion(expected.destination.id, expected.destination.version);
      if (previous.id !== input.expectedSourceVersionId || result.attribution?.principalId !== this.principal || destination.attribution?.principalId !== this.principal
        || result.move?.inputSha256 !== wikiMoveInputHash(input) || destination.move?.inputSha256 !== wikiMoveInputHash(input)) return invalid();
      this.wikiReferenceAccess(expected.destination.id, true);
      return { status: response.status, body: { ...expected, accessEpoch: this.policies.epoch() } };
    }
    if (method === 'POST' && (path === '/api/revisions/docx' || /^\/api\/revisions\/[DPL]\d+\/docx\/(?:import|replace)$/.test(path))) {
      const invalid = (): never => { throw new HttpError(409, 'This saved Word receipt does not match the original operation.', 'DOCX_RECEIPT_MISMATCH'); };
      if (!target || !body || !record(body.revision) || !Array.isArray(body.versions)) return invalid();
      const detail = body as unknown as RevisionDetail;
      if (detail.revision.id !== target.id || detail.revision.kind !== 'document') return invalid();
      const current = this.store.detail(target.id);
      for (const version of detail.versions) {
        const stored = current.versions.find(item => item.id === version.id);
        if (!stored || !isDeepStrictEqual(version, stored)) return invalid();
      }
      const result = detail.versions.find(item => item.number === detail.revision.currentVersion);
      if (!result?.docx) return invalid();
      if (path === '/api/revisions/docx') {
        const input = parseDocxImportInput(mutationInput);
        if (result.number !== 1 || result.attribution?.principalId !== this.principal || !isDeepStrictEqual(result.docx.sourceFile, input.sourceFile)
          || detail.revision.title !== input.title || detail.revision.summary !== (input.summary ?? '')
          || result.docxOperation?.kind !== 'import' || result.docxOperation.inputSha256 !== docxOperationHash(input)) return invalid();
      } else {
        const replacing = path.endsWith('/replace');
        const input = replacing ? parseDocxReplaceInput(mutationInput) : parseDocxReimportInput(mutationInput);
        const original = detail.versions.find(item => item.id === input.expectedVersionId);
        if (!original?.docx || original.number !== input.expectedVersion || original.contentHash !== input.expectedContentHash) return invalid();
        const unchanged = replacing && 'quote' in input && input.quote === input.replacement;
        if (result.number !== input.expectedVersion + (unchanged ? 0 : 1)) return invalid();
        if (unchanged ? result.id !== original.id : result.attribution?.principalId !== this.principal || result.message !== input.message) return invalid();
        if (!unchanged && (result.docxOperation?.kind !== (replacing ? 'replace' : 'reimport') || result.docxOperation.inputSha256 !== docxOperationHash(input))) return invalid();
        if (!isDeepStrictEqual(result.docx.sourceFile, 'sourceFile' in input ? input.sourceFile : original.docx.sourceFile)) return invalid();
        if ('rangeId' in input) {
          const range = original.docx.projection.editableRanges.find(item => item.id === input.rangeId);
          if (!range || range.text.slice(input.start, input.end) !== input.quote) return invalid();
        }
      }
      // Package evidence is immutable; only authorization is refreshed on replay.
    }
    if (/^\/api\/pastes(?:\/PA[1-9]\d{0,14}(?:\/comments)?)?$/.test(path)) {
      const invalid = () => new HttpError(409, 'This saved Paste receipt does not match the original request.');
      if (!target || !body) throw invalid();
      const { accessEpoch: _epoch, ...saved } = body;
      if (path.endsWith('/comments')) {
        const input = parsePasteCommentInput(mutationInput);
        if (typeof body.id !== 'string' || body.pasteId !== target.id) throw invalid();
        const expected = this.store.pastes.transaction(target.id, body.id);
        if (!isDeepStrictEqual(saved, expected) || expected.kind !== 'comment' || expected.contentVersion !== input.contentVersion
          || expected.comment !== input.body || expected.attribution.principalId !== this.principal) throw invalid();
      } else {
        if (body.id !== target.id || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) throw invalid();
        const expected = this.store.pastes.snapshot(target.id, body.version);
        if (!isDeepStrictEqual(saved, expected)) throw invalid();
        const input = method === 'POST' ? parseCreatePasteInput(this.creationInput(mutationInput).content) : parseUpdatePasteInput(mutationInput);
        if (method === 'POST' && (expected.authorId !== this.principal || expected.version !== 1 || expected.contentVersion !== 1)) throw invalid();
        if ('expectedVersion' in input) {
          const previous = this.store.pastes.snapshot(target.id, input.expectedVersion);
          const previousContent = this.store.pastes.version(target.id, previous.contentVersion);
          if (previous.contentHash !== previousContent.sha256 || previous.bytes !== previousContent.bytes || previous.lineCount !== previousContent.lineCount) throw invalid();
          const source = input.content ?? previousContent.content;
          const checked = validatePasteContent(source);
          const contentHash = createHash('sha256').update(source, 'utf8').digest('hex');
          const contentChanged = source !== previousContent.content;
          const changes = (['title', 'language', 'status'] as const).flatMap(field => input[field] !== undefined && input[field] !== previous[field] ? [{ field, oldValue: previous[field], newValue: input[field]! }] : []);
          const changed = contentChanged || changes.length > 0;
          // Reconstruct the whole requested transition. Checking only supplied
          // fields would accept an unrelated canonical edit which also changed
          // an omitted language, status, title, or source snapshot.
          const projected = {
            ...previous,
            title: input.title ?? previous.title,
            language: input.language === undefined ? previous.language : input.language,
            status: input.status ?? previous.status,
            version: previous.version + (changed ? 1 : 0),
            contentVersion: previous.contentVersion + (contentChanged ? 1 : 0),
            contentHash, bytes: checked.bytes, lineCount: checked.lineCount,
            updatedAt: changed ? expected.updatedAt : previous.updatedAt,
          };
          if (!isDeepStrictEqual(expected, projected)) throw invalid();
          if (changed) {
            const transition = this.store.pastes.transition(target.id, projected.version);
            const contentChange = contentChanged ? { from: previous.contentVersion, to: projected.contentVersion, fromHash: previous.contentHash, toHash: projected.contentHash } : undefined;
            if (!transition || transition.kind !== 'edit' || transition.pasteId !== target.id || transition.pasteVersion !== projected.version
              || transition.contentVersion !== projected.contentVersion || transition.contentHash !== projected.contentHash || transition.attribution.principalId !== this.principal
              || !isDeepStrictEqual(transition.changes ?? [], changes) || !isDeepStrictEqual(transition.contentChange, contentChange)) throw invalid();
            if (contentChanged && this.store.pastes.version(target.id, projected.contentVersion).content !== source) throw invalid();
          }
        } else {
          for (const field of ['title', 'language'] as const) if (input[field] !== expected[field]) throw invalid();
          if (createHash('sha256').update(input.content, 'utf8').digest('hex') !== expected.contentHash) throw invalid();
        }
      }
      // A historical receipt stays historical. Obtain current metadata and CAS
      // versions with a fresh read; refresh only authorization evidence here.
      return { status: response.status, body: { ...body, accessEpoch: this.policies.epoch() } };
    }
    if (/^\/api\/revisions\/[DPL]\d+\/citation-evidence(?:\/[^/]+\/retract)?$/.test(path)) {
      const source = record(body?.source);
      if (!target || !body || body.revisionId !== target.id || typeof body.id !== 'string' || typeof source?.fileId !== 'string') throw new HttpError(409, 'This saved citation record cannot be safely replayed.');
      const stored = this.citationEvidence(target.id, body.id);
      const { accessEpoch: _storedEpoch, ...current } = stored;
      const { accessEpoch: _savedEpoch, ...saved } = body;
      const expected = body.state === 'active' ? { ...current, state: 'active', recordVersion: 1 } : current;
      if (body.state === 'active') delete expected.retraction;
      if (!isDeepStrictEqual(saved, expected)) throw new HttpError(409, 'This saved citation record has inconsistent evidence.');
      const child = /^\/api\/revisions\/[DPL]\d+\/citation-evidence\/([^/]+)\/retract$/.exec(path);
      const mismatch = () => new HttpError(409, 'This saved citation record does not match the original request.');
      if (child) {
        const input = record(mutationInput), retraction = record(body.retraction);
        if (body.id !== child[1] || body.state !== 'retracted' || body.recordVersion !== Number(input?.expectedRecordVersion) + 1
          || typeof input?.reason !== 'string' || retraction?.reason !== input.reason.trim() || record(retraction.attribution)?.principalId !== this.principal) throw mismatch();
      } else {
        const input = parseCitationEvidenceInput(mutationInput);
        if (body.state !== 'active' || body.recordVersion !== 1 || body.versionId !== input.versionId || body.contentHash !== input.contentHash || record(body.target)?.id !== input.targetId
          || !isDeepStrictEqual(body.source, input.source) || body.verdict !== input.verdict || body.quote !== input.quote || body.locator !== input.locator || body.note !== input.note
          || record(body.attribution)?.principalId !== this.principal) throw mismatch();
      }
      // Keep the original receipt, including its historical state; only current
      // authority and the permission epoch are refreshed on an exact retry.
      return { status: response.status, body: { ...body, accessEpoch: this.policies.epoch() } };
    }
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
