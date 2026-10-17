/** A deliberately small reading projection, never a replacement for the saved TeX source. */
export type PaperPreviewInline =
  | { kind: 'text' | 'literal' | 'code'; text: string }
  | { kind: 'math'; expression: string; source: string }
  | { kind: 'strong' | 'emphasis'; children: PaperPreviewInline[] };

export type PaperPreviewBlock =
  | { kind: 'paragraph'; children: PaperPreviewInline[] }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; children: PaperPreviewInline[] }
  | { kind: 'math'; expression: string; source: string }
  | { kind: 'source'; source: string };

export interface PaperPreview { blocks: PaperPreviewBlock[]; limited: boolean }

// These bound the reading projection only. Editing, saving and exporting retain all source.
export const PAPER_PREVIEW_MAX_CHARACTERS = 250_000;
export const PAPER_PREVIEW_MAX_MATH_CHARACTERS = 12_000;
const MAX_NODES = 4_000, MAX_MATH = 300, MAX_DEPTH = 12;
const mathEnvironments = new Set(['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*', 'displaymath', 'math']);
const verbatimEnvironments = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted']);
const headingLevels: Record<string, 1 | 2 | 3 | 4> = { title: 1, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 4 };

interface Budget { nodes: number; math: number; limited: boolean }

function group(source: string, start: number, open = '{', close = '}'): { text: string; end: number } | null {
  if (source[start] !== open) return null;
  let depth = 1;
  for (let index = start + 1; index < Math.min(source.length, start + PAPER_PREVIEW_MAX_MATH_CHARACTERS); index++) {
    if (source[index] === '\\') { index++; continue; }
    if (source[index] === '%') { const newline = source.indexOf('\n', index); if (newline < 0) return null; index = newline; continue; }
    if (source[index] === open) { if (++depth > 64) return null; }
    if (source[index] === close && --depth === 0) return { text: source.slice(start + 1, index), end: index + 1 };
  }
  return null;
}

function closingMath(source: string, start: number, close: string): number {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === '%') { const newline = source.indexOf('\n', index); if (newline < 0) return -1; index = newline; continue; }
    if (depth === 0 && source.startsWith(close, index)) return index;
    if (source[index] === '\\') { index++; continue; }
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth = Math.max(0, depth - 1);
  }
  return -1;
}

