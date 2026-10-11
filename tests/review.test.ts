import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLocally } from '../shared/review';
import { localModelEndpoint, parseAIResponse } from '../server/ai';

test('paper checks resolve references across files and BibTeX, preserving line anchors', () => {
  const report = analyzeLocally('paper', [
    { path: 'main.tex', content: '\\begin{abstract}Hi\\end{abstract}\nSee \\ref{thm:one} and \\citep[p. 4]{known,missing}.\n% \\ref{commented}\n\\ref{missing-label}' },
    { path: 'proof.tex', content: '\\label{thm:one}\n\\label{thm:one}' },
    { path: 'refs.bib', content: '@article{known, title={Known}}' },
  ]);
  assert.equal(report.provider, 'local');
  assert.deepEqual(report.findings.map(f => [f.title, f.filePath, f.line]), [
    ['Duplicate label', 'proof.tex', 2], ['Unresolved citation', 'main.tex', 2], ['Unresolved reference', 'main.tex', 4],
  ]);
});

test('local checks detect blockers without echoing secret values', () => {
  const report = analyzeLocally('code', [{ path: 'x.ts', content: '<<<<<<< HEAD\nconst apiKey = "sensitive-test-value";\neval(input);\n// TODO: test' }]);
  assert.equal(report.findings[0].severity, 'error');
  assert.equal(report.findings.length, 4);
  assert.ok(!JSON.stringify(report).includes('sensitive-test-value'));
});

test('Markdown Setext headings are allowed while complete and incomplete conflict blocks remain errors', () => {
  const heading = analyzeLocally('document', [{ path: 'motion.md', content: 'Requested relief\n=======\nFourteen additional days.\n\nReasons\n==========\nThe parties need a complete record.' }]);
  assert.equal(heading.findings.filter(finding => finding.title === 'Unresolved merge marker').length, 0);
  for (const content of ['<<<<<<< HEAD\nOld wording\n=======\nNew wording\n>>>>>>> change', '<<<<<<< HEAD\nUnfinished conflict', 'Orphaned end\n>>>>>>> change']) {
    const report = analyzeLocally('document', [{ path: 'motion.md', content }]);
    assert.ok(report.findings.some(finding => finding.title === 'Unresolved merge marker' && finding.severity === 'error'));
  }
});

test('escaped percentages do not hide genuine LaTeX references', () => {
  const report = analyzeLocally('paper', [{ path: 'paper.tex', content: String.raw`50\% and \ref{missing} % \ref{ignored}` }]);
  assert.equal(report.findings.filter(f => f.title === 'Unresolved reference').length, 1);
});

test('bibliography review uses the bounded snapshot inventory and never calls incomplete citations missing', () => {
  const ignored = analyzeLocally('paper', [{ path: 'main.tex', content: '\\begin{abstract}Text\\end{abstract}\n\\verb|\\cite{ignore}|\n\\begin{verbatim}\\cite{ignore-too}\\end{verbatim}\n\\cite{known}' }, { path: 'refs.bib', content: '@book(known,title={Nested {title}})' }]);
  assert.equal(ignored.findings.length, 0);
  const incomplete = analyzeLocally('paper', [{ path: 'main.tex', content: '\\begin{abstract}Text\\end{abstract}\n\\cite{unresolved}' }, { path: 'refs.bib', content: '@book{broken,title={unterminated}' }]);
  assert.equal(incomplete.findings.some(finding => finding.title === 'Unresolved citation'), false);
  assert.ok(incomplete.findings.some(finding => finding.title === 'Bibliography inventory limitation'));
  assert.match(incomplete.summary, /active TeX reachability/); assert.equal(incomplete.model, 'text-checks-v2');
});

test('drafting checks identify missing evidence without claiming legal analysis', () => {
  const report = analyzeLocally('document', [{ path: 'motion.md', content: 'The record establishes the claim. [citation needed]\nSubmitted on [date].' }]);
  assert.equal(report.findings.length, 2);
  assert.match(report.summary, /not verified/);
});

test('local model endpoint forbids remote origins and embedded credentials', () => {
  assert.equal(localModelEndpoint('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/api/chat');
  assert.throws(() => localModelEndpoint('https://remote.example'));
  assert.throws(() => localModelEndpoint('http://user:password@localhost:11434'));
  assert.throws(() => localModelEndpoint('http://localhost:11434/redirect'));
});

const files = [{ path: 'main.ts', content: 'const x = 1;\n' }];
const response = (value: unknown) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
test('AI adapter accepts grounded findings and keeps explicit model provenance', () => {
  const report = parseAIResponse(response({ summary: 'Test review.', findings: [{ severity: 'warning', filePath: 'main.ts', line: 1, title: 'Example', body: 'Example finding.' }] }), files, 'configured-model');
  assert.equal(report.model, 'configured-model');
  assert.equal(report.findings[0].source, 'ai');
});
test('AI adapter rejects incomplete, refused, malformed and ungrounded output', () => {
  assert.throws(() => parseAIResponse({ status: 'incomplete', output: [] }, files, 'model'));
  assert.throws(() => parseAIResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }, files, 'model'));
  assert.throws(() => parseAIResponse(response({ summary: 'x', findings: [{ severity: 'error', filePath: 'invented.ts', line: 1, title: 'x', body: 'x' }] }), files, 'model'));
  assert.throws(() => parseAIResponse(response({ summary: 'x', findings: [{ severity: 'error', filePath: 'main.ts', line: 500, title: 'x', body: 'x' }] }), files, 'model'));
  assert.throws(() => parseAIResponse(response({ summary: 'x', findings: 'none' }), files, 'model'));
});
