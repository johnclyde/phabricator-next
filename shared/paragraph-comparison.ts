import { diffArrays, wordsWithSpaceDiff } from 'diff';
import { COMPARISON_LIMITS, type ChangePassage, type ComparisonFile, type ComparisonLimitReason, type ComparisonLimits, type ComparisonMetrics, type ComparisonRange, type ComparisonSegment, type ReadyComparison, type TooLargeComparison } from './comparison';

/** A physical source block is not a parsed or rendered LaTeX paragraph. */
export const PARAGRAPH_COMPARISON_LIMITS = Object.freeze({ maxParagraphs: 2_000 });
export interface ReorderedParagraph {
  id: string;
  before: ComparisonRange;
  after: ComparisonRange;
  /** Each exact body lies wholly within this literal removed/added segment. */
  beforeSegment: number;
  afterSegment: number;
  /** Original ordered passage indexes, never a second deduplicated cursor. */
  beforePassage: number;
  afterPassage: number;
}
export interface ReadyParagraphComparison extends ReadyComparison {
  alignment: 'source-paragraphs';
  reordered: ReorderedParagraph[];
}
export type ParagraphComparison = ReadyParagraphComparison | TooLargeComparison;
interface Body extends ComparisonRange { text: string }
interface Pair { before: Body; after: Body; afterIndex: number }

function budgets(overrides: Partial<ComparisonLimits>): ComparisonLimits {
  const result = { ...COMPARISON_LIMITS };
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(result, key)) throw new RangeError(`Unknown comparison budget: ${key}.`);
    const name = key as keyof ComparisonLimits, value = overrides[name];
    if (!Number.isSafeInteger(value) || value! < 0 || value! > COMPARISON_LIMITS[name]) throw new RangeError(`${name} must be an integer from zero through ${COMPARISON_LIMITS[name]}.`);
    result[name] = value!;
  }
  return result;
}
function validateFile(file: ComparisonFile | null): void {
  if (file !== null && (!file || typeof file.path !== 'string' || !file.path || typeof file.content !== 'string')) throw new RangeError('Select a source file with an exact path and text content, or null for an absent file.');
}
function lineCount(text: string): number {
  if (!text.length) return 0;
  let count = text.endsWith('\n') ? 0 : 1;
  for (let offset = 0; offset < text.length; offset++) if (text.charCodeAt(offset) === 10) count++;
  return count;
}

/**
 * Blank lines contain only ASCII spaces/tabs before LF/CRLF (or EOF).
 * Bodies retain internal newlines and leading/trailing spaces. Their final
 * LF/CRLF and all blank lines remain separate, literal gap text. Bare CR is
 * source text, not a line separator. The scan never splits a surrogate pair.
 */
function sourceBodies(text: string, remaining: number): Body[] | null {
  const result: Body[] = [];
  let start = -1, end = -1, lineStart = 0;
  const finish = (): boolean => {
    if (start < 0) return true;
    if (result.length >= remaining) return false;
    result.push({ start, end, text: text.slice(start, end) }); start = -1; return true;
  };
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart), lineEnd = newline < 0 ? text.length : newline;
    const contentEnd = newline >= 0 && lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    let blank = true;
    for (let offset = lineStart; offset < contentEnd; offset++) if (text.charCodeAt(offset) !== 32 && text.charCodeAt(offset) !== 9) { blank = false; break; }
    if (blank) { if (!finish()) return null; }
    else { if (start < 0) start = lineStart; end = contentEnd; }
    lineStart = newline < 0 ? text.length : newline + 1;
  }
  return finish() ? result : null;
}

/**
 * Optional literal source-paragraph alignment. Unique equal bodies establish
 * a deterministic increasing backbone; reordered bodies remain complete
 * removals/additions. No text normalization, semantic matching, copy inference,
 * TeX execution, source mutation, or comment-anchor relocation takes place.
 * A different equally valid backbone may be selected for the reversed pair.
 *
 * One global token inventory and ledger cover every refinement and output.
 * Limits are deterministic work ceilings, not a wall-clock guarantee.
 */
