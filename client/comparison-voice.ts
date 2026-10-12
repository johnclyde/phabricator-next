import type { FileComparison, ReadyComparison } from '../shared/comparison';
import { comparisonPassages } from '../shared/comparison-navigation';

interface SpokenVersion { id: string; number: number; contentHash: string }
export interface ComparisonVoiceSnapshot {
  revisionId: string;
  base: SpokenVersion | null;
  target: SpokenVersion;
  filePath: string;
  result: FileComparison;
  passageIndex: number;
  skipSpaceTabOnly?: boolean;
  paragraphAlignment?: boolean;
  word?: { scopeLabel: string; basePackageSha256: string | null; targetPackageSha256: string };
}

export const COMPARISON_SPEECH_LIMIT = 2_200;
const EXCERPT_LIMIT = 220;
const PASSAGE_LIMIT = 3;

/** Unicode code-point clipping never separates a surrogate pair. */
function clip(value: string, limit: number): { text: string; shortened: boolean } {
  const points = Array.from(value);
  if (points.length <= limit) return { text: value, shortened: false };
  let text = points.slice(0, limit).join('');
  const boundary = text.lastIndexOf(' ');
  if (boundary > text.length - 35 && boundary > text.length / 2) text = text.slice(0, boundary);
  return { text, shortened: true };
}

function whitespaceName(value: string, count: number): string {
  const name = value === ' ' ? 'space' : value === '\t' ? 'tab' : value === '\n' ? 'line feed' : value === '\r' ? 'carriage return' : value === '\u00a0' ? 'non-breaking space' : `Unicode whitespace U+${value.codePointAt(0)!.toString(16).toUpperCase()}`;
  return count === 1 ? name : `${count} ${name}${name.startsWith('Unicode') ? ' characters' : 's'}`;
}

function excerpt(value: string): string {
  if (!value.length) return 'empty text';
  const selected = clip(value, EXCERPT_LIMIT);
  const points = Array.from(selected.text);
  const whitespaceOnly = points.every(point => /\s/u.test(point));
  const parts: string[] = [];
  for (let index = 0; index < points.length;) {
    const point = points[index]!;
    if (!/\s/u.test(point)) { parts.push(point); index++; continue; }
    let end = index + 1;
    while (points[end] === point) end++;
    const count = end - index;
    // Ordinary word separators remain readable. Other whitespace, including
    // leading/trailing spaces, is named so whitespace-only changes are audible.
    parts.push(point === ' ' && count === 1 && index > 0 && end < points.length && !whitespaceOnly
      ? ' ' : ` [${whitespaceName(point, count)}] `);
    index = end;
  }
  return `${parts.join('').trim()}${selected.shortened ? ' … Excerpt shortened.' : ''}`;
}

function passage(result: ReadyComparison, index: number, position: number, count: number, filtered: boolean): string {
  const selected = result.passages[index]!;
  const segments = result.segments.slice(selected.segmentStart, selected.segmentEnd);
  const removed = segments.filter(segment => segment.kind === 'removed').map(segment => segment.text).join('');
  const added = segments.filter(segment => segment.kind === 'added').map(segment => segment.text).join('');
  return `Change ${position + 1} of ${count}${filtered ? ' under this filter' : ''}. ${removed ? `Removed text: ${excerpt(removed)}. ` : ''}${added ? `Added text: ${excerpt(added)}.` : ''}`.trim();
}

/**
 * Narrates an already-selected, already-authorized comparison. It never reads a
 * cache, chooses latest versions, computes another diff, invokes AI, or speaks.
 * The caller owns current selection/session checks and local speech playback.
 */
