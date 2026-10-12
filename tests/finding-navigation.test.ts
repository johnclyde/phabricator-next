import test from 'node:test';
import assert from 'node:assert/strict';
import type { Finding, ReviewAnalysis, ReviewRun, RevisionDetail, RevisionVersion } from '../shared/types.ts';
import { analyzeLocally } from '../shared/review.ts';
import { COMPARISON_LIMITS } from '../shared/comparison.ts';
import { FINDING_NAVIGATION_LIMITS, FINDING_SPEECH_LIMIT, findingAnalysisError, findingNarration, findingSource, moveFindingCursor, type FindingSelection, type OnDeviceReview, type ResolvedFindingSelection } from '../shared/finding-navigation.ts';
import { defaultFindingSelection, findingEvidenceIdentity, findingSelectionIdentity, findingSelectionMetadata, isFindingSelection, isRecordedFindingSelection, onDeviceFindingSelection, recordedFindingSelection, recordedReviewSelection, resolveFindingSelection } from '../client/finding-navigation-model.ts';

const hash = (number: number) => number.toString(16).repeat(64);
const finding = (id = 'local-1', line = 2): Finding => ({ id, severity: 'warning', filePath: 'motion.tex', line, title: 'Unfinished work', body: 'Decide whether to resolve this placeholder.', source: 'local' });
const analysis = (findings = [finding()]): ReviewAnalysis => ({ provider: 'local', model: 'deterministic-v1', summary: 'Text checks only.', findings });
const version = (number: number, content = 'Opening\r\nTODO: revise café 😀\r\n'): RevisionVersion => ({ id: `version-${number}`, revisionId: 'P1', number, files: [{ path: 'motion.tex', content }], message: '', contentHash: hash(number), createdAt: '2026-10-01T12:00:00.000Z' });
const review = (id = 'run-1', source = version(1), result = analysis()): ReviewRun => ({ ...result, id, revisionId: 'P1', versionId: source.id, contentHash: source.contentHash, createdAt: '2026-10-02T12:00:00.000Z' });
function detail(versions = [version(1), version(2)], reviews = [review('run-2', versions[1]), review('run-1', versions[0])]): RevisionDetail {
  return { revision: { id: 'P1', kind: 'paper', title: 'Motion', summary: '', status: 'needs_review', repositoryId: null, projectId: null, currentVersion: versions.at(-1)!.number, createdAt: '', updatedAt: '' }, versions, reviews, comments: [], threads: [], threadEvents: [], suggestionApplications: [], activity: [] };
}
function selected(data = detail(), id = 'run-1'): FindingSelection { const selected = recordedFindingSelection(data, id); assert.ok(selected); return selected; }
function ready(data = detail(), selection = selected(data), local?: OnDeviceReview): ResolvedFindingSelection { const result = resolveFindingSelection(data, selection, local); if ('error' in result) assert.fail(result.error); return result; }

test('recorded selection pins exact historical run/version/hash even when finding IDs repeat and new heads/runs arrive', () => {
  const data = detail(), choice = selected(data), original = structuredClone(data);
  const result = ready(data, choice);
  assert.equal(result.review?.id, 'run-1'); assert.equal(result.version.number, 1); assert.equal(result.finding?.id, 'local-1');
  data.versions.push(version(3)); data.revision.currentVersion = 3; data.reviews.unshift(review('new-run', version(3)));
  assert.equal(ready(data, choice).review?.id, 'run-1');
  assert.notEqual(findingSelectionIdentity(choice), findingSelectionIdentity(selected(data, 'run-2')));
  assert.deepEqual(original.reviews[1], result.review);
});

test('default respects the inspected immutable version and only the first matching stored run', () => {
  const data = detail(), target = { id: data.versions[0]!.id, contentHash: data.versions[0]!.contentHash };
  assert.equal(defaultFindingSelection(data, target)?.review.kind, 'recorded');
  assert.equal(ready(data, defaultFindingSelection(data, target)!).review?.id, 'run-1');
  assert.equal(defaultFindingSelection(data, null), null);
  assert.equal(defaultFindingSelection(data, { ...target, contentHash: hash(8) }), null);
  data.reviews.unshift({ ...review('bad', version(1)), findings: [finding(), finding()] });
  const invalid = defaultFindingSelection(data, target)!; assert.equal(invalid.review.kind === 'recorded' && invalid.review.reviewId, 'bad');
  assert.ok('error' in resolveFindingSelection(data, invalid), 'an invalid matching run reports its problem instead of silently falling through to an older one');
});

