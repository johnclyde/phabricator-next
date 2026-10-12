import { parseTranscriptEditInput, type TranscriptEditInput } from '../shared/transcript-edit';

export type TranscriptEditVoiceAction = 'readTranscriptEdit' | 'previewTranscriptEdit' | 'confirmTranscriptEdit' | 'cancelTranscriptEdit';
export interface TranscriptEditController {
  revisionId: string;
  readonly identity: string;
  execute(action: TranscriptEditVoiceAction): { text: string; identity: string };
}
export type RegisterTranscriptEdit = (controller: TranscriptEditController | null) => void;
export const TRANSCRIPT_EDIT_SPEECH_LIMIT = 3000;

function clip(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit - 24).join('') + ' … Excerpt shortened.';
}
function excerpt(text: string): string {
  const parts: string[] = [], points = Array.from(text);
  for (let index = 0; index < Math.min(points.length, 1200);) {
    const point = points[index]!;
    if (!/\s/u.test(point)) { parts.push(point); index++; continue; }
    let end = index + 1;
    while (points[end] === point) end++;
    const count = end - index;
    const name = point === ' ' ? 'space' : point === '\t' ? 'tab' : point === '\n' ? 'line feed' : point === '\r' ? 'carriage return' : point === '\u00a0' ? 'non-breaking space' : `Unicode whitespace U+${point.codePointAt(0)!.toString(16).toUpperCase()}`;
    parts.push(point === ' ' && count === 1 && index > 0 && end < points.length ? ' ' : ` [${count > 1 ? `${count} ` : ''}${name}${count > 1 ? 's' : ''}] `);
    index = end;
  }
  return clip(parts.join('').trim() + (points.length > 1200 ? ' … Excerpt shortened.' : ''), 1250);
}

/** Reads a caller-authorized snapshot. `confirmed` means a prepared preview, never a saved version. */
export function transcriptEditNarration(value: TranscriptEditInput, confirmed: boolean): string {
  let input: TranscriptEditInput;
  try { input = parseTranscriptEditInput(value); } catch { return 'This transcript edit is unavailable. Select an exact source passage and prepare a new preview.'; }
  const target = input.target;
  const location = target.kind === 'text' ? `file ${clip(target.anchor.filePath, 180)}` : 'supported Word passage';
  const original = target.kind === 'text' ? target.anchor.quote : target.quote;
  return clip(`${input.revisionId}, original version ${input.expectedVersion}, ${location}. Original passage: ${excerpt(original)}. Replacement: ${excerpt(input.replacement)}. ${confirmed ? 'This preview is ready. Say confirm transcript edit to submit it, or cancel transcript edit to keep the draft without confirming.' : 'Prepare a current preview before confirming.'} Nothing has been saved by reading this preview.`, TRANSCRIPT_EDIT_SPEECH_LIMIT);
}
