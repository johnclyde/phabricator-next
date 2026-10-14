import { DOCX_LIMITS, type DocxBlock, type DocxProjection, type DocxVersionPins } from './docx';

/** Offsets are UTF-16 code units in one complete stored main-story paragraph. */
export interface DocxPassageReplacement { blockId: string; start: number; end: number; quote: string; replacement: string }
export interface DocxReplaceBatchInput extends DocxVersionPins { replacements: DocxPassageReplacement[]; message: string }
export const DOCX_BATCH_LIMITS = { serializedBytes: 512 * 1024 } as const;
/** Stable request identity; does not normalize or reorder passages or literal text. */
export function docxBatchInputCanonical(input: DocxReplaceBatchInput): string {
  return JSON.stringify({ expectedVersion: input.expectedVersion, expectedVersionId: input.expectedVersionId, expectedContentHash: input.expectedContentHash, expectedAccessEpoch: input.expectedAccessEpoch,
    replacements: input.replacements.map(edit => ({ blockId: edit.blockId, start: edit.start, end: edit.end, quote: edit.quote, replacement: edit.replacement })), message: input.message });
}

/** The package processor additionally verifies the original XML structure. */
export function docxBatchParagraphs(projection: DocxProjection): DocxBlock[] {
  const ranges = new Map(projection.editableRanges.map(range => [range.id, range]));
  return projection.blocks.filter(block => block.part === projection.mainPart && block.kind === 'paragraph' && block.runs.length > 0
    && block.runs.every(run => {
      const range = run.rangeId && ranges.get(run.rangeId);
      return !run.change && !run.noteId && !run.commentIds?.length && range && range.blockId === block.id && range.part === block.part && range.text === run.text;
    }) && block.runs.map(run => run.text).join('') === block.text);
}

const splitCharacter = (text: string, offset: number) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!);
/** Validate the complete batch before processing or storing any version. No passage-count cap. */
export function validateDocxBatch(projection: DocxProjection, replacements: readonly DocxPassageReplacement[]): void {
  if (!Array.isArray(replacements) || !replacements.length) throw new Error('Choose at least one Word passage.');
  if (new TextEncoder().encode(JSON.stringify(replacements)).length > DOCX_BATCH_LIMITS.serializedBytes) throw new Error('The complete Word edit selection exceeds 512 KiB.');
  const paragraphs = new Map(docxBatchParagraphs(projection).map(block => [block.id, block]));
  const selected = new Map<string, DocxPassageReplacement[]>();
  for (const edit of replacements) {
    if (!edit || typeof edit.blockId !== 'string' || typeof edit.quote !== 'string' || typeof edit.replacement !== 'string' || !Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end)) throw new Error('Choose exact Word paragraph passages.');
    const paragraph = paragraphs.get(edit.blockId);
    if (!paragraph) throw new Error('That Word paragraph is unsupported or does not match this source.');
    if (edit.start < 0 || edit.end <= edit.start || edit.end > paragraph.text.length || paragraph.text.slice(edit.start, edit.end) !== edit.quote || splitCharacter(paragraph.text, edit.start) || splitCharacter(paragraph.text, edit.end)) throw new Error('Every Word quotation must exactly match its paragraph without splitting a character.');
    if (edit.quote.length > DOCX_LIMITS.replacementLength || edit.replacement.length > DOCX_LIMITS.replacementLength || /[\u0000-\u001F\uFFFE\uFFFF]/u.test(edit.replacement) || /[\uD800-\uDFFF]/u.test(edit.replacement)) throw new Error('Each Word passage and replacement supports at most 20,000 characters; replacements must be single-line text.');
    if (edit.quote === edit.replacement) throw new Error('Every selected Word replacement must change its original quotation.');
    const group = selected.get(edit.blockId) ?? []; group.push(edit); selected.set(edit.blockId, group);
  }
  for (const group of selected.values()) {
    const sorted = [...group].sort((a, b) => a.start - b.start);
    for (let index = 1; index < sorted.length; index++) if (sorted[index]!.start < sorted[index - 1]!.end) throw new Error('Word passages must not overlap. Remove or combine the overlapping edits.');
  }
}
