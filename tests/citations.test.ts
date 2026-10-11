import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCitations, CITATION_LIMITS, isConcreteCitationOccurrence } from '../shared/citations.ts';
import { citationEvidenceTarget } from '../shared/citation-evidence.ts';
import type { SourceFile } from '../shared/types.ts';

const bibliography = (content: string): SourceFile => ({ path: 'references.bib', content });
const manuscript = (content: string): SourceFile => ({ path: 'main.tex', content });
const values = (content: string) => analyzeCitations([bibliography(content)]).entries[0]!.fields.map(field => [field.name, field.value]);

test('BibTeX records retain nested brace and quoted values, numeric atoms and TeX markup exactly', () => {
  const files = [bibliography(String.raw`Outside text is ignored.
@BOOK(Proof:2026,
 TITLE = {A {Nested} {\LaTeX} Title},
 author = "Kurt G{\"o}del and {Someone, Else}",
 year = 2026,
 note = "Quote {"inside"} and {a {nested} group}",
)
@article{empty,}
@misc{fieldless}`), manuscript(String.raw`\cite{Proof:2026,empty,fieldless,absent}`)];
  const index = analyzeCitations(files); assert.equal(index.complete, true); assert.equal(index.entries.length, 3);
  assert.deepEqual(index.entries[0]!.fields.map(field => [field.name, field.value]), [['title', String.raw`A {Nested} {\LaTeX} Title`], ['author', String.raw`Kurt G{\"o}del and {Someone, Else}`], ['year', '2026'], ['note', 'Quote {"inside"} and {a {nested} group}']]);
  assert.deepEqual(index.citations.map(item => item.resolution), ['resolved', 'resolved', 'resolved', 'missing']);
  for (const entry of index.entries) assert.equal(files.find(file => file.path === entry.filePath)!.content.slice(entry.start, entry.end), entry.source);
  for (const field of index.entries[0]!.fields) assert.equal(files[0]!.content.slice(field.start, field.end), field.source);
});

test('unique snapshot string declarations concatenate across files and forward references without pretending to execute BibTeX', () => {
  const files = [{ path: 'z.bib', content: '@string{place={Press}}\n@string{series={Foundations } # place}' }, { path: 'a.bib', content: '@article{key, title=series # " " # 42, month=jan}' }, manuscript('\\cite{key,absent}')];
  const index = analyzeCitations(files); assert.equal(index.entries[0]!.fields[0]!.value, 'Foundations Press 42'); assert.equal(index.entries[0]!.fields[1]!.value, null);
  assert.equal(index.complete, false); assert.ok(index.diagnostics.some(item => item.code === 'unresolved_string' && item.key === 'jan'));
  assert.deepEqual(index.citations.map(item => item.resolution), ['resolved', 'unknown']);
  assert.deepEqual(analyzeCitations([...files].reverse()), index, 'input order cannot alter target identities or string lookup');
});

test('string cycles, case-insensitive redefinitions and duplicate fields stay explicit rather than selecting a value', () => {
  const index = analyzeCitations([bibliography('@string{a=b}\n@string{b=a}\n@string{x="First"}\n@string{X="Second"}\n@book{k,title=a,publisher=x,year=2025,YEAR=2026}')]);
  assert.equal(index.complete, false); assert.equal(index.entries[0]!.fields[0]!.value, null); assert.equal(index.entries[0]!.fields[1]!.value, null);
  for (const code of ['cyclic_string', 'ambiguous_string', 'duplicate_field']) assert.ok(index.diagnostics.some(item => item.code === code), code);
  assert.deepEqual(index.entries[0]!.fields.slice(2).map(field => field.value), ['2025', '2026'], 'duplicate fields remain separately reviewable');
});

test('entry and occurrence IDs bind exact UTF-16 ranges with CRLF, astral text and one-based lines', () => {
  const tex = '😀 prefix\r\n  \\citep[See][p. 3]{  Key ,\r\n Other }', bib = '😀\r\n@book{Key,title={A}}\r\n@article{Other,title="B"}';
  const index = analyzeCitations([manuscript(tex), bibliography(bib)]);
  assert.deepEqual(index.citations.map(item => [item.key, item.line, tex.slice(item.start, item.end)]), [['Key', 2, 'Key'], ['Other', 3, 'Other']]);
  for (const entry of index.entries) assert.equal(entry.id, JSON.stringify(['entry', entry.filePath, entry.start, entry.end, entry.key]));
  for (const citation of index.citations) assert.equal(citation.id, JSON.stringify(['citation', citation.filePath, citation.start, citation.end, citation.key]));
  assert.equal(index.entries[0]!.line, 2); assert.equal(index.entries[0]!.start, bib.indexOf('@book'));
  assert.notEqual(analyzeCitations([manuscript(' ' + tex), bibliography(bib)]).citations[0]!.id, index.citations[0]!.id);
});

