import { scanMentions, type MentionToken } from './mentions';
import { REMARKUP_LIMITS, remarkupScanPreflight, type RemarkupBlock, type RemarkupDocument, type RemarkupInline, type RemarkupListItem, type RemarkupSpan, type RemarkupText } from './remarkup';

export interface RemarkupOutlineHeading extends RemarkupSpan {
  /** The rendered HTML level (2–6), not the number of Remarkup markers. */
  level: number;
  label: string;
  anchor: string;
}
export type RemarkupOutlineFallback = 'parser' | 'depth' | 'nodes' | 'work' | 'invalid';
export interface RemarkupOutline { headings: RemarkupOutlineHeading[]; fallback: RemarkupOutlineFallback | null }

class OutlineLimit extends RangeError {
  constructor(readonly reason: RemarkupOutlineFallback) { super(`Remarkup outline exceeds the ${reason} boundary.`); }
}
class Budget {
  private work = 0;
  private nodes = 0;
  charge(amount: number): void { if (!Number.isSafeInteger(amount) || amount < 0 || (this.work += amount) > REMARKUP_LIMITS.work) throw new OutlineLimit('work'); }
  visit(depth: number): void {
    if (depth > REMARKUP_LIMITS.depth) throw new OutlineLimit('depth');
    if (++this.nodes > REMARKUP_LIMITS.nodes) throw new OutlineLimit('nodes');
    this.charge(1);
  }
  array(value: unknown): void { if (!Array.isArray(value)) throw new OutlineLimit('invalid'); if (value.length > REMARKUP_LIMITS.nodes) throw new OutlineLimit('nodes'); }
}

function wellFormed(value: string, budget: Budget): void {
  budget.charge(value.length);
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new OutlineLimit('invalid');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new OutlineLimit('invalid');
  }
}
const legacyCombining = (point: number) => point >= 0x0300 && point <= 0x036f || point >= 0x1dc0 && point <= 0x1dff || point >= 0x20d0 && point <= 0x20ff || point >= 0xfe20 && point <= 0xfe2f;

/** HeaderBlockRule's 32-glyph, word-boundary truncation. These are libphutil's
 * four combining ranges, deliberately not modern grapheme segmentation: ZWJ,
 * emoji modifiers and variation selectors count separately. A leading mark
 * gets the historical space only when truncation actually occurs. */
function truncateAnchor(value: string, budget: Budget): string {
  budget.charge(value.length);
  const glyphs: string[] = [];
  let glyph: string[] | null = null;
  for (const character of value) {
    if (legacyCombining(character.codePointAt(0)!)) { glyph ??= [' ']; glyph.push(character); }
    else {
      if (glyph !== null) glyphs.push(glyph.join(''));
      if (glyphs.length === 33) break;
      glyph = [character];
    }
  }
  if (glyphs.length < 33 && glyph !== null) glyphs.push(glyph.join(''));
  if (glyphs.length <= 32) return value;
  let boundary: number | null = null, nonboundary = false;
  // ASCII normalization leaves only '-' from the truncator's break/stop set.
  // Index 32 is intentionally inspected: a break immediately after the last
  // retained glyph permits the entire 32-glyph prefix.
  for (let i = 32; i >= 16; i--) {
    if (glyphs[i] === '-') boundary = i;
    else { nonboundary = true; if (boundary !== null) break; }
  }
  return glyphs.slice(0, boundary === null || !nonboundary ? 32 : boundary).join('');
}

function anchorName(text: string, budget: Budget): string | null {
  if (typeof text !== 'string') throw new OutlineLimit('invalid');
  wellFormed(text, budget);
  const lower = text.toLowerCase(); budget.charge(lower.length);
  let anchor = lower.replace(/[\u0000-\u002f\u003a-\u0060\u007b-\u007f]+/g, '-');
  let start = 0, end = anchor.length;
  while (start < end && anchor[start] === '-') start++;
  while (end > start && anchor[end - 1] === '-') end--;
  anchor = truncateAnchor(anchor.slice(start, end), budget).replace(/-(a|an|the|at|by|for|in|of|on|per|to|up|and|as|but|if|or|nor)$/, '');
  // These historical non-ASCII controls survive normalizeAnchor(), but cannot
  // be shared through the application's section route. Fail explicitly.
  if (/[\u0080-\u009f]/.test(anchor)) throw new OutlineLimit('invalid');
  return anchor || null;
}

/** Mirrors getAnchorNameFromHeaderText's input: restored TOC serialization,
 * not raw Remarkup source. Invalid Unicode/controls and resource excess throw
 * RangeError; remarkupOutline converts those into an atomic fallback.
 * Lowercasing uses JavaScript Unicode mappings: old PHP installations could
 * use different mbstring tables or their ASCII-only fallback. */
export function remarkupHeadingAnchor(text: string): string | null { return anchorName(text, new Budget()); }

function span(node: RemarkupSpan, parent: RemarkupSpan): void {
  if (!node || !Number.isSafeInteger(node.start) || !Number.isSafeInteger(node.end) || node.start < parent.start || node.end < node.start || node.end > parent.end) throw new OutlineLimit('invalid');
}
function escaped(text: string, budget: Budget): string {
  budget.charge(text.length);
  // PHP htmlspecialchars(..., ENT_QUOTES, 'UTF-8'), including its apostrophe
  // spelling. This is anchor data only and is never injected as HTML.
  const result = text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]!);
  budget.charge(result.length); return result;
}
function withoutMentions(node: RemarkupText, mentions: MentionToken[], budget: Budget): string {
  let lo = 0, hi = mentions.length;
  while (lo < hi) { budget.charge(1); const mid = (lo + hi) >>> 1; if (mentions[mid]!.start < node.start) lo = mid + 1; else hi = mid; }
  const parts: string[] = []; let position = node.start;
  for (let i = lo; i < mentions.length && mentions[i]!.start < node.end; i++) {
    budget.charge(1); const mention = mentions[i]!;
    if (mention.end > node.end) throw new OutlineLimit('invalid');
    parts.push(node.text.slice(position - node.start, mention.start - node.start)); position = mention.end;
  }
  parts.push(node.text.slice(position - node.start)); return parts.join('');
}

