import type { SourceFile } from './types';

/** Snapshot inventory bounds, measured in UTF-16 code units rather than bytes. */
export const CITATION_LIMITS = Object.freeze({ files: 200, totalSource: 4_000_000, fileSource: 1_000_000, entries: 10_000, citations: 20_000, fields: 100_000, tokens: 100_000, nesting: 64, diagnostics: 1_000, fieldValue: 262_144, resolvedTotal: 4_000_000, entryLinks: 100_000, entryLinkText: 4_000_000 });
export interface CitationLocation { filePath: string; start: number; end: number; line: number }
export interface CitationField extends CitationLocation { id: string; name: string; source: string; value: string | null }
export interface CitationEntry extends CitationLocation { id: string; key: string; kind: 'bibtex' | 'bibitem'; type: string; source: string; fields: CitationField[] }
export interface CitationOccurrence extends CitationLocation { id: string; key: string; command: string; resolution: 'resolved' | 'missing' | 'ambiguous' | 'unknown'; entryIds: string[] }
export type CitationDiagnosticCode = 'limit' | 'malformed_bibtex' | 'malformed_tex' | 'duplicate_key' | 'duplicate_field' | 'unresolved_string' | 'cyclic_string' | 'ambiguous_string' | 'dynamic_key' | 'unsupported_tex' | 'wildcard';
export interface CitationDiagnostic extends CitationLocation { id: string; code: CitationDiagnosticCode; severity: 'warning' | 'info' | 'error'; message: string; key?: string }
export interface CitationIndex { entries: CitationEntry[]; citations: CitationOccurrence[]; diagnostics: CitationDiagnostic[]; complete: boolean }

// The implementation below inventories literal source, never TeX execution,
// bibliography inclusion order, citation style, or the truth of a cited claim.

