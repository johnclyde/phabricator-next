import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createGitFixture } from '../tests/git-fixture.ts';
import { createGitObserver } from './git.ts';
import { resolveRevisionPatch } from './revision-patch.ts';
import { deriveGitReviewEvidence, type GitReviewCandidate } from './git-review-gates.ts';
import { DEFAULT_REVISION_LIFECYCLE_CONFIG } from '../shared/revision-lifecycle.ts';
import { sourceSnapshotCanonical } from '../shared/source-snapshot.ts';
import type { RevisionVersion } from '../shared/types.ts';
import { requiredBuildFailures } from '../shared/git-review-gates.ts';

async function fixture(format: 'sha1' | 'sha256' = 'sha1') {
  const git = await createGitFixture(format), observer = createGitObserver({ R1: git.barePath });
  const source = await observer.commit('R1', git.importCommit), imported = await observer.importSnapshot('R1', git.importCommit);
  const version: RevisionVersion = { id: 'version-1', revisionId: 'D1', number: 1, files: imported.files, contentHash: createHash('sha256').update(sourceSnapshotCanonical(imported.files)).digest('hex'), message: 'Imported tree', createdAt: '2026-10-13T00:00:00Z', gitSource: imported.provenance };
  const patch = resolveRevisionPatch('R1', [version], version.id, version.contentHash), head = { versionId: version.id, number: version.number, contentHash: version.contentHash };
  const candidate: GitReviewCandidate = { patch, lifecycle: {
    head, lifecycle: { revisionId: 'D1', version: 3, status: 'accepted', reviewStarted: true, closedFromAccepted: null, resumeAcceptanceHead: null, updatedAt: null },
    authorship: { version: 1, author: null }, evidence: { sha256: 'e'.repeat(64), reviewIds: ['review-1'], errorCount: 0 },
    config: { ...DEFAULT_REVISION_LIFECYCLE_CONFIG }, configId: 'config-1', actions: [],
    reviewers: { version: 2, accepting: 1, rejecting: 0, olderRejecting: 0, blocking: 0, acceptance: { kind: 'reviewers', head, transactionId: 'reviewer-1' } },
  } };
  return { git, source, version, candidate, close: () => git.close() };
}

for (const format of ['sha1', 'sha256'] as const) test(`review association proves complete ${format} source and current acceptance`, async () => {
  const f = await fixture(format); try {
    const evidence = deriveGitReviewEvidence(f.source, [f.candidate], () => []);
    assert.equal(evidence.association, 'verified'); assert.equal(evidence.revision?.accepted, true);
    assert.equal(evidence.revision?.targetTreeId, f.source.commit.treeId);
    for (const change of [
      (c: GitReviewCandidate) => { c.lifecycle.head = { ...c.lifecycle.head, versionId: 'new-version' }; },
      (c: GitReviewCandidate) => { c.patch.repositoryId = 'R2'; },
      (c: GitReviewCandidate) => { c.patch.targetTreeId = 'a'.repeat(format === 'sha1' ? 40 : 64); },
    ]) { const c = structuredClone(f.candidate); change(c); assert.equal(deriveGitReviewEvidence(f.source, [c], () => []).revision, null); }
    for (const change of [
      (c: GitReviewCandidate) => { c.lifecycle.reviewers.acceptance = { kind: 'legacy', head: null, transactionId: null }; },
      (c: GitReviewCandidate) => { c.lifecycle.reviewers.acceptance = { kind: 'reviewers', head: { ...c.lifecycle.head, contentHash: 'f'.repeat(64) }, transactionId: 'old' }; },
      (c: GitReviewCandidate) => { c.lifecycle.evidence.errorCount = 1; },
      (c: GitReviewCandidate) => { c.lifecycle.reviewers.blocking = 1; },
      (c: GitReviewCandidate) => { c.lifecycle.reviewers.olderRejecting = 1; },
      (c: GitReviewCandidate) => { c.lifecycle.lifecycle.status = 'needs_review'; },
    ]) { const c = structuredClone(f.candidate); change(c); assert.equal(deriveGitReviewEvidence(f.source, [c], () => []).revision?.accepted, false); }
    const closed = structuredClone(f.candidate); closed.lifecycle.lifecycle.status = 'closed'; closed.lifecycle.lifecycle.closedFromAccepted = true;
    assert.equal(deriveGitReviewEvidence(f.source, [closed], () => []).revision?.accepted, true);
    closed.lifecycle.lifecycle.closedFromAccepted = false; assert.equal(deriveGitReviewEvidence(f.source, [closed], () => []).revision?.accepted, false);
    const corrupt = structuredClone(f.candidate); corrupt.patch.files[0]!.content += 'unreviewed bytes';
    assert.throws(() => deriveGitReviewEvidence(f.source, [corrupt], () => []), /patch/i);
  } finally { await f.close(); }
});

