import type { ComparisonRange } from '../shared/comparison';
import type { ComparisonDiscussionPlacement, ComparisonPassage, ComparisonSide } from '../shared/comparison-discussion';

export const INLINE_DISCUSSION_LIMIT = 20;

function excerpt(text: string, limit: number) {
  if (text.length <= limit) return text;
  const boundary = text.charCodeAt(limit - 1);
  return `${text.slice(0, boundary >= 0xd800 && boundary <= 0xdbff ? limit - 1 : limit)}…`;
}

/** Inline discussion is a bounded reading view; the full thread owns its editor. */
export default function ComparisonDiscussion({ placement, versionNumber, openThread }: {
  placement: ComparisonDiscussionPlacement;
  versionNumber: number;
  openThread: (threadId: string) => void;
}) {
  const { thread, root, comments, anchor, side } = placement;
  const replies = comments.filter(comment => comment.id !== root.id);
  const shownReplies = replies.slice(-3);
  return <aside className="comparison-discussion" aria-label={`Discussion on version ${versionNumber}`}
    data-comparison-thread-id={thread.id} data-comparison-side={side} data-source-start={anchor.start} data-source-end={anchor.end}>
    <header><strong>Version {versionNumber} · {side === 'before' ? 'Base' : 'Target'} discussion</strong><span className={`badge badge-${thread.status}`}>{thread.status === 'resolved' ? 'Resolved' : 'Open'}</span></header>
    <blockquote className="comparison-discussion-quote">{excerpt(anchor.quote, 320)}</blockquote>
    <div className="comparison-discussion-message"><strong>{root.author}</strong><p>{excerpt(root.body, 2_000)}</p></div>
    {shownReplies.map(comment => <div className="comparison-discussion-message comparison-discussion-reply" key={comment.id}><strong>{comment.author}</strong><p>{excerpt(comment.body, 1_000)}</p></div>)}
    <footer><small>Reading excerpts · {comments.length} {comments.length === 1 ? 'comment' : 'comments'}{replies.length > shownReplies.length ? ` · ${replies.length - shownReplies.length} earlier replies in full discussion` : ''}</small><button type="button" className="button" onClick={() => openThread(thread.id)}>Open discussion</button></footer>
  </aside>;
}

export function ComparisonPassageComment({ side, range, passage, versionNumber, canComment, onComment }: {
  side: ComparisonSide;
  range: ComparisonRange;
  passage: ComparisonPassage;
  versionNumber: number;
  canComment: boolean;
  onComment: (side: ComparisonSide, range: ComparisonRange) => void;
}) {
  const label = `Comment on ${side === 'before' ? 'removed' : 'added'} text · Version ${versionNumber}`;
  return <span className="comparison-passage-comment" data-comparison-comment-side={side}>
    <button type="button" className="button" disabled={!canComment || passage.status !== 'ready'} onClick={() => { if (canComment && passage.status === 'ready') onComment(side, range); }}>{label}</button>
    {passage.status === 'unavailable' && <small className="comparison-comment-unavailable">{passage.message}</small>}
  </span>;
}
