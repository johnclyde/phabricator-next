import type { EffectiveAccess, NewObjectAccessInput, ObjectAccess, Space } from './policy';
import type { PublicAccount } from './auth';
import type { Project } from './projects';
import type { TaskColumnMove } from './workboards';
import type { GitSourceProvenance } from './repositories';
import type { FileRecord, RevisionAsset } from './files';
import type { PasteRecord } from './pastes';
import type { DocxSource } from './docx';
import type { WikiHierarchy, WikiLocation, WikiMoveProvenance, WikiPublication, WikiLifecycleHistory, WikiLifecyclePins } from './wiki';
export type { WikiPublication, WikiLifecyclePins, WikiDraftInput, WikiPublishInput, WikiDeleteInput, WikiLifecycleKind, WikiLifecycleSnapshot, WikiLifecycleTransaction, WikiLifecycleHistory, WikiLifecycleReceipt, WikiStatus, WikiLocation, WikiReference, WikiAncestor, WikiChildren, WikiHierarchy, WikiPathResult, WikiMoveInput, WikiMovePreview, WikiMoveReceipt, WikiMoveProvenance } from './wiki';
export type { FileRecord, RevisionAsset } from './files';
export { WORKBOARD_BULK_MOVE_LIMIT } from './workboards';
export type { WorkboardBulkMoveQuery, WorkboardBulkMoveTask, WorkboardBulkMovePreview, BulkMoveWorkboardCardsInput, WorkboardBulkMoveReceipt } from './workboards';
export type { Workboard, WorkboardColumn, WorkboardColumnSnapshot, WorkboardCard, WorkboardCardPage, WorkboardColumnView, WorkboardFilter, WorkboardQuery, WorkboardCardsQuery, WorkboardDetail, WorkboardReceipt, ConfigureWorkboardInput, CreateWorkboardColumnInput, UpdateWorkboardColumnInput, WorkboardColumnPosition, ReorderWorkboardColumnInput, WorkboardCardPosition, MoveWorkboardCardInput, WorkboardImportColumn, WorkboardImportPreview, ImportWorkboardColumnsInput, TaskColumnMove, WorkboardFieldChange, WorkboardTransaction, WorkboardHistory } from './workboards';
export type { Project, ProjectKind, ProjectMembershipMode, ProjectMembershipStatus, ProjectReference, ProjectHierarchy, ProjectChildPreview, ProjectSnapshot, ProjectField, ProjectFieldChange, ProjectStatus, ProjectIcon, ProjectColorKey, ProjectRelation, ProjectRelationStatus, ProjectPreferences, ProjectTransaction, ProjectHistory, ProjectMembersPage, ProjectWatchersPage, ProjectDetail, ProjectAccessLostAcknowledgement, ProjectLegacyAcknowledgement, ProjectUpdateResult, ProjectInput, UpdateProjectInput, ProjectMembersInput, ProjectMembershipInput, ProjectWatcherInput, ProjectSilenceInput } from './projects';

