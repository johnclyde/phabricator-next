import type { RevisionDetail, ReviewThread } from './types';

export type DiscussionFilter = 'open' | 'resolved' | 'all';
export interface DiscussionCursor {
  threadId: string | null;
  boundary: 'first' | 'last' | 'empty' | null;
}

/** Stable chronological thread cards, including comments saved before threads existed. */
export function orderedDiscussionThreads(detail: Pick<RevisionDetail, 'threads' | 'comments'>): ReviewThread[] {
  const threads = new Map((detail.threads || []).map(thread => [thread.id, thread]));
  const comments = [...detail.comments].sort((left, right) => compare(left.createdAt, right.createdAt) || compare(left.id, right.id));
  for (const comment of comments) {
    const id = comment.threadId || comment.id;
    if (!threads.has(id)) threads.set(id, { id, revisionId: comment.revisionId, rootCommentId: id, status: 'open', version: 1, createdAt: comment.createdAt, updatedAt: comment.createdAt });
  }
  return [...threads.values()].sort((left, right) => compare(left.createdAt, right.createdAt) || compare(left.id, right.id));
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export function filterDiscussionThreads(threads: readonly ReviewThread[], filter: DiscussionFilter): ReviewThread[] {
  return threads.filter(thread => filter === 'all' || thread.status === filter);
}

/** Like upstream n/p and N/P: no wrapping, no automatic expansion or resolution. */
export function moveDiscussionCursor(threads: readonly Pick<ReviewThread, 'id'>[], currentId: string | null, direction: 1 | -1, collapsedIds: ReadonlySet<string>, includeCollapsed = false): DiscussionCursor {
  const currentIndex = currentId === null ? -1 : threads.findIndex(thread => thread.id === currentId);
  const threadId = currentIndex >= 0 ? currentId : null;
  const eligible = (id: string) => includeCollapsed || !collapsedIds.has(id);
  if (!threads.some(thread => eligible(thread.id))) return { threadId, boundary: 'empty' };
  if (currentIndex < 0 && direction < 0) return { threadId: null, boundary: 'first' };
  for (let index = currentIndex + direction; index >= 0 && index < threads.length; index += direction) {
    const next = threads[index]!;
    if (eligible(next.id)) return { threadId: next.id, boundary: null };
  }
  return { threadId, boundary: direction < 0 ? 'first' : 'last' };
}