test('removed or changed immutable identities fail explicitly without latest/source-line fallback', () => {
  const original = detail(), choice = selected(original);
  for (const mutate of [
    (data: RevisionDetail) => { data.reviews = data.reviews.filter(run => run.id !== 'run-1'); },
    (data: RevisionDetail) => { data.reviews[1]!.versionId = 'version-2'; },
    (data: RevisionDetail) => { data.reviews[1]!.contentHash = hash(9); },
    (data: RevisionDetail) => { data.reviews[1]!.revisionId = 'P9'; },
    (data: RevisionDetail) => { data.versions[0]!.contentHash = hash(9); },
    (data: RevisionDetail) => { data.versions[0]!.revisionId = 'P9'; },
    (data: RevisionDetail) => { data.versions.splice(0, 1); },
    (data: RevisionDetail) => { data.reviews.push(data.reviews[1]!); },
    (data: RevisionDetail) => { data.versions.push(data.versions[0]!); },
  ]) { const data = structuredClone(original); mutate(data); assert.ok('error' in resolveFindingSelection(data, choice)); }
  assert.match((resolveFindingSelection(original, { ...choice, findingId: 'retired-finding' }) as { error: string }).error, /finding.*no longer present/);
});

test('metadata validates exact object binding and whitelists both recorded and retired on-device markers', () => {
  const choice = selected(), polluted = { ...choice, analysis: analysis(), source: 'private', review: { ...choice.review, summary: 'private' } };
  assert.equal(isRecordedFindingSelection(polluted, 'P1'), true);
  assert.equal(isFindingSelection(polluted, 'P2'), false);
  assert.deepEqual(findingSelectionMetadata(polluted), choice);
  const metadata = findingSelectionMetadata(choice); metadata.review.versionId = 'changed'; assert.notEqual(metadata.review.versionId, choice.review.versionId);
  for (const value of [null, {}, { ...choice, findingId: '' }, { ...choice, review: { ...choice.review, contentHash: 'not-a-hash' } }, { ...choice, review: { ...choice.review, kind: 'new-kind' } }]) assert.equal(isFindingSelection(value, 'P1'), false);
  const local: OnDeviceReview = { id: 'local-run', revisionId: 'P1', versionId: 'version-1', contentHash: hash(1), analysis: analysis() };
  const transient = onDeviceFindingSelection(local)!; assert.ok(transient);
  assert.equal(isRecordedFindingSelection(transient, 'P1'), false);
  const stored = JSON.stringify(findingSelectionMetadata({ ...transient, analysis: local.analysis } as FindingSelection));
  assert.equal(stored.includes('Text checks'), false); assert.equal(stored.includes('private'), false);
  assert.match((resolveFindingSelection(detail(), JSON.parse(stored)) as { error: string }).error, /on-device result is unavailable/);
});

test('transient results require a unique analysis identity and exact source pins and never become recorded evidence', () => {
  const local: OnDeviceReview = { id: 'local-run', revisionId: 'P1', versionId: 'version-1', contentHash: hash(1), analysis: analysis() };
  const choice = onDeviceFindingSelection(local)!;
  const result = ready(detail(), choice, local);
  assert.equal(result.review, null); assert.match(result.provenance, /Local deterministic checks.*on-device.*not recorded/);
  for (const changed of [{ ...local, id: 'new-local-run' }, { ...local, versionId: 'version-2' }, { ...local, contentHash: hash(2) }, { ...local, revisionId: 'P2' }]) assert.ok('error' in resolveFindingSelection(detail(), choice, changed));
  const ai = { ...local, analysis: { ...local.analysis, provider: 'ollama' as const } };
  assert.equal(onDeviceFindingSelection(ai), null); assert.ok('error' in resolveFindingSelection(detail(), choice, ai));
  const malformed = { ...local, analysis: analysis([{ ...finding(), id: '' }]) };
  const malformedChoice = onDeviceFindingSelection(malformed)!; assert.ok(malformedChoice); assert.equal(malformedChoice.findingId, null);
  assert.match((resolveFindingSelection(detail(), malformedChoice, malformed) as { error: string }).error, /malformed/);
});