export function compareParagraphFile(beforeFile: ComparisonFile | null, afterFile: ComparisonFile | null, overrides: Partial<ComparisonLimits> = {}): ParagraphComparison {
  validateFile(beforeFile); validateFile(afterFile);
  if (!beforeFile && !afterFile) throw new RangeError('The selected file must exist in at least one version.');
  if (beforeFile && afterFile && beforeFile.path !== afterFile.path) throw new RangeError('Compare the same exact file path in both versions.');
  const limits = budgets(overrides), before = beforeFile?.content ?? '', after = afterFile?.content ?? '';
  const identity = { filePath: (beforeFile || afterFile)!.path, mode: 'words' as const, beforePresent: beforeFile !== null, afterPresent: afterFile !== null, beforeLength: before.length, afterLength: after.length };
  const metrics: ComparisonMetrics = { inputCodeUnits: before.length + after.length, sourceLines: null, tokens: null, comparisons: 0 };
  const exceeded = (reason: ComparisonLimitReason): TooLargeComparison => ({ ...identity, status: 'too_large', reason, metrics: { ...metrics } });
  if (metrics.inputCodeUnits > limits.maxInputCodeUnits) return exceeded('input_code_units');
  metrics.sourceLines = lineCount(before) + lineCount(after);
  if (metrics.sourceLines > limits.maxSourceLines) return exceeded('source_lines');
  const oldBodies = sourceBodies(before, PARAGRAPH_COMPARISON_LIMITS.maxParagraphs);
  if (!oldBodies) return exceeded('paragraphs');
  const newBodies = sourceBodies(after, PARAGRAPH_COMPARISON_LIMITS.maxParagraphs - oldBodies.length);
  if (!newBodies) return exceeded('paragraphs');
  // Count the entire admitted source, including unchanged backbone bodies and
  // unrefined reorder gaps. Dividing work into paragraphs cannot bypass tokens.
  const oldWords = wordsWithSpaceDiff.tokenize(before), newWords = wordsWithSpaceDiff.tokenize(after);
  metrics.tokens = oldWords.length + newWords.length;
  if (metrics.tokens > limits.maxTokens) return exceeded('tokens');
  const tokenIds = new Map<string, number>(), lengths: number[] = [];
  const tokens = (words: string[]) => {
    const positions = new Map<number, number>([[0, 0]]); let offset = 0;
    const ids = words.map((word, index) => { let id = tokenIds.get(word); if (id === undefined) { id = lengths.length; tokenIds.set(word, id); lengths.push(word.length); } offset += word.length; positions.set(offset, index + 1); return id; });
    return { ids, positions };
  };
  const oldTokens = tokens(oldWords), newTokens = tokens(newWords);
  const tokenPosition = (source: typeof oldTokens, offset: number) => { const index = source.positions.get(offset); if (index === undefined) throw new Error('Source paragraph boundary splits a literal token.'); return index; };
  const stopped = Symbol('paragraph comparison budget exhausted'); let failure: ComparisonLimitReason = 'comparisons';
  const stop = (reason: ComparisonLimitReason): never => { failure = reason; throw stopped; };
  const comparison = () => { if (metrics.comparisons >= limits.maxComparisons) stop('comparisons'); metrics.comparisons++; };
  try {
    const occurrences = new Map<string, { oldCount: number; newCount: number; afterIndex: number }>();
    for (const body of oldBodies) { const entry = occurrences.get(body.text); if (entry) entry.oldCount++; else occurrences.set(body.text, { oldCount: 1, newCount: 0, afterIndex: -1 }); }
    newBodies.forEach((body, afterIndex) => { const entry = occurrences.get(body.text); if (entry) { entry.newCount++; entry.afterIndex = afterIndex; } else occurrences.set(body.text, { oldCount: 0, newCount: 1, afterIndex }); });
    const pairs: Pair[] = [];
    for (const body of oldBodies) { const entry = occurrences.get(body.text)!; if (entry.oldCount === 1 && entry.newCount === 1) { comparison(); pairs.push({ before: body, after: newBodies[entry.afterIndex]!, afterIndex: entry.afterIndex }); } }
    // Patience/LIS over integer positions: O(P log P), no all-pairs matrix.
    const tails: number[] = [], predecessors = new Int32Array(pairs.length).fill(-1);
    pairs.forEach((pair, index) => {
      let low = 0, high = tails.length;
      while (low < high) { comparison(); const middle = (low + high) >>> 1; if (pairs[tails[middle]!]!.afterIndex < pair.afterIndex) low = middle + 1; else high = middle; }
      if (low) predecessors[index] = tails[low - 1]!;
      tails[low] = index;
    });
    const retained = new Set<number>(), backbone: Pair[] = [];
    for (let index = tails.at(-1) ?? -1; index >= 0; index = predecessors[index]!) { retained.add(index); backbone.push(pairs[index]!); }
    backbone.reverse();
    const reorderedPairs = pairs.filter((_, index) => !retained.has(index)), oldMoved = reorderedPairs.map(pair => pair.before), newMoved = reorderedPairs.map(pair => pair.after).sort((a, b) => a.start - b.start);
    let oldMoveIndex = 0, newMoveIndex = 0, oldOffset = 0, newOffset = 0, editLength = 0, rendered = 0;
    const segments: ComparisonSegment[] = [], passages: ChangePassage[] = [];
    let active: ChangePassage | null = null;
    const spendEdits = (count: number) => { if (editLength + count > limits.maxEditLength) stop('edit_length'); editLength += count; };
    const emit = (kind: ComparisonSegment['kind'], size: number) => {
      if (!size) return;
      if (rendered + size > limits.maxRenderedCodeUnits) stop('rendered_code_units'); rendered += size;
      const oldEnd = oldOffset + (kind === 'added' ? 0 : size), newEnd = newOffset + (kind === 'removed' ? 0 : size), previous = segments.at(-1);
      if (kind === 'unchanged') active = null;
      else if (!active) {
        if (passages.length >= limits.maxPassages) stop('passages');
        active = { kind, before: { start: oldOffset, end: oldOffset }, after: { start: newOffset, end: newOffset }, segmentStart: segments.length, segmentEnd: segments.length };
        passages.push(active);
      }
      if (previous?.kind === kind) { previous.before.end = oldEnd; previous.after.end = newEnd; }
      else { if (segments.length >= limits.maxSegments) stop('segments'); segments.push({ kind, text: '', before: { start: oldOffset, end: oldEnd }, after: { start: newOffset, end: newEnd } }); }
      if (active) { active.before.end = oldEnd; active.after.end = newEnd; active.segmentEnd = segments.length; active.kind = active.before.start === oldEnd ? 'added' : active.after.start === newEnd ? 'removed' : 'replaced'; }
      oldOffset = oldEnd; newOffset = newEnd;
    };
    const gap = (oldEnd: number, newEnd: number) => {
      while (oldMoveIndex < oldMoved.length && oldMoved[oldMoveIndex]!.end <= oldOffset) oldMoveIndex++;
      while (newMoveIndex < newMoved.length && newMoved[newMoveIndex]!.end <= newOffset) newMoveIndex++;
      const moved = oldMoveIndex < oldMoved.length && oldMoved[oldMoveIndex]!.start < oldEnd || newMoveIndex < newMoved.length && newMoved[newMoveIndex]!.start < newEnd;
      const oldStartToken = tokenPosition(oldTokens, oldOffset), oldEndToken = tokenPosition(oldTokens, oldEnd), newStartToken = tokenPosition(newTokens, newOffset), newEndToken = tokenPosition(newTokens, newEnd);
      if (moved) {
        spendEdits(oldEndToken - oldStartToken + newEndToken - newStartToken);
        emit('removed', oldEnd - oldOffset); emit('added', newEnd - newOffset);
      } else {
        const changes = diffArrays(oldTokens.ids.slice(oldStartToken, oldEndToken), newTokens.ids.slice(newStartToken, newEndToken), { maxEditLength: limits.maxEditLength - editLength, comparator(left, right) { comparison(); return left === right; } }) ?? stop('edit_length');
        for (const change of changes) { if (change.added || change.removed) spendEdits(change.count); emit(change.added ? 'added' : change.removed ? 'removed' : 'unchanged', change.value.reduce((sum, id) => sum + lengths[id]!, 0)); }
      }
      if (oldOffset !== oldEnd || newOffset !== newEnd) throw new Error('Source paragraph refinement did not preserve source ranges.');
    };
    for (const pair of backbone) { gap(pair.before.start, pair.after.start); emit('unchanged', pair.before.end - pair.before.start); }
    gap(before.length, after.length);
    for (const segment of segments) segment.text = segment.kind === 'added' ? after.slice(segment.after.start, segment.after.end) : before.slice(segment.before.start, segment.before.end);
    const passageBySegment = new Int32Array(segments.length).fill(-1);
    passages.forEach((passage, index) => { for (let segment = passage.segmentStart; segment < passage.segmentEnd; segment++) passageBySegment[segment] = index; });
    const locate = (ordered: { pair: Pair; index: number }[], side: 'before' | 'after') => {
      const found = new Int32Array(reorderedPairs.length); let segmentIndex = 0;
      for (const { pair, index } of ordered) {
        while (segmentIndex < segments.length && segments[segmentIndex]![side].end < pair[side].end) segmentIndex++;
        const segment = segments[segmentIndex];
        if (!segment || segment.kind !== (side === 'before' ? 'removed' : 'added') || segment[side].start > pair[side].start || passageBySegment[segmentIndex]! < 0) throw new Error('Reordered source paragraph was not retained as a complete literal change.');
        found[index] = segmentIndex;
      }
      return found;
    };
    const ordered = reorderedPairs.map((pair, index) => ({ pair, index })), oldSegments = locate(ordered, 'before'), newSegments = locate([...ordered].sort((a, b) => a.pair.after.start - b.pair.after.start), 'after');
    const reordered = reorderedPairs.map((pair, index): ReorderedParagraph => ({ id: `reordered-${pair.before.start}-${pair.after.start}`, before: { start: pair.before.start, end: pair.before.end }, after: { start: pair.after.start, end: pair.after.end }, beforeSegment: oldSegments[index]!, afterSegment: newSegments[index]!, beforePassage: passageBySegment[oldSegments[index]!]!, afterPassage: passageBySegment[newSegments[index]!]! }));
    return { ...identity, status: 'ready', fileChange: !beforeFile ? 'added' : !afterFile ? 'removed' : passages.length ? 'modified' : 'unchanged', segments, passages, metrics: { ...metrics }, alignment: 'source-paragraphs', reordered };
  } catch (error) { if (error === stopped) return exceeded(failure); throw error; }
}
