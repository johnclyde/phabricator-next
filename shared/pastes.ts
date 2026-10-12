import type { MentionProof } from './mentions';
import type { ActorAttribution } from './types';
import type { NewObjectAccessInput, ObjectAccess } from './policy';

export const PASTE_MAX_BYTES = 1024 * 1024;
export const PASTE_MAX_TITLE = 255;
export const PASTE_MAX_LANGUAGE = 64;
export const PASTE_MAX_COMMENT = 10_000;
export const PASTE_SNIPPET_LENGTH = 240;
export const PASTE_LIST_MAX_SCAN = 1000;
export const PASTE_LIST_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export type PasteStatus = 'active' | 'archived';
/** PA identifiers avoid the existing P manuscript namespace. */
export interface PasteRecord {
  id: string; title: string; language: string | null; status: PasteStatus; authorId: string;
  /** Advances on metadata or content edits; comments do not advance it. */
  version: number;
  /** Advances only when exact content changes. */
  contentVersion: number; contentHash: string; bytes: number; lineCount: number;
  createdAt: string; updatedAt: string;
}
export interface PasteVersion {
  pasteId: string; number: number; content: string; sha256: string; bytes: number; lineCount: number;
  createdAt: string; attribution: ActorAttribution;
}
export type PasteVersionSummary = Omit<PasteVersion, 'content'>;
export interface PasteVersionsPage { versions: PasteVersionSummary[]; nextBefore: number | null; accessEpoch?: number }
export interface PasteFieldChange { field: 'title' | 'language' | 'status'; oldValue: string | null; newValue: string | null }
export interface PasteTransaction {
  id: string; pasteId: string; sequence: number; pasteVersion: number;
  /** Exact content inspected for a comment, or resulting content for an edit. */
  contentVersion: number; contentHash: string;
  kind: 'create' | 'edit' | 'comment'; createdAt: string; attribution: ActorAttribution;
  snapshot?: PasteRecord; changes?: PasteFieldChange[];
  contentChange?: { from: number; to: number; fromHash: string; toHash: string };
  comment?: string; mentions?: MentionProof;
}
export interface PasteHistory { transactions: PasteTransaction[]; nextBefore: number | null; accessEpoch?: number }
export interface PasteDetail { paste: PasteRecord; version: PasteVersion; history: PasteHistory; access?: ObjectAccess; accessEpoch?: number }
export interface CreatePasteInput { title?: string; language?: string | null; content: string; access?: NewObjectAccessInput }
export interface UpdatePasteInput { expectedVersion: number; title?: string; language?: string | null; content?: string; status?: PasteStatus }
export interface PasteCommentInput { contentVersion: number; body: string }
export interface PasteListQuery {
  query?: string; authorId?: string; language?: string | null; status?: PasteStatus | 'all';
  createdAfter?: string; createdBefore?: string; before?: number; limit?: number;
}
export interface PasteListItem extends PasteRecord { snippet: string }
export interface PastePage { pastes: PasteListItem[]; nextBefore: number | null; accessEpoch?: number }

/** Preserve exact UTF-8 text, including BOM and all newline styles. */
export function validatePasteContent(value: unknown): { content: string; bytes: number; lineCount: number } {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) throw new Error('Paste content must be nonempty valid text without NUL characters.');
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > PASTE_MAX_BYTES) throw new Error('Paste content may contain at most 1 MiB of UTF-8 text.');
  const lineCount = 1 + (value.match(/\r\n|\r|\n/g)?.length ?? 0);
  return { content: value, bytes, lineCount };
}
