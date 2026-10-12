import type { RevisionDetail, ReviewAnalysis, ReviewRun, RevisionVersion } from '../shared/types.ts';
import { FINDING_NAVIGATION_LIMITS, findingAnalysisError, findingHashValid, findingIdValid, findingProvenance, type FindingSelection, type FindingReviewPin, type OnDeviceReview, type ResolvedFindingSelection } from '../shared/finding-navigation.ts';
import type { VersionIdentity } from './comparison-model.ts';
export type { FindingSelection, FindingReviewPin, OnDeviceReview, ResolvedFindingSelection } from '../shared/finding-navigation.ts';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function isFindingSelection(value: unknown, revisionId: string): value is FindingSelection {
  if (!record(value) || !/^[DPL][1-9]\d*$/.test(revisionId) || value.revisionId !== revisionId || !(value.findingId === null || findingIdValid(value.findingId)) || !record(value.review)) return false;
  const pin = value.review;
  return findingIdValid(pin.versionId) && findingHashValid(pin.contentHash) && (pin.kind === 'recorded' ? findingIdValid(pin.reviewId) : pin.kind === 'on-device' && findingIdValid(pin.analysisId));
}
export function isRecordedFindingSelection(value: unknown, revisionId: string): value is FindingSelection & { review: Extract<FindingReviewPin, { kind: 'recorded' }> } {
  return isFindingSelection(value, revisionId) && value.review.kind === 'recorded';
}
function inventoryError(detail: RevisionDetail): string | null {
  return !Array.isArray(detail.versions) || !Array.isArray(detail.reviews) || detail.versions.length > FINDING_NAVIGATION_LIMITS.maxSnapshotItems || detail.reviews.length > FINDING_NAVIGATION_LIMITS.maxSnapshotItems ? 'The loaded review inventory exceeds the finding navigation limit or is unavailable.' : null;
}
function versionFor(detail: RevisionDetail, pin: VersionIdentity): RevisionVersion | null {
  const versions = detail.versions.filter(version => version.id === pin.id);
  if (versions.length !== 1) return null;
  const version = versions[0]!;
  return version.revisionId === detail.revision.id && version.contentHash === pin.contentHash && Number.isSafeInteger(version.number) && version.number > 0 ? version : null;
}
/** Build only pins, so unavailable/oversized evidence stays selectable and reports its resolver error. */
export function recordedReviewSelection(review: ReviewRun): FindingSelection | null {
  const first = Array.isArray(review.findings) ? review.findings[0]?.id : null;
  const selection: FindingSelection = { revisionId: review.revisionId, review: { kind: 'recorded', reviewId: review.id, versionId: review.versionId, contentHash: review.contentHash }, findingId: findingIdValid(first) ? first : null };
  return isFindingSelection(selection, review.revisionId) ? selection : null;
}
export function recordedFindingSelection(detail: RevisionDetail, reviewId: string): FindingSelection | null {
  if (inventoryError(detail)) return null;
  const review = detail.reviews.find(review => review.id === reviewId);
  return review?.revisionId === detail.revision.id ? recordedReviewSelection(review) : null;
}
/** Only for absent preferences. An explicit retired/malformed saved selection must be resolved, never replaced by this default. */
export function defaultFindingSelection(detail: RevisionDetail, inspected: VersionIdentity | null): FindingSelection | null {
  if (!inspected || inventoryError(detail) || !versionFor(detail, inspected)) return null;
  const run = detail.reviews.find(review => review.versionId === inspected.id && review.contentHash === inspected.contentHash);
  return run ? recordedFindingSelection(detail, run.id) : null;
}
export function onDeviceFindingSelection(local: OnDeviceReview): FindingSelection | null {
  const first = Array.isArray(local.analysis?.findings) ? local.analysis.findings[0]?.id : null;
  const selection: FindingSelection = { revisionId: local.revisionId, review: { kind: 'on-device', analysisId: local.id, versionId: local.versionId, contentHash: local.contentHash }, findingId: findingIdValid(first) ? first : null };
  return local.analysis?.provider === 'local' && isFindingSelection(selection, local.revisionId) ? selection : null;
}
export function resolveFindingSelection(detail: RevisionDetail, selection: FindingSelection, onDevice?: OnDeviceReview | null): ResolvedFindingSelection | { error: string } {
  if (!isFindingSelection(selection, detail.revision.id)) return { error: 'The saved finding selection has invalid evidence identities. Choose a review run explicitly.' };
  const inventory = inventoryError(detail); if (inventory) return { error: inventory };
  const pin = selection.review;
  const version = versionFor(detail, { id: pin.versionId, contentHash: pin.contentHash });
  if (!version) return { error: 'The review’s exact immutable source version is unavailable or its content hash changed. Choose a review run explicitly.' };
  let review: ReviewRun | null = null, analysis: ReviewAnalysis;
  if (pin.kind === 'recorded') {
    const matches = detail.reviews.filter(item => item.id === pin.reviewId);
    if (matches.length !== 1) return { error: 'The selected recorded review is unavailable or ambiguous. Choose a review run explicitly.' };
    review = matches[0]!;
    if (review.revisionId !== detail.revision.id || review.versionId !== pin.versionId || review.contentHash !== pin.contentHash) return { error: 'The selected recorded review no longer matches its immutable source identity. Choose a review run explicitly.' };
    analysis = review;
  } else {
    if (!onDevice || onDevice.id !== pin.analysisId || onDevice.revisionId !== detail.revision.id || onDevice.versionId !== pin.versionId || onDevice.contentHash !== pin.contentHash) return { error: 'The selected on-device result is unavailable. Its analysis only survives in this tab and was never recorded as acceptance evidence. Choose a review run explicitly or run on-device checks again.' };
    if (onDevice.analysis.provider !== 'local') return { error: 'An on-device result must be local deterministic checks, not AI or recorded evidence.' };
    analysis = onDevice.analysis;
  }
  const invalid = findingAnalysisError(analysis); if (invalid) return { error: invalid };
  const index = selection.findingId === null ? -1 : analysis.findings.findIndex(finding => finding.id === selection.findingId);
  if (selection.findingId !== null && index < 0) return { error: 'The selected finding is no longer present in this exact review. Choose a finding explicitly.' };
  return { selection: findingSelectionMetadata(selection), review, version, analysis, finding: index < 0 ? null : analysis.findings[index]!, index, provenance: findingProvenance(analysis, review !== null) };
}
/** Source-free pins for both kinds. A persisted device marker must resolve unavailable after its transient result retires. */
export function findingSelectionMetadata(selection: FindingSelection): FindingSelection {
  const pin = selection.review;
  return { revisionId: selection.revisionId, review: pin.kind === 'recorded' ? { kind: pin.kind, reviewId: pin.reviewId, versionId: pin.versionId, contentHash: pin.contentHash } : { kind: pin.kind, analysisId: pin.analysisId, versionId: pin.versionId, contentHash: pin.contentHash }, findingId: selection.findingId };
}
export function findingSelectionIdentity(selection: FindingSelection): string { return JSON.stringify(findingSelectionMetadata(selection)); }
/** Runtime-only canonical evidence identity; never persist this string or use it as a source hash. */
export function findingEvidenceIdentity(resolved: ResolvedFindingSelection): string {
  if (findingAnalysisError(resolved.analysis)) return 'unavailable';
  const analysis = resolved.analysis;
  return JSON.stringify([resolved.selection.revisionId, findingSelectionMetadata(resolved.selection).review, resolved.version.number, resolved.review?.createdAt ?? null, analysis.provider, analysis.model, analysis.summary, analysis.findings.map(finding => [finding.id, finding.severity, finding.filePath, finding.line, finding.title, finding.body, finding.source])]);
}
