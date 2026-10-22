import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderPaperMath, PAPER_MATH_MARKUP_BUDGET } from '../client/paper-math-render';
import { parsePaperPreview } from '../shared/paper-preview';
import { comparePaperPreviews } from '../shared/paper-preview-comparison';

// Browser stylesheet imports are irrelevant to SSR safety checks; Vite handles them in builds.
register(`data:text/javascript,${encodeURIComponent('export async function load(url, context, nextLoad) { if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true }; return nextLoad(url, context); }')}`, import.meta.url);
const { default: PaperMathPreview } = await import('../client/PaperMathPreview');
const renderSource = (source: string) => renderToStaticMarkup(createElement(PaperMathPreview, { source }));
const render = (...expressions: string[]) => renderPaperMath(expressions.map(expression => ({ expression, displayMode: false })));

test('local math rendering produces accessible MathML while the initial preview keeps exact equations visible', () => {
  const result = render(String.raw`\frac{1}{2}`);
  const html = result.results[0]!.html!;
  assert.match(html, /<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
  assert.match(html, /<mfrac>/);
  assert.match(html, /aria-hidden="true"/);
  const pending = renderSource(String.raw`\section{Result} The answer is $\frac{1}{2}$.`);
  assert.match(pending, /<h3>Result<\/h3>/);
  assert.match(pending, /\$\\frac\{1\}\{2\}\$/);
  assert.match(pending, /Preparing math on this device/);
});

test('unknown expressions and incomplete edits retain escaped original source', () => {
  const result = render(String.raw`\unknown{<script>alert(1)</script>}`);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0]!.html, null);
  const html = renderSource(String.raw`$\unknown{<script>alert(1)</script>}$ and $unfinished`);
  assert.match(html, /\$\\unknown\{&lt;script&gt;alert\(1\)&lt;\/script&gt;\}\$/);
  assert.match(html, /\$unfinished/);
  assert.doesNotMatch(html, /<script\b/);
});

test('rendered highlights escape source text and preserve the whole unsupported equation fallback', () => {
  const source = String.raw`<script>alert(1)</script> $\unknown{<img src=x>}$`;
  const parsedPreview = parsePaperPreview(source);
  const comparison = comparePaperPreviews(parsePaperPreview(''), parsedPreview);
  assert.equal(comparison.status, 'ready');
  if (comparison.status !== 'ready') return;
  const html = renderToStaticMarkup(createElement(PaperMathPreview, {
    source, parsedPreview, highlights: comparison.after, changeKind: 'added',
  }));
  assert.match(html, /<ins[^>]*data-change-kind="added"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<code[^>]*>\$\\unknown\{&lt;img src=x&gt;\}\$<\/code><\/ins>/);
  assert.doesNotMatch(html, /<(?:script|img)\b/);
  assert.equal(source, String.raw`<script>alert(1)</script> $\unknown{<img src=x>}$`);
});