export type RevisionKind = 'code' | 'paper' | 'document';
export type RevisionStatus = 'draft' | 'needs_review' | 'changes_requested' | 'accepted' | 'closed';
export type TaskStatus = 'open' | 'in_progress' | 'resolved' | 'duplicate';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export interface ActorAttribution { principalId: string; displayName: string; credentialId: string | null; requestId: string }
export interface SourceFile { path: string; content: string }
export interface Repository { id: string; name: string; remoteUrl: string; description: string; defaultBranch: string }
export interface Task { id: string; title: string; description: string; status: TaskStatus; priority: Priority; projectIds: string[]; ownerId: string | null; authorId: string | null; version: number; createdAt: string; updatedAt: string }
export type TaskSnapshot = Omit<Task, 'ownerId' | 'authorId' | 'projectIds'> & Partial<Pick<Task, 'ownerId' | 'authorId' | 'projectIds'>> & { projectId?: string | null };
export type TaskField = 'title' | 'description' | 'status' | 'priority' | 'projectId' | 'ownerId';
export interface TaskFieldChange { field: TaskField; oldValue: string | null; newValue: string | null; oldValueHidden?: boolean; newValueHidden?: boolean }
export type TaskSubscriptionState = 'subscribed' | 'unsubscribed';
export interface TaskSubscriptionStatus { taskId: string; principalId: string; state: TaskSubscriptionState | null; version: number; automatic: boolean; subscribed: boolean; updatedAt: string | null; accessEpoch?: number }
export interface TaskSubscriptionPage { subscribers: TaskSubscriptionStatus[]; nextAfter: string | null; viewer: TaskSubscriptionStatus; accessEpoch?: number }
export interface TaskSubscriptionInput { principalId: string; action: 'subscribe' | 'unsubscribe'; expectedMembershipVersion: number }
export interface TaskTransaction { attribution?: ActorAttribution; id: string; taskId: string; sequence: number; taskVersion: number; kind: 'create' | 'legacy' | 'edit' | 'comment' | 'dependency' | 'dependency_status' | 'subscription' | 'merge' | 'project' | 'column'; actor: string | null; createdAt: string; snapshot?: TaskSnapshot; changes?: TaskFieldChange[]; comment?: string; dependency?: { taskId: string; action: 'added' | 'removed'; direction: 'depends_on' | 'blocks' }; dependencyStatus?: { taskId: string; oldStatus: TaskStatus; newStatus: TaskStatus }; subscription?: { principalId: string; oldState: TaskSubscriptionState | null; newState: TaskSubscriptionState; membershipVersion: number; reason: 'explicit' | 'created' | 'commented' | 'former_owner' | 'merged' }; merge?: { taskId: string; direction: 'merged_into' | 'merged_from'; operationId: string }; project?: { projectId: string; action: 'added' | 'removed'; operationId: string }; column?: TaskColumnMove }
export interface TaskAccessLostAcknowledgement { id: string; saved: true; accessLost: true; accessEpoch: number }
export type TaskUpdateResult = Task | TaskAccessLostAcknowledgement;
export interface TaskHistory { transactions: TaskTransaction[]; nextBefore: number | null; firstAvailableSequence: number | null; accessEpoch?: number }
export type TaskReference = Pick<Task, 'id' | 'title' | 'status' | 'priority' | 'version'>;
export interface TaskDetail { task: Task; history: TaskHistory; dependsOn: TaskReference[]; blocks: TaskReference[]; duplicateOf: TaskReference[]; duplicates: TaskReference[]; activity: Activity[]; access?: ObjectAccess; accessEpoch?: number }
export interface WikiDocument { publication?:WikiPublication; location?: WikiLocation; id: string; title: string; slug: string; content: string; version: number; createdAt: string; updatedAt: string }
export interface WikiVersion { accessEpoch?: number; location?: WikiLocation; move?: WikiMoveProvenance; attribution?: ActorAttribution; id: string; documentId: string; number: number; title: string; slug: string; content: string; author: string | null; createdAt: string; message: string; kind: 'create' | 'edit' | 'restore' | 'legacy' | 'move_to' | 'move_away' | 'draft' | 'delete'; restoredFrom: number | null }
export type WikiVersionSummary = Omit<WikiVersion, 'content'>;
export interface WikiHistory { accessEpoch?: number; versions: WikiVersionSummary[]; nextBefore: number | null; firstAvailableVersion: number }
export interface WikiDetail { head?:WikiVersion; lifecycle?:WikiLifecycleHistory; document: WikiDocument; history: WikiHistory; activity: Activity[]; hierarchy?: WikiHierarchy; access?: ObjectAccess; accessEpoch?: number }
export interface Revision { id: string; title: string; summary: string; kind: RevisionKind; status: RevisionStatus; repositoryId: string | null; projectId: string | null; currentVersion: number; createdAt: string; updatedAt: string }
export interface RevisionVersion { attribution?: ActorAttribution; gitSource?: GitSourceProvenance; docx?: DocxSource; docxOperation?: { kind: 'import' | 'reimport' | 'replace'; inputSha256: string }; id: string; revisionId: string; number: number; files: SourceFile[]; assets?: RevisionAsset[]; message: string; contentHash: string; createdAt: string }
/** Source offsets are UTF-16 code units, start inclusive and end exclusive. */
export interface PassageAnchor { versionId: string; contentHash: string; filePath: string; start: number; end: number; quote: string; prefix: string; suffix: string }
export interface PassageInput { start: number; end: number; quote: string }
export interface SuggestedReplacement { replacement: string }
export interface ReviewComment { attribution?: ActorAttribution; id: string; revisionId: string; versionId: string; filePath: string | null; line: number | null; body: string; author: string; createdAt: string; threadId?: string; anchor?: PassageAnchor; viewedVersionId?: string; suggestion?: SuggestedReplacement }
export interface ReviewThread { id: string; revisionId: string; rootCommentId: string; status: 'open' | 'resolved'; version: number; createdAt: string; updatedAt: string }
export interface ReviewThreadEvent { attribution?: ActorAttribution; id: string; revisionId: string; threadId: string; action: 'resolved' | 'reopened'; versionId: string; threadVersion: number; actor: string; createdAt: string }
export interface SuggestionApplication { attribution?: ActorAttribution; id: string; revisionId: string; commentId: string; threadId: string; fromVersionId: string; toVersionId: string; fromContentHash: string; toContentHash: string; threadVersion: number; actor: string; createdAt: string }
export interface Finding { id: string; severity: 'info' | 'warning' | 'error'; filePath: string; line: number; title: string; body: string; source: 'local' | 'ai' }
export interface ReviewAnalysis { summary: string; findings: Finding[]; provider: 'local' | 'openai' | 'ollama'; model: string }
export interface ReviewRun extends ReviewAnalysis { attribution?: ActorAttribution; id: string; revisionId: string; versionId: string; contentHash: string; createdAt: string }
export interface Activity { attribution?: ActorAttribution; id: string; objectId: string; actor: string; action: string; detail: string; createdAt: string }
export type SpaceSummary = Space & { capabilities: EffectiveAccess };
export interface AppState { pastes?: PasteRecord[]; files?: FileRecord[]; projects: Project[]; repositories: Repository[]; tasks: Task[]; documents: WikiDocument[]; revisions: Revision[]; activity: Activity[]; spaces: SpaceSummary[]; access: Record<string, ObjectAccess>; principals: PublicAccount[]; currentPrincipalId: string; followingTaskIds: string[]; joinedProjectIds: string[]; watchingProjectIds: string[]; accessEpoch: number; canCreate: boolean; ai: { configured: boolean; model: string | null; localConfigured?: boolean; localModel?: string | null }; mode: 'local-single-user' | 'authenticated-workspace' }
export interface RevisionDetail { revision: Revision; versions: RevisionVersion[]; comments: ReviewComment[]; threads: ReviewThread[]; threadEvents: ReviewThreadEvent[]; suggestionApplications: SuggestionApplication[]; reviews: ReviewRun[]; activity: Activity[]; access?: ObjectAccess; accessEpoch?: number }
export interface CreateRevisionInput { access?: NewObjectAccessInput; title: string; summary?: string; kind: RevisionKind; files: SourceFile[]; assets?: RevisionAsset[]; shareAssets?: boolean; expectedAccessEpoch?: number; repositoryId?: string | null; projectId?: string | null }
export interface CreateVersionInput { files: SourceFile[]; assets?: RevisionAsset[]; message: string; expectedVersion: number; expectedVersionId?: string; expectedContentHash?: string; shareAssets?: boolean; expectedAccessEpoch?: number }
export interface ReviewInput { provider: 'local' | 'openai' | 'ollama'; expectedVersion: number }
export interface CreateCommentInput { body: string; versionId: string; filePath?: string | null; line?: number | null; passage?: PassageInput; suggestion?: SuggestedReplacement }
export interface CreateReplyInput { body: string; viewedVersionId: string }
export interface UpdateThreadInput { status: 'open' | 'resolved'; expectedThreadVersion: number; versionId: string }
export interface ApplySuggestionInput { expectedVersion: number; expectedVersionId: string; expectedContentHash: string; expectedThreadVersion: number }
export interface TaskInput { title: string; description?: string; status?: TaskStatus; priority?: Priority; projectIds?: string[]; projectId?: string | null; ownerId?: string | null }
export type UpdateTaskInput = Partial<Omit<TaskInput, 'projectId' | 'projectIds'>> & { expectedVersion: number };
export interface TaskProjectsInput { action: 'add' | 'remove' | 'set'; projectIds: string[]; expectedVersion: number }
export interface TaskCommentInput { body: string }
export interface TaskDependencyInput { taskId: string; action: 'add' | 'remove'; expectedVersion: number }
export interface TaskMergeInput { taskId: string; expectedVersion: number; expectedTargetVersion: number }
export interface TaskMergeInInput { sources: { taskId: string; expectedVersion: number }[]; expectedVersion: number }
export interface DocumentInput extends Partial<WikiLifecyclePins> { title: string; slug: string; content: string; expectedVersion?: number; expectedAccessEpoch?: number; message?: string }
export interface RestoreDocumentInput extends Partial<WikiLifecyclePins> { version: number; expectedVersion: number; message?: string }
