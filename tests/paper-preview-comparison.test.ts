import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePaperPreview, type PaperPreview, type PaperPreviewInline } from '../shared/paper-preview';
import { comparePaperPreviews, PAPER_PREVIEW_COMPARISON_LIMITS, type PaperPreviewHighlights } from '../shared/paper-preview-comparison';

function compare(before: string, after: string) {
  const comparison = comparePaperPreviews(parsePaperPreview(before), parsePaperPreview(after));
  assert.equal(comparison.status, 'ready');
  return comparison;
}

function leaves(preview: PaperPreview): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (nodes: PaperPreviewInline[], prefix: string) => nodes.forEach((node, index) => {
    const path = `${prefix}-${index}`;
    if (node.kind === 'strong' || node.kind === 'emphasis') visit(node.children, path);
    else if (node.kind === 'math') result.set(path, node.source);
    else if ('text' in node) result.set(path, node.text);
  });
  preview.blocks.forEach((block, index) => {
    const path = `block-${index}`;
    if (block.kind === 'paragraph' || block.kind === 'heading') visit(block.children, path);
    else result.set(path, block.source);
  });
  return result;
}

function highlighted(source: string, highlights: PaperPreviewHighlights): string[] {
  const sourceLeaves = leaves(parsePaperPreview(source));
  return Object.entries(highlights).flatMap(([path, ranges]) => {
    const text = sourceLeaves.get(path);
    assert.notEqual(text, undefined, `Highlight points to a real rendered leaf: ${path}`);
    let end = 0;
    return ranges.map(range => {
      assert.ok(range.start >= end && range.end > range.start && range.end <= text!.length);
      assert.ok(!/[\uDC00-\uDFFF]/.test(text![range.start] ?? ''), 'No range starts inside a surrogate pair.');
      assert.ok(!/[\uD800-\uDBFF]/.test(text![range.end - 1] ?? ''), 'No range ends inside a surrogate pair.');
      end = range.end;
      return text!.slice(range.start, range.end);
    });
  });
}

test('rendered comparison marks changed prose words at exact UTF-16 leaf offsets', () => {
  const before = 'The red fox sees β😀 and cafe\u0301.', after = 'The blue fox sees γ🦊 and cafe\u0301.';
  const comparison = compare(before, after);
  assert.equal(comparison.changed, true);
  assert.deepEqual(comparison.before, { 'block-0-0': [{ start: 4, end: 7 }, { start: 17, end: 20 }] });
  assert.deepEqual(comparison.after, { 'block-0-0': [{ start: 4, end: 8 }, { start: 18, end: 21 }] });
  assert.deepEqual(highlighted(before, comparison.before), ['red', 'β😀']);
  assert.deepEqual(highlighted(after, comparison.after), ['blue', 'γ🦊']);
});

test('hidden preamble, document delimiters, comments and prose whitespace do not create reading changes', () => {
  const before = String.raw`\documentclass{article}\usepackage{amsmath}\title{Unused}\begin{document}The claim
holds for $x$.

Proof here.\end{document}`;
  const after = String.raw`\documentclass{book}\title{Also hidden}\begin{document}
  The   claim holds for \(x\). % invisible comment
Proof here.
\end{document} trailing material`;
  assert.deepEqual(compare(before, after), { status: 'ready', before: {}, after: {}, changed: false });
  assert.equal(compare('a+b', 'a + b').changed, false);
  assert.equal(compare('alpha beta', 'alphabeta').changed, true, 'Words joined together are still different words.');
});

test('title changes, heading levels and nested emphasis retain their visible context', () => {
  const before = String.raw`\title{First theorem}\begin{document}\maketitle\section{Proof}\textbf{A \emph{short} proof}\end{document}`;
  const after = String.raw`\title{Second theorem}\begin{document}\maketitle\subsection{Proof}\textbf{A short proof}\end{document}`;
  const comparison = compare(before, after);
  assert.deepEqual(highlighted(before, comparison.before), ['First', 'Proof', 'short']);
  assert.deepEqual(highlighted(after, comparison.after), ['Second', 'Proof', 'short']);
  assert.deepEqual(comparison.before['block-2-0-1-0'], [{ start: 0, end: 5 }]);
  const emphasis = compare('Plain words', String.raw`\emph{Plain words}`);
  assert.deepEqual(highlighted('Plain words', emphasis.before), ['Plain words']);
  assert.deepEqual(emphasis.after, { 'block-0-0-0': [{ start: 0, end: 11 }] });
});

