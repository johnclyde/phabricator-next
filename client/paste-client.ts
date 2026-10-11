import type { CreatePasteInput, PasteCommentInput, PasteRecord, PasteTransaction, PasteVersion, UpdatePasteInput } from '../shared/pastes';
import type { MutationMethod } from './offline';
export const PASTE_LANGUAGES = ['plaintext', 'bash', 'c', 'cpp', 'css', 'diff', 'go', 'java', 'javascript', 'json', 'latex', 'tex', 'markdown', 'php', 'python', 'ruby', 'rust', 'sql', 'typescript', 'xml', 'yaml'] as const;
export const PASTE_HIGHLIGHT_LIMIT = 100_000;
export interface PasteDraft { title: string; language: string; content: string }
export interface PasteIntent { id: string; kind: 'create' | 'edit' | 'comment'; path: string; method: MutationMethod; body: CreatePasteInput | UpdatePasteInput | PasteCommentInput; draftKey: string; draft: unknown; contentHash?: string }
export interface PasteSelection { number: number; sha256: string }
export interface PasteLine { number: number; text: string; start: number; end: number }
/** Compact UTF-16 starts plus end sentinel; preserves every original newline byte. */
export function pasteLineOffsets(content: string): Uint32Array {
  let count = 1;
  for (let index = 0; index < content.length; index++) { if (content[index] === '\r') { count++; if (content[index + 1] === '\n') index++; } else if (content[index] === '\n') count++; }
  const offsets = new Uint32Array(count + 1); let line = 1;
  for (let index = 0; index < content.length; index++) { if (content[index] === '\r') { if (content[index + 1] === '\n') index++; offsets[line++] = index + 1; } else if (content[index] === '\n') offsets[line++] = index + 1; }
  offsets[count] = content.length; return offsets;
}
/** Build only bounded visible line objects; ranges use compact offsets directly. */
export function pasteLines(content: string, limit = 5000, offsets = pasteLineOffsets(content)): PasteLine[] {
  const lines: PasteLine[] = [];
  for (let index = 0; index < Math.min(offsets.length - 1, limit, 5000); index++) { const start = offsets[index]!, end = offsets[index + 1]!; let stop = end; if (content[stop - 1] === '\n') stop--; if (content[stop - 1] === '\r') stop--; lines.push({ number: index + 1, text: content.slice(start, Math.max(start, stop)), start, end }); }
  return lines;
}
export function pasteReceiptMatches(value: PasteRecord | PasteTransaction, intent: PasteIntent): boolean {
  if (intent.kind === 'comment') { const input = intent.body as PasteCommentInput; return 'kind' in value && value.kind === 'comment' && value.pasteId === intent.path.split('/')[3] && value.contentVersion === input.contentVersion && value.comment === input.body.trim(); }
  if (!('title' in value) || !/^PA[1-9]\d*$/.test(value.id)) return false;
  const input = intent.body as CreatePasteInput & UpdatePasteInput;
  if (intent.kind === 'edit' && (value.id !== intent.path.split('/')[3] || ![input.expectedVersion, input.expectedVersion + 1].includes(value.version))) return false;
  return (input.title === undefined || value.title === input.title.trim()) && (input.language === undefined || value.language === (input.language?.trim() || null)) && (input.status === undefined || value.status === input.status) && (intent.contentHash === undefined || value.contentHash === intent.contentHash);
}
export function pasteVersionMatches(version: PasteVersion, id: string, selection?: PasteSelection | null): boolean { return version.pasteId === id && (!selection || version.number === selection.number && version.sha256 === selection.sha256); }
export interface PasteToken { text: string; classes: string[] }
/** Decode only the escaping emitted by highlight.js. Unknown markup fails closed. */
export function safePasteTokens(html: string, source: string): PasteToken[] {
  const tokens: PasteToken[] = [], stack: string[][] = []; let cursor = 0;
  const decode = (value: string) => value.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_whole, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" }[entity]!));
  for (const match of html.matchAll(/<span class="([a-zA-Z0-9_ -]+)">|<\/span>|([^<]+)/g)) {
    if (match.index !== cursor || tokens.length > 20_000) return [{ text: source, classes: [] }]; cursor += match[0].length;
    if (match[1]) { const classes = match[1].split(' '); if (stack.length > 64 || classes.some(value => !/^(?:hljs-)?[A-Za-z][A-Za-z0-9_-]*$/.test(value))) return [{ text: source, classes: [] }]; stack.push(classes); }
    else if (match[0] === '</span>') { if (!stack.length) return [{ text: source, classes: [] }]; stack.pop(); }
    else tokens.push({ text: decode(match[2] || ''), classes: stack.flat() });
  }
  return cursor !== html.length || stack.length || tokens.map(token => token.text).join('') !== source ? [{ text: source, classes: [] }] : tokens;
}
export function pasteTokenLines(tokens: PasteToken[], lines: PasteLine[]): PasteToken[][] {
  const output = lines.map(() => [] as PasteToken[]); let offset = 0, index = 0;
  for (const token of tokens) { const end = offset + token.text.length; while (index < lines.length && lines[index]!.start < end) { const line = lines[index]!, start = Math.max(offset, line.start), stop = Math.min(end, line.start + line.text.length); if (stop > start) output[index]!.push({ text: token.text.slice(start - offset, stop - offset), classes: token.classes }); if (line.end >= end) break; index++; } offset = end; }
  return output;
}
