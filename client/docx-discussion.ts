import type { RevisionDetail, RevisionVersion, ReviewComment } from '../shared/types';
import { createDocxPassageAnchor, validDocxPassageAnchor, type DocxPassageInput } from '../shared/docx-discussion';
import { orderedDiscussionThreads } from '../shared/discussion-navigation';

export function wordPassage(version: RevisionVersion, rangeId: string, start: number, end: number): DocxPassageInput {
  const range = version.docx?.projection.editableRanges.find(item => item.id === rangeId);
  const input = { rangeId, start, end, quote: range?.text.slice(start, end) ?? '' };
  createDocxPassageAnchor(version, input);
  return input;
}

export function wordDiscussionThreads(detail: Pick<RevisionDetail, 'comments' | 'threads'>, version: RevisionVersion) {
  const roots = new Map(detail.comments.map(comment => [comment.id, comment]));
  const messages = new Map<string, ReviewComment[]>();
  for (const comment of detail.comments) { const id = comment.threadId || comment.id, group = messages.get(id); if (group) group.push(comment); else messages.set(id, [comment]); }
  return orderedDiscussionThreads(detail).flatMap(thread => {
    const root = roots.get(thread.rootCommentId);
    return root?.versionId === version.id && root.docxAnchor && validDocxPassageAnchor(root.docxAnchor, version) ? [{ thread, root, comments: messages.get(thread.id) || [] }] : [];
  });
}

export function wordDiscussionSnapshot(detail: Pick<RevisionDetail, 'comments' | 'threads'>, version: RevisionVersion): string {
  return JSON.stringify([version.id, version.contentHash, version.docx?.sha256, wordDiscussionThreads(detail, version).map(({ thread, root, comments }) => [thread.id, thread.version, thread.status, root.docxAnchor, comments.map(comment => [comment.id, comment.body, comment.author, comment.createdAt])])]);
}