function parse(source: string, budget: Budget, depth: number, blocksAllowed: boolean): PaperPreviewBlock[] {
  const blocks: PaperPreviewBlock[] = [];
  let inline: PaperPreviewInline[] = [];
  const flush = () => { if (inline.some(node => node.kind !== 'text' || node.text.trim())) blocks.push({ kind: 'paragraph', children: inline }); inline = []; };
  const text = (value: string, kind: 'text' | 'literal' | 'code' = 'text') => {
    if (!value) return;
    const last = inline.at(-1);
    if (last?.kind === kind && 'text' in last) last.text += value;
    else { inline.push({ kind, text: value }); budget.nodes++; }
  };
  const children = (value: string): PaperPreviewInline[] => parse(value, budget, depth + 1, false).flatMap(block => block.kind === 'paragraph' ? block.children : []);
  const math = (expression: string, original: string, display: boolean) => {
    if (expression.length > PAPER_PREVIEW_MAX_MATH_CHARACTERS || ++budget.math > MAX_MATH) {
      budget.limited = true;
      if (display && blocksAllowed) { flush(); blocks.push({ kind: 'source', source: original }); }
      else text(original, 'literal');
      return;
    }
    budget.nodes++;
    if (display && blocksAllowed) { flush(); blocks.push({ kind: 'math', expression, source: original }); }
    else inline.push({ kind: 'math', expression, source: original });
  };

  for (let index = 0; index < source.length;) {
    if (budget.nodes >= MAX_NODES || depth > MAX_DEPTH) { budget.limited = true; text(source.slice(index), 'literal'); break; }
    const character = source[index]!;
    if (character === '%') {
      const newline = source.indexOf('\n', index);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (character === '\n' && blocksAllowed) {
      const blank = /^\n[\t \r]*\n(?:[\t \r]*\n)*/.exec(source.slice(index));
      if (blank) { flush(); index += blank[0].length; continue; }
    }
    const environment = character === '\\' ? /^\\begin\{([a-zA-Z*]+)\}/.exec(source.slice(index)) : null;
    if (environment && (mathEnvironments.has(environment[1]!) || verbatimEnvironments.has(environment[1]!))) {
      const name = environment[1]!, endMarker = `\\end{${name}}`, start = index + environment[0].length;
      const verbatim = verbatimEnvironments.has(name);
      const end = verbatim ? source.indexOf(endMarker, start) : closingMath(source, start, endMarker);
      if (end < 0) { text(source.slice(index), 'literal'); break; }
      const original = source.slice(index, end + endMarker.length);
      if (verbatim) {
        if (blocksAllowed) { flush(); blocks.push({ kind: 'source', source: original }); budget.nodes++; }
        else text(original, 'code');
      } else math(name === 'displaymath' || name === 'math' ? source.slice(start, end) : original, original, name !== 'math');
      index = end + endMarker.length;
      continue;
    }
    const verb = character === '\\' ? /^\\verb\*?([^a-zA-Z\s])/.exec(source.slice(index)) : null;
    if (verb) {
      const start = index + verb[0].length, end = source.indexOf(verb[1]!, start), newline = source.indexOf('\n', start);
      if (end >= 0 && (newline < 0 || end < newline)) { text(source.slice(start, end), 'code'); index = end + 1; continue; }
      text(source.slice(index, newline < 0 ? source.length : newline), 'literal');
      index = newline < 0 ? source.length : newline;
      continue;
    }
    const opener = source.startsWith('$$', index) ? '$$' : character === '$' ? '$' : source.startsWith('\\[', index) ? '\\[' : source.startsWith('\\(', index) ? '\\(' : null;
    if (opener) {
      const closer = opener === '\\[' ? '\\]' : opener === '\\(' ? '\\)' : opener;
      const start = index + opener.length, end = closingMath(source, start, closer);
      if (end < 0) { text(source.slice(index), 'literal'); break; }
      math(source.slice(start, end), source.slice(index, end + closer.length), opener === '$$' || opener === '\\[');
      index = end + closer.length;
      continue;
    }
    if (character === '\\') {
      const escaped = source[index + 1];
      if (escaped && '%$&#_{} '.includes(escaped)) { text(escaped); index += 2; continue; }
      if (escaped === '\\') { text('\n'); index += 2; continue; }
      const command = /^\\([a-zA-Z]+)\*?/.exec(source.slice(index));
      if (command) {
        const name = command[1]!;
        let argumentStart = index + command[0].length;
        while (source[argumentStart] === ' ' || source[argumentStart] === '\t') argumentStart++;
        if (source[argumentStart] === '[') { const optional = group(source, argumentStart, '[', ']'); if (optional) argumentStart = optional.end; }
        const argument = group(source, argumentStart);
        if (argument && Object.hasOwn(headingLevels, name) && blocksAllowed) {
          flush(); blocks.push({ kind: 'heading', level: headingLevels[name]!, children: children(argument.text) }); budget.nodes++;
          index = argument.end; continue;
        }
        if (argument && ['textbf', 'emph', 'textit', 'texttt'].includes(name)) {
          if (name === 'texttt') text(argument.text, 'code');
          else { inline.push({ kind: name === 'textbf' ? 'strong' : 'emphasis', children: children(argument.text) }); budget.nodes++; }
          index = argument.end; continue;
        }
        // Unimplemented commands remain visible, including references, includes and package setup.
        const end = argument?.end ?? index + command[0].length;
        text(source.slice(index, end), 'literal'); index = end; continue;
      }
    }
    text(character === '~' ? '\u00a0' : character);
    index++;
  }
  flush();
  return blocks;
}

export function parsePaperPreview(source: string): PaperPreview {
  if (source.length > PAPER_PREVIEW_MAX_CHARACTERS) return { blocks: [{ kind: 'source', source }], limited: true };
  const budget: Budget = { nodes: 0, math: 0, limited: false };
  return { blocks: parse(source, budget, 0, true), limited: budget.limited };
}
