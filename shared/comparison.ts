import { diffArrays, lineDiff, wordsWithSpaceDiff, type ArrayChange } from 'diff';

export interface ComparisonFile { readonly path: string; readonly content: string }
export type ComparisonMode = 'words' | 'lines';
/** Half-open offsets in the exact original string, measured in UTF-16 code units. */
export interface ComparisonRange { start: number; end: number }
export interface ComparisonSegment {
  kind: 'unchanged' | 'removed' | 'added';
  text: string;
  before: ComparisonRange;
  after: ComparisonRange;
}
export interface ChangePassage {
  kind: 'added' | 'removed' | 'replaced';
  before: ComparisonRange;
  after: ComparisonRange;
  /** Half-open segment indexes; adjacent additions/removals form one passage. */
  segmentStart: number;
  segmentEnd: number;
}
export interface ComparisonLimits {
  maxInputCodeUnits: number;
  maxSourceLines: number;
  maxTokens: number;
  maxEditLength: number;
  maxComparisons: number;
  maxSegments: number;
  maxPassages: number;
  maxRenderedCodeUnits: number;
}
/** Fixed hard ceilings. Callers may lower these budgets, never raise them. */
export const COMPARISON_LIMITS: Readonly<ComparisonLimits> = Object.freeze({
  maxInputCodeUnits: 200_000,
  maxSourceLines: 8_000,
  maxTokens: 40_000,
  maxEditLength: 1_024,
  maxComparisons: 250_000,
  maxSegments: 2_000,
  maxPassages: 1_000,
  maxRenderedCodeUnits: 120_000,
});
export type ComparisonLimitReason = 'input_code_units' | 'source_lines' | 'tokens' | 'edit_length' | 'comparisons' | 'segments' | 'passages' | 'rendered_code_units';
interface ComparisonIdentity {
  filePath: string;
  mode: ComparisonMode;
  beforePresent: boolean;
  afterPresent: boolean;
  beforeLength: number;
  afterLength: number;
}
export interface ComparisonMetrics {
  inputCodeUnits: number;
  /** Null means this stage was never reached; zero means two empty inputs. */
  sourceLines: number | null;
  tokens: number | null;
  comparisons: number;
}
export interface ReadyComparison extends ComparisonIdentity {
  status: 'ready';
  fileChange: 'added' | 'removed' | 'modified' | 'unchanged';
  segments: ComparisonSegment[];
  passages: ChangePassage[];
  metrics: ComparisonMetrics;
}
export interface TooLargeComparison extends ComparisonIdentity {
  status: 'too_large';
  reason: ComparisonLimitReason;
  /** No truncated segments/passages: a bounded failure is never an empty diff. */
  metrics: ComparisonMetrics;
}
export type FileComparison = ReadyComparison | TooLargeComparison;

function budgets(overrides: Partial<ComparisonLimits>): ComparisonLimits {
  const result = { ...COMPARISON_LIMITS };
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(result, key)) throw new RangeError(`Unknown comparison budget: ${key}.`);
    const name = key as keyof ComparisonLimits;
    const value = overrides[name];
    if (!Number.isSafeInteger(value) || value! < 0 || value! > COMPARISON_LIMITS[name]) {
      throw new RangeError(`${name} must be an integer from zero through ${COMPARISON_LIMITS[name]}.`);
    }
    result[name] = value!;
  }
  return result;
}

function validateFile(file: ComparisonFile | null): void {
  if (file !== null && (!file || typeof file.path !== 'string' || !file.path || typeof file.content !== 'string')) {
    throw new RangeError('Select a source file with an exact path and text content, or null for an absent file.');
  }
}

function lineCount(content: string): number {
  if (!content.length) return 0;
  let count = content.endsWith('\n') ? 0 : 1;
  for (let index = 0; index < content.length; index++) if (content.charCodeAt(index) === 10) count++;
  return count;
}

/**
 * Compare exactly one selected path. Null is an absent file, distinct from an
 * existing empty file. Version/session identity and authorization belong to the
 * caller: this helper never selects latest versions, fetches, stores, or speaks.
 *
 * Literal tokenizers preserve whitespace, CRLF, Unicode and final newlines.
 * Input is capped before tokenization; admitted tokens, edit distance, counted
 * comparisons and rendered output are capped independently. Integer token IDs
 * keep each algorithm comparison constant-cost. No clock-based cutoff means the
 * result is deterministic, but this is not a hard wall-clock guarantee. A worker
 * may still be desirable on slow devices. No semantic moves/renames are inferred.
 */
