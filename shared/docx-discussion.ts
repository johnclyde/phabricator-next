import { DOCX_LIMITS } from './docx';
import type { RevisionVersion } from './types';

export interface DocxPassageInput { rangeId: string; start: number; end: number; quote: string }
export interface DocxPassageAnchor extends DocxPassageInput { versionId: string; contentHash: string; part: string; blockId: string; prefix: string; suffix: string }
export interface DocxPackageComment { passage: DocxPassageInput; author: string; date: string; body: string }
export interface DocxDiscussionThreadPin { threadId: string; expectedThreadVersion: number }
export interface DocxDiscussionExportInput { versionId: string; contentHash: string; expectedAccessEpoch: number; threads: DocxDiscussionThreadPin[] }
export interface DocxDiscussionExport {
  format: 'phabricator.docx.discussion-export.v1';
  revisionId: string; versionId: string; versionNumber: number; contentHash: string;
  sourceSha256: string; accessEpoch: number; threads: DocxDiscussionThreadPin[];
  fileName: string; bytes: number; sha256: string; dataBase64: string;
}
export const DOCX_DISCUSSION_LIMITS = { threads: 64, bodyLength: 500_000, quoteLength: 20_000 } as const;
const split = (value: string, offset: number) => offset > 0 && offset < value.length && /[\uD800-\uDBFF]/.test(value[offset - 1]!) && /[\uDC00-\uDFFF]/.test(value[offset]!);

/** Word ranges are bound to the original package projection, never relocated by quotation. */
export function createDocxPassageAnchor(version: RevisionVersion, input: DocxPassageInput): DocxPassageAnchor {
  const projection = version.docx?.projection;
  if (!projection || !input || typeof input.rangeId !== 'string' || input.rangeId.length > 2000) throw new RangeError('Choose a supported passage in this Word version.');
  const ranges = projection.editableRanges.filter(range => range.id === input.rangeId);
  const range = ranges[0];
  if (ranges.length !== 1 || !range || range.part !== projection.mainPart || !projection.blocks.some(block => block.id === range.blockId && block.part === range.part && block.runs.some(run => run.rangeId === range.id && run.text === range.text))) throw new RangeError('Choose an ordinary text passage in the main Word document.');
  if (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end) || input.start < 0 || input.end <= input.start || input.end > range.text.length || input.end - input.start > DOCX_DISCUSSION_LIMITS.quoteLength || split(range.text, input.start) || split(range.text, input.end)) throw new RangeError('Choose a nonempty Word passage of at most 20,000 characters without splitting a Unicode character.');
  const quote = range.text.slice(input.start, input.end);
  if (typeof input.quote !== 'string' || input.quote !== quote) throw new RangeError('The quotation must match the original Word passage exactly.');
  let before = Math.max(0, input.start - 80), after = Math.min(range.text.length, input.end + 80);
  if (split(range.text, before)) before++;
  if (split(range.text, after)) after--;
  return { versionId: version.id, contentHash: version.contentHash, part: range.part, blockId: range.blockId, rangeId: range.id, start: input.start, end: input.end, quote, prefix: range.text.slice(before, input.start), suffix: range.text.slice(input.end, after) };
}

export function validDocxPassageAnchor(value: DocxPassageAnchor, version: RevisionVersion): boolean {
  try {
    const expected = createDocxPassageAnchor(version, value);
    return (Object.keys(expected) as (keyof DocxPassageAnchor)[]).every(key => expected[key] === value[key]);
  } catch { return false; }
}

export function docxDiscussionFilename(id: string, number: number): string {
  if (!/^[DPL][1-9]\d{0,14}$/.test(id) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid Word export identity.');
  return `${id}-v${number}-discussion.docx`;
}

/** Structure and all selected identities must match before decoding potentially large bytes. */
export function validDocxDiscussionExport(value: unknown, id: string, input: DocxDiscussionExportInput, version: RevisionVersion): value is DocxDiscussionExport {
  if (!value || typeof value !== 'object' || !/^[DPL][1-9]\d{0,14}$/.test(id) || !Number.isSafeInteger(version.number) || version.number < 1 || !version.docx || version.revisionId !== id || version.id !== input.versionId || version.contentHash !== input.contentHash || !Array.isArray(input.threads) || !input.threads.length || input.threads.length > DOCX_DISCUSSION_LIMITS.threads || input.threads.some(pin => !pin || typeof pin.threadId !== 'string' || !pin.threadId.length || pin.threadId.length > 100 || !Number.isSafeInteger(pin.expectedThreadVersion) || pin.expectedThreadVersion < 1) || new Set(input.threads.map(pin => pin.threadId)).size !== input.threads.length) return false;
  const result = value as Partial<DocxDiscussionExport>;
  if (result.format !== 'phabricator.docx.discussion-export.v1' || result.revisionId !== id || result.versionId !== version.id || result.versionNumber !== version.number || result.contentHash !== version.contentHash || result.sourceSha256 !== version.docx.sha256 || !Number.isSafeInteger(result.accessEpoch) || result.accessEpoch! < 0 || result.accessEpoch !== input.expectedAccessEpoch || !Array.isArray(result.threads) || result.threads.length !== input.threads.length || result.threads.some((pin, index) => !pin || pin.threadId !== input.threads[index]!.threadId || pin.expectedThreadVersion !== input.threads[index]!.expectedThreadVersion)) return false;
  if (result.fileName !== docxDiscussionFilename(id, version.number) || !Number.isSafeInteger(result.bytes) || result.bytes! < 1 || result.bytes! > DOCX_LIMITS.compressedBytes || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256) || typeof result.dataBase64 !== 'string' || result.dataBase64.length !== 4 * Math.ceil(result.bytes! / 3)) return false;
  const padding = (3 - result.bytes! % 3) % 3;
  return result.dataBase64.endsWith('='.repeat(padding)) && !/[^A-Za-z0-9+/]/.test(result.dataBase64.slice(0, result.dataBase64.length - padding));
}

export async function docxDiscussionBytes(value: unknown, id: string, input: DocxDiscussionExportInput, version: RevisionVersion): Promise<Uint8Array<ArrayBuffer>> {
  if (!validDocxDiscussionExport(value, id, input, version)) throw new Error('The Word export does not match the selected version, discussion, access snapshot, or size limit.');
  const binary = atob(value.dataBase64);
  if (binary.length !== value.bytes || btoa(binary) !== value.dataBase64) throw new Error('The Word export encoding or byte length is invalid.');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== value.sha256) throw new Error('The Word export SHA-256 does not match its bytes.');
  return bytes;
}
