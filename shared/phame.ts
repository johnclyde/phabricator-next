/** Internal Phame publishing inherits the current blog policy. */
export type PhamePostStatus = 'draft' | 'published' | 'archived';
export interface PhameBlogData { description: string; subtitle: string; status: 'active' | 'archived'; authorIds: string[]; editorIds: string[] }
export interface PhamePostRevision { version: number; title: string; subtitle: string; body: string; status: PhamePostStatus; actorId: string; createdAt: string }
export interface PhameComment { id: string; actorId: string; actorName: string; body: string; createdAt: string }
export interface PhamePostData { blogId: string; subtitle: string; body: string; status: PhamePostStatus; publishedAt: string | null; revisions: PhamePostRevision[]; comments: PhameComment[] }
