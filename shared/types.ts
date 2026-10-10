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
export interface WikiDetail { document: WikiDocument; history: WikiHistory; activity: Activity[] }
export interface Revision { id: string; title: string; summary: string; kind: RevisionKind; status: RevisionStatus; repositoryId: string | null; projectId: string | null; currentVersion: number; createdAt: string; updatedAt: string }
export interface RevisionVersion { attribution?: ActorAttribution; id: string; revisionId: string; number: number; files: SourceFile[]; message: string; contentHash: string; createdAt: string }
export interface ReviewComment { attribution?: ActorAttribution; id: string; revisionId: string; versionId: string; filePath: string | null; line: number | null; body: string; author: string; createdAt: string }
export interface Finding { id: string; severity: 'info' | 'warning' | 'error'; filePath: string; line: number; title: string; body: string; source: 'local' | 'ai' }
export interface ReviewAnalysis { summary: string; findings: Finding[]; provider: 'local' | 'openai' | 'ollama'; model: string }
export interface ReviewRun extends ReviewAnalysis { attribution?: ActorAttribution; id: string; revisionId: string; versionId: string; contentHash: string; createdAt: string }
export interface Activity { attribution?: ActorAttribution; id: string; objectId: string; actor: string; action: string; detail: string; createdAt: string }
export interface AppState { projects: Project[]; repositories: Repository[]; tasks: Task[]; documents: WikiDocument[]; revisions: Revision[]; activity: Activity[]; ai: { configured: boolean; model: string | null; localConfigured?: boolean; localModel?: string | null }; mode: 'local-single-user' | 'authenticated-workspace' }
export interface RevisionDetail { revision: Revision; versions: RevisionVersion[]; comments: ReviewComment[]; reviews: ReviewRun[]; activity: Activity[] }
export interface CreateRevisionInput { title: string; summary?: string; kind: RevisionKind; files: SourceFile[]; repositoryId?: string | null; projectId?: string | null }
export interface CreateVersionInput { files: SourceFile[]; message: string; expectedVersion: number }
export interface ReviewInput { provider: 'local' | 'openai' | 'ollama'; expectedVersion: number }
export interface CreateCommentInput { body: string; versionId: string; filePath?: string | null; line?: number | null }
export interface TaskInput { title: string; description?: string; status?: TaskStatus; priority?: Priority; projectId?: string | null }
export interface DocumentInput { title: string; slug: string; content: string; expectedVersion?: number; message?: string }
export interface RestoreDocumentInput { version: number; expectedVersion: number; message?: string }