test('cursor follows complete literal finding order with explicit boundaries and no wrapping or severity sort', () => {
  const findings = [finding('a'), { ...finding('b'), severity: 'error' as const }, finding('c')];
  assert.deepEqual(moveFindingCursor(findings, null, 1), { findingId: 'a', boundary: null });
  assert.deepEqual(moveFindingCursor(findings, null, -1), { findingId: null, boundary: 'first' });
  assert.deepEqual(moveFindingCursor(findings, 'a', 1), { findingId: 'b', boundary: null });
  assert.deepEqual(moveFindingCursor(findings, 'b', -1), { findingId: 'a', boundary: null });
  assert.deepEqual(moveFindingCursor(findings, 'c', 1), { findingId: 'c', boundary: 'last' });
  assert.deepEqual(moveFindingCursor(findings, 'a', -1), { findingId: 'a', boundary: 'first' });
  assert.equal(moveFindingCursor(findings, 'missing', 1).boundary, 'unavailable');
  assert.equal(moveFindingCursor([finding(), finding()], null, 1).boundary, 'unavailable');
  assert.equal(moveFindingCursor([], null, 1).boundary, 'empty');
});

test('source locations preserve exact Unicode and CRLF offsets, including empty and trailing empty lines', () => {
  const source = version(1, 'α😀\r\n\t café e\u0301\r\n'), located = findingSource(source, finding());
  assert.equal(located.status, 'ready');
  if (located.status === 'ready') {
    assert.equal(located.file, source.files[0]); assert.deepEqual(located.range, { start: 5, end: 15 });
    assert.equal(source.files[0]!.content.slice(located.range.start, located.range.end), '\t café e\u0301\r');
    assert.equal(located.versionId, source.id); assert.equal(located.contentHash, source.contentHash);
  }
  const trailing = findingSource(source, finding('last', 3)); assert.equal(trailing.status, 'ready');
  if (trailing.status === 'ready') assert.deepEqual(trailing.range, { start: 16, end: 16 });
  const empty = findingSource(version(1, ''), finding('empty', 1)); assert.equal(empty.status, 'ready');
  if (empty.status === 'ready') assert.deepEqual(empty.range, { start: 0, end: 0 });
  assert.equal(findingSource(source, finding('missing', 4)).status, 'unavailable');
});

test('unlocated findings remain readable while missing, invalid, ambiguous and oversized original source stays unavailable', () => {
  const data = detail();
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 99]) {
    data.reviews[1]!.findings = [finding('local-1', invalid)];
    const result = ready(data); assert.equal(result.finding!.line, invalid); assert.equal(findingSource(result.version, result.finding!).status, 'unavailable');
    assert.match(findingNarration(result, 'current'), /Original source location unavailable/);
  }
  data.reviews[1]!.findings = [{ ...finding(), filePath: 'not-there.tex' }];
  assert.equal(findingSource(ready(data).version, ready(data).finding!).status, 'unavailable');
  const ambiguous = version(1); ambiguous.files.push(ambiguous.files[0]!);
  assert.equal((findingSource(ambiguous, finding()) as { reason: string }).reason, 'ambiguous_file');
  for (const content of ['x'.repeat(COMPARISON_LIMITS.maxRenderedCodeUnits + 1), '\n'.repeat(COMPARISON_LIMITS.maxSourceLines)]) assert.equal((findingSource(version(1, content), finding('first', 1)) as { reason: string }).reason, 'source_limit');
  const noPath = { ...finding(), filePath: undefined } as unknown as Finding;
  data.reviews[1]!.findings = [noPath]; assert.ok(ready(data).finding); assert.equal(findingSource(version(1), noPath).status, 'unavailable');
});

test('complete-result limits fail atomically and never return a deceptively short finding list', () => {
  const max = FINDING_NAVIGATION_LIMITS;
  assert.match(findingAnalysisError(analysis(Array.from({ length: max.maxFindings + 1 }, (_, i) => finding(`local-${i}`))))!, /complete review exceeds.*No partial/);
  const oversized = detail(); oversized.reviews[1]!.findings = Array.from({ length: max.maxFindings + 1 }, (_, i) => finding(`local-${i}`));
  const oversizedChoice = recordedReviewSelection(oversized.reviews[1]!)!; assert.ok(oversizedChoice);
  assert.match((resolveFindingSelection(oversized, oversizedChoice) as { error: string }).error, /complete review exceeds/);
  assert.match(findingAnalysisError({ ...analysis(), summary: 'x'.repeat(max.maxTextCodeUnits + 1) })!, /complete review exceeds/);
  assert.match(findingAnalysisError(analysis(Array.from({ length: 21 }, (_, i) => ({ ...finding(`local-${i}`), body: 'x'.repeat(max.maxTextCodeUnits) }))))!, /complete review exceeds/);
  const large = Array.from({ length: max.maxFindings }, (_, index) => ({ ...finding(`local-${index}`), body: 'x', title: 'x' }));
  assert.equal(findingAnalysisError(analysis(large)), null);
  const data = detail(); data.reviews[1]!.findings = large;
  const result = ready(data, { ...selected(), findingId: large.at(-1)!.id }); assert.equal(result.index, max.maxFindings - 1);
  assert.equal(moveFindingCursor(result.analysis.findings, large.at(-1)!.id, 1).boundary, 'last');
});

