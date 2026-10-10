import type { PassageAnchor, PassageInput, RevisionVersion } from './types';

const MAX_QUOTE_LENGTH = 20_000;
const CONTEXT_LENGTH = 80;

export interface AnchorProjection {
  status: 'original' | 'relocated' | 'ambiguous' | 'changed' | 'file_missing';
  start: number | null;
  end: number | null;
  occurrences: number;
}

/** All offsets address the unmodified source string in UTF-16 code units. */
function splitsSurrogatePair(content: string, offset: number): boolean {
  if (offset <= 0 || offset >= content.length) return false;
  const before = content.charCodeAt(offset - 1), after = content.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function validOffsets(start: number, end: number): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start;
}

function context(content: string, start: number, end: number): { prefix: string; suffix: string } {
  let prefixStart = Math.max(0, start - CONTEXT_LENGTH);
  let suffixEnd = Math.min(content.length, end + CONTEXT_LENGTH);
  if (splitsSurrogatePair(content, prefixStart)) prefixStart++;
  if (splitsSurrogatePair(content, suffixEnd)) suffixEnd--;
  return { prefix: content.slice(prefixStart, start), suffix: content.slice(end, suffixEnd) };
}

export function createPassageAnchor(version: RevisionVersion, filePath: string, input: PassageInput): PassageAnchor {
  const file = version.files.find(item => item.path === filePath);
  if (!file) throw new RangeError('Choose a file that exists in the selected version.');
  if (!input || !validOffsets(input.start, input.end) || input.end > file.content.length) {
    throw new RangeError('Choose a nonempty passage within the selected source file using integer offsets.');
  }
  if (input.end - input.start > MAX_QUOTE_LENGTH) throw new RangeError('Choose a passage of at most 20,000 UTF-16 code units.');
  if (splitsSurrogatePair(file.content, input.start) || splitsSurrogatePair(file.content, input.end)) {
    throw new RangeError('Passage boundaries must not split a Unicode surrogate pair.');
  }
  const quote = file.content.slice(input.start, input.end);
  if (typeof input.quote !== 'string' || input.quote !== quote) {
    throw new RangeError('The quoted passage must exactly match the selected source version. Select it again.');
  }
  return {
    versionId: version.id, contentHash: version.contentHash, filePath,
    start: input.start, end: input.end, quote,
    ...context(file.content, input.start, input.end),
  };
}

/** Counts overlapping exact matches in linear time without retaining a match list. */
function occurrencesOf(content: string, quote: string): { occurrences: number; first: number } {
  const fallback = new Uint32Array(quote.length);
  for (let index = 1, length = 0; index < quote.length; index++) {
    while (length > 0 && quote[index] !== quote[length]) length = fallback[length - 1]!;
    if (quote[index] === quote[length]) length++;
    fallback[index] = length;
  }
  let occurrences = 0, first = -1;
  for (let index = 0, length = 0; index < content.length; index++) {
    while (length > 0 && content[index] !== quote[length]) length = fallback[length - 1]!;
    if (content[index] === quote[length]) length++;
    if (length === quote.length) {
      const start = index + 1 - quote.length, end = index + 1;
      if (!splitsSurrogatePair(content, start) && !splitsSurrogatePair(content, end)) {
        if (first === -1) first = start;
        occurrences++;
      }
      length = fallback[length - 1]!;
    }
  }
  return { occurrences, first };
}

export function projectAnchor(anchor: PassageAnchor, targetVersion: RevisionVersion): AnchorProjection {
  const empty = (status: AnchorProjection['status'], occurrences = 0): AnchorProjection => ({ status, start: null, end: null, occurrences });
  const file = targetVersion.files.find(item => item.path === anchor.filePath);
  if (!file) return empty('file_missing');
  if (!validOffsets(anchor.start, anchor.end) || typeof anchor.quote !== 'string' || !anchor.quote.length
    || anchor.quote.length > MAX_QUOTE_LENGTH || anchor.end - anchor.start !== anchor.quote.length) return empty('changed');

  if (targetVersion.id === anchor.versionId) {
    const originalContext = context(file.content, anchor.start, anchor.end);
    if (targetVersion.contentHash !== anchor.contentHash || anchor.end > file.content.length
      || splitsSurrogatePair(file.content, anchor.start) || splitsSurrogatePair(file.content, anchor.end)
      || file.content.slice(anchor.start, anchor.end) !== anchor.quote
      || originalContext.prefix !== anchor.prefix || originalContext.suffix !== anchor.suffix) return empty('changed');
    return { status: 'original', start: anchor.start, end: anchor.end, occurrences: 1 };
  }

  const { occurrences, first } = occurrencesOf(file.content, anchor.quote);
  if (!occurrences) return empty('changed');
  if (occurrences > 1) return empty('ambiguous', occurrences);
  return { status: 'relocated', start: first, end: first + anchor.quote.length, occurrences };
}

/** Inclusive, one-based LF/CRLF lines; excludes the final selected line's terminator. */
export function lineRange(content: string, startLine: number, endLine: number): PassageInput {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new RangeError('Choose an ordered range of positive integer line numbers.');
  }
  let line = 1, lineStart = 0, start = -1, end = -1;
  for (let offset = 0; offset <= content.length; offset++) {
    if (offset !== content.length && content.charCodeAt(offset) !== 10) continue;
    if (line === startLine) start = lineStart;
    if (line === endLine) {
      end = offset < content.length && offset > lineStart && content.charCodeAt(offset - 1) === 13 ? offset - 1 : offset;
      break;
    }
    line++;
    lineStart = offset + 1;
  }
  if (start < 0 || end < 0) throw new RangeError('The selected line range must exist in the source file.');
  if (start === end) throw new RangeError('Choose a line range containing a nonempty source passage.');
  return { start, end, quote: content.slice(start, end) };
}
