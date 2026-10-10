import type { EffectiveAccess, NewObjectAccessInput, ObjectAccess, Space } from './policy';
import type { PublicAccount } from './auth';

export type RevisionKind = 'code' | 'paper' | 'document';
export type RevisionStatus = 'draft' | 'needs_review' | 'changes_requested' | 'accepted' | 'closed';
export type TaskStatus = 'open' | 'in_progress' | 'resolved';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export interface ActorAttribution { principalId: string; displayName: string; credentialId: string | null; requestId: string }
export interface SourceFile { path: string; content: string }
export interface Project { id: string; name: string; description: string; color: string }
export interface Repository { id: string; name: string; remoteUrl: string; description: string; defaultBranch: string }
export interface Task { id: string; title: string; description: string; status: TaskStatus; priority: Priority; projectId: string | null; createdAt: string; updatedAt: string }
export interface WikiDocument { id: string; title: string; slug: string; content: string; version: number; createdAt: string; updatedAt: string }
export interface WikiVersion { attribution?: ActorAttribution; id: string; documentId: string; number: number; title: string; slug: string; content: string; author: string | null; createdAt: string; message: string; kind: 'create' | 'edit' | 'restore' | 'legacy'; restoredFrom: number | null }
export type WikiVersionSummary = Omit<WikiVersion, 'content'>;
export interface WikiHistory { versions: WikiVersionSummary[]; nextBefore: number | null; firstAvailableVersion: number }
export interface WikiDetail { document: WikiDocument; history: WikiHistory; activity: Activity[]; access?: ObjectAccess; accessEpoch?: number }
export interface Revision { id: string; title: string; summary: string; kind: RevisionKind; status: RevisionStatus; repositoryId: string | null; projectId: string | null; currentVersion: number; createdAt: string; updatedAt: string }
export interface RevisionVersion { attribution?: ActorAttribution; id: string; revisionId: string; number: number; files: SourceFile[]; message: string; contentHash: string; createdAt: string }
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
export interface AppState { projects: Project[]; repositories: Repository[]; tasks: Task[]; documents: WikiDocument[]; revisions: Revision[]; activity: Activity[]; spaces: SpaceSummary[]; access: Record<string, ObjectAccess>; principals: PublicAccount[]; accessEpoch: number; canCreate: boolean; ai: { configured: boolean; model: string | null; localConfigured?: boolean; localModel?: string | null }; mode: 'local-single-user' | 'authenticated-workspace' }
export interface RevisionDetail { revision: Revision; versions: RevisionVersion[]; comments: ReviewComment[]; threads: ReviewThread[]; threadEvents: ReviewThreadEvent[]; suggestionApplications: SuggestionApplication[]; reviews: ReviewRun[]; activity: Activity[]; access?: ObjectAccess; accessEpoch?: number }
export interface CreateRevisionInput { access?: NewObjectAccessInput; title: string; summary?: string; kind: RevisionKind; files: SourceFile[]; repositoryId?: string | null; projectId?: string | null }
export interface CreateVersionInput { files: SourceFile[]; message: string; expectedVersion: number }
export interface ReviewInput { provider: 'local' | 'openai' | 'ollama'; expectedVersion: number }
export interface CreateCommentInput { body: string; versionId: string; filePath?: string | null; line?: number | null; passage?: PassageInput; suggestion?: SuggestedReplacement }
export interface CreateReplyInput { body: string; viewedVersionId: string }
export interface UpdateThreadInput { status: 'open' | 'resolved'; expectedThreadVersion: number; versionId: string }
export interface ApplySuggestionInput { expectedVersion: number; expectedVersionId: string; expectedContentHash: string; expectedThreadVersion: number }
export interface TaskInput { title: string; description?: string; status?: TaskStatus; priority?: Priority; projectId?: string | null }
export interface DocumentInput { title: string; slug: string; content: string; expectedVersion?: number; message?: string }
export interface RestoreDocumentInput { version: number; expectedVersion: number; message?: string }
