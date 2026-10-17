import { diffArrays } from 'diff';
import type { PaperPreview, PaperPreviewInline } from './paper-preview';

/** Half-open UTF-16 offsets in the original leaf text or math/source node. */
export interface PaperPreviewHighlight { start: number; end: number }
export type PaperPreviewHighlights = Readonly<Record<string, readonly PaperPreviewHighlight[]>>;
export type PaperPreviewComparison =
  | { status: 'ready'; before: PaperPreviewHighlights; after: PaperPreviewHighlights; changed: boolean }
  | { status: 'unavailable'; reason: string };

/** Fixed bounds on the comparison, independent of the reading parser's limits. */
export const PAPER_PREVIEW_COMPARISON_LIMITS = Object.freeze({
  inputCodeUnits: 500_000,
  nodes: 8_000,
  tokens: 40_000,
  editLength: 2_048,
  comparisons: 250_000,
  segments: 4_000,
  highlightRanges: 4_000,
  highlightedCodeUnits: 240_000,
});

interface Token { id: number; path: string; start: number; end: number }
interface Projection { tokens: Token[]; text: Map<string, string> }
type MutableHighlights = Record<string, PaperPreviewHighlight[]>;

class ComparisonLimit extends Error {}

/**
 * Compare the reading projection, never the saved source or generated KaTeX HTML.
 * Prose is compared by Unicode words/punctuation, ignoring prose whitespace and
 * paragraph reflow. Heading levels and emphasis remain part of each word's
 * identity. Literal/code/source fallbacks are exact atoms, including whitespace.
 * Equations are exact-expression atoms: changed equations are highlighted whole,
 * while changing only an equivalent delimiter does not change the reading diff.
 * A possible macro definition makes subsequent equations context-sensitive:
 * changes to that definition or later math requests conservatively highlight
 * potentially affected equations. No TeX, mathematical equivalence, or moved
 * paragraph matching is evaluated here.
 *
 * Keys match PaperMathPreview's leaf paths: block-i for a display equation/source
 * block, block-i-j for inline children, and another -k for nested emphasis.
 */