test('equations are atomic while unchanged formulas and equivalent delimiters remain unmarked', () => {
  const before = String.raw`For $x^2$, use \[a+b=c\] and $z$ afterwards.`;
  const after = String.raw`For $x^3$, use $$a+b\ne c$$ and \(z\) afterwards.`;
  const comparison = compare(before, after);
  assert.deepEqual(highlighted(before, comparison.before), ['$x^2$', String.raw`\[a+b=c\]`]);
  assert.deepEqual(highlighted(after, comparison.after), ['$x^3$', String.raw`$$a+b\ne c$$`]);
  assert.deepEqual(comparison.before['block-0-1'], [{ start: 0, end: '$x^2$'.length }]);
  assert.deepEqual(comparison.after['block-1'], [{ start: 0, end: String.raw`$$a+b\ne c$$`.length }]);
  assert.equal(compare(String.raw`\[x\]`, '$$x$$').changed, false);
  const displayChange = compare('$x$', String.raw`\[x\]`);
  assert.deepEqual(highlighted('$x$', displayChange.before), ['$x$']);
  assert.deepEqual(highlighted(String.raw`\[x\]`, displayChange.after), [String.raw`\[x\]`]);
});

test('changed macro definitions conservatively mark potentially affected later equations', () => {
  const before = String.raw`$a$ then $\gdef\x{1}$ and $\x$ then \[z+1\] unchanged prose`;
  const after = String.raw`$a$ then $\gdef\x{2}$ and $\x$ then \[z+1\] unchanged prose`;
  const comparison = compare(before, after);
  assert.deepEqual(highlighted(before, comparison.before), [String.raw`$\gdef\x{1}$`, String.raw`$\x$`, String.raw`\[z+1\]`]);
  assert.deepEqual(highlighted(after, comparison.after), [String.raw`$\gdef\x{2}$`, String.raw`$\x$`, String.raw`\[z+1\]`]);
  assert.equal(compare(before, before).changed, false);
  for (const command of ['def', 'gdef', 'edef', 'xdef', 'let', 'futurelet', 'global', 'newcommand', 'renewcommand', 'providecommand']) {
    const first = `$\\${command}\\x{1}$ then $\\x$`;
    const second = `$\\${command}\\x{2}$ then $\\x$`;
    assert.ok(highlighted(second, compare(first, second).after).includes(String.raw`$\x$`), command);
  }
});

test('later changed macro invocations remain part of the conservative math context', () => {
  const before = String.raw`$\gdef\set#1{\gdef\x{#1}}$ then $\set{1}$ then $\x$`;
  const after = String.raw`$\gdef\set#1{\gdef\x{#1}}$ then $\set{2}$ then $\x$`;
  const comparison = compare(before, after);
  assert.deepEqual(highlighted(before, comparison.before), [String.raw`$\set{1}$`, String.raw`$\x$`]);
  assert.deepEqual(highlighted(after, comparison.after), [String.raw`$\set{2}$`, String.raw`$\x$`]);
});

test('literal commands, code and source blocks compare exact text including whitespace', () => {
  const before = String.raw`\unknown{a b} \verb|a b|
\begin{verbatim}a b\end{verbatim}`;
  const after = String.raw`\unknown{a  b} \verb|a  b|
\begin{verbatim}a  b\end{verbatim}`;
  const comparison = compare(before, after);
  assert.deepEqual(highlighted(before, comparison.before), [String.raw`\unknown{a b}`, 'a b', String.raw`\begin{verbatim}a b\end{verbatim}`]);
  assert.deepEqual(highlighted(after, comparison.after), [String.raw`\unknown{a  b}`, 'a  b', String.raw`\begin{verbatim}a  b\end{verbatim}`]);
  assert.equal(compare(String.raw`\verb|one|`, 'one').changed, true, 'Visible code formatting remains significant.');
});

