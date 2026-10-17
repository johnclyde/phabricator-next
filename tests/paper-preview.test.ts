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

test('complete documents project their body and render preamble metadata at maketitle', () => {
  const source = String.raw`\documentclass[12pt]{article}
\usepackage{amsmath}
\newcommand{\unexecuted}{hidden setup}
\title{Finite sums with $n$}
\author{A. Researcher}
\date{October 2026}
\begin{document}
\maketitle
\section{Proof}
For $n>0$, \[\sum_{i=1}^n i = \frac{n(n+1)}{2}\]
\cite{unresolved} and \input{other.tex} remain visible.
\end{document}
ignored trailing material`;
  const original = source;
  const parsed = parsePaperPreview(source);
  assert.equal(parsed.limited, false);
  assert.deepEqual(parsed.blocks.slice(0, 4), [
    { kind: 'heading', level: 1, children: [{ kind: 'text', text: 'Finite sums with ' }, { kind: 'math', expression: 'n', source: '$n$' }] },
    { kind: 'paragraph', children: [{ kind: 'text', text: 'A. Researcher' }] },
    { kind: 'paragraph', children: [{ kind: 'text', text: 'October 2026' }] },
    { kind: 'heading', level: 2, children: [{ kind: 'text', text: 'Proof' }] },
  ]);
  assert.ok(parsed.blocks.some(block => block.kind === 'math' && block.expression.includes('sum')));
  assert.ok(text(source).includes(String.raw`\cite{unresolved}`));
  assert.ok(text(source).includes(String.raw`\input{other.tex}`));
  assert.doesNotMatch(JSON.stringify(parsed), /documentclass|usepackage|unexecuted|hidden setup|maketitle|begin\{document\}|end\{document\}|trailing material/);
  assert.equal(source, original);
});

test('document wrappers accept whitespace and comments and need no closing marker while editing', () => {
  const source = '\\documentclass{article}\n\\title % title metadata\n {Draft}\n\\author{Writer}\n\\date{}\n\\begin % document wrapper\n {document}\\maketitle\\section{Proof}Body $x$';
  const parsed = parsePaperPreview(source);
  assert.equal(parsed.blocks.filter(block => block.kind === 'heading').length, 2);
  assert.deepEqual(parsed.blocks[1], { kind: 'paragraph', children: [{ kind: 'text', text: 'Writer' }] });
  assert.ok(text(source).includes('Body $x$'));
  assert.equal(parsed.blocks.length, 4);
  const ended = source + '\\end % closing wrapper\n {document}ignored';
  assert.deepEqual(parsePaperPreview(ended), parsed);
  assert.deepEqual(parsePaperPreview(String.raw`\documentclass{article}\begin{document}\end{document}`), { blocks: [], limited: false });
  for (const fragment of [String.raw`\begin{document`, String.raw`\end{document}`, String.raw`\documentclass{article}`]) {
    assert.equal(text(fragment), fragment);
  }
});

test('maketitle uses only explicit metadata, does not consume following groups and does not run macros', () => {
  assert.equal(text(String.raw`\title{Hidden title}\begin{document}Body\end{document}`), 'Body');
  assert.deepEqual(parsePaperPreview(String.raw`\title{Old}\title{New}\date{}\begin{document}\maketitle{Body}\end{document}`).blocks, [
    { kind: 'heading', level: 1, children: [{ kind: 'text', text: 'New' }] },
    { kind: 'paragraph', children: [{ kind: 'text', text: '{Body}' }] },
  ]);
  assert.equal(text(String.raw`\title{Title}\date{\today}\begin{document}\maketitle\textbf{Body}\end{document}`), String.raw`Title\today`);
  assert.ok(inline(String.raw`\title{Title}\begin{document}\maketitle\textbf{Body}\end{document}`).some(node => node.kind === 'strong'));
  assert.equal(text(String.raw`\maketitle{fragment}`), String.raw`\maketitle{fragment}`);
  assert.equal(text(String.raw`\newcommand{\openbracket}{[}\begin{document}Body\end{document}`), 'Body');
  assert.equal(text(String.raw`A [draft note\begin{document}For x in [0,1), see [draft note\end{document}ignored`), 'For x in [0,1), see [draft note');
  assert.equal(text(String.raw`\title{Title}\begin{document}\maketitle[0,1)\end{document}ignored`), 'Title[0,1)');
  for (const prefix of [String.raw`\textbf{Interval}`, String.raw`\section{Proof}`, String.raw`\section[Short]{Proof}`]) {
    const preview = JSON.stringify(parsePaperPreview(`\\begin{document}${prefix} [0,1)\\end{document}ignored`));
    assert.ok(preview.includes('[0,1)'), prefix);
    assert.doesNotMatch(preview, /ignored|end\{document\}/, prefix);
  }
  const largeTitle = 'x'.repeat(11_000);
  const repeatedTitles = `\\title{${largeTitle}}\\begin{document}${'\\maketitle'.repeat(10_000)}\\end{document}`;
  assert.deepEqual(parsePaperPreview(repeatedTitles), { blocks: [{ kind: 'heading', level: 1, children: [{ kind: 'text', text: largeTitle }] }], limited: false });
});