test('trailers only disambiguate verified trees and cannot impersonate a reviewed revision', async () => {
  const f = await fixture(); try {
    const version = { ...f.version, revisionId: 'D2' }, other: GitReviewCandidate = { patch: resolveRevisionPatch('R1', [version], version.id, version.contentHash), lifecycle: structuredClone(f.candidate.lifecycle) };
    other.lifecycle.lifecycle.revisionId = 'D2';
    assert.equal(deriveGitReviewEvidence(f.source, [f.candidate, other], () => []).association, 'ambiguous');
    const withMessage = (message: string) => ({ ...f.source, commit: { ...f.source.commit, message } });
    for (const trailer of ['D1', 'https://example.test/D1']) assert.equal(deriveGitReviewEvidence(withMessage(`Message\n\nDifferential Revision: ${trailer}`), [other, f.candidate], () => []).revision?.revisionId, 'D1');
    for (const revisionId of ['P1', 'L1']) {
      const version = { ...f.version, revisionId }, candidate: GitReviewCandidate = { patch: resolveRevisionPatch('R1', [version], version.id, version.contentHash), lifecycle: structuredClone(f.candidate.lifecycle) }; candidate.lifecycle.lifecycle.revisionId = revisionId;
      for (const trailer of [revisionId, `https://example.test/${revisionId}`]) assert.equal(deriveGitReviewEvidence(withMessage(`Message\n\nDifferential Revision: ${trailer}`), [f.candidate, candidate], () => []).revision?.revisionId, revisionId);
    }
    for (const trailer of ['D9', 'garbage', 'https://example.test/D1?spoof=D2', 'D1\nDifferential Revision: D2']) {
      const evidence = deriveGitReviewEvidence(withMessage(`Message\n\nDifferential Revision: ${trailer}`), [f.candidate], () => []);
      assert.equal(evidence.association, 'mismatch'); assert.equal(evidence.revision, null);
    }
    assert.equal(deriveGitReviewEvidence({ ...withMessage('Differential Revision: D1'), commit: { ...f.source.commit, message: 'Differential Revision: D1', treeId: 'f'.repeat(40) } }, [f.candidate], () => []).association, 'mismatch');
  } finally { await f.close(); }
});

test('only terminal trailers select revisions while quoted body references remain prose', async () => {
  const f = await fixture(); try {
    const version = { ...f.version, revisionId: 'D2' }, other: GitReviewCandidate = { patch: resolveRevisionPatch('R1', [version], version.id, version.contentHash), lifecycle: structuredClone(f.candidate.lifecycle) };
    other.lifecycle.lifecycle.revisionId = 'D2';
    const derive = (message: string) => deriveGitReviewEvidence({ ...f.source, commit: { ...f.source.commit, message } }, [f.candidate, other], () => []);
    for (const separator of ['\n', '\r\n']) {
      const message = ['Review quoting another change', '', 'Differential Revision: D99', '', 'This quoted body line is not the commit association.', '', 'Differential Revision: D1', 'Revision Version: version-1', 'Revision Content: abcdef', 'Landing Operation: example', '', ' \t'].join(separator);
      assert.equal(derive(message).revision?.revisionId, 'D1');
    }
    assert.equal(derive('Subject\n\nDifferential Revision: D1\nThis line is a body quotation, not a footer.').association, 'ambiguous');
    assert.equal(derive('Subject\n\nDifferential Revision: D1\n\nAn ordinary final body paragraph.').association, 'ambiguous');
    assert.equal(derive('Subject\n\nDifferential Revision: D1\n\nSigned-off-by: Person <person@example.test>').association, 'ambiguous');
    for (const footer of ['Differential Revision: D1\nDifferential Revision: D2', 'Differential Revision:', 'Differential Revision: malformed', 'Differential Revision: D1\n  unexpected continuation', 'Differential Revision: https://example.test/D1?spoof=D2']) {
      const evidence = derive(`Subject\n\nBody quoting a reference:\nDifferential Revision: D1\n\n${footer}\n`);
      assert.equal(evidence.association, 'mismatch'); assert.equal(evidence.revision, null);
    }
  } finally { await f.close(); }
});

test('required build policy fails closed without exact current evidence and excludes private identifiers from messages', () => {
  assert.match(requiredBuildFailures(undefined, ['private-plan'])[0]!, /unavailable/);
  for (const status of ['missing', 'stale', 'disabled', 'pending', 'building', 'failed', 'aborted', 'paused'] as const) {
    const failures = requiredBuildFailures({ association: 'none', revision: null, builds: [{ planId: 'private-plan', planVersion: 2, enabled: status !== 'disabled', status, builds: [] }] }, ['private-plan']);
    assert.equal(failures.length, 1); assert.match(failures[0]!, new RegExp(status)); assert.doesNotMatch(failures[0]!, /private-plan/);
  }
  assert.deepEqual(requiredBuildFailures({ association: 'none', revision: null, builds: [{ planId: 'plan', planVersion: 2, enabled: true, status: 'passed', builds: [] }] }, ['plan']), []);
});
