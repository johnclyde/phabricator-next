import { createPassageAnchor, projectAnchor } from './anchors';
import { orderedDiscussionThreads } from './discussion-navigation';
import type { ComparisonRange, FileComparison, ReadyComparison } from './comparison';
import type { PassageAnchor, RevisionDetail, RevisionVersion, ReviewComment, ReviewThread } from './types';

export type ComparisonSide = 'before' | 'after';
export interface ComparisonDiscussionContext {
  revisionId: string;
  base: RevisionVersion | null;
  target: RevisionVersion | null;
  filePath: string;
}
export type ComparisonPassage = {
  status: 'ready'; side: ComparisonSide; versionId: string; versionNumber: number; anchor: PassageAnchor;
} | {
  status: 'unavailable';
  reason: 'missing_version' | 'wrong_revision' | 'word_projection' | 'missing_file' | 'invalid_range';
  message: string;
};

/** Resolve only the selected, original source. No clipping, relocation or head fallback. */
export function comparisonPassage(context: ComparisonDiscussionContext, side: ComparisonSide, range: ComparisonRange): ComparisonPassage {
  const unavailable = (reason: Extract<ComparisonPassage, { status: 'unavailable' }>['reason'], message: string): ComparisonPassage => ({ status: 'unavailable', reason, message });
  if (side !== 'before' && side !== 'after') return unavailable('invalid_range', 'Choose the before or after source.');
  const version = side === 'before' ? context.base : context.target;
  if (!version) return unavailable('missing_version', 'This comparison side has no loaded source version.');
  if (version.revisionId !== context.revisionId) return unavailable('wrong_revision', 'The source version does not belong to this revision.');
  if (context.base?.docx || context.target?.docx) return unavailable('word_projection', 'Use the Word passage discussion controls for this comparison.');
  const files = version.files.filter(file => file.path === context.filePath);
  if (files.length !== 1) return unavailable('missing_file', 'Choose a file that exists exactly once in this source version.');
  try {
    // Let the anchor validator report invalid/oversized ranges before allocating
    // a potentially large quotation. This is its 20,000-code-unit quote ceiling.
    const quote = range && range.end - range.start <= 20_000 ? files[0]!.content.slice(range.start, range.end) : '';
    const anchor = createPassageAnchor(version, context.filePath, { start: range?.start, end: range?.end, quote });
    return { status: 'ready', side, versionId: version.id, versionNumber: version.number, anchor };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return unavailable('invalid_range', error.message);
  }
}

export interface ComparisonDiscussionPlacement {
  thread: ReviewThread;
  root: ReviewComment;
  comments: ReviewComment[];
  side: ComparisonSide;
  anchor: PassageAnchor;
  /** Insert the card after this segment; the quotation may span earlier segments. */
  segmentIndex: number;
  /** Every nonempty segment overlapping the original quotation on this side. */
  segmentIndexes: number[];
}

/** Reject stale/mismatched comparisons before using their source offsets. */
function matchesSources(context: ComparisonDiscussionContext, comparison: ReadyComparison): boolean {
  if (comparison.filePath !== context.filePath || context.base?.docx || context.target?.docx) return false;
  for (const side of ['before', 'after'] as const) {
    const version = side === 'before' ? context.base : context.target;
    if (version && version.revisionId !== context.revisionId) return false;
    const files = version?.files.filter(file => file.path === context.filePath) || [];
    if (files.length > 1) return false;
    const file = files[0], content = file?.content || '';
    if (comparison[side === 'before' ? 'beforePresent' : 'afterPresent'] !== Boolean(file)
      || comparison[side === 'before' ? 'beforeLength' : 'afterLength'] !== content.length) return false;
    let offset = 0;
    for (const segment of comparison.segments) {
      if (!['unchanged', 'removed', 'added'].includes(segment.kind)) return false;
      const range = segment[side], present = side === 'before' ? segment.kind !== 'added' : segment.kind !== 'removed';
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
        || range.start !== offset || range.end !== offset + (present ? segment.text.length : 0)
        || (present && content.slice(range.start, range.end) !== segment.text)) return false;
      offset = range.end;
    }
    if (offset !== content.length) return false;
  }
  return true;
}

/**
 * Place exact original text threads in stable chronological order. Reversing the
 * pair reverses their presentation side, never their anchors. An identical pair
 * uses the after side once. Word, projected, corrupt and unavailable anchors stay
 * in the normal discussion list rather than being guessed onto this comparison.
 */
export function comparisonDiscussionThreads(
  detail: Pick<RevisionDetail, 'comments' | 'threads'>,
  context: ComparisonDiscussionContext,
  comparison: FileComparison,
): ComparisonDiscussionPlacement[] {
  if (comparison.status !== 'ready' || !matchesSources(context, comparison)) return [];
  if (context.base && context.target && context.base.id === context.target.id && context.base.contentHash !== context.target.contentHash) return [];
  const roots = new Map<string, ReviewComment | null>();
  for (const comment of detail.comments) roots.set(comment.id, roots.has(comment.id) ? null : comment);
  const comments = new Map<string, ReviewComment[]>();
  for (const comment of detail.comments) {
    if (comment.revisionId !== context.revisionId || roots.get(comment.id) !== comment) continue;
    const id = comment.threadId || comment.id, group = comments.get(id);
    if (group) group.push(comment); else comments.set(id, [comment]);
  }
  const placements: ComparisonDiscussionPlacement[] = [];
  for (const thread of orderedDiscussionThreads(detail)) {
    const root = roots.get(thread.rootCommentId), anchor = root?.anchor;
    if (thread.revisionId !== context.revisionId || !root || !anchor || root.docxAnchor
      || root.revisionId !== context.revisionId || (root.threadId || root.id) !== thread.id || root.viewedVersionId !== undefined
      || root.versionId !== anchor.versionId || root.filePath !== context.filePath || anchor.filePath !== context.filePath) continue;
    // Prefer after when both selections identify the same immutable version.
    const side = context.target?.id === anchor.versionId ? 'after' : context.base?.id === anchor.versionId ? 'before' : null;
    if (!side) continue;
    const version = side === 'before' ? context.base! : context.target!;
    if (projectAnchor(anchor, version).status !== 'original') continue;
    const segmentIndexes: number[] = [];
    comparison.segments.forEach((segment, index) => {
      const range = segment[side];
      if (range.start < anchor.end && range.end > anchor.start && range.start < range.end) segmentIndexes.push(index);
    });
    if (!segmentIndexes.length) continue;
    const messages = (comments.get(thread.id) || []).filter(comment => comment.versionId === root.versionId)
      .sort((left, right) => compare(left.createdAt, right.createdAt) || compare(left.id, right.id));
    placements.push({ thread, root, comments: messages, side, anchor, segmentIndex: segmentIndexes[segmentIndexes.length - 1]!, segmentIndexes });
  }
  return placements;
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