test('metadata declared in the body before maketitle replaces preamble metadata without duplicate headings', () => {
  const source = String.raw`\title{Old}\author{Old writer}\date{Old date}
\begin{document}\title{Final title}\author{Writer}\date{}\maketitle Body\end{document}`;
  const parsed = parsePaperPreview(source);
  assert.deepEqual(parsed.blocks, [
    { kind: 'heading', level: 1, children: [{ kind: 'text', text: 'Final title' }] },
    { kind: 'paragraph', children: [{ kind: 'text', text: 'Writer' }] },
    { kind: 'paragraph', children: [{ kind: 'text', text: ' Body' }] },
  ]);
  assert.equal(text(String.raw`\begin{document}\title{Title}\author{Writer}\date{2026}\maketitle\end{document}`), 'TitleWriter2026');
  assert.equal(text(String.raw`\begin{document}\title{Hidden until maketitle}Body\end{document}`), 'Body');
});

test('literal examples, math, arguments, and nested environments cannot introduce document boundaries', () => {
  const examples = [
    '% \\begin{document} example\n',
    String.raw`\\begin{document}`,
    String.raw`\verb|\begin{document}|`,
    String.raw`\verb*+\begin{document}+`,
    ...['verbatim', 'verbatim*', 'lstlisting', 'minted'].map(name => `\\begin{${name}}\n\\begin{document}\n\\end{${name}}`),
    String.raw`$\text{\begin{document}}$`,
    String.raw`\[\begin{document}\]`,
    String.raw`\begin{align}\begin{document}\end{align}`,
    String.raw`\newcommand{\example}{\begin{document}}`,
    String.raw`{nested {\begin{document}}}`,
    String.raw`\option[\begin{document}]{value}`,
    String.raw`\option[{]}\begin{document}]{value}`,
    String.raw`\newcommand{\example}[1][\begin{document}]{#1}`,
    String.raw`\begin{quote}\begin{document}example\end{document}\end{quote}`,
  ];
  for (const example of examples) {
    const fragment = `VISIBLE BEFORE ${example}\nVISIBLE AFTER`;
    assert.ok(JSON.stringify(parsePaperPreview(fragment)).includes('VISIBLE BEFORE'), example);
    const complete = `${example}\n\\begin{document}REAL BODY\\end{document}`;
    assert.equal(text(complete), 'REAL BODY', example);
    const bodyExample = example.replaceAll('begin{document}', 'end{document}');
    const body = `\\begin{document}VISIBLE BEFORE ${bodyExample}\nVISIBLE AFTER\\end{document}`;
    assert.ok(JSON.stringify(parsePaperPreview(body)).includes('VISIBLE AFTER'), example);
  }
});

test('document title markers inside literal body examples remain untouched', () => {
  const source = String.raw`\title{Title}\begin{document}
\verb|\maketitle| \macro{\maketitle} $\text{\maketitle}$
\begin{verbatim}\maketitle\end{verbatim}
\maketitle
\end{document}`;
  const parsed = parsePaperPreview(source);
  assert.equal(parsed.blocks.filter(block => block.kind === 'heading').length, 1);
  assert.ok(parsed.blocks.some(block => block.kind === 'source' && block.source.includes(String.raw`\maketitle`)));
  assert.ok(text(source).includes(String.raw`\macro{\maketitle}`));
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