test('LaTeX comments, escaped control symbols, inline verbatim and common verbatim environments contain no citations', () => {
  const tex = String.raw`% \cite{comment}
50\% real \cite{a} \\cite{not-a-command}
\verb|\cite{verbatim}| \verb*+\cite{verbatim-star}+
\lstinline[language=TeX]!\cite{listing}!
\begin{verbatim}
\cite{environment}
\end{verbatim}
\begin{Verbatim}[numbers=left]\cite{fancy}\end{Verbatim}
\begin{minted}{tex}\cite{minted}\end{minted}
\begin{comment}\cite{comment-environment}\end{comment}
\begin{thebibliography}{9}
\bibitem[Author {with ] inside braces}]{a} A bibliography item.
\cite{a,% comma and \cite{fake}
  b} \cite{c% join
d}
\bibitem{b} Second. \bibitem{cd} Third.
\end{thebibliography}`;
  const index = analyzeCitations([manuscript(tex)]); assert.equal(index.complete, true, JSON.stringify(index.diagnostics));
  assert.deepEqual(index.citations.map(item => item.key), ['a', 'a', 'b', 'cd']); assert.ok(index.citations.every(item => item.resolution === 'resolved'));
  assert.deepEqual(index.entries.map(item => item.key), ['a', 'b', 'cd']);
});

test('cite families handle notes, stars, multicite groups and volume arguments without mistaking notes for keys', () => {
  const index = analyzeCitations([manuscript(String.raw`\Citet* [See {nested}] [p. 2] {a}
\Parencites(Compare)(and also)[1]{a}[2]{b,c}
\volcite[See]{IV}[22]{d} \pvolcites(Compare)[See]{II}[1]{a}{III}{b}
\citeyearpar{c} \footfullcite{d} \nocite{*}`), bibliography('@book{a}\n@book{b}\n@book{c}\n@book{d}')]);
  assert.equal(index.complete, true, JSON.stringify(index.diagnostics));
  assert.deepEqual(index.citations.map(item => item.key), ['a', 'a', 'b', 'c', 'd', 'a', 'b', 'c', 'd', '*']);
  assert.equal(index.citations[0]!.command, 'Citet*'); assert.equal(index.citations.at(-1)!.resolution, 'unknown');
  assert.equal(index.diagnostics[0]!.code, 'wildcard'); assert.equal(index.diagnostics[0]!.severity, 'info');
});

test('duplicate snapshot keys include bibitems and remain case-sensitive, with all exact candidates linked', () => {
  const index = analyzeCitations([bibliography('@article{same}\n@book{Same}\n@misc{same}'), manuscript('\\begin{thebibliography}{9}\\bibitem{same} Text.\\end{thebibliography} \\cite{same,Same}')]);
  assert.equal(index.complete, true); assert.equal(index.citations[0]!.resolution, 'ambiguous'); assert.equal(index.citations[0]!.entryIds.length, 3); assert.equal(index.citations[1]!.resolution, 'resolved');
  assert.equal(index.diagnostics.filter(item => item.code === 'duplicate_key').length, 3);
});

test('bibitem targets retain complete raw entry bodies through the next literal item or bibliography end', () => {
  const tex = String.raw`\begin{thebibliography}{9}
\bibitem[Author (2026)]{a} Author. {A title}. \emph{Journal}.
% \bibitem{not-real}
\verb|\bibitem{not-real-either}| \cite{b}
\bibitem{b} Second author. https://example.test/${' '}
\end{thebibliography}
This text is outside the bibliography. \cite{a}`;
  const index = analyzeCitations([manuscript(tex)]); assert.equal(index.complete, true); assert.equal(index.entries.length, 2);
  assert.equal(index.entries[0]!.source, tex.slice(tex.indexOf('\\bibitem['), tex.indexOf('\\bibitem{b}')));
  assert.equal(index.entries[1]!.source, tex.slice(tex.indexOf('\\bibitem{b}'), tex.indexOf('\\end{thebibliography}')));
  for (const entry of index.entries) { assert.equal(tex.slice(entry.start, entry.end), entry.source); assert.equal(entry.id, JSON.stringify(['entry', entry.filePath, entry.start, entry.end, entry.key])); }
  assert.equal(index.citations[1]!.entryIds[0], index.entries[0]!.id);
  const outside = analyzeCitations([manuscript('\\bibitem{outside} Full raw text. \\cite{absent}')]);
  assert.equal(outside.complete, false); assert.ok(outside.diagnostics.some(item => item.code === 'unsupported_tex')); assert.equal(outside.entries[0]!.source, '\\bibitem{outside} Full raw text. \\cite{absent}'); assert.equal(outside.citations[0]!.resolution, 'unknown');
  const unclosed = analyzeCitations([manuscript('\\begin{thebibliography}{9}\\bibitem{a} Text')]); assert.equal(unclosed.complete, false); assert.ok(unclosed.diagnostics.some(item => item.code === 'malformed_tex'));
});