export function comparePaperPreviews(before: PaperPreview, after: PaperPreview): PaperPreviewComparison {
  if (before.limited || after.limited) return { status: 'unavailable', reason: 'The reading preview reached its source limit. Use Changes to compare the exact source.' };
  const limits = PAPER_PREVIEW_COMPARISON_LIMITS;
  const ids = new Map<string, number>();
  const mathContexts = new Map<string, number>();
  let inputCodeUnits = 0, nodeCount = 0, tokenCount = 0;
  const exceeded = (reason: string): never => { throw new ComparisonLimit(reason); };
  const input = (length: number) => {
    inputCodeUnits += length;
    if (inputCodeUnits > limits.inputCodeUnits) exceeded('The reading content is too large to highlight on this device.');
  };
  const node = () => {
    if (++nodeCount > limits.nodes) exceeded('The reading content has too many elements to highlight on this device.');
  };
  const project = (preview: PaperPreview): Projection => {
    const result: Projection = { tokens: [], text: new Map() };
    let mathContext = 0, definitionsPossible = false;
    const token = (context: string, kind: string, value: string, path: string, start: number, end: number) => {
      if (++tokenCount > limits.tokens) exceeded('The reading content has too many words to highlight on this device.');
      const key = JSON.stringify([context, kind, value]);
      let id = ids.get(key);
      if (id === undefined) { id = ids.size; ids.set(key, id); }
      result.tokens.push({ id, path, start, end });
    };
    const atomic = (context: string, kind: string, value: string, source: string, path: string) => {
      input(Math.max(value.length, source.length));
      result.text.set(path, source);
      if (source.length) token(context, kind, value, path, 0, source.length);
    };
    const math = (context: string, kind: string, expression: string, source: string, path: string) => {
      atomic(`${context}/math-context-${mathContext}`, kind, expression, source, path);
      // KaTeX preserves macros across successful requests. Do not try to execute
      // or prove the effects of definitions here; after a possible definition,
      // any later request could invoke a macro which changes another definition.
      definitionsPossible ||= /\\(?:def|gdef|edef|xdef|let|futurelet|global|newcommand|renewcommand|providecommand)\b/.test(expression);
      if (definitionsPossible) {
        const key = JSON.stringify([mathContext, kind, expression]);
        let next = mathContexts.get(key);
        if (next === undefined) { next = mathContexts.size + 1; mathContexts.set(key, next); }
        mathContext = next;
      }
    };
    const inline = (children: readonly PaperPreviewInline[], path: string, context: string, depth: number) => {
      if (depth > 32) exceeded('The reading content is nested too deeply to highlight on this device.');
      children.forEach((child, index) => {
        node();
        const childPath = `${path}-${index}`;
        if (child.kind === 'strong' || child.kind === 'emphasis') {
          inline(child.children, childPath, `${context}/${child.kind}`, depth + 1);
        } else if (child.kind === 'math') {
          math(context, 'inline-math', child.expression, child.source, childPath);
        } else if (child.kind === 'text') {
          input(child.text.length);
          result.text.set(childPath, child.text);
          // The Unicode flag keeps surrogate pairs intact; combining marks stay
          // with their word. Offsets remain in the exact unnormalized leaf text.
          for (const match of child.text.matchAll(/[\p{L}\p{M}\p{N}_]+|[^\s]/gu)) {
            token(context, 'text', match[0], childPath, match.index, match.index + match[0].length);
          }
        } else if ('text' in child) {
          atomic(context, child.kind, child.text, child.text, childPath);
        }
      });
    };
    preview.blocks.forEach((block, index) => {
      node();
      const path = `block-${index}`;
      if (block.kind === 'paragraph' || block.kind === 'heading') {
        inline(block.children, path, block.kind === 'heading' ? `heading-${block.level}` : 'paragraph', 0);
      } else if (block.kind === 'math') {
        math('display', 'math', block.expression, block.source, path);
      } else {
        atomic('display', 'source', block.source, block.source, path);
      }
    });
    return result;
  };

  try {
    const old = project(before), current = project(after);
    const oldHighlights: MutableHighlights = {}, newHighlights: MutableHighlights = {};
    const highlight = (projection: Projection, highlights: MutableHighlights, token: Token) => {
      const ranges = highlights[token.path] ??= [];
      const previous = ranges.at(-1);
      // Joining changed words across their original whitespace preserves every
      // character without creating a mark element for each individual word.
      if (previous && (previous.end >= token.start || /^\s*$/.test(projection.text.get(token.path)!.slice(previous.end, token.start)))) previous.end = token.end;
      else ranges.push({ start: token.start, end: token.end });
    };
    if (!old.tokens.length || !current.tokens.length) {
      // A wholly added/removed reading has no alignment work or edit-distance
      // search. Still apply all input and output limits to its exact ranges.
      old.tokens.forEach(token => highlight(old, oldHighlights, token));
      current.tokens.forEach(token => highlight(current, newHighlights, token));
    } else {
      let comparisons = 0;
      const changes = diffArrays(old.tokens.map(token => token.id), current.tokens.map(token => token.id), {
        maxEditLength: limits.editLength,
        comparator(left, right) {
          if (++comparisons > limits.comparisons) exceeded('These readings require too much comparison work to highlight on this device.');
          return left === right;
        },
      }) ?? exceeded('These readings contain too many changes to highlight on this device.');
      if (changes.length > limits.segments) exceeded('These readings contain too many separate changes to highlight on this device.');
      let oldIndex = 0, newIndex = 0;
      for (const change of changes) {
        if (change.added) {
          for (let index = 0; index < change.count; index++) highlight(current, newHighlights, current.tokens[newIndex++]!);
        } else if (change.removed) {
          for (let index = 0; index < change.count; index++) highlight(old, oldHighlights, old.tokens[oldIndex++]!);
        } else { oldIndex += change.count; newIndex += change.count; }
      }
      if (oldIndex !== old.tokens.length || newIndex !== current.tokens.length) throw new Error('Reading comparison did not account for every token.');
    }
    let rangeCount = 0, highlightedCodeUnits = 0;
    for (const highlights of [oldHighlights, newHighlights]) for (const ranges of Object.values(highlights)) for (const range of ranges) {
      rangeCount++;
      highlightedCodeUnits += range.end - range.start;
    }
    if (rangeCount > limits.highlightRanges || highlightedCodeUnits > limits.highlightedCodeUnits) exceeded('These readings require too much highlighting to display on this device.');
    return { status: 'ready', before: oldHighlights, after: newHighlights, changed: rangeCount > 0 };
  } catch (error) {
    if (error instanceof ComparisonLimit) return { status: 'unavailable', reason: error.message };
    throw error;
  }
}
