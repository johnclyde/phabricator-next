import type { Finding, ReviewAnalysis, ReviewRun, RevisionVersion, SourceFile } from './types.ts';
import { COMPARISON_LIMITS } from './comparison.ts';

export type FindingReviewPin = { kind: 'recorded'; reviewId: string; versionId: string; contentHash: string }
  | { kind: 'on-device'; analysisId: string; versionId: string; contentHash: string };
export interface FindingSelection { revisionId: string; review: FindingReviewPin; findingId: string | null }
export interface OnDeviceReview { id: string; revisionId: string; versionId: string; contentHash: string; analysis: ReviewAnalysis }
export interface ResolvedFindingSelection {
  selection: FindingSelection;
  review: ReviewRun | null;
  version: RevisionVersion;
  analysis: ReviewAnalysis;
  finding: Finding | null;
  index: number;
  provenance: string;
}
export const FINDING_NAVIGATION_LIMITS = Object.freeze({ maxFindings: 20_000, maxTextCodeUnits: 100_000, maxTotalCodeUnits: 2_000_000, maxSnapshotItems: 10_000, maxSourceFiles: 1_000 });
export const FINDING_SPEECH_LIMIT = 2_200;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const findingIdValid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
export const findingHashValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Whole-result preflight. An oversized result is never presented as a partial or empty review. */
export function findingAnalysisError(value: unknown): string | null {
  if (!record(value) || !['local', 'openai', 'ollama'].includes(String(value.provider)) || !Array.isArray(value.findings) || typeof value.summary !== 'string' || typeof value.model !== 'string') return 'The selected review evidence has an invalid analysis shape.';
  if (value.findings.length > FINDING_NAVIGATION_LIMITS.maxFindings) return 'The complete review exceeds the finding navigation limit. No partial finding list was selected.';
  let units = 0;
  const text = (item: string) => { units += item.length; return item.length <= FINDING_NAVIGATION_LIMITS.maxTextCodeUnits && units <= FINDING_NAVIGATION_LIMITS.maxTotalCodeUnits; };
  if (!text(value.summary) || !text(value.model)) return 'The complete review exceeds the finding text limit. No partial finding list was selected.';
  const ids = new Set<string>();
  for (const item of value.findings) {
    if (!record(item) || !findingIdValid(item.id) || ids.has(item.id) || !['info', 'warning', 'error'].includes(String(item.severity)) || typeof item.title !== 'string' || typeof item.body !== 'string' || item.source !== (value.provider === 'local' ? 'local' : 'ai')
      || (item.filePath !== undefined && typeof item.filePath !== 'string') || (item.line !== undefined && typeof item.line !== 'number')) return 'The selected review contains malformed or ambiguous findings, or inconsistent review provenance.';
    ids.add(item.id);
    if (!text(item.id) || !text(item.title) || !text(item.body) || !text((item.filePath as string | undefined) ?? '')) return 'The complete review exceeds the finding text limit. No partial finding list was selected.';
  }
  return null;
}

/** These names intentionally keep deterministic checks distinct from both AI providers. */
export function findingProvenance(analysis: ReviewAnalysis, recorded: boolean): string {
  const provider = analysis.provider === 'local' ? 'Local deterministic checks' : analysis.provider === 'ollama' ? 'Local AI review' : 'Hosted AI review';
  return `${provider} · ${analysis.model} · ${recorded ? 'recorded on server' : 'on-device, not recorded as acceptance evidence'}`;
}

export interface FindingCursor { findingId: string | null; boundary: 'first' | 'last' | 'empty' | 'unavailable' | null }
/** Literal stored order, no severity sorting, wrapping, or recovery from a retired finding ID. */
export function moveFindingCursor(findings: readonly Pick<Finding, 'id'>[], currentId: string | null, direction: 1 | -1): FindingCursor {
  if (findings.length > FINDING_NAVIGATION_LIMITS.maxFindings) return { findingId: currentId, boundary: 'unavailable' };
  if (!findings.length) return { findingId: currentId, boundary: currentId === null ? 'empty' : 'unavailable' };
  const ids = new Set<string>();
  for (const finding of findings) { if (!findingIdValid(finding.id) || ids.has(finding.id)) return { findingId: currentId, boundary: 'unavailable' }; ids.add(finding.id); }
  const index = currentId === null ? -1 : findings.findIndex(finding => finding.id === currentId);
  if (currentId !== null && index < 0) return { findingId: currentId, boundary: 'unavailable' };
  const next = index + direction;
  if (next < 0) return { findingId: currentId, boundary: 'first' };
  if (next >= findings.length) return { findingId: currentId, boundary: 'last' };
  return { findingId: findings[next]!.id, boundary: null };
}

export type FindingSource = { status: 'ready'; file: SourceFile; versionId: string; contentHash: string; filePath: string; line: number; range: { start: number; end: number } }
  | { status: 'unavailable'; reason: 'invalid_version' | 'unsupported_document' | 'invalid_location' | 'missing_file' | 'ambiguous_file' | 'source_limit' | 'missing_line'; message: string };
