import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { aiProposalHead, aiProposalResult, aiProposalSourceVersion, aiProposalWordEdits, applyAIProposal, type AIProposalGenerateInput } from '../shared/ai-proposals.ts';
import type { RevisionKind, RevisionVersion } from '../shared/types.ts';
import { sourceSnapshotCanonical } from '../shared/source-snapshot.ts';
import { aiProposalSource, generateAIProposal, AI_PROPOSAL_PROMPT, AIProposalProviderError } from '../server/ai-proposal-provider.ts';
import { inspectDocx, replaceDocxBatch } from '../server/docx-package.ts';

// Explicit operator invocation only. No workspace database or user files are read.
const args = process.argv.slice(2), outputIndex = args.indexOf('--output');
if (args.length !== 4 || !args.includes('--run') || !args.includes('--allow-hosted') || outputIndex < 0 || !args[outputIndex + 1] || args[outputIndex + 1]!.startsWith('--')) {
  throw new Error('Usage: OPENAI_MODEL=<model> node --env-file-if-exists=.env --import tsx scripts/evaluate-ai-proposals.ts --run --allow-hosted --output REPORT.json. Sends six synthetic examples and may incur API usage.');
}
const model = process.env.OPENAI_MODEL?.trim();
if (!model || !process.env.OPENAI_API_KEY?.trim()) throw new Error('Configure OPENAI_MODEL and OPENAI_API_KEY explicitly.');
await writeFile(args[outputIndex + 1]!, JSON.stringify({ status: 'started', model, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function version(content: string, path = 'draft.txt'): RevisionVersion {
  const files = [{ path, content }];
  return { id: randomUUID(), revisionId: 'P1', number: 1, files, contentHash: hash(sourceSnapshotCanonical(files, [])), message: 'Synthetic evaluation example', createdAt: new Date().toISOString() };
}
const fixtures: { name: string; kind: RevisionKind; source: RevisionVersion; instruction: string; expected: string[] }[] = [
  { name: 'spelling-only', kind: 'document', source: version('The analaysis preserves the original evidence.'), instruction: 'Correct only spelling errors. Preserve every other character.', expected: ['The analysis preserves the original evidence.'] },
  { name: 'latex-and-citation-preservation', kind: 'paper', source: version('The result in \\ref{sec:method} is consistant with \\cite{smith2024}.\n', 'paper.tex'), instruction: 'Correct only the spelling error in the prose. Preserve LaTeX commands, citation keys, punctuation and the final newline exactly.', expected: ['The result in \\ref{sec:method} is consistent with \\cite{smith2024}.\n'] },
  { name: 'numbers-and-quoted-prose', kind: 'document', source: version('The applicant filed 24 exhibits. The witness wrote: "The applicant filed 24 exhibits."'), instruction: 'Change applicant to petitioner only outside the quoted witness statement. Preserve the quoted statement, number, punctuation and all other wording.', expected: ['The petitioner filed 24 exhibits. The witness wrote: "The applicant filed 24 exhibits."'] },
  { name: 'unsupported-claim-abstention', kind: 'paper', source: version('This intervention always cures the disease.'), instruction: 'No supporting evidence is supplied. Explain the evidence limitation without changing the text or inventing sources. Propose no edits.', expected: ['This intervention always cures the disease.'] },
  { name: 'no-unrequested-rewrite', kind: 'document', source: version('The sample contains 24 observations.'), instruction: 'Correct spelling mistakes only. If there are none, return no edits. Do not improve style or alter claims.', expected: ['The sample contains 24 observations.'] },
];
const packageBytes = await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url)), projection = await inspectDocx(packageBytes), digest = hash(packageBytes);
const word: RevisionVersion = { ...version(''), files: [], docx: { format: 'docx', fileName: 'Synthetic motion.docx', sha256: digest, bytes: packageBytes.length, sourceFile: { fileId: 'F1', sha256: digest, bytes: packageBytes.length }, projection } };
word.contentHash = hash(sourceSnapshotCanonical([], [], word.docx));
const wordFiles = aiProposalSourceVersion(word).files;
fixtures.push({ name: 'word-paragraph-preservation', kind: 'document', source: word, instruction: `Replace the entire first supplied paragraph (${wordFiles[0]!.path}) with exactly "Reviewed synthetic heading.". Leave every other supplied paragraph unchanged.`, expected: wordFiles.map((file, index) => index === 0 ? 'Reviewed synthetic heading.' : file.content) });
const report = { format: 'phabricator.ai-proposal-evaluation.v1', model, startedAt: new Date().toISOString(), promptSha256: hash(AI_PROPOSAL_PROMPT), limitations: 'Six synthetic smoke cases with literal expected outputs. This is not a representative accuracy benchmark or verification of scientific claims, citations or legal correctness. No real workspace documents are submitted. Usage cost is not measured.', results: [] as unknown[] };
let failures = 0, completed = 0;
for (const fixture of fixtures) {
  completed++;
  const input: AIProposalGenerateInput = { provider: 'openai', model, instruction: fixture.instruction, expectedHead: aiProposalHead(fixture.source), expectedAccessEpoch: 1, scope: null, allowHosted: true };
  const source = aiProposalSource(fixture.kind, fixture.source, input), started = Date.now();
  try {
    const generated = await generateAIProposal(input, source), result = aiProposalResult(generated.result, fixture.source, null);
    const actual = (result.edits.length ? applyAIProposal(fixture.source, result) : aiProposalSourceVersion(fixture.source).files).map(file => file.content);
    const passed = JSON.stringify(actual) === JSON.stringify(fixture.expected);
    if (fixture.source.docx && result.edits.length) await replaceDocxBatch(packageBytes, aiProposalWordEdits(fixture.source, result), { author: 'Synthetic evaluation', date: new Date().toISOString() });
    if (!passed) failures++;
    report.results.push({ name: fixture.name, passed, elapsedMs: Date.now() - started, source, expected: fixture.expected, actual, result, responseModel: generated.responseModel, providerResponseId: generated.providerResponseId });
    console.log(JSON.stringify({ name: fixture.name, passed, edits: result.edits.length, elapsedMs: Date.now() - started }));
  } catch (error) {
    failures++; report.results.push({ name: fixture.name, passed: false, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : 'Evaluation failed.' });
    console.log(JSON.stringify({ name: fixture.name, passed: false, elapsedMs: Date.now() - started }));
    if (error instanceof AIProposalProviderError) break;
  }
}
await writeFile(args[outputIndex + 1]!, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ passed: completed - failures, failed: failures, notRun: fixtures.length - completed, report: args[outputIndex + 1] }));
if (failures) process.exitCode = 1;
