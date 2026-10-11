import type { ActorAttribution } from './types';
import type { FileMediaType } from './files';
import { isConcreteCitationOccurrence, type CitationIndex } from './citations';

export interface CitationInventoryResponse {
  revisionId: string; version: { id: string; number: number; contentHash: string };
  index: CitationIndex; accessEpoch?: number;
}

/** A reviewer's recorded observation, never an automatically verified authority. */
export type CitationVerdict = 'supports' | 'contradicts' | 'inconclusive';
export interface CitationEvidenceTarget {
  id: string; kind: 'entry' | 'citation'; key: string; filePath: string;
  start: number; end: number; line: number;
}
/** Dynamic keys and collection wildcards cannot identify one cited source. */
export function citationEvidenceTarget(index: CitationIndex, id: string): CitationEvidenceTarget | null {
  const entry = index.entries.find(item => item.id === id);
  const citation = entry ? undefined : index.citations.find(item => item.id === id);
  const target = entry ?? citation;
  if (!target) return null;
  if (citation && !isConcreteCitationOccurrence(citation)) return null;
  return { id: target.id, kind: entry ? 'entry' : 'citation', key: target.key, filePath: target.filePath, start: target.start, end: target.end, line: target.line };
}
export interface CitationEvidenceSource {
  fileId: string; sha256: string; bytes: number; mediaType: FileMediaType;
}
export interface CitationEvidenceInput {
  versionId: string; contentHash: string; targetId: string;
  source: CitationEvidenceSource; verdict: CitationVerdict;
  quote: string; locator: string; note: string;
  attested: true; expectedAccessEpoch: number;
}
export interface CitationEvidenceRetraction {
  reason: string; createdAt: string; attribution: ActorAttribution;
}
export interface CitationEvidenceRecord {
  id: string; revisionId: string; versionId: string; versionNumber: number;
  contentHash: string; target: CitationEvidenceTarget; source: CitationEvidenceSource;
  basis: 'reviewer-attestation'; verdict: CitationVerdict;
  quote: string; locator: string; note: string;
  createdAt: string; attribution: ActorAttribution;
  state: 'active' | 'retracted'; recordVersion: number;
  retraction?: CitationEvidenceRetraction;
  accessEpoch?: number;
}
export interface CitationEvidencePage {
  records: CitationEvidenceRecord[]; nextBefore: number | null; accessEpoch?: number;
}
export interface CitationEvidenceQuery {
  versionId: string; targetId?: string; before?: number; limit?: number;
}
export interface RetractCitationEvidenceInput {
  expectedRecordVersion: number; reason: string;
}
