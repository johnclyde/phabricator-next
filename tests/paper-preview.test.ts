import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePaperPreview, PAPER_PREVIEW_MAX_CHARACTERS, type PaperPreviewInline } from '../shared/paper-preview';

function inline(source: string): PaperPreviewInline[] {
  return parsePaperPreview(source).blocks.flatMap(block => block.kind === 'paragraph' || block.kind === 'heading' ? block.children : []);
}
function text(source: string): string {
  return inline(source).map(node => 'text' in node ? node.text : node.kind === 'math' ? node.source : '').join('');
}

test('paper preview recognizes prose, nested headings, emphasis and each math delimiter', () => {
  const source = String.raw`\section[Short]{The \emph{main} theorem with $x^2$}

For $x>0$ and \(y=2\), we obtain
\[\frac{x}{y}\]
and $$\sum_{i=1}^n i$$.
\begin{align*}a&=b\\c&=d\end{align*}`;
  const preview = parsePaperPreview(source);
  assert.equal(preview.limited, false);
  assert.equal(preview.blocks[0]?.kind, 'heading');
  const heading = preview.blocks[0];
  assert.ok(heading?.kind === 'heading');
  assert.equal(heading.level, 2);
  assert.ok(heading.children.some(node => node.kind === 'emphasis'));
  assert.deepEqual(preview.blocks.filter(block => block.kind === 'math').map(block => block.expression), [String.raw`\frac{x}{y}`, String.raw`\sum_{i=1}^n i`, String.raw`\begin{align*}a&=b\\c&=d\end{align*}`]);
  assert.deepEqual(inline('A $x$ and \\(y\\)').filter(node => node.kind === 'math').map(node => node.expression), ['x', 'y']);
});

test('comments, escaped punctuation and verbatim contents cannot introduce equations', () => {
  assert.equal(text('before% $not math$\nafter and \\$5 \\% \\_'), 'beforeafter and $5 % _');
  const source = String.raw`\verb|$literal$ % still here| and \begin{verbatim}
$not math$ \section{Not a heading} % literal
\end{verbatim}`;
  const parsed = parsePaperPreview(source);
  assert.ok(parsed.blocks.some(block => block.kind === 'source' && block.source.includes('$not math$')));
  assert.equal(inline(source).filter(node => node.kind === 'math').length, 0);
  assert.ok(inline(source).some(node => node.kind === 'code' && node.text === '$literal$ % still here'));
  assert.equal(text(String.raw`\verb|unfinished $literal$`), String.raw`\verb|unfinished $literal$`);
});

test('math closing delimiters respect escaped punctuation, braces and comments', () => {
  const source = '$\\text{a $ b} + \\$5% $ ignored\n + c$';
  const nodes = inline(source);
  assert.equal(nodes.length, 1);
  assert.ok(nodes[0]?.kind === 'math');
  assert.equal(nodes[0].source, source);
  assert.equal(nodes[0].expression, source.slice(1, -1));
  const environment = '\\begin{equation}a % \\end{equation}\n+b\\end{equation}';
  const block = parsePaperPreview(environment).blocks[0];
  assert.ok(block?.kind === 'math');
  assert.equal(block.source, environment);
});

test('unsupported and incomplete source is preserved visibly rather than discarded', () => {
  for (const source of [String.raw`\cite{unknown}`, String.raw`\input{secret.tex}`, '$unfinished', String.raw`\[unfinished`, String.raw`\begin{align}unfinished`, String.raw`\section{unfinished`]) {
    assert.equal(text(source), source);
  }
  assert.equal(text(String.raw`\href{https://example.test}{<img src=x onerror=alert(1)>}`), String.raw`\href{https://example.test}{<img src=x onerror=alert(1)>}`);
});

test('preview work limits leave all source available without limiting authoring', () => {
  const huge = '😀'.repeat(PAPER_PREVIEW_MAX_CHARACTERS) + '\nLAST LINE';
  assert.deepEqual(parsePaperPreview(huge), { blocks: [{ kind: 'source', source: huge }], limited: true });
  const largeEquation = '$$' + 'x'.repeat(12_001) + '$$';
  assert.deepEqual(parsePaperPreview(largeEquation), { blocks: [{ kind: 'source', source: largeEquation }], limited: true });
  const many = Array.from({ length: 305 }, (_, index) => `$x_${index}$`).join(' ');
  const parsed = parsePaperPreview(many);
  assert.equal(parsed.limited, true);
  assert.equal(text(many), many);
  assert.equal(inline(many).filter(node => node.kind === 'math').length, 300);
});