test('bounded speech distinguishes each provider and recorded versus on-device provenance', () => {
  for (const provider of ['local', 'ollama', 'openai'] as const) {
    const data = detail(), run = data.reviews[1]!; run.provider = provider; run.model = `model-${provider}`; run.findings[0]!.source = provider === 'local' ? 'local' : 'ai';
    const text = findingNarration(ready(data), 'current');
    assert.match(text, provider === 'local' ? /Local deterministic checks/ : provider === 'ollama' ? /Local AI review/ : /Hosted AI review/);
    assert.match(text, /P1, version 1/); assert.match(text, /Recorded on server/); assert.ok(text.includes(`model-${provider}`));
    assert.match(text, /Finding 1 of 1.*warning.*File motion.tex, line 2/);
  }
  const local: OnDeviceReview = { id: 'device-a', revisionId: 'P1', versionId: 'version-1', contentHash: hash(1), analysis: analysis() };
  assert.match(findingNarration(ready(detail(), onDeviceFindingSelection(local)!, local)), /On-device result, not recorded as acceptance evidence/);
});

test('speech excerpts are bounded Unicode, identify shortening, preserve provenance despite a long model, and never read source secrets', () => {
  const data = detail(); data.reviews[1]!.model = '😀'.repeat(10_000); data.reviews[1]!.summary = 'Résumé 😀 '.repeat(1_000);
  data.reviews[1]!.findings = Array.from({ length: 4 }, (_, index) => ({ ...finding(`local-${index}`), title: '😀'.repeat(500), body: 'Claim 😀 '.repeat(1_000) }));
  data.versions[0]!.files[0]!.content = 'secret-value\nsecret-value\n';
  const text = findingNarration(ready(data));
  assert.ok(Array.from(text).length <= FINDING_SPEECH_LIMIT); assert.match(text, /Reading the first 3/); assert.match(text, /Recorded on server/); assert.match(text, /shortened|speech length limit/); assert.equal(text.includes('secret-value'), false);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text), false);
});

test('runtime evidence identity detects changed findings and provenance without adding evidence to persisted metadata', () => {
  const data = detail(), choice = selected(data), original = findingEvidenceIdentity(ready(data, choice));
  assert.equal(findingEvidenceIdentity(ready(data, { ...choice, findingId: null })), original, 'cursor presentation does not change the evidence generation');
  data.reviews[1]!.findings[0]!.body = 'Different evidence text';
  assert.notEqual(findingEvidenceIdentity(ready(data, choice)), original);
  assert.equal(findingSelectionIdentity(choice), findingSelectionIdentity(selected(data)));
  assert.equal(JSON.stringify(findingSelectionMetadata(choice)).includes('Different evidence'), false);
});

test('real portable manuscript checks stay in their original order and same-source empty evidence resolves honestly', () => {
  const source = version(1, '\\begin{abstract}Text.\\end{abstract}\nTODO: support this claim.\n\\ref{absent}\n');
  const result = analyzeLocally('paper', source.files), data = detail([source], [review('real', source, result)]), original = structuredClone(data);
  const resolved = ready(data, selected(data, 'real'));
  assert.deepEqual(resolved.analysis.findings, result.findings); assert.ok(resolved.analysis.findings.length >= 2);
  assert.equal(findingSource(resolved.version, resolved.finding!).status, 'ready');
  findingNarration(resolved); findingEvidenceIdentity(resolved); assert.deepEqual(data, original);
  data.reviews[0]!.findings = []; const empty = ready(data, selected(data, 'real'));
  assert.equal(empty.finding, null); assert.equal(empty.index, -1); assert.match(findingNarration(empty), /0 findings/); assert.match(findingNarration(empty, 'current'), /No current finding/);
});

test('ambiguous findings and contradictory deterministic/AI provenance fail before a result can be narrated', () => {
  assert.match(findingAnalysisError(analysis([finding(), finding()]))!, /ambiguous/);
  assert.match(findingAnalysisError(analysis([{ ...finding(), source: 'ai' }]))!, /provenance/);
  assert.match(findingAnalysisError({ ...analysis(), provider: 'openai' })!, /provenance/);
  const resolved = ready(), forged = { ...resolved, selection: { ...resolved.selection, review: { ...resolved.selection.review, contentHash: hash(7) } } };
  assert.match(findingNarration(forged), /evidence is unavailable/);
});