function headingText(nodes: RemarkupInline[], parent: RemarkupSpan, body: string, mentions: MentionToken[], budget: Budget, depth: number): { label: string; serialized: string } {
  interface Frame { nodes: RemarkupInline[]; index: number; depth: number; parent: RemarkupSpan; opaque: boolean; close: string }
  budget.array(nodes);
  const stack: Frame[] = [{ nodes, index: 0, depth, parent, opaque: false, close: '' }], label: string[] = [], serialized: string[] = [];
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    if (frame.index === frame.nodes.length) { serialized.push(frame.close); stack.pop(); continue; }
    const node = frame.nodes[frame.index++]!; budget.visit(frame.depth); span(node, frame.parent);
    if (node.type === 'text') {
      if (typeof node.text !== 'string' || node.text.length !== node.end - node.start || node.text !== body.slice(node.start, node.end)) throw new OutlineLimit('invalid');
      wellFormed(node.text, budget); label.push(node.text);
      serialized.push(escaped(frame.opaque ? node.text : withoutMentions(node, mentions, budget), budget));
      continue;
    }
    if (node.type === 'break') { const text = node.soft ? ' ' : '\n'; label.push(text); serialized.push(text); continue; }
    let open = '', close = '', opaque = frame.opaque;
    switch (node.type) {
      case 'strong': break;
      case 'em': open = '<em>'; close = '</em>'; break;
      case 'del': open = '<del>'; close = '</del>'; break;
      case 'underline': open = '<u>'; close = '</u>'; break;
      case 'highlight': open = '<span class="remarkup-highlight">'; close = '</span>'; break;
      case 'code': open = '<tt class="remarkup-monospaced">'; close = '</tt>'; opaque = true; break;
      case 'link': opaque = true; break;
      default: throw new OutlineLimit('invalid');
    }
    budget.charge(open.length + close.length); serialized.push(open); budget.array(node.children);
    stack.push({ nodes: node.children, index: 0, depth: frame.depth + 1, parent: node, opaque, close });
  }
  return { label: label.join(''), serialized: serialized.join('') };
}

/** Pure, bounded heading projection from the exact parsed source. It neither
 * resolves people/objects nor changes source. HeaderBlockRule historically
 * normalizes restored HTML from italic/code/etc. rules; retain those naming
 * quirks while exposing a readable plain label separately. Production mention
 * tokens are empty before postprocessing, so only their exact frozen spans are
 * omitted from anchor data. Custom anchors/interpreters are outside this AST. */
export function remarkupOutline(document: RemarkupDocument, body: string): RemarkupOutline {
  try {
    if (!document || document.format !== 'phabricator.remarkup.v1') throw new OutlineLimit('invalid');
    if (document.fallback) return { headings: [], fallback: 'parser' };
    if (typeof body !== 'string') throw new OutlineLimit('invalid');
    if (body.length > REMARKUP_LIMITS.bodyLength) throw new OutlineLimit('work');
    if (remarkupScanPreflight(body)) throw new OutlineLimit('work');
    const budget = new Budget(); budget.charge(body.length); budget.array(document.blocks);
    const mentions = scanMentions(body);
    interface Frame { nodes: (RemarkupBlock | RemarkupListItem)[]; index: number; depth: number; parent: RemarkupSpan }
    const stack: Frame[] = [{ nodes: document.blocks, index: 0, depth: 0, parent: { start: 0, end: body.length } }];
    const headings: RemarkupOutlineHeading[] = [], used = new Set<string>(), nextSuffix = new Map<string, number>();
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (frame.index === frame.nodes.length) { stack.pop(); continue; }
      const node = frame.nodes[frame.index++]!; budget.visit(frame.depth); span(node, frame.parent);
      if (node.type === 'heading') {
        if (!Number.isInteger(node.level) || node.level < 2 || node.level > 6) throw new OutlineLimit('invalid');
        const { label, serialized } = headingText(node.children, node, body, mentions, budget, frame.depth + 1), base = anchorName(serialized, budget);
        if (base === null) continue;
        let anchor = base, suffix = nextSuffix.get(base) ?? 1;
        while (used.has(anchor)) { budget.charge(anchor.length + 1); anchor = `${base}-${suffix++}`; }
        nextSuffix.set(base, suffix); used.add(anchor);
        headings.push({ start: node.start, end: node.end, level: node.level, label, anchor });
        continue;
      }
      let children: (RemarkupBlock | RemarkupListItem)[] | null = null;
      switch (node.type) {
        case 'quote': case 'note': case 'list-item': children = node.children; break;
        case 'list': children = node.items; break;
        case 'paragraph': case 'code-block': case 'literal': case 'rule': break;
        default: throw new OutlineLimit('invalid');
      }
      if (children) { budget.array(children); stack.push({ nodes: children, index: 0, depth: frame.depth + 1, parent: node }); }
    }
    return { headings, fallback: null };
  } catch (error) {
    if (error instanceof OutlineLimit) return { headings: [], fallback: error.reason };
    if (error instanceof RangeError) return { headings: [], fallback: 'work' };
    throw error;
  }
}