test('empty, equal, added and removed readings return truthful reversible ranges', () => {
  assert.deepEqual(compare('', ''), { status: 'ready', before: {}, after: {}, changed: false });
  assert.deepEqual(compare(' \n\n', '\t'), { status: 'ready', before: {}, after: {}, changed: false });
  const source = String.raw`\section{New section}Some prose with $x$ and \textbf{weight}.`;
  const added = compare('', source), removed = compare(source, '');
  assert.deepEqual(added.before, {});
  assert.deepEqual(added.after, removed.before);
  assert.deepEqual(removed.after, {});
  assert.deepEqual(highlighted(source, added.after), ['New section', 'Some prose with', '$x$', 'and', 'weight', '.']);
  assert.equal(compare(source, source).changed, false);
  const replacement = compare('The first claim holds.', 'The second claim fails.');
  const reversed = compare('The second claim fails.', 'The first claim holds.');
  assert.deepEqual(replacement.before, reversed.after);
  assert.deepEqual(replacement.after, reversed.before);
});

test('repeated words use deterministic ordered matching and changed runs merge only across whitespace', () => {
  const before = 'repeat old short repeat unchanged old end';
  const after = 'repeat new long repeat unchanged new end';
  const comparison = compare(before, after);
  assert.deepEqual(highlighted(before, comparison.before), ['old short', 'old']);
  assert.deepEqual(highlighted(after, comparison.after), ['new long', 'new']);
  assert.deepEqual(compare(before, after), comparison);
  assert.deepEqual(highlighted('a,b', compare('a,b', 'x,y').before), ['a', 'b'], 'An unchanged punctuation token separates ranges.');
});

test('comparison never mutates parsed nodes, original source, or exact formula text', () => {
  const beforeSource = String.raw`\section{A}Proof with $\frac{1}{2}$ and \textbf{bold words}.`;
  const afterSource = String.raw`\section{B}Proof with $\frac{2}{3}$ and \textbf{new words}.`;
  const before = parsePaperPreview(beforeSource), after = parsePaperPreview(afterSource);
  const snapshot = JSON.stringify([before, after]);
  function freeze(value: object) { Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); }); Object.freeze(value); }
  freeze(before); freeze(after);
  assert.equal(comparePaperPreviews(before, after).status, 'ready');
  assert.equal(JSON.stringify([before, after]), snapshot);
  assert.ok(beforeSource.includes(String.raw`$\frac{1}{2}$`));
  assert.ok(afterSource.includes(String.raw`$\frac{2}{3}$`));
});

test('incomplete parsing and deterministic resource limits never return partial or false unchanged highlights', () => {
  const limited = parsePaperPreview('x'.repeat(250_001));
  assert.equal(limited.limited, true);
  const outcomes = [
    comparePaperPreviews(limited, limited),
    comparePaperPreviews({ limited: false, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'x'.repeat(PAPER_PREVIEW_COMPARISON_LIMITS.inputCodeUnits + 1) }] }] }, parsePaperPreview('x')),
    comparePaperPreviews(parsePaperPreview('x '.repeat(PAPER_PREVIEW_COMPARISON_LIMITS.tokens + 1)), parsePaperPreview('x')),
    comparePaperPreviews(parsePaperPreview('a '.repeat(1_100)), parsePaperPreview('b '.repeat(1_100))),
    comparePaperPreviews(parsePaperPreview('x'.repeat(PAPER_PREVIEW_COMPARISON_LIMITS.highlightedCodeUnits + 1)), parsePaperPreview('')),
  ];
  for (const result of outcomes) {
    assert.equal(result.status, 'unavailable');
    assert.ok('reason' in result && result.reason.length > 0);
    assert.ok(!('before' in result) && !('after' in result) && !('changed' in result));
  }
  assert.deepEqual(comparePaperPreviews(limited, limited), outcomes[0]);
});

test('a wholly added long reading avoids edit-distance work while retaining all exact highlighted text', () => {
  const source = 'word '.repeat(PAPER_PREVIEW_COMPARISON_LIMITS.editLength + 1).trimEnd();
  const comparison = compare('', source);
  assert.deepEqual(comparison.after, { 'block-0-0': [{ start: 0, end: source.length }] });
});
