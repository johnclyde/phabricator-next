import type { NewObjectAccessInput } from './policy';

/** Imported Word author strings are document metadata, never application principals. */
export interface DocxImportedAttribution { author?: string; date?: string }
export interface DocxFileIdentity { fileId: string; sha256: string; bytes: number }
export interface DocxTextRange { id: string; part: string; blockId: string; text: string }
export interface DocxRun {
  text: string;
  change?: 'inserted' | 'deleted' | 'moveFrom' | 'moveTo';
  rangeId?: string;
  noteId?: string;
  commentIds?: string[];
}
export interface DocxBlock { id: string; part: string; kind: 'paragraph' | 'table-cell'; headingLevel?: number; runs: DocxRun[]; text: string }
export interface DocxNote { id: string; kind: 'footnote' | 'endnote'; blocks: DocxBlock[] }
export interface DocxImportedComment extends DocxImportedAttribution { id: string; blocks: DocxBlock[] }
export interface DocxTrackedChange extends DocxImportedAttribution { id: string; part: string; kind: string; text: string }
export interface DocxProjection {
  format: 'phabricator.docx.projection.v1';
  mainPart: string;
  blocks: DocxBlock[];
  notes: DocxNote[];
  comments: DocxImportedComment[];
  changes: DocxTrackedChange[];
  editableRanges: DocxTextRange[];
  warnings: string[];
}
/** Source File remains a continuing access dependency after package edits. */
export interface DocxSource {
  format: 'docx';
  fileName: string;
  sha256: string;
  bytes: number;
  sourceFile: DocxFileIdentity;
  projection: DocxProjection;
}
export interface DocxInspection { sourceFile: DocxFileIdentity; fileName: string; projection: DocxProjection; accessEpoch: number }
export interface DocxImportInput { projectId?: string | null; projectIds?: string[]; draft?: boolean; title: string; summary?: string; testPlan?: string; sourceFile: DocxFileIdentity; expectedAccessEpoch: number; shareSource: boolean; access?: NewObjectAccessInput }
export interface DocxVersionPins { expectedVersion: number; expectedVersionId: string; expectedContentHash: string; expectedAccessEpoch: number }
export interface DocxReimportInput extends DocxVersionPins { sourceFile: DocxFileIdentity; shareSource: boolean; message: string }
export interface DocxReplacement { rangeId: string; start: number; end: number; quote: string; replacement: string }
export interface DocxReplaceInput extends DocxVersionPins, DocxReplacement { message: string }
export const DOCX_LIMITS = { compressedBytes: 16 * 1024 * 1024, inflatedBytes: 96 * 1024 * 1024, parts: 4096, xmlBytes: 8 * 1024 * 1024, projectionBytes: 2 * 1024 * 1024, replacementLength: 20_000, deadlineMs: 15_000 } as const;
