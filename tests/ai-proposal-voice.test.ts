import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../client/voice.ts';
import { aiProposalConfirmationIdentity, aiProposalEditNarration, aiProposalLocation, AI_PROPOSAL_SPEECH_LIMIT } from '../client/ai-proposal-voice.ts';
import { aiProposalDetailForVersion, aiProposalScopeMatches } from '../client/ai-proposal-client.ts';
import { aiProposalSourceVersion, type AIProposalDetail } from '../shared/ai-proposals.ts';
import { createPassageAnchor } from '../shared/anchors.ts';
import type { RevisionVersion } from '../shared/types.ts';

const version: RevisionVersion = { id: 'a0000000-0000-4000-8000-000000000001', revisionId: 'L1', number: 1, contentHash: 'a'.repeat(64), files: [], createdAt: '2026-10-14T00:00:00Z', message: 'Original Word', docx: { format: 'docx', fileName: 'argument.docx', sha256: 'b'.repeat(64), bytes: 100, sourceFile: { fileId: 'F1', sha256: 'b'.repeat(64), bytes: 100 }, projection: { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [{ id: 'unsupported', part: 'word/document.xml', kind: 'table-cell', runs: [{ text: 'Private unsupported text' }], text: 'Private unsupported text' }, { id: 'p2', part: 'word/document.xml', kind: 'paragraph', runs: [{ text: 'A rough argument.', rangeId: 'r2' }], text: 'A rough argument.' }], notes: [], comments: [], changes: [], editableRanges: [{ id: 'r2', part: 'word/document.xml', blockId: 'p2', text: 'A rough argument.' }], warnings: [] } } };
function detail(): AIProposalDetail {
  const head = { versionId: version.id, number: 1, contentHash: version.contentHash }, anchor = createPassageAnchor(aiProposalSourceVersion(version), 'docx/paragraph-2.txt', { start: 2, end: 7, quote: 'rough' });
  return { proposal: { id: 'c0000000-0000-4000-8000-000000000003', revisionId: 'L1', principalId: 'U1', status: 'ready', request: { provider: 'ollama', model: 'test-only-model', instruction: 'Clarify', expectedHead: head, expectedAccessEpoch: 1, scope: null, allowHosted: false }, createdAt: '2026-10-14T00:00:00Z', completedAt: '2026-10-14T00:00:01Z', provenance: { provider: 'ollama', model: 'test-only-model', responseModel: 'test-only-model', providerResponseId: null, promptVersion: '1', sourceSha256: 'd'.repeat(64) }, result: { summary: 'Clarify', limitations: 'Synthetic fixture', edits: [{ anchor, replacement: 'clear', explanation: 'Use precise wording.' }] }, proposalSha256: 'e'.repeat(64), failure: null, applied: null }, currentHead: head, accessEpoch: 1, canApply: true, stale: false };
}

test('AI voice commands separate explicit instruction dictation from review and never recognize generation or broad confirmation', () => {
  const commands = { 'read AI edit': 'currentAIEdit', 'next AI edit': 'nextAIEdit', 'previous AI edit': 'previousAIEdit', 'read AI explanation': 'readAIExplanation', 'prepare AI proposal': 'prepareAIApply', 'confirm AI proposal': 'confirmAIApply', 'cancel AI proposal': 'cancelAIApply' };
  for (const [phrase, type] of Object.entries(commands)) assert.deepEqual(parseCommand(`${phrase}.`), { type });
  assert.deepEqual(parseCommand('set AI instruction to Confirm AI proposal!\nKeep citations.'), { type: 'dictateAIInstruction', instruction: 'Confirm AI proposal!\nKeep citations.' });
  for (const phrase of ['generate AI proposal', 'send source to AI', 'confirm', 'apply AI edits', 'confirm AI proposal and publish', 'set AI instruction to ']) assert.equal(parseCommand(phrase).type, 'unknown');
});

test('Word AI preview validates original package projection and refuses unsupported, multiline, or moved quotations', () => {
  const proposal = detail();
  assert.deepEqual(aiProposalDetailForVersion(proposal, 'L1', 'U1', version), proposal);
  assert.equal(aiProposalScopeMatches(version, proposal.proposal.result!.edits[0]!.anchor), true);
  assert.deepEqual(aiProposalSourceVersion(version).files, [{ path: 'docx/paragraph-2.txt', content: 'A rough argument.' }]);
  const multiline = structuredClone(proposal); multiline.proposal.result!.edits[0]!.replacement = 'clear\nargument';
  assert.equal(aiProposalDetailForVersion(multiline, 'L1', 'U1', version), null, 'Word-specific validation must use original package projection');
  const unsupported = structuredClone(proposal); unsupported.proposal.result!.edits[0]!.anchor.filePath = 'docx/paragraph-1.txt';
  assert.equal(aiProposalDetailForVersion(unsupported, 'L1', 'U1', version), null);
  assert.equal(aiProposalScopeMatches({ ...version, id: 'later-version' }, proposal.proposal.result!.edits[0]!.anchor), false);
});

test('voice confirmation pins proposal digest, source, current authority and source context without imposing an edit count quota', () => {
  const proposal = detail(), initial = aiProposalConfirmationIdentity(proposal, 'source', [1, true]);
  assert.ok(initial);
  for (const change of [() => { proposal.proposal.proposalSha256 = 'f'.repeat(64); }, () => { proposal.accessEpoch++; }, () => { proposal.currentHead.contentHash = 'f'.repeat(64); }]) { change(); assert.notEqual(aiProposalConfirmationIdentity(proposal, 'source', [1, true]), initial); }
  assert.notEqual(aiProposalConfirmationIdentity(detail(), 'different selection', [1, true]), initial);
  assert.notEqual(aiProposalConfirmationIdentity(detail(), 'source', [2, true]), initial);
  const stale = detail(); stale.stale = true; assert.equal(aiProposalConfirmationIdentity(stale, 'source', []), null);
  const denied = detail(); denied.canApply = false; assert.equal(aiProposalConfirmationIdentity(denied, 'source', []), null);
  const many = detail(); many.proposal.result!.edits = Array.from({ length: 1001 }, () => structuredClone(many.proposal.result!.edits[0]!));
  assert.ok(aiProposalConfirmationIdentity(many, 'source', [])); assert.match(aiProposalEditNarration(many, 1000), /Edit 1001 of 1001/);
});

test('AI narration identifies Word paragraphs, reads explanations separately, and labels bounded excerpts without changing source', () => {
  const proposal = detail(), original = structuredClone(proposal);
  assert.equal(aiProposalLocation('docx/paragraph-2.txt'), 'Word paragraph 2');
  assert.match(aiProposalEditNarration(proposal, 0), /Word paragraph 2.*Original: rough.*Replacement: clear/);
  assert.match(aiProposalEditNarration(proposal, 0, true), /Explanation: Use precise wording/);
  assert.deepEqual(proposal, original);
  proposal.proposal.result!.edits[0]!.replacement = '😀'.repeat(4000);
  const spoken = aiProposalEditNarration(proposal, 0); assert.ok(Array.from(spoken).length <= AI_PROPOSAL_SPEECH_LIMIT + 100); assert.match(spoken, /Excerpt shortened/);
});
