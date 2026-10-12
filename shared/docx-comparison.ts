import { compareFile, COMPARISON_LIMITS, type ComparisonLimits, type ComparisonMode, type FileComparison } from './comparison.ts';
import type { SourceFile } from './types.ts';

export const DOCX_COMPARISON_SCOPES = Object.freeze(['document', 'footnotes', 'endnotes'] as const);
export type DocxComparisonScopeId = typeof DOCX_COMPARISON_SCOPES[number];
export const DOCX_COMPARISON_SCOPE_LABELS: Readonly<Record<DocxComparisonScopeId, string>> = Object.freeze({ document: 'Main document', footnotes: 'Footnotes', endnotes: 'Endnotes' });
export const DOCX_COMPARISON_NOTICE = 'Projected run text only: deleted and move-from runs are omitted; ordinary, inserted and move-to runs remain. Projection v1 does not fully represent outer, row or paragraph-mark revisions, fields, formatting, objects or page layout. This is not Word’s complete accepted or final text. Imported comment bodies are outside these comparison scopes.';
export const DOCX_COMPARISON_SEPARATORS = 'Comparison adds one LF between stored blocks, two LFs between notes, note-ID headers and note-reference markers. These separators and markers are synthetic. Note IDs and stored order are compared literally, without automatic renumbering or semantic matching.';
/** Bounds apply across the complete projection, not a reader's visible slice. */
export const DOCX_COMPARISON_LIMITS = Object.freeze({ maxBlocks: 8_000, maxRuns: 40_000, maxNotes: 4_000, maxWarnings: 200, maxSourceCodeUnits: 2_000_000, maxMetadataCodeUnits: 2_000_000, maxOutputCodeUnits: COMPARISON_LIMITS.maxInputCodeUnits });
/** Half-open UTF-16 ranges in the synthetic comparison text, never DOCX edit anchors. */
export interface DocxComparisonBoundary { kind: 'block' | 'note' | 'reference'; id: string; start: number; end: number }
export interface DocxComparisonScope { id: DocxComparisonScopeId; label: string; file: SourceFile; boundaries: DocxComparisonBoundary[] }
export interface ReadyDocxComparisonProjection { status: 'ready'; scopes: Record<DocxComparisonScopeId, DocxComparisonScope | null>; warnings: string[] }
export interface UnavailableDocxComparisonProjection { status: 'unavailable'; reason: 'unsupported_projection' | 'invalid_projection' | 'projection_limit'; message: string }
export type DocxComparisonProjection = ReadyDocxComparisonProjection | UnavailableDocxComparisonProjection;

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function isDocxComparisonScope(value: unknown): value is DocxComparisonScopeId { return typeof value === 'string' && (DOCX_COMPARISON_SCOPES as readonly string[]).includes(value); }
class ProjectionFailure extends Error { constructor(readonly reason: UnavailableDocxComparisonProjection['reason'], message: string) { super(message); } }
const invalid = (): never => { throw new ProjectionFailure('invalid_projection', 'This stored Word projection is incomplete or invalid. Download the exact Word versions to inspect them.'); };
const limit = (): never => { throw new ProjectionFailure('projection_limit', 'This Word projection exceeds the bounded text-comparison limit. Download the exact Word versions to inspect them.'); };

/**
 * A read-only projection of the runs we actually stored. In particular, block.text
 * is deliberately never read: it includes deleted text. No fallback to that field
 * or to display slices is safe. There is no package mutation, hash creation, fetch,
 * source persistence, or attempted interpretation of unrepresented Word revisions.
 * Validation finishes before rendering; a failure never returns partial scopes.
 */