test('untrusted math cannot create links, images, CSS, HTML attributes or remote fetches', () => {
  const result = render(
    String.raw`\href{javascript:alert(1)}{click}`,
    String.raw`\includegraphics{https://example.test/tracker}`,
    String.raw`\htmlStyle{background:url(https://example.test/tracker)}{x}`,
    String.raw`\htmlClass{evil}{x}`,
    String.raw`\htmlId{evil}{x}`,
  );
  const mathHtml = result.results.map(item => item.html ?? '').join('');
  assert.doesNotMatch(mathHtml, /<(?:a|img|iframe|script|style|link)\b|\b(?:src|href)="|class="evil"|id="evil"/);
  const html = renderSource('<img src="https://example.test/prose" onerror="alert(1)">\n<iframe src="https://example.test/frame"></iframe>');
  assert.doesNotMatch(html, /<(?:a|img|iframe|script|style|link)\b|\b(?:src|href)="|class="evil"|id="evil"/);
  assert.match(html, /&lt;img/);
});

test('macro state is local to one document and a failed expression cannot mutate later equations', () => {
  const first = render(String.raw`\gdef\answer{42}`, String.raw`\answer`);
  assert.ok(first.results.every(item => item.html !== null));
  assert.equal(render(String.raw`\answer`).results[0]!.html, null);
  const failed = render(String.raw`\gdef\answer{42}\unknown`, String.raw`\answer`);
  assert.equal(failed.failed, 2);
  assert.ok(failed.results.every(item => item.html === null));
});

test('recursive macros fail safely and user dimensions are capped', () => {
  assert.equal(render(String.raw`\def\loop{\loop}\loop`).results[0]!.html, null);
  const huge = render(String.raw`\rule{999999em}{999999em}`).results[0]!.html!;
  assert.doesNotMatch(huge, /(?:width|height):999999em/);
  assert.match(huge, /(?:width|height):20em/);
});

test('cumulative markup and input budgets bound large previews without discarding original source', () => {
  const expression = 'x+'.repeat(400) + 'x';
  const expressions = Array.from({ length: 300 }, () => expression);
  const result = render(...expressions);
  assert.equal(result.limited, true);
  assert.equal(result.results.length, 300);
  assert.ok(result.results.some(item => item.html !== null));
  assert.ok(result.results.some(item => item.html === null));
  assert.ok(result.results.reduce((sum, item) => sum + (item.html?.length ?? 0), 0) <= PAPER_MATH_MARKUP_BUDGET);
  const source = expressions.map(value => `$${value}$`).join('\n');
  const pending = renderSource(source);
  assert.equal((pending.match(/Original equation source/g) ?? []).length, 300);
  assert.equal((pending.match(/\$x\+x\+/g) ?? []).length, 300);
  assert.equal(render(' '.repeat(12_001)).limited, true);
});

const structuredPaper = String.raw`\documentclass{article}
\newtheorem{proposition}{Proposition}
\newtheorem{example}{Example}
\newcommand{\leftdiv}{\mathrel{\mid_L}}
\DeclareMathOperator{\common}{gcd}
\title{Cancellation}
\begin{document}
\maketitle
\begin{abstract}A statement about $a\leftdiv b$.\end{abstract}
\begin{example}\label{ex:first}First example.\end{example}
\begin{example}\label{ex:second}Second example.\end{example}
\begin{proposition}\label{prop:first}Assume $\common(a,m)=1$.\end{proposition}
\begin{proof}Use Example~\ref{ex:second} and Proposition~\ref{prop:first}.
\begin{equation}\label{eq:result}a\leftdiv mn\end{equation}
Equation~\eqref{eq:result} finishes the proof.\end{proof}
\appendix
\section{Context}Additional context.
\end{document}`;

test('structured manuscripts render declared notation, labeled equations and theorem references without source debris', () => {
  const parsed = parsePaperPreview(structuredPaper);
  const requests: { expression: string; displayMode: boolean }[] = [];
  const visit = (nodes: import('../shared/paper-preview').PaperPreviewInline[]) => {
    for (const node of nodes) {
      if (node.kind === 'math') requests.push({ expression: node.expression, displayMode: false });
      else if (node.kind === 'strong' || node.kind === 'emphasis') visit(node.children);
      else assert.notEqual(node.kind, 'literal');
    }
  };
  for (const block of parsed.blocks) {
    if (block.kind === 'math') requests.push({ expression: block.expression, displayMode: true });
    else if (block.kind === 'heading' || block.kind === 'paragraph') visit(block.children);
  }
  const rendered = renderPaperMath(requests);
  assert.equal(rendered.failed, 0);
  assert.equal(rendered.limited, false);
  assert.ok(rendered.results.every(result => result.html));
  const html = renderSource(structuredPaper);
  assert.match(html, /<strong>Abstract<\/strong>/);
  assert.match(html, /<strong>Example 2\.<\/strong>/);
  assert.match(html, /<strong>Proposition 1\.<\/strong>/);
  assert.match(html, /<strong>Proof\.<\/strong>/);
  assert.match(html, /Example\u00a02 and Proposition\u00a01/);
  assert.match(html, /Equation\u00a0\(1\)/);
  assert.doesNotMatch(html, /paper-math-command|\\begin\{proof\}|\\ref\{|\\appendix/);
});

test('preamble notation participates in reading comparisons and remains scoped to its document', () => {
  const changed = structuredPaper.replace('\\mid_L', '\\mid_R');
  const comparison = comparePaperPreviews(parsePaperPreview(structuredPaper), parsePaperPreview(changed));
  assert.equal(comparison.status, 'ready');
  if (comparison.status === 'ready') assert.equal(comparison.changed, true);
  const plain = parsePaperPreview(String.raw`\begin{document}$a\leftdiv b$\end{document}`);
  const block = plain.blocks[0];
  assert.ok(block?.kind === 'paragraph');
  const node = block.children[0];
  assert.ok(node?.kind === 'math');
  assert.equal(render(node.expression).failed, 1);
});

test('unused preamble declarations do not exhaust the math input budget of a long paper', () => {
  const declarations = Array.from({ length: 20 }, (_, index) => String.raw`\newcommand{\unused${String.fromCharCode(65 + index)}}{\operatorname{unused}}`).join('\n');
  const source = declarations + String.raw`\begin{document}` + '$x$ '.repeat(150) + String.raw`\end{document}`;
  const parsed = parsePaperPreview(source);
  const expressions = parsed.blocks.flatMap(block => block.kind === 'paragraph' ? block.children.filter(node => node.kind === 'math').map(node => node.expression) : []);
  assert.equal(expressions.length, 150);
  const result = render(...expressions);
  assert.equal(result.failed, 0);
  assert.equal(result.limited, false);
});

test('commented equation labels and literal preamble examples do not define notation or references', () => {
  const source = String.raw`\verb|\newcommand{\fake}{42}|
% \newcommand{\hidden}{42}
\newcommand{\outer}{\newcommand{\nested}{42}}
\begin{document}
\begin{equation}x=1 % \label{eq:fake}
\label{eq:real}\end{equation}
See \eqref{eq:real}, \ref{eq:fake}; $\fake+\nested+\hidden$.
\end{document}`;
  const parsed = parsePaperPreview(source);
  const html = renderSource(source);
  assert.match(html, /See \(1\),/);
  assert.match(html, /\\ref\{eq:fake\}/);
  const paragraph = parsed.blocks.find(block => block.kind === 'paragraph' && block.children.some(node => node.kind === 'math'));
  assert.ok(paragraph?.kind === 'paragraph');
  const math = paragraph.children.find(node => node.kind === 'math');
  assert.ok(math?.kind === 'math');
  assert.equal(math.expression, String.raw`\fake+\nested+\hidden`);
});
