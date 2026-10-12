import type { RevisionDetail, RevisionVersion } from '../shared/types.ts';
import { docxComparisonScopes, isDocxComparisonScope, projectDocxComparison, type DocxComparisonScopeId, type ReadyDocxComparisonProjection } from '../shared/docx-comparison.ts';
import type { ComparisonSelection, VersionIdentity } from './comparison-model.ts';

export interface DocxVersionIdentity extends VersionIdentity { packageSha256: string }
export interface DocxComparisonSelection extends Omit<ComparisonSelection, 'base' | 'target' | 'filePath' | 'view'> {
  base: DocxVersionIdentity | null;
  target: DocxVersionIdentity;
  filePath: DocxComparisonScopeId;
  view: 'changes';
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function identity(value: unknown): value is DocxVersionIdentity { return record(value) && id(value.id) && hash(value.contentHash) && hash(value.packageSha256); }
export function docxVersionIdentity(version: RevisionVersion): DocxVersionIdentity | null {
  if (!id(version.id) || !hash(version.contentHash) || version.docx?.format !== 'docx' || !hash(version.docx.sha256)) return null;
  return { id: version.id, contentHash: version.contentHash, packageSha256: version.docx.sha256 };
}
export function isDocxComparisonSelection(value: unknown, revisionId: string): value is DocxComparisonSelection {
  return record(value) && id(revisionId) && value.revisionId === revisionId && (value.base === null || identity(value.base)) && identity(value.target) && isDocxComparisonScope(value.filePath) && (value.mode === 'words' || value.mode === 'lines') && value.view === 'changes' && (value.skipSpaceTabOnly === undefined || typeof value.skipSpaceTabOnly === 'boolean');
}
function find(detail: RevisionDetail, pin: DocxVersionIdentity): RevisionVersion | null {
  const matches = detail.versions.filter(version => version.id === pin.id);
  if (matches.length !== 1) return null;
  const version = matches[0]!;
  return version.revisionId === detail.revision.id && Number.isSafeInteger(version.number) && version.number > 0 && version.contentHash === pin.contentHash && version.docx?.format === 'docx' && version.docx.sha256 === pin.packageSha256 ? version : null;
}
/** Omit initialTarget only when deliberately choosing the head. A retired reader target never falls back to it. */
export function defaultDocxComparison(detail: RevisionDetail, initialTarget?: DocxVersionIdentity | null): DocxComparisonSelection | null {
  const target = initialTarget === undefined ? detail.versions.find(version => version.number === detail.revision.currentVersion) : initialTarget && identity(initialTarget) ? find(detail, initialTarget) : null;
  if (!target || target.revisionId !== detail.revision.id || !Number.isSafeInteger(target.number) || target.number < 1) return null;
  const targetPin = docxVersionIdentity(target); if (!targetPin) return null;
  const candidates = detail.versions.filter(version => version.revisionId === detail.revision.id && version.number === target.number - 1);
  if (candidates.length > 1 || target.number > 1 && candidates.length !== 1) return null;
  const base = candidates[0];
  const basePin = base ? docxVersionIdentity(base) : null;
  if (base && !basePin) return null;
  return { revisionId: detail.revision.id, base: basePin, target: targetPin, filePath: 'document', mode: 'words', view: 'changes' };
}
export interface ResolvedDocxComparison { base: RevisionVersion | null; target: RevisionVersion; before: ReadyDocxComparisonProjection | null; after: ReadyDocxComparisonProjection; scopes: DocxComparisonScopeId[]; samePackage: boolean }
export function resolveDocxComparison(detail: RevisionDetail, selection: DocxComparisonSelection): ResolvedDocxComparison | { error: string } {
  if (!isDocxComparisonSelection(selection, detail.revision.id)) return { error: 'The saved Word comparison has invalid version or package identities. Choose versions explicitly, or compare the selected reader version.' };
  const target = find(detail, selection.target), base = selection.base ? find(detail, selection.base) : null;
  if (!target || selection.base && !base) return { error: 'A selected immutable Word version is unavailable or its snapshot/package hash does not match. Choose versions explicitly, or compare the selected reader version.' };
  const before = base ? projectDocxComparison(base.docx!.projection) : null, after = projectDocxComparison(target.docx!.projection);
  if (before?.status === 'unavailable') return { error: `Base version: ${before.message}` };
  if (after.status === 'unavailable') return { error: `Target version: ${after.message}` };
  const scopes = docxComparisonScopes(before, after);
  if (!scopes.includes(selection.filePath)) return { error: 'The selected Word scope is absent from this exact pair. Choose a scope explicitly.' };
  return { base, target, before, after, scopes, samePackage: base !== null && base.docx!.sha256 === target.docx!.sha256 };
}
/** Only exact pins and presentation preferences persist; never projection/source or narration text. */
export function docxComparisonMetadata(selection: DocxComparisonSelection): DocxComparisonSelection {
  const copy = (pin: DocxVersionIdentity): DocxVersionIdentity => ({ id: pin.id, contentHash: pin.contentHash, packageSha256: pin.packageSha256 });
  return { revisionId: selection.revisionId, base: selection.base && copy(selection.base), target: copy(selection.target), filePath: selection.filePath, mode: selection.mode, view: selection.view, ...(selection.skipSpaceTabOnly === undefined ? {} : { skipSpaceTabOnly: selection.skipSpaceTabOnly }) };
}
export function docxComparisonIdentity(selection: DocxComparisonSelection): string {
  const pin = (value: DocxVersionIdentity) => [value.id, value.contentHash, value.packageSha256];
  return JSON.stringify([selection.revisionId, selection.base && pin(selection.base), pin(selection.target), selection.filePath, selection.mode, selection.view, Boolean(selection.skipSpaceTabOnly)]);
}