/** Exact original text only. No quotation search, relocation, or fallback to line one. */
export function findingSource(version: RevisionVersion, finding: Finding): FindingSource {
  const no = (reason: Extract<FindingSource, { status: 'unavailable' }>['reason'], message: string): FindingSource => ({ status: 'unavailable', reason, message });
  if (!findingIdValid(version.id) || !findingHashValid(version.contentHash) || !Number.isSafeInteger(version.number) || version.number < 1) return no('invalid_version', 'The exact source version is unavailable.');
  if (version.docx) return no('unsupported_document', 'Word package findings do not have a supported original text-line location.');
  if (typeof finding.filePath !== 'string' || !finding.filePath || !Number.isSafeInteger(finding.line) || finding.line < 1) return no('invalid_location', 'This finding has no valid original file and one-based line location.');
  if (!Array.isArray(version.files) || version.files.length > FINDING_NAVIGATION_LIMITS.maxSourceFiles) return no('source_limit', 'The original source inventory exceeds the inline navigation limit.');
  const matches = version.files.filter(file => file?.path === finding.filePath);
  if (matches.length === 0) return no('missing_file', 'The finding’s original file is absent from this exact version.');
  if (matches.length !== 1) return no('ambiguous_file', 'More than one original file has this path; its source location is ambiguous.');
  const file = matches[0]!;
  if (typeof file.content !== 'string') return no('missing_file', 'The finding’s original file has no available text source.');
  if (file.content.length > COMPARISON_LIMITS.maxRenderedCodeUnits) return no('source_limit', 'The original file exceeds the inline display limit. Download its exact source to read it.');
  let line = 1, start = 0, selectedStart: number | null = null, selectedEnd: number | null = null;
  for (let index = 0; index <= file.content.length; index++) {
    if (index !== file.content.length && file.content.charCodeAt(index) !== 10) continue;
    if (line === finding.line) { selectedStart = start; selectedEnd = index; }
    if (index < file.content.length) { line++; start = index + 1; }
    if (line > COMPARISON_LIMITS.maxSourceLines) return no('source_limit', 'The original file exceeds the inline line-count limit. Download its exact source to read it.');
  }
  if (selectedStart === null || selectedEnd === null) return no('missing_line', 'The finding’s original line is outside this exact source file.');
  return { status: 'ready', file, versionId: version.id, contentHash: version.contentHash, filePath: file.path, line: finding.line, range: { start: selectedStart, end: selectedEnd } };
}

/** Bounded Unicode iteration avoids copying an entire long field merely to narrate an excerpt. */
function excerpt(value: string, limit: number): string {
  let text = '', count = 0;
  for (const point of value) { if (count++ === limit) return `${text.trim()} … Excerpt shortened.`; text += point; }
  return text.trim();
}
function spoken(value: string, limit: number): string { return excerpt(value, limit).replace(/\s+/gu, ' '); }
function narrateOne(snapshot: ResolvedFindingSelection, index: number): string {
  const finding = snapshot.analysis.findings[index]!;
  const source = findingSource(snapshot.version, finding);
  const location = source.status === 'ready' ? `File ${spoken(source.filePath, 160)}, line ${source.line}.` : `Original source location unavailable. ${source.message}`;
  return `Finding ${index + 1} of ${snapshot.analysis.findings.length}. ${finding.severity}. ${spoken(finding.title, 200)}. ${location} ${spoken(finding.body, 500)}`;
}
/** Already selected/authorized evidence only: no cache, network, AI, mutation or playback. */
export function findingNarration(snapshot: ResolvedFindingSelection, scope: 'all' | 'current' = 'all'): string {
  if (findingAnalysisError(snapshot.analysis) || snapshot.selection.revisionId !== snapshot.version.revisionId || snapshot.selection.review.versionId !== snapshot.version.id || snapshot.selection.review.contentHash !== snapshot.version.contentHash) return 'The selected review evidence is unavailable. Choose a review run explicitly.';
  const pin = snapshot.selection.review, device = pin.kind === 'on-device';
  if (pin.kind === 'on-device') {
    if (snapshot.review !== null || snapshot.analysis.provider !== 'local') return 'The selected review evidence is unavailable. Choose a review run explicitly.';
  } else if (!snapshot.review || snapshot.review.id !== pin.reviewId || snapshot.review.versionId !== snapshot.version.id || snapshot.review.contentHash !== snapshot.version.contentHash) return 'The selected review evidence is unavailable. Choose a review run explicitly.';
  const provider = snapshot.analysis.provider === 'local' ? 'Local deterministic checks' : snapshot.analysis.provider === 'ollama' ? 'Local AI review' : 'Hosted AI review';
  const header = `${snapshot.selection.revisionId}, version ${snapshot.version.number}. ${provider}, model ${spoken(snapshot.analysis.model, 120)}. ${device ? 'On-device result, not recorded as acceptance evidence' : 'Recorded on server'}. `;
  const count = snapshot.analysis.findings.length;
  let body: string;
  if (scope === 'current') body = snapshot.index >= 0 && snapshot.analysis.findings[snapshot.index]?.id === snapshot.selection.findingId ? narrateOne(snapshot, snapshot.index) : 'No current finding is selected.';
  else body = `${count} ${count === 1 ? 'finding' : 'findings'}. ${count > 3 ? 'Reading the first 3; use next finding to continue. ' : ''}${spoken(snapshot.analysis.summary, 320)} ${snapshot.analysis.findings.slice(0, 3).map((_, index) => narrateOne(snapshot, index)).join(' ')}`;
  const result = header + body, suffix = ' … Reading stopped at the speech length limit. Use read current finding for one finding.';
  let text = '', countPoints = 0;
  for (const point of result) { if (++countPoints > FINDING_SPEECH_LIMIT - suffix.length) return text + suffix; text += point; }
  return result;
}