export function projectDocxComparison(value: unknown): DocxComparisonProjection {
  if (!record(value) || value.format !== 'phabricator.docx.projection.v1') return { status: 'unavailable', reason: 'unsupported_projection', message: 'This Word projection format is not supported for text comparison. Download the exact Word versions to inspect them.' };
  try {
    let blocks = 0, runs = 0, sourceUnits = 0, metadataUnits = 0, outputUnits = 0;
    const metadata = (item: unknown, allowEmpty = false): string => {
      if (typeof item !== 'string' || !allowEmpty && !item.length) return invalid();
      metadataUnits += item.length;
      if (metadataUnits > DOCX_COMPARISON_LIMITS.maxMetadataCodeUnits || item.length > 4_000) return limit();
      return item;
    };
    const list = (item: unknown, maximum: number): unknown[] => { if (!Array.isArray(item)) return invalid(); if (item.length > maximum) return limit(); return item; };
    metadata(value.mainPart);
    const main = list(value.blocks, DOCX_COMPARISON_LIMITS.maxBlocks);
    const notes = list(value.notes, DOCX_COMPARISON_LIMITS.maxNotes);
    const warnings = list(value.warnings, DOCX_COMPARISON_LIMITS.maxWarnings).map(item => metadata(item, true));
    // These structures are outside text coverage; check the v1 envelope without
    // walking or copying their potentially large source bodies.
    for (const field of ['comments', 'changes', 'editableRanges']) list(value[field], DOCX_COMPARISON_LIMITS.maxRuns);
    const blockIds = new Set<string>(), noteIds = new Set<string>();
    const validateBlocks = (items: unknown[]) => {
      blocks += items.length; if (blocks > DOCX_COMPARISON_LIMITS.maxBlocks) return limit();
      for (const item of items) {
        if (!record(item) || item.kind !== 'paragraph' && item.kind !== 'table-cell') return invalid();
        const id = metadata(item.id); metadata(item.part);
        if (blockIds.has(id)) return invalid(); blockIds.add(id);
        const children = list(item.runs, DOCX_COMPARISON_LIMITS.maxRuns);
        runs += children.length; if (runs > DOCX_COMPARISON_LIMITS.maxRuns) return limit();
        for (const child of children) {
          if (!record(child) || typeof child.text !== 'string' || child.change !== undefined && (typeof child.change !== 'string' || !['inserted', 'deleted', 'moveFrom', 'moveTo'].includes(child.change))) return invalid();
          sourceUnits += child.text.length; if (sourceUnits > DOCX_COMPARISON_LIMITS.maxSourceCodeUnits) return limit();
          if (child.noteId !== undefined) metadata(child.noteId);
        }
      }
    };
    validateBlocks(main);
    for (const item of notes) {
      if (!record(item) || item.kind !== 'footnote' && item.kind !== 'endnote') return invalid();
      const id = metadata(item.id); if (noteIds.has(id)) return invalid(); noteIds.add(id);
      validateBlocks(list(item.blocks, DOCX_COMPARISON_LIMITS.maxBlocks));
    }
    const scope = (id: DocxComparisonScopeId): DocxComparisonScope => {
      const chunks: string[] = [], boundaries: DocxComparisonBoundary[] = []; let length = 0;
      const append = (text: string) => { outputUnits += text.length; if (outputUnits > DOCX_COMPARISON_LIMITS.maxOutputCodeUnits) return limit(); chunks.push(text); length += text.length; };
      const renderBlocks = (items: unknown[]) => {
        items.forEach((raw, index) => {
          const block = raw as Record<string, unknown>; if (index) append('\n'); const start = length;
          for (const child of block.runs as Record<string, unknown>[]) {
            if (child.change === 'deleted' || child.change === 'moveFrom') continue;
            append(child.text as string);
            if (typeof child.noteId === 'string') {
              const referenceStart = length; append(`[Note reference: ${child.noteId}]`);
              boundaries.push({ kind: 'reference', id: child.noteId, start: referenceStart, end: length });
            }
          }
          boundaries.push({ kind: 'block', id: block.id as string, start, end: length });
        });
      };
      if (id === 'document') renderBlocks(main);
      else {
        const kind = id === 'footnotes' ? 'footnote' : 'endnote'; let count = 0;
        for (const raw of notes) {
          const note = raw as Record<string, unknown>; if (note.kind !== kind) continue;
          if (count++) append('\n\n'); const start = length;
          append(`[${kind === 'footnote' ? 'Footnote' : 'Endnote'} ID: ${note.id as string}]`);
          const items = note.blocks as unknown[]; if (items.length) append('\n'); renderBlocks(items);
          boundaries.push({ kind: 'note', id: note.id as string, start, end: length });
        }
      }
      return { id, label: DOCX_COMPARISON_SCOPE_LABELS[id], file: { path: id, content: chunks.join('') }, boundaries };
    };
    return { status: 'ready', scopes: { document: scope('document'), footnotes: notes.some(item => (item as Record<string, unknown>).kind === 'footnote') ? scope('footnotes') : null, endnotes: notes.some(item => (item as Record<string, unknown>).kind === 'endnote') ? scope('endnotes') : null }, warnings: [DOCX_COMPARISON_NOTICE, DOCX_COMPARISON_SEPARATORS, ...warnings] };
  } catch (error) {
    if (error instanceof ProjectionFailure) return { status: 'unavailable', reason: error.reason, message: error.message };
    throw error;
  }
}

export function docxComparisonScopes(before: ReadyDocxComparisonProjection | null, after: ReadyDocxComparisonProjection): DocxComparisonScopeId[] {
  return DOCX_COMPARISON_SCOPES.filter(id => Boolean(before?.scopes[id] || after.scopes[id]));
}
export function compareDocxScope(before: ReadyDocxComparisonProjection | null, after: ReadyDocxComparisonProjection, scope: DocxComparisonScopeId, mode: ComparisonMode = 'words', limits: Partial<ComparisonLimits> = {}): FileComparison {
  if (!isDocxComparisonScope(scope)) throw new RangeError('Choose an explicit Word comparison scope.');
  return compareFile(before?.scopes[scope]?.file ?? null, after.scopes[scope]?.file ?? null, mode, limits);
}
