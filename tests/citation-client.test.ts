import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citationReceiptMatches, retractionReceiptMatches, type CitationRetractionIntent } from '../client/citation-client';
import type { CitationEvidenceInput, CitationEvidenceRecord } from '../shared/citation-evidence';

const source = { fileId: 'F1', sha256: 'a'.repeat(64), bytes: 14, mediaType: 'application/octet-stream' as const };
const attribution = { principalId: 'U1', displayName: 'Reviewer', credentialId: null, requestId: 'request' };
const input: CitationEvidenceInput = { versionId: 'version-1', contentHash: 'b'.repeat(64), targetId: 'target-1', source, quote: '  Exact quote.\n', locator: 'page 2', note: 'Supports this observation.', verdict: 'supports', attested: true, expectedAccessEpoch: 1 };
const record: CitationEvidenceRecord = { id: 'evidence-1', revisionId: 'P1', versionId: input.versionId, versionNumber: 1, contentHash: input.contentHash, target: { id: input.targetId, kind: 'entry', key: 'alpha', filePath: 'refs.bib', start: 0, end: 1, line: 1 }, source, basis: 'reviewer-attestation', verdict: input.verdict, quote: input.quote, locator: input.locator, note: input.note, createdAt: '2026-10-10T00:00:00Z', attribution, state: 'active', recordVersion: 1 };

test('an exact attestation receipt preserves verbatim text and each immutable binding', () => {
  assert.equal(citationReceiptMatches(record, 'P1', input), true);
  for (const patch of [{ revisionId: 'P2' }, { versionId: 'version-2' }, { contentHash: 'c'.repeat(64) }, { quote: input.quote.trim() }, { locator: 'page 3' }, { note: 'Changed' }, { verdict: 'contradicts' as const }, { target: { ...record.target, id: 'target-2' } }, { source: { ...source, fileId: 'F2' } }, { source: { ...source, sha256: 'd'.repeat(64) } }, { source: { ...source, bytes: 15 } }, { source: { ...source, mediaType: 'application/pdf' as const } }]) assert.equal(citationReceiptMatches({ ...record, ...patch }, 'P1', input), false);
  assert.equal(citationReceiptMatches({ ...record, state: 'retracted', recordVersion: 2 }, 'P1', input), true, 'a later retraction does not invalidate an exact create receipt');
});
test('retraction receipt must match original record, source, reason, and transition', () => {
  const intent: CitationRetractionIntent = { id: 'intent', recordId: record.id, source, body: { expectedRecordVersion: 1, reason: 'Wrong locator' } };
  const retracted: CitationEvidenceRecord = { ...record, state: 'retracted', recordVersion: 2, retraction: { reason: 'Wrong locator', createdAt: record.createdAt, attribution } };
  assert.equal(retractionReceiptMatches(retracted, intent), true);
  assert.equal(retractionReceiptMatches({ ...retracted, recordVersion: 3 }, intent), false);
  assert.equal(retractionReceiptMatches({ ...retracted, retraction: { ...retracted.retraction!, reason: 'Different reason' } }, intent), false);
  assert.equal(retractionReceiptMatches(record, intent), false);
});