export function comparisonNarration(snapshot: ComparisonVoiceSnapshot, scope: 'all' | 'current' = 'all'): string {
  if (snapshot.filePath !== snapshot.result.filePath || !/^[DPL][1-9]\d*$/.test(snapshot.revisionId)
    || !Number.isSafeInteger(snapshot.target.number) || snapshot.target.number < 1
    || (snapshot.base !== null && (!Number.isSafeInteger(snapshot.base.number) || snapshot.base.number < 1))
    || (snapshot.word && (!['document', 'footnotes', 'endnotes'].includes(snapshot.filePath) || !snapshot.word.scopeLabel || !/^[a-f0-9]{64}$/.test(snapshot.word.targetPackageSha256) || (snapshot.base === null ? snapshot.word.basePackageSha256 !== null : !/^[a-f0-9]{64}$/.test(snapshot.word.basePackageSha256 || ''))))) {
    return 'The selected comparison is unavailable. Choose the versions and file again.';
  }
  const filename = clip(snapshot.filePath, 160);
  const versions = `${snapshot.revisionId}, ${snapshot.base ? `version ${snapshot.base.number}` : 'empty base'} to version ${snapshot.target.number}`;
  const header = snapshot.word ? `${versions}, Word projected text, ${clip(snapshot.word.scopeLabel, 160).text}. ` : `${versions}, file ${filename.text}${filename.shortened ? ' (filename shortened)' : ''}. `;
  const result = snapshot.result;
  const filtered = snapshot.skipSpaceTabOnly === true;
  const filterNotice = filtered ? 'Space and tab-only changes are skipped for navigation. All literal changes remain visible. ' : '';
  let body: string;
  if (result.status === 'too_large') {
    body = snapshot.word ? 'This projected scope exceeds the comparison limit. No changes were summarized. Read the selected projected text or download the exact Word packages.' : 'This file exceeds the comparison limit. No changes were summarized. Read or download the selected source versions.';
  } else if (!result.passages.length) {
    body = snapshot.word ? result.fileChange === 'added' ? 'Empty projected scope added.' : result.fileChange === 'removed' ? 'Empty projected scope removed.' : 'No projected text changes in this scope. This does not establish Word package equality.' : result.fileChange === 'added' ? 'Empty file added.' : result.fileChange === 'removed' ? 'Empty file deleted.' : 'No text changes in this file.';
  } else {
    const fileChange = result.fileChange === 'added' ? snapshot.word ? 'Projected scope added. ' : 'File added. ' : result.fileChange === 'removed' ? snapshot.word ? 'Projected scope removed. ' : 'File deleted. ' : '';
    const navigation = comparisonPassages(result, filtered);
    const position = navigation.indexes.indexOf(snapshot.passageIndex);
    const counts = filtered ? `Navigating ${navigation.indexes.length} of ${result.passages.length} changed ${result.passages.length === 1 ? 'passage' : 'passages'}. ${navigation.skipped} space/tab-only ${navigation.skipped === 1 ? 'passage' : 'passages'} skipped. ` : '';
    if (!navigation.indexes.length) {
      body = counts + 'No changed passages remain under this filter. Turn the filter off to navigate every literal change.';
    } else if (scope === 'current') {
      body = fileChange + counts + (position >= 0
        ? passage(result, snapshot.passageIndex, position, navigation.indexes.length, filtered) : 'Select a changed passage first.');
    } else {
      body = fileChange + (filtered ? counts : `${result.passages.length} changed ${result.passages.length === 1 ? 'passage' : 'passages'}. `)
        + (navigation.indexes.length > PASSAGE_LIMIT ? `Reading the first ${PASSAGE_LIMIT}. Use next change to continue through the selected ${snapshot.word ? 'Word scope' : 'file'}. ` : '')
        + navigation.indexes.slice(0, PASSAGE_LIMIT).map((index, ordinal) => passage(result, index, ordinal, navigation.indexes.length, filtered)).join(' ');
    }
  }
  const notice = ' … Reading stopped at the speech length limit. Use read current change to hear one passage.';
  const paragraphNotice = snapshot.paragraphAlignment && !snapshot.word ? 'Source paragraph alignment. Exact paragraph matches describe source text, not rendered structure. ' : '';
  const narration = header + paragraphNotice + filterNotice + body + (snapshot.word ? ' This stored projection has limited tracked-change coverage; it is not fully accepted Word text.' : '');
  const bounded = clip(narration, COMPARISON_SPEECH_LIMIT - Array.from(notice).length);
  return bounded.shortened ? bounded.text + notice : narration;
}