test('dynamic keys, unknown cite-like commands and changed token rules are uncertain rather than falsely missing', () => {
  const index = analyzeCitations([manuscript(String.raw`\cite{\macro,{grouped},a b,}
\customcite{dynamic} \catcode37=12 \cite{absent}`)]);
  assert.equal(index.complete, false); assert.ok(index.citations.every(item => item.resolution === 'unknown'));
  assert.ok(index.diagnostics.some(item => item.code === 'dynamic_key')); assert.equal(index.diagnostics.filter(item => item.code === 'unsupported_tex').length, 2);
});

test('nested citation notes are explicitly uncertain and malformed diagnostic ranges never exceed source', () => {
  const nested = analyzeCitations([manuscript('\\cite[Compare \\cite{inner}]{outer}')]);
  assert.equal(nested.complete, false); assert.equal(nested.citations[0]?.resolution, 'unknown'); assert.ok(nested.diagnostics.some(item => item.code === 'unsupported_tex'));
  for (const file of [manuscript('\\cite'), bibliography('@book{k,')]) {
    const index = analyzeCitations([file]); assert.equal(index.complete, false);
    assert.ok(index.diagnostics.every(item => item.start <= item.end && item.end <= file.content.length));
  }
});

test('snapshot inventory includes unused files and literal commands in conditional or macro bodies', () => {
  const files = [manuscript('\\newcommand{\\example}{\\cite{unused}}\n\\iffalse\\cite{unreachable}\\fi'), { path: 'unused.bib', content: '@book{unused}\n@book{unreachable}' }, { path: 'notes.md', content: '\\cite{not-tex}' }];
  const index = analyzeCitations(files); assert.equal(index.complete, true); assert.deepEqual(index.citations.map(item => item.resolution), ['resolved', 'resolved']);
});

test('BibTeX comments/preambles are not entries and percent characters within fields remain literal', () => {
  assert.deepEqual(values('@comment{ @book{ignored,title={nested}} }\n@preamble{"ignored" # {also ignored}}\n@book{real, title={100% original}, note="100% quoted"}'), [['title', '100% original'], ['note', '100% quoted']]);
  const index = analyzeCitations([bibliography('@comment(unused)\n@string(a="A")\n@book{real,title=a}')]); assert.equal(index.entries.length, 1); assert.equal(index.complete, true);
});

test('malformed source stops safely, retains earlier records and makes unmatched keys unknown', () => {
  for (const invalid of ['@book{broken,title={unterminated', '@book{broken,title="unbalanced }"}', '@book{broken,title="A" "B"}', '@book{broken, title=}', '@string{bad="A" #}', '@book{broken,title={a}, % not a BibTeX field\nyear=2026}']) {
    const index = analyzeCitations([bibliography('@book{good}\n' + invalid + '\n@book{phantom}'), manuscript('\\cite{good,phantom,absent}')]);
    assert.equal(index.complete, false, invalid); assert.ok(index.diagnostics.some(item => item.code === 'malformed_bibtex'), invalid); assert.equal(index.entries[0]?.key, 'good'); assert.ok(index.citations.filter(item => item.key !== 'good').every(item => item.resolution === 'unknown'));
  }
  for (const invalid of ['\\cite{unterminated', '\\cite[missing]{a', '\\verb|unterminated\n\\cite{a}', '\\begin{verbatim}\\cite{a}']) {
    const index = analyzeCitations([manuscript(invalid)]); assert.equal(index.complete, false); assert.ok(index.diagnostics.some(item => item.code === 'malformed_tex'));
  }
});