type Part = { kind: 'literal' | 'macro'; value: string; location: CitationLocation };
type Expression = { parts: Part[]; location: CitationLocation };
type ParsedField = { field: CitationField; expression: Expression };
type Macro = { name: string; expression: Expression; location: CitationLocation };
class StopFile extends Error {}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const space = (character: string | undefined) => character !== undefined && /\s/.test(character);
const letter = (character: string | undefined) => character !== undefined && /[A-Za-z@]/.test(character);
const identifier = (character: string | undefined) => character !== undefined && !/[\s"#%'(),={}]/.test(character);
const literalKey = (key: string) => key.length > 0 && !/[\s\\{}%#~^]/.test(key);

/** Independent of bounded diagnostics: does this occurrence name one literal key? */
export function isConcreteCitationOccurrence(citation: Pick<CitationOccurrence, 'key' | 'command'>): boolean {
  return literalKey(citation.key) && !citation.key.includes(',') && !(citation.command.replace(/\*$/, '').toLowerCase() === 'nocite' && citation.key === '*');
}

/**
 * Inventory .bib and .tex/.ltx/.bbl source. This does not choose an entrypoint,
 * expand TeX, evaluate conditionals, follow includes, load styles, inherit
 * crossref/xdata fields, or verify cited claims. Literal commands in macro
 * definitions/conditional branches are included because this is a snapshot.
 * @string lookup uses unique declarations throughout the snapshot, including
 * forward references; it does not reproduce BibTeX's ordered execution.
 * A resolved citation means one inventoried entry, not compilation reachability.
 * Missing is only reported when the bounded inventory is complete.
 */
export function analyzeCitations(files: readonly SourceFile[]): CitationIndex {
  const index: CitationIndex = { entries: [], citations: [], diagnostics: [], complete: true };
  const macros = new Map<string, Macro[]>(), fields: ParsedField[] = [], diagnostics = new Set<string>();
  let tokens = 0, resolvedTotal = 0, fieldsCount = 0;
  const diagnostic = (code: CitationDiagnosticCode, location: CitationLocation, message: string, key?: string, incomplete = true, severity: CitationDiagnostic['severity'] = 'warning') => {
    if (incomplete) index.complete = false;
    const id = JSON.stringify(['diagnostic', code, location.filePath, location.start, location.end, key ?? '']);
    if (diagnostics.has(id)) return;
    if (index.diagnostics.length >= CITATION_LIMITS.diagnostics - 1) {
      index.complete = false;
      if (index.diagnostics.length < CITATION_LIMITS.diagnostics) index.diagnostics.push({ ...location, id: JSON.stringify(['diagnostic', 'limit', location.filePath, location.start, location.end, 'diagnostics']), code: 'limit', severity: 'warning', message: 'Diagnostic limit reached; further problems are not individually listed.' });
      return;
    }
    diagnostics.add(id); index.diagnostics.push({ ...location, id, code, severity, message, ...(key === undefined ? {} : { key }) });
  };
  const stop = (location: CitationLocation, message: string): never => { diagnostic('limit', location, message); throw new StopFile(); };
  const countToken = (location: CitationLocation) => { if (++tokens > CITATION_LIMITS.tokens) stop(location, 'Expression token limit reached; remaining source is not inventoried.'); };
  const addEntry = (entry: CitationEntry) => { if (index.entries.length >= CITATION_LIMITS.entries) stop(entry, 'Bibliography entry limit reached; remaining source is not inventoried.'); index.entries.push(entry); };
  if (files.length > CITATION_LIMITS.files) { diagnostic('limit', { filePath: files[0]?.path ?? '', start: 0, end: 0, line: 1 }, 'Snapshot file limit reached; no files were inventoried.'); return index; }
  const supplied = [...files].sort((a, b) => compare(a.path, b.path));
  let sourceLength = 0;
  const paths = new Set<string>();
  for (let fileNumber = 0; fileNumber < supplied.length; fileNumber++) {
    const file = supplied[fileNumber]!;
    if (!/\.(?:bib|tex|ltx|bbl)$/i.test(file.path)) continue;
    const beginning: CitationLocation = { filePath: file.path, start: 0, end: 0, line: 1 };
    if (fileNumber >= CITATION_LIMITS.files) { diagnostic('limit', beginning, 'Snapshot file limit reached; this file is not inventoried.'); break; }
    if (paths.has(file.path)) { diagnostic('unsupported_tex', beginning, 'Duplicate source paths make source identities uncertain.'); continue; } paths.add(file.path);
    if (file.content.length > CITATION_LIMITS.fileSource || sourceLength + file.content.length > CITATION_LIMITS.totalSource) { diagnostic('limit', beginning, 'Source size limit reached; this file is not inventoried.'); continue; }
    sourceLength += file.content.length;
    const text = file.content, lineStarts = [0];
    for (let n = 0; n < text.length; n++) if (text[n] === '\n') lineStarts.push(n + 1);
    const location = (start: number, end: number): CitationLocation => {
      start = Math.min(text.length, start); end = Math.min(text.length, Math.max(start, end));
      let low = 0, high = lineStarts.length;
      while (low + 1 < high) { const middle = (low + high) >>> 1; if (lineStarts[middle]! <= start) low = middle; else high = middle; }
      return { filePath: file.path, start, end, line: low + 1 };
    };
    let position = 0, bibliographyDepth = 0;
    let pendingBibitem: CitationEntry | null = null;
    const finishBibitem = (end: number) => {
      if (!pendingBibitem) return;
      pendingBibitem.end = Math.max(pendingBibitem.end, Math.min(text.length, end));
      pendingBibitem.source = text.slice(pendingBibitem.start, pendingBibitem.end);
      pendingBibitem.id = JSON.stringify(['entry', file.path, pendingBibitem.start, pendingBibitem.end, pendingBibitem.key]);
      pendingBibitem = null;
    };
    const malformed = (kind: 'malformed_bibtex' | 'malformed_tex', start: number, message: string): never => { diagnostic(kind, location(start, position), `${message} The rest of this file is not inventoried.`); throw new StopFile(); };
    const whitespace = () => { while (space(text[position])) position++; };
    const texWhitespace = () => { while (position < text.length) { if (space(text[position])) position++; else if (text[position] === '%') { const end = text.indexOf('\n', position); position = end < 0 ? text.length : end + 1; } else break; } };
    // BibTeX counts braces even when preceded by a backslash. Quotes are only
    // delimiters at brace depth zero; TeX accent commands keep their own braces.
    const bibLiteral = (): Part => {
      const start = position, open = text[position++]!, close = open === '{' ? '}' : '"'; let depth = 0;
      while (position < text.length) {
        const character = text[position++]!;
        if (character === '{') { if (++depth > CITATION_LIMITS.nesting) stop(location(start, position), 'BibTeX brace nesting limit reached.'); }
        else if (character === '}') { if (depth) depth--; else if (close === '}') return { kind: 'literal', value: text.slice(start + 1, position - 1), location: location(start, position) }; else malformed('malformed_bibtex', start, 'Unbalanced brace in quoted value.'); }
        else if (character === close && depth === 0) return { kind: 'literal', value: text.slice(start + 1, position - 1), location: location(start, position) };
      }
      return malformed('malformed_bibtex', start, 'Unterminated BibTeX value.');
    };
    const expression = (): Expression => {
      whitespace(); const start = position, parts: Part[] = [];
      while (true) {
        whitespace(); const tokenStart = position; countToken(location(position, position));
        if (text[position] === '{' || text[position] === '"') parts.push(bibLiteral());
        else {
          while (identifier(text[position])) position++;
          const token = text.slice(tokenStart, position);
          if (!token) malformed('malformed_bibtex', start, 'Expected a field value or string abbreviation.');
          parts.push({ kind: /^\d+$/.test(token) ? 'literal' : 'macro', value: /^\d+$/.test(token) ? token : token.toLowerCase(), location: location(tokenStart, position) });
        }
        whitespace(); if (text[position] !== '#') break; position++;
      }
      return { parts, location: location(start, position) };
    };
    const name = () => { const start = position; while (identifier(text[position])) position++; return text.slice(start, position); };
    const closing = (close: string, start: number) => { whitespace(); if (text[position] === ',') { position++; whitespace(); } if (text[position] !== close) malformed('malformed_bibtex', start, 'Expected the end of the BibTeX record.'); position++; };
    const texGroup = (open = '{', close = '}'): { start: number; end: number; contentStart: number; contentEnd: number } => {
      const start = position;
      if (text[position++] !== open) malformed('malformed_tex', start, `Expected ${open} argument.`);
      let braces = 0;
      while (position < text.length) {
        const character = text[position++]!;
        if (character === '\\') { if (position < text.length) position++; continue; }
        if (character === '%') { const end = text.indexOf('\n', position); position = end < 0 ? text.length : end + 1; continue; }
        if (character === '{') { if (++braces > CITATION_LIMITS.nesting) stop(location(start, position), 'LaTeX argument nesting limit reached.'); }
        else if (character === '}' && braces > 0) braces--;
        else if (character === close && braces === 0) return { start, end: position, contentStart: start + 1, contentEnd: position - 1 };
        else if (character === '}' && close !== '}') malformed('malformed_tex', start, 'Unbalanced brace in optional argument.');
      }
      return malformed('malformed_tex', start, 'Unterminated LaTeX argument.');
    };
    const optional = (max: number, open = '[', close = ']') => { for (let n = 0; n < max; n++) { texWhitespace(); if (text[position] !== open) return; const group = texGroup(open, close); if (/\\(?:[A-Za-z]*cite[A-Za-z]*|bibitem)\b/.test(text.slice(group.contentStart, group.contentEnd))) diagnostic('unsupported_tex', location(group.start, group.end), 'Citation-like source inside an optional note is not recursively inventoried; its expansion is uncertain.'); } texWhitespace(); if (text[position] === open) malformed('malformed_tex', position, 'Too many optional arguments for the supported command.'); };
    try {
      if (/\.bib$/i.test(file.path)) {
        while (position < text.length) {
          if (text[position++] !== '@') continue;
          const start = position - 1, type = name().toLowerCase(); whitespace(); const open = text[position++], close = open === '{' ? '}' : ')';
          if (!type || (open !== '{' && open !== '(')) malformed('malformed_bibtex', start, 'Expected a BibTeX record type and delimiter.');
          if (type === 'comment') {
            let depth = 1;
            while (position < text.length && depth) { const char = text[position++]!; if (char === open) { if (++depth > CITATION_LIMITS.nesting) stop(location(start, position), 'Comment nesting limit reached.'); } else if (char === close) depth--; }
            if (depth) malformed('malformed_bibtex', start, 'Unterminated BibTeX comment.'); continue;
          }
          if (type === 'preamble') { expression(); closing(close, start); continue; }
          whitespace(); const keyStart = position; const key = name(); whitespace();
          if (!key) malformed('malformed_bibtex', start, 'Expected a bibliography key or abbreviation name.');
          if (type === 'string') {
            if (text[position++] !== '=') malformed('malformed_bibtex', start, 'Expected equals after the string abbreviation.');
            const value = expression(); closing(close, start); const macro: Macro = { name: key.toLowerCase(), expression: value, location: location(keyStart, keyStart + key.length) };
            const definitions = macros.get(macro.name); if (definitions) definitions.push(macro); else macros.set(macro.name, [macro]); continue;
          }
          if (text[position] !== ',' && text[position] !== close) malformed('malformed_bibtex', start, 'Expected a comma after the bibliography key.');
          const entryFields: CitationField[] = [], seenFields = new Set<string>();
          if (text[position] === ',') position++;
          while (true) {
            whitespace(); if (text[position] === close) { position++; break; }
            const fieldStart = position, fieldName = name().toLowerCase(); whitespace();
            if (!fieldName || text[position++] !== '=') malformed('malformed_bibtex', fieldStart, 'Expected a field name and equals sign.');
            if (++fieldsCount > CITATION_LIMITS.fields) stop(location(fieldStart, position), 'Bibliography field limit reached.');
            const value = expression(), fieldLocation = location(fieldStart, position);
            const field: CitationField = { ...fieldLocation, id: JSON.stringify(['field', file.path, fieldStart, position, key, fieldName]), name: fieldName, source: text.slice(fieldStart, position), value: null };
            if (seenFields.has(fieldName)) diagnostic('duplicate_field', fieldLocation, `The field “${fieldName}” occurs more than once in this entry.`, key); seenFields.add(fieldName);
            entryFields.push(field); fields.push({ field, expression: value });
            if (text[position] === ',') position++; else if (text[position] !== close) malformed('malformed_bibtex', fieldStart, 'Expected a comma or record end after a field.');
          }
          addEntry({ ...location(start, position), id: JSON.stringify(['entry', file.path, start, position, key]), kind: 'bibtex', type, key, source: text.slice(start, position), fields: entryFields });
        }
      } else {
        while (position < text.length) {
          if (text[position] === '%') { const end = text.indexOf('\n', position); position = end < 0 ? text.length : end + 1; continue; }
          if (text[position++] !== '\\') continue;
          const start = position - 1, commandStart = position;
          if (!letter(text[position])) { if (position < text.length) position++; continue; }
          while (letter(text[position])) position++;
          const plain = text.slice(commandStart, position), lower = plain.toLowerCase(); const command = plain + (text[position] === '*' ? (position++, '*') : '');
          if (lower === 'verb' || lower === 'lstinline') {
            if (lower === 'lstinline') optional(1);
            const delimiter = text[position++]; if (!delimiter || delimiter === '\n' || delimiter === '\r') malformed('malformed_tex', start, 'Missing inline verbatim delimiter.');
            while (position < text.length && text[position] !== delimiter && text[position] !== '\n' && text[position] !== '\r') position++;
            if (text[position] !== delimiter) malformed('malformed_tex', start, 'Unterminated inline verbatim text.'); position++; continue;
          }
          if (plain === 'begin' || plain === 'end') {
            texWhitespace(); if (text[position] !== '{') continue;
            const environment = texGroup(), name = text.slice(environment.contentStart, environment.contentEnd);
            if (name === 'thebibliography') {
              if (plain === 'end') {
                finishBibitem(start);
                if (bibliographyDepth > 0) bibliographyDepth--; else diagnostic('unsupported_tex', location(start, position), 'A bibliography environment ends without a matching literal beginning; execution scope is uncertain.');
              } else {
                if (bibliographyDepth > 0) diagnostic('unsupported_tex', location(start, position), 'Nested literal bibliography environments have uncertain execution scope.');
                bibliographyDepth++;
              }
            }
            if (plain === 'end') continue;
            if (['verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim', 'LVerbatim', 'lstlisting', 'minted', 'comment'].includes(name)) {
              const marker = `\\end{${name}}`, end = text.indexOf(marker, position);
              if (end < 0) { position = text.length; malformed('malformed_tex', start, 'Unterminated verbatim or comment environment.'); }
              position = end + marker.length;
            }
            continue;
          }
          if (['catcode', 'csname', 'scantokens'].includes(lower)) diagnostic('unsupported_tex', location(start, position), `The inventory does not evaluate \\${plain}; generated commands or changed token rules are uncertain.`);
          if (lower === 'bibitem') {
            finishBibitem(start);
            optional(1); const group = texGroup(), raw = text.slice(group.contentStart, group.contentEnd), key = raw.trim();
            if (!literalKey(key)) { diagnostic('dynamic_key', location(group.contentStart, group.contentEnd), 'This bibliography key requires TeX expansion or contains unsupported tokens.', key); continue; }
            if (!bibliographyDepth) diagnostic('unsupported_tex', location(start, position), 'A literal bibliography item occurs outside a literal thebibliography environment; compilation scope is uncertain.');
            const entry: CitationEntry = { ...location(start, position), id: JSON.stringify(['entry', file.path, start, position, key]), kind: 'bibitem', type: 'bibitem', key, source: text.slice(start, position), fields: [] };
            addEntry(entry); pendingBibitem = entry; continue;
          }
          const multi = MULTICITES.has(lower), volume = VOLUMECITES.has(lower);
          if (!SINGLECITES.has(lower) && !multi && !volume) {
            if (/cite/.test(lower) && !['bibliographystyle', 'citeindex', 'citetext'].includes(lower)) diagnostic('unsupported_tex', location(start, position), `Citation-like command \\${plain} is outside the supported literal command set.`);
            continue;
          }
          if (multi) optional(2, '(', ')');
          do {
            optional(volume ? 1 : 2);
            if (volume) { texGroup(); optional(1); }
            const group = texGroup(); let keyStart = group.contentStart, keyEnd = keyStart, segment = keyStart, value = '', depth = 0, found = false;
            for (let at = group.contentStart; at <= group.contentEnd; at++) {
              if (text[at] === '%' && at < group.contentEnd) { value += text.slice(segment, at); const end = text.indexOf('\n', at); at = end < 0 || end >= group.contentEnd ? group.contentEnd - 1 : end; segment = at + 1; continue; }
              if (at !== group.contentEnd && !(text[at] === ',' && depth === 0)) {
                if (!space(text[at])) { if (!found) keyStart = at; found = true; keyEnd = at + 1; }
                if (text[at] === '\\' && at + 1 < group.contentEnd) { at++; keyEnd = at + 1; }
                else if (text[at] === '{') depth++; else if (text[at] === '}') depth--;
                continue;
              }
              value += text.slice(segment, at); const key = value.trim(), loc = location(keyStart, found ? keyEnd : keyStart);
              if (index.citations.length >= CITATION_LIMITS.citations) stop(loc, 'Citation occurrence limit reached; remaining source is not inventoried.');
              const wildcard = lower === 'nocite' && key === '*', literal = literalKey(key) && !key.includes(',');
              index.citations.push({ ...loc, id: JSON.stringify(['citation', file.path, loc.start, loc.end, key]), key, command, resolution: 'unknown', entryIds: [] });
              if (wildcard) diagnostic('wildcard', loc, 'The wildcard requests a bibliography collection; active data sources are not inferred from this snapshot.', key, false, 'info');
              else if (!literal) diagnostic('dynamic_key', loc, 'This citation key requires TeX expansion or contains unsupported tokens.', key);
              keyStart = at + 1; keyEnd = keyStart; segment = keyStart; value = ''; found = false;
            }
            texWhitespace();
          } while (multi && (text[position] === '[' || text[position] === '{'));
        }
      }
    } catch (error) { if (!(error instanceof StopFile)) throw error; }
    finishBibitem(position);
    if (bibliographyDepth) diagnostic('malformed_tex', location(position, position), 'A literal bibliography environment has no matching end; bibliography item bodies are bounded by the scanned source.');
  }
  const macroCache = new Map<string, string | null>(), resolving = new Set<string>();
  const resolveExpression = (expression: Expression, depth = 0): string | null => {
    if (depth > CITATION_LIMITS.nesting) { diagnostic('limit', expression.location, 'String abbreviation expansion depth limit reached.'); return null; }
    let value = '';
    for (const part of expression.parts) {
      let text: string | null = part.value;
      if (part.kind === 'macro') {
        const definitions = macros.get(part.value);
        if (!definitions?.length) { diagnostic('unresolved_string', part.location, `No unique snapshot declaration resolves “${part.value}”. External style abbreviations are not loaded.`, part.value); text = null; }
        else if (definitions.length > 1) { diagnostic('ambiguous_string', part.location, `Multiple snapshot declarations define “${part.value}”; file execution order is not inferred.`, part.value); text = null; }
        else if (resolving.has(part.value)) { diagnostic('cyclic_string', part.location, `String abbreviation “${part.value}” participates in a cycle.`, part.value); text = null; }
        else if (macroCache.has(part.value)) text = macroCache.get(part.value)!;
        else { resolving.add(part.value); text = resolveExpression(definitions[0]!.expression, depth + 1); resolving.delete(part.value); macroCache.set(part.value, text); }
      }
      if (text === null) return null;
      if (value.length + text.length > CITATION_LIMITS.fieldValue) { diagnostic('limit', expression.location, 'Resolved field or abbreviation exceeds the value length limit.'); return null; }
      value += text;
    }
    if (resolvedTotal + value.length > CITATION_LIMITS.resolvedTotal) { diagnostic('limit', expression.location, 'Total resolved bibliography text limit reached.'); return null; }
    resolvedTotal += value.length; return value;
  };
  for (const [name, definitions] of macros) {
    if (definitions.length > 1) for (const definition of definitions) diagnostic('ambiguous_string', definition.location, `Multiple snapshot declarations define “${name}”; no execution order is assumed.`, name);
    else if (!macroCache.has(name)) { resolving.add(name); macroCache.set(name, resolveExpression(definitions[0]!.expression)); resolving.delete(name); }
  }
  for (const item of fields) item.field.value = resolveExpression(item.expression);
  const keys = new Map<string, CitationEntry[]>();
  for (const entry of index.entries) { const matches = keys.get(entry.key); if (matches) matches.push(entry); else keys.set(entry.key, [entry]); }
  for (const [key, entries] of keys) if (entries.length > 1) for (const entry of entries) diagnostic('duplicate_key', entry, `The key “${key}” has ${entries.length} entries in this snapshot.`, key, false);
  const linkText = new Map([...keys].map(([key, entries]) => [key, entries.reduce((length, entry) => length + entry.id.length, 0)]));
  let entryLinks = 0, entryLinkText = 0;
  for (const citation of index.citations) {
    if (!isConcreteCitationOccurrence(citation)) continue;
    const entries = keys.get(citation.key) ?? [];
    const characters = linkText.get(citation.key) ?? 0;
    if (entryLinks + entries.length > CITATION_LIMITS.entryLinks || entryLinkText + characters > CITATION_LIMITS.entryLinkText) { diagnostic('limit', citation, 'Citation-to-entry link count or text limit reached; further match lists are omitted.'); }
    else { citation.entryIds = entries.map(entry => entry.id); entryLinks += entries.length; entryLinkText += characters; }
    citation.resolution = entries.length > 1 ? 'ambiguous' : entries.length === 1 ? 'resolved' : index.complete ? 'missing' : 'unknown';
  }
  // A later bounded match list can make a formerly negative lookup uncertain.
  if (!index.complete) for (const citation of index.citations) if (citation.resolution === 'missing') citation.resolution = 'unknown';
  index.diagnostics.sort((a, b) => compare(a.filePath, b.filePath) || a.start - b.start || compare(a.code, b.code));
  return index;
}

const SINGLECITES = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citefullauthor', 'citeyear', 'citeyearpar', 'citetitle', 'citedate', 'citeurl', 'parencite', 'textcite', 'autocite', 'footcite', 'footcitetext', 'smartcite', 'supercite', 'fullcite', 'footfullcite', 'notecite', 'pnotecite', 'fnotecite', 'nocite']);
const MULTICITES = new Set(['cites', 'parencites', 'textcites', 'autocites', 'footcites', 'footcitetexts', 'smartcites', 'supercites', 'volcites', 'pvolcites', 'fvolcites', 'ftvolcites', 'svolcites', 'tvolcites', 'avolcites']);
const VOLUMECITES = new Set(['volcite', 'pvolcite', 'fvolcite', 'ftvolcite', 'svolcite', 'tvolcite', 'avolcite', 'volcites', 'pvolcites', 'fvolcites', 'ftvolcites', 'svolcites', 'tvolcites', 'avolcites']);
