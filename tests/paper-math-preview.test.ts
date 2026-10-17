import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderPaperMath, PAPER_MATH_MARKUP_BUDGET } from '../client/paper-math-render';

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