test('source and nesting limits produce explicit incomplete inventories without false missing claims', () => {
  let index = analyzeCitations([bibliography('x'.repeat(CITATION_LIMITS.fileSource + 1)), manuscript('\\cite{unknown}')]);
  assert.equal(index.complete, false); assert.equal(index.citations[0]?.resolution, 'unknown'); assert.equal(index.diagnostics[0]?.code, 'limit');
  index = analyzeCitations(Array.from({ length: CITATION_LIMITS.files + 1 }, (_, number) => ({ path: `${number}.bib`, content: '@book{k}' })));
  assert.equal(index.complete, false); assert.equal(index.entries.length, 0);
  index = analyzeCitations([bibliography('@book{k,title=' + '{'.repeat(CITATION_LIMITS.nesting + 2) + 'deep' + '}'.repeat(CITATION_LIMITS.nesting + 2) + '}'), manuscript('\\cite{missing}')]);
  assert.equal(index.complete, false); assert.equal(index.citations[0]?.resolution, 'unknown'); assert.equal(index.diagnostics[0]?.code, 'limit');
});

test('exponential string expansion and long chains are bounded with null fields and explicit diagnostics', () => {
  const strings = ['@string{s0="0123456789"}', ...Array.from({ length: 24 }, (_, index) => `@string{s${index + 1}=s${index} # s${index}}`)];
  const index = analyzeCitations([bibliography(strings.join('\n') + '\n@book{k,title=s24}')]);
  assert.equal(index.complete, false); assert.equal(index.entries[0]?.fields[0]?.value, null); assert.ok(index.diagnostics.some(item => item.code === 'limit'));
  const chain = Array.from({ length: 100 }, (_, n) => `@string{v${n}=v${n + 1}}`).join('\n') + '@string{v100="end"}@book{k,title=v0}';
  assert.equal(analyzeCitations([bibliography(chain)]).complete, false);
});

test('entry, occurrence, diagnostic and match-list limits bound adversarial repeated source', () => {
  let index = analyzeCitations([bibliography(Array.from({ length: CITATION_LIMITS.entries + 1 }, (_, n) => `@book{k${n}}`).join('\n')), manuscript('\\cite{not-found}')]);
  assert.equal(index.entries.length, CITATION_LIMITS.entries); assert.equal(index.complete, false); assert.equal(index.citations[0]?.resolution, 'unknown');
  index = analyzeCitations([manuscript('\\cite{x}'.repeat(CITATION_LIMITS.citations + 1))]); assert.equal(index.citations.length, CITATION_LIMITS.citations); assert.equal(index.complete, false); assert.ok(index.citations.every(item => item.resolution === 'unknown'));
  index = analyzeCitations([bibliography('@book{same}\n'.repeat(1001)), manuscript('\\cite{same}'.repeat(150))]);
  assert.ok(index.diagnostics.length <= CITATION_LIMITS.diagnostics); assert.ok(index.citations.reduce((sum, item) => sum + item.entryIds.length, 0) <= CITATION_LIMITS.entryLinks); assert.equal(index.complete, false);
  const key = 'x'.repeat(20_000);
  index = analyzeCitations([bibliography(`@book{${key}}\n`.repeat(20)), manuscript(`\\cite{${key}}`.repeat(30))]);
  assert.ok(index.citations.reduce((sum, item) => sum + item.entryIds.reduce((length, id) => length + id.length, 0), 0) <= CITATION_LIMITS.entryLinkText); assert.equal(index.complete, false);
});

test('concrete citation eligibility remains exact after diagnostics are truncated', () => {
  const index = analyzeCitations([manuscript('\\cite{\\dynamic}'.repeat(CITATION_LIMITS.diagnostics + 1) + '\\nocite{*}\\cite{literal-missing}')]);
  assert.equal(index.diagnostics.length, CITATION_LIMITS.diagnostics);
  assert.equal(isConcreteCitationOccurrence(index.citations.at(-3)!), false); assert.equal(isConcreteCitationOccurrence(index.citations.at(-2)!), false);
  assert.equal(isConcreteCitationOccurrence(index.citations.at(-1)!), true);
  assert.equal(citationEvidenceTarget(index, index.citations.at(-3)!.id), null); assert.equal(citationEvidenceTarget(index, index.citations.at(-2)!.id), null);
  assert.equal(citationEvidenceTarget(index, index.citations.at(-1)!.id)?.key, 'literal-missing');
  for (const key of ['', 'with space', 'a,b', '\\macro', '{group}', 'a%b', 'a#b', 'a~b', 'a^b']) assert.equal(isConcreteCitationOccurrence({ key, command: 'cite' }), false);
  assert.equal(isConcreteCitationOccurrence({ key: '*', command: 'NoCite*' }), false);
});