export function compareFile(
  beforeFile: ComparisonFile | null,
  afterFile: ComparisonFile | null,
  mode: ComparisonMode = 'words',
  overrides: Partial<ComparisonLimits> = {},
): FileComparison {
  validateFile(beforeFile); validateFile(afterFile);
  if (!beforeFile && !afterFile) throw new RangeError('The selected file must exist in at least one version.');
  if (beforeFile && afterFile && beforeFile.path !== afterFile.path) throw new RangeError('Compare the same exact file path in both versions.');
  if (mode !== 'words' && mode !== 'lines') throw new RangeError('Choose literal words or lines comparison.');
  const limits = budgets(overrides);
  const before = beforeFile?.content ?? '', after = afterFile?.content ?? '';
  const identity: ComparisonIdentity = { filePath: (beforeFile || afterFile)!.path, mode, beforePresent: beforeFile !== null, afterPresent: afterFile !== null, beforeLength: before.length, afterLength: after.length };
  const metrics: ComparisonMetrics = { inputCodeUnits: before.length + after.length, sourceLines: null, tokens: null, comparisons: 0 };
  const exceeded = (reason: ComparisonLimitReason): TooLargeComparison => ({ ...identity, status: 'too_large', reason, metrics: { ...metrics } });
  if (metrics.inputCodeUnits > limits.maxInputCodeUnits) return exceeded('input_code_units');
  metrics.sourceLines = lineCount(before) + lineCount(after);
  if (metrics.sourceLines > limits.maxSourceLines) return exceeded('source_lines');

  const tokenize = (text: string) => mode === 'words' ? wordsWithSpaceDiff.tokenize(text) : lineDiff.tokenize(text, {});
  const oldTokens = tokenize(before), newTokens = tokenize(after);
  metrics.tokens = oldTokens.length + newTokens.length;
  if (metrics.tokens > limits.maxTokens) return exceeded('tokens');

  const ids = new Map<string, number>(); const lengths: number[] = [];
  const intern = (tokens: string[]): number[] => tokens.map(token => {
    let id = ids.get(token);
    if (id === undefined) { id = lengths.length; ids.set(token, id); lengths.push(token.length); }
    return id;
  });
  const oldIds = intern(oldTokens), newIds = intern(newTokens);
  const exhausted = Symbol('comparison budget exhausted');
  let changes: ArrayChange<number>[] | undefined;
  try {
    changes = diffArrays(oldIds, newIds, {
      maxEditLength: limits.maxEditLength,
      comparator(left, right) {
        if (metrics.comparisons >= limits.maxComparisons) throw exhausted;
        metrics.comparisons++;
        return left === right;
      },
    });
  } catch (error) { if (error === exhausted) return exceeded('comparisons'); throw error; }
  if (!changes) return exceeded('edit_length');
  changes = changes.filter(change => change.count > 0);
  if (changes.length > limits.maxSegments) return exceeded('segments');

  let rendered = 0, passageCount = 0, previousChanged = false;
  const changeLengths = changes.map(change => {
    const size = change.value.reduce((sum, token) => sum + lengths[token]!, 0);
    rendered += size;
    const changed = change.added || change.removed;
    if (changed && !previousChanged) passageCount++;
    previousChanged = changed;
    return size;
  });
  if (rendered > limits.maxRenderedCodeUnits) return exceeded('rendered_code_units');
  if (passageCount > limits.maxPassages) return exceeded('passages');

  const segments: ComparisonSegment[] = []; const passages: ChangePassage[] = [];
  let oldOffset = 0, newOffset = 0, active: ChangePassage | null = null;
  changes.forEach((change, index) => {
    const length = changeLengths[index]!;
    if (!length) return;
    const oldEnd = oldOffset + (change.added ? 0 : length);
    const newEnd = newOffset + (change.removed ? 0 : length);
    const kind = change.added ? 'added' : change.removed ? 'removed' : 'unchanged';
    const segment: ComparisonSegment = { kind, text: change.added ? after.slice(newOffset, newEnd) : before.slice(oldOffset, oldEnd), before: { start: oldOffset, end: oldEnd }, after: { start: newOffset, end: newEnd } };
    if (kind === 'unchanged') active = null;
    else {
      if (!active) {
        active = { kind, before: { start: oldOffset, end: oldOffset }, after: { start: newOffset, end: newOffset }, segmentStart: segments.length, segmentEnd: segments.length };
        passages.push(active);
      }
      active.before.end = oldEnd; active.after.end = newEnd; active.segmentEnd = segments.length + 1;
      active.kind = active.before.end === active.before.start ? 'added' : active.after.end === active.after.start ? 'removed' : 'replaced';
    }
    segments.push(segment); oldOffset = oldEnd; newOffset = newEnd;
  });
  // Strict tokens must reconstruct both sources. Never render a misleading diff
  // if a future dependency change violates that assumption.
  if (oldOffset !== before.length || newOffset !== after.length) throw new Error('Literal comparison did not preserve both source lengths.');
  return { ...identity, status: 'ready', fileChange: !beforeFile ? 'added' : !afterFile ? 'removed' : passages.length ? 'modified' : 'unchanged', segments, passages, metrics: { ...metrics } };
}
