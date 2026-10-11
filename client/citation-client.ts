import type { CitationEvidenceInput, CitationEvidenceRecord, CitationEvidenceSource, CitationVerdict, RetractCitationEvidenceInput } from '../shared/citation-evidence';

export interface CitationDraft { source: CitationEvidenceSource | null; verdict: CitationVerdict; quote: string; locator: string; note: string; attested: boolean }
export const emptyCitationDraft = (): CitationDraft => ({ source: null, verdict: 'supports', quote: '', locator: '', note: '', attested: false });
export interface CitationIntent { id: string; body: CitationEvidenceInput; draft: CitationDraft }
export interface CitationRetractionDraft { source: CitationEvidenceSource; reason: string }
export interface CitationRetractionIntent { id: string; recordId: string; source: CitationEvidenceSource; draft?: CitationRetractionDraft; body: RetractCitationEvidenceInput }
export function sameCitationSource(a: CitationEvidenceSource, b: CitationEvidenceSource): boolean { return a.fileId === b.fileId && a.sha256 === b.sha256 && a.bytes === b.bytes && a.mediaType === b.mediaType; }
/** A lost receipt can only retire the exact original request, never a newer draft. */
export function citationReceiptMatches(record: CitationEvidenceRecord, revisionId: string, input: CitationEvidenceInput): boolean {
  return record.revisionId === revisionId && record.versionId === input.versionId && record.contentHash === input.contentHash && record.target.id === input.targetId && sameCitationSource(record.source, input.source) && record.basis === 'reviewer-attestation' && record.quote === input.quote && record.locator === input.locator && record.note === input.note && record.verdict === input.verdict;
}
export function retractionReceiptMatches(record: CitationEvidenceRecord, intent: CitationRetractionIntent): boolean { return record.id === intent.recordId && record.state === 'retracted' && record.recordVersion === intent.body.expectedRecordVersion + 1 && record.retraction?.reason === intent.body.reason && sameCitationSource(record.source, intent.source); }
