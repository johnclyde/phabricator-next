/** Bounded native core Remarkup. Source spans are end-exclusive UTF-16 offsets.
 * Rendering never resolves accounts, reads objects, or executes interpreters. */
import { scanMentions, type MentionToken } from './mentions';
export const REMARKUP_LIMITS = { bodyLength: 20_000, depth: 32, nodes: 5_000, work: 2_000_000 } as const;
export interface RemarkupSpan { start: number; end: number }
export interface RemarkupText extends RemarkupSpan { type: 'text'; text: string }
export interface RemarkupBreak extends RemarkupSpan { type: 'break'; soft: boolean }
export interface RemarkupStyle extends RemarkupSpan { type: 'strong' | 'em' | 'del' | 'underline' | 'highlight'; children: RemarkupInline[] }
export interface RemarkupCode extends RemarkupSpan { type: 'code'; children: RemarkupText[] }
export interface RemarkupLink extends RemarkupSpan { type: 'link'; href: string; children: RemarkupInline[] }
export type RemarkupInline = RemarkupText | RemarkupBreak | RemarkupStyle | RemarkupCode | RemarkupLink;
export interface RemarkupParagraph extends RemarkupSpan { type: 'paragraph'; children: RemarkupInline[] }
/** HTML heading level, 2 through 6, matching core Remarkup's offset. */
export interface RemarkupHeading extends RemarkupSpan { type: 'heading'; level: number; children: RemarkupInline[] }
export interface RemarkupCodeBlock extends RemarkupSpan { type: 'code-block'; children: RemarkupText[]; language: string | null }
export interface RemarkupQuote extends RemarkupSpan { type: 'quote'; header: RemarkupInline[] | null; children: RemarkupBlock[] }
export interface RemarkupListItem extends RemarkupSpan { type: 'list-item'; checked: boolean | null; children: RemarkupBlock[] }
export interface RemarkupList extends RemarkupSpan { type: 'list'; ordered: boolean; startNumber: number; items: RemarkupListItem[] }
export interface RemarkupRule extends RemarkupSpan { type: 'rule' }
export interface RemarkupNote extends RemarkupSpan { type: 'note'; kind: 'note' | 'warning' | 'important'; showLabel: boolean; children: RemarkupBlock[] }
export interface RemarkupLiteral extends RemarkupSpan { type: 'literal'; text: string }
export type RemarkupBlock = RemarkupParagraph | RemarkupHeading | RemarkupCodeBlock | RemarkupQuote | RemarkupList | RemarkupRule | RemarkupNote | RemarkupLiteral;
export type RemarkupNode = RemarkupInline | RemarkupBlock | RemarkupListItem;
export type RemarkupFallback = 'length' | 'depth' | 'nodes' | 'work';
export interface RemarkupDocument { format: 'phabricator.remarkup.v1'; blocks: RemarkupBlock[]; fallback: RemarkupFallback | null }

/** No implicit scheme, wiki lookup, base-path mapping, embeds, or network reads.
 * Root-relative links intentionally address the origin root. */
export function safeRemarkupHref(value: string): string | null {
  if (typeof value !== 'string' || !value || value.length > REMARKUP_LIMITS.bodyLength || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (/[\u0000-\u001f\u007f-\u009f\\]/.test(decoded)) return null;
  if (value.startsWith('#')) return value;
  if (value.startsWith('/')) return !value.startsWith('//') && !decoded.startsWith('//') ? value : null;
  if (/^https?:\/\//i.test(value)) {
    try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password ? value : null; } catch { return null; }
  }
  if (/^mailto:/i.test(value)) return value.slice(7).length && !decoded.slice(7).startsWith('//') ? value : null;
  return null;
}

interface Mapped { text: string; offsets: number[] }
interface Stream extends Mapped { atoms: Map<number, RemarkupInline> }
const whitespace = /^[ \t\r\n\v\f]*$/;
const listStart = /^[ \t\r\n\v\f]*(?:[-*#]+|([1-9][0-9]*)[.)]|\[\D?\])[ \t\r\n\v\f]+/;
const listContinue = /^[ \t\r\n\v\f]*(?:[-*#]+|[0-9]+[.)]|\[\D?\])[ \t\r\n\v\f]+/;
const horizontal = /^[ \t\r\v\f]*(?:_{3,}|\*[ \t\r\v\f]?\*[ \t\r\v\f]?\*(?:[ \t\r\v\f]|\*)*|-[ \t\r\v\f]?-[ \t\r\v\f]?-(?:[ \t\r\v\f]|-)*)$/;
const note = /^(?:\((NOTE|IMPORTANT|WARNING)\)|(NOTE|IMPORTANT|WARNING):)[ \t\r\n\v\f]*/;
class Limit extends Error { constructor(readonly reason: RemarkupFallback) { super(reason); } }
// A suffix regexp without a start anchor can retry a long whitespace run at
// every character. Walking backward preserves ASCII Remarkup trim semantics.
function trimEndIndex(text: string, characters = ' \t\r\n\v\f'): number {
  let end = text.length; while (end && characters.includes(text[end - 1]!)) end--; return end;
}
function linkCandidateWork(text: string): number {
  // Both the frozen mention scanner and the link parser test each opening
  // bracket. Their URI whitespace branches may also retry a long run. Bound
  // both searches before either regexp, leaving plain indentation unrestricted.
  if (!text.includes('[')) return 0;
  let closing = text.length, work = 0, whitespaceRun = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ']') closing = i;
    else if (text[i] === '[') work += closing - i;
    if (' \t\r\n\v\f'.includes(text[i]!)) { work += 2 * whitespaceRun + 1; whitespaceRun++; } else whitespaceRun = 0;
    if (work > REMARKUP_LIMITS.work) throw new Limit('work');
  }
  return work;
}

/** Reuse the parser's linear guard before another projection invokes the
 * frozen mention scanner. A typed AST alone does not prove its source passed
 * this guard; callers can accidentally pair it with a different body. */
export function remarkupScanPreflight(body: string): RemarkupFallback | null {
  if (typeof body !== 'string') throw new TypeError('Remarkup source must be text.');
  if (body.length > REMARKUP_LIMITS.bodyLength) return 'length';
  try { return body.length + linkCandidateWork(body) > REMARKUP_LIMITS.work ? 'work' : null; }
  catch (error) { if (error instanceof Limit) return error.reason; throw error; }
}

class Parser {
  private work = 0;
  private count = 0;
  private readonly atomicText = new WeakSet<RemarkupText>();
  private readonly mentions: Map<number, MentionToken>;
  constructor(private readonly body: string) {
    this.charge(body.length + linkCandidateWork(body));
    // Mention syntax is stored before typography upstream, even for unresolved
    // people. Keep the released v1 scanner frozen; no directory lookup occurs.
    try { this.mentions = new Map(scanMentions(body).map(token => [token.start, token])); }
    catch (error) { if (error instanceof RangeError) throw new Limit(error.message === 'Mention quoting exceeds 32 nested blocks.' ? 'depth' : 'work'); throw error; }
  }
  private charge(amount: number): void { this.work += amount; if (this.work > REMARKUP_LIMITS.work) throw new Limit('work'); }
  private depth(depth: number): void { if (depth > REMARKUP_LIMITS.depth) throw new Limit('depth'); }
  private node<T extends RemarkupNode>(value: T): T { if (++this.count > REMARKUP_LIMITS.nodes) throw new Limit('nodes'); return value; }
  private span(value: Mapped): RemarkupSpan { return { start: value.offsets[0] ?? 0, end: value.offsets.length ? value.offsets.at(-1)! + 1 : value.offsets[0] ?? 0 }; }
  private cut(value: Mapped, start: number, end = value.text.length): Mapped { this.charge(Math.max(0, end - start)); return { text: value.text.slice(start, end), offsets: value.offsets.slice(start, end) }; }
  private join(values: Mapped[]): Mapped { this.charge(values.reduce((sum, value) => sum + value.text.length, 0)); return { text: values.map(value => value.text).join(''), offsets: values.flatMap(value => value.offsets) }; }
  private trim(value: Mapped): Mapped { this.charge(value.text.length); const first = value.text.search(/[^ \t\r\n\v\f]/); return first < 0 ? this.cut(value, 0, 0) : this.cut(value, first, trimEndIndex(value.text)); }
  private lines(value: Mapped): Mapped[] { this.charge(value.text.length); const result: Mapped[] = []; let start = 0; for (let i = 0; i < value.text.length; i++) if (value.text[i] === '\n') { result.push(this.cut(value, start, i + 1)); start = i + 1; } if (start < value.text.length) result.push(this.cut(value, start)); return result; }
  private text(value: Mapped): RemarkupText[] {
    this.charge(value.text.length); const result: RemarkupText[] = []; let start = 0;
    for (let i = 1; i <= value.text.length; i++) if (i === value.text.length || value.offsets[i] !== value.offsets[i - 1]! + 1) {
      const first = value.offsets[start]!, end = value.offsets[i - 1]! + 1;
      result.push(this.node({ type: 'text', start: first, end, text: this.body.slice(first, end) })); start = i;
    }
    return result;
  }
  private stream(value: Mapped): Stream { return { ...value, atoms: new Map() }; }
  private streamCut(value: Stream, start: number, end = value.text.length): Stream {
    return { ...this.cut(value, start, end), atoms: new Map([...value.atoms].filter(([at]) => at >= start && at < end).map(([at, node]) => [at - start, node])) };
  }
  private streamJoin(values: Stream[]): Stream {
    const atoms = new Map<number, RemarkupInline>(); let offset = 0;
    for (const value of values) { for (const [at, node] of value.atoms) atoms.set(offset + at, node); offset += value.text.length; }
    return { ...this.join(values), atoms };
  }
  private atom(node: RemarkupInline): Stream { return { text: '\x01', offsets: [node.start], atoms: new Map([[0, node]]) }; }
  private materialize(value: Stream, soft: boolean): RemarkupInline[] {
    this.charge(value.text.length); const result: RemarkupInline[] = []; let start = 0;
    const flush = (end: number) => { if (start < end) result.push(...this.text(this.cut(value, start, end))); };
    for (let i = 0; i < value.text.length; i++) {
      const atom = value.atoms.get(i);
      if (atom) { flush(i); result.push(atom); start = i + 1; }
      else if (value.text[i] === '\n') {
        const cr = i > start && value.text[i - 1] === '\r'; flush(i - Number(cr));
        result.push(this.node({ type: 'break', start: value.offsets[i - Number(cr)]!, end: value.offsets[i]! + 1, soft })); start = i + 1;
      }
    }
    flush(value.text.length); return result;
  }
  private fromNodes(nodes: RemarkupInline[]): Stream {
    return this.streamJoin(nodes.map(node => node.type === 'text' && !this.atomicText.has(node) || node.type === 'break' ? this.stream({ text: this.body.slice(node.start, node.end), offsets: Array.from({ length: node.end - node.start }, (_, i) => node.start + i) }) : this.atom(node)));
  }
  /** Replace matches with stored nodes before later rules see their syntax. */
  private replace(value: Stream, pattern: RegExp, callback: (part: Stream, match: RegExpExecArray) => RemarkupInline | null): Stream {
    this.charge(value.text.length); const parts: Stream[] = []; let cursor = 0;
    for (const match of value.text.matchAll(pattern)) {
      this.charge(match[0].length + 1); const start = match.index!, part = this.streamCut(value, start, start + match[0].length), result = callback(part, match);
      if (!result) continue;
      parts.push(this.streamCut(value, cursor, start), this.atom(result)); cursor = start + match[0].length;
    }
    parts.push(this.streamCut(value, cursor)); return this.streamJoin(parts);
  }
  private spanStream(value: Stream): RemarkupSpan {
    const result = this.span(value), last = value.atoms.get(value.text.length - 1); return { ...result, end: last?.end ?? result.end };
  }
  private literalInline(value: Stream): RemarkupInline | null {
    // If prior code tokens are nested in a link, keep the earlier code node and
    // leave the link syntax untouched, matching the upstream flat-text check.
    if (value.atoms.size) return null;
    const range = this.span(value), node = this.node<RemarkupText>({ type: 'text', ...range, text: this.body.slice(range.start, range.end) }); this.atomicText.add(node); return node;
  }
  private style(value: Stream, type: RemarkupStyle['type'], pattern: RegExp, soft: boolean, depth: number): Stream {
    this.depth(depth);
    for (const [at, node] of value.atoms) if (['strong', 'em', 'del', 'underline', 'highlight'].includes(node.type)) {
      const styled = node as RemarkupStyle;
      value.atoms.set(at, { ...styled, children: this.materialize(this.style(this.fromNodes(styled.children), type, pattern, soft, depth + 1), soft) });
    }
    return this.replace(value, pattern, (part, match) => {
      if (type === 'highlight' && /^!+$/.test(match[1]!)) return null;
      this.depth(depth + 1);
      let inside = this.streamCut(part, 2, part.text.length - 2);
      // Highlight's additional terminal exclamation points remain content.
      if (type === 'highlight') inside = this.streamJoin([this.streamCut(part, 2, 2 + match[1]!.length), this.streamCut(part, 4 + match[1]!.length)]);
      return this.node({ type, ...this.spanStream(part), children: this.materialize(inside, soft) });
    });
  }
  private inline(original: Mapped, depth: number, soft = false): RemarkupInline[] {
    this.depth(depth); let value = this.stream(original);
    // Unsupported evaluated expressions stay literal and never execute.
    value = this.replace(value, /\$\{\{\{[^\n]+?\}\}\}/g, part => this.literalInline(part));
    value = this.replace(value, /##([\s\S]+?)##|\B`([^\n]+?)`/g, (part, match) => {
      if (part.atoms.size) return null;
      const amount = match[1] === undefined ? 1 : 2;
      return this.node({ type: 'code', ...this.span(part), children: this.text(this.cut(part, amount, part.text.length - amount)) });
    });
    const documentLink = (part: Stream, uriStart: number, uriEnd: number, labelStart?: number, labelEnd?: number): RemarkupInline | null => {
      if (part.atoms.size) return null;
      const uri = this.trim(this.cut(part, uriStart, uriEnd)), href = safeRemarkupHref(uri.text);
      if (!href || uri.text === '/') return this.literalInline(part); // Wiki root/name resolution is separate.
      const label = labelStart === undefined ? uri : this.trim(this.cut(part, labelStart, labelEnd));
      return this.node({ type: 'link', ...this.span(part), href, children: this.text(label.text ? label : uri) });
    };
    value = this.replace(value, /\B\[\[([^|\]]+?)(?:\|([^\]]+?))?\]\]\B/g, (part, match) => documentLink(part, 2, 2 + match[1]!.length, match[2] === undefined ? undefined : 3 + match[1]!.length, part.text.length - 2));
    value = this.replace(value, /\B\[([^\]]+?)\]\(([ \t\r\n\v\f]*[^ \t\r\n\v\f()]*(?:(?:\([^ ()]*\))+[^ \t\r\n\v\f()]*)?[ \t\r\n\v\f]*)\)\B/g, (part, match) => {
      const uri = match[2]!.trim();
      if (!uri || /^["'`]/.test(uri) || !uri.includes('/') && !uri.includes('@') && !uri.startsWith('tel:')) return null;
      return documentLink(part, match[1]!.length + 3, part.text.length - 1, 1, 1 + match[1]!.length);
    });
    value = this.replace(value, /<[A-Za-z0-9_]{3,32}:\/\/[^ \t\r\n\v\f\x01]+?>|\{[A-Za-z0-9_]{3,32}:\/\/[^ \t\r\n\v\f\x01]+?\}/g, part => {
      if (part.text[0] === '{') return this.literalInline(part);
      const uri = this.cut(part, 1, part.text.length - 1), href = safeRemarkupHref(uri.text);
      return href ? this.node({ type: 'link', ...this.span(part), href, children: this.text(uri) }) : this.literalInline(part);
    });
    // Preserve punctuation in a separate source leaf, rather than putting it in href.
    this.charge(value.text.length); const links: Stream[] = []; let cursor = 0;
    for (const match of value.text.matchAll(/(?<![A-Za-z0-9_])[A-Za-z0-9_]{3,32}:\/\/[^ \t\r\n\v\f\x01]+/g)) {
      let uri = match[0].slice(0, trimEndIndex(match[0], ';,.:!?')); if (uri.endsWith(')') && !uri.includes('(')) uri = uri.slice(0, -1);
      const href = safeRemarkupHref(uri); if (!href) continue;
      const at = match.index!, part = this.streamCut(value, at, at + uri.length); if (part.atoms.size) continue;
      links.push(this.streamCut(value, cursor, at), this.atom(this.node({ type: 'link', ...this.span(part), href, children: this.text(part) }))); cursor = at + uri.length;
    }
    links.push(this.streamCut(value, cursor)); value = this.streamJoin(links);
    const mentioned: Stream[] = []; cursor = 0; this.charge(value.text.length);
    for (let at = 0; at < value.text.length; at++) {
      if (value.atoms.has(at)) continue;
      const token = this.mentions.get(value.offsets[at]!); if (!token) continue;
      const length = token.end - token.start, part = this.streamCut(value, at, at + length);
      if (part.atoms.size || part.text !== this.body.slice(token.start, token.end) || part.offsets.some((offset, i) => offset !== token.start + i)) continue;
      const node = this.node<RemarkupText>({ type: 'text', start: token.start, end: token.end, text: part.text }); this.atomicText.add(node);
      mentioned.push(this.streamCut(value, cursor, at), this.atom(node)); cursor = at + length; at = cursor - 1;
    }
    mentioned.push(this.streamCut(value, cursor)); value = this.streamJoin(mentioned);
    const styles: [RemarkupStyle['type'], RegExp][] = [
      ['strong', /\*\*([\s\S]+?)\*\*/g], ['del', /(?<!~)~~([^ \t\r\n\v\f~][\s\S]*?~*)~~/g],
      ['highlight', /!!([^\n]+?)(!{2,})/g], ['em', /(?<!:)\/\/([\s\S]+?)\/\//g],
      ['underline', /(?<!_|\/)__([^ \t\r\n\v\f_/][\s\S]*?_*)__(?!\/|\.[^ \t\r\n\v\f])/g],
    ];
    for (const [type, pattern] of styles) value = this.style(value, type, pattern, soft, depth);
    return this.materialize(value, soft);
  }
  private listLength(input: Mapped[], start: number): number {
    if (!listStart.test(input[start]!.text)) return 0;
    let end = start + 1, single = true;
    while (end < input.length) {
      this.charge(input[end]!.text.length + 1); const text = input[end]!.text;
      if (listContinue.test(text)) { end++; single = false; continue; }
      const empty = whitespace.test(text), indented = text.startsWith(' '), next = input[end + 1]?.text;
      if ((empty || indented) && (indented && !empty || next !== undefined && next.startsWith(' ') && !whitespace.test(next))) { end++; continue; }
      if (empty) end++; break;
    }
    return single && end < input.length && input[start]!.text.startsWith('#') ? 0 : end - start;
  }
  private list(group: Mapped[], depth: number): RemarkupList {
    this.depth(depth); const items: Mapped[][] = []; let current: Mapped[] = [];
    for (const line of group) { this.charge(line.text.length); if (listContinue.test(line.text) && current.length) { items.push(current); current = []; } current.push(line); } if (current.length) items.push(current);
    const minimum = Math.min(...items.map(item => /^[ \t\r\v\f]*/.exec(item[0]!.text)![0].length));
    let startNumber = 1; for (const item of items) { const match = listStart.exec(item[0]!.text); if (match?.[1]) { const number = Number(match[1]); if (Number.isSafeInteger(number) && number > 0) startNumber = number; break; } }
    const values = items.map(item => {
      const first = this.cut(item[0]!, minimum), mark = /^[ \t\r\v\f]*([-*#]{2,})/.exec(first.text);
      const indentation = mark ? mark[1]!.length - 1 : /^[ \t\r\v\f]*/.exec(first.text)![0].length;
      const ordered = /^[ \t\r\v\f]*(?:#|[0-9])/.test(first.text);
      const prefix = /^[ \t\r\v\f]*(?:[-*#]+|[0-9]+[.)])[ \t\r\v\f]*/.exec(first.text);
      let content = prefix ? this.cut(first, prefix[0].length) : first;
      const checkbox = /^[ \t\r\v\f]*\[(\D?)\][ \t\r\v\f]*/.exec(content.text);
      const checked = checkbox ? !!checkbox[1]!.trim() : null; if (checkbox) content = this.cut(content, checkbox[0].length);
      const joined = this.join([content, ...item.slice(1)].map(line => {
        // Core list wrapping strips ASCII spaces around LF, not tabs/CR.
        const lead = /^ */.exec(line.text)![0].length;
        return line.text.endsWith('\n') ? this.join([this.cut(line, lead, Math.max(lead, trimEndIndex(line.text.slice(0, -1), ' '))), this.cut(line, line.text.length - 1)]) : this.cut(line, lead);
      }));
      const value = this.trim(joined), children: RemarkupBlock[] = []; let at = 0;
      for (const part of value.text.split(/\n{2,}/)) {
        if (part) { const segment = this.cut(value, at, at + part.length); children.push(this.node({ type: 'paragraph', ...this.span(segment), children: this.inline(segment, depth + 1, true) })); }
        at += part.length; while (value.text[at] === '\n') at++;
      }
      return { indentation, ordered, checked, children, range: this.span(this.join(item)) };
    });
    const tree = (start: number, end: number, level: number, top: boolean): RemarkupList => {
      this.depth(level); this.charge(end - start); let min = start;
      for (let i = end - 1; i >= start; i--) if (values[i]!.indentation <= values[min]!.indentation) min = i;
      const minimumDepth = values[min]!.indentation, nodes: RemarkupListItem[] = [];
      if (min > start) { const nested = tree(start, min, level + 1, false); nodes.push(this.node({ type: 'list-item', start: nested.start, end: nested.end, checked: null, children: [nested] })); }
      let last = min;
      const append = (until: number) => {
        const value = values[last]!, children = [...value.children]; if (last + 1 < until) children.push(tree(last + 1, until, level + 1, false));
        nodes.push(this.node({ type: 'list-item', ...value.range, end: values[until - 1]!.range.end, checked: value.checked, children }));
      };
      for (let i = min + 1; i < end; i++) if (values[i]!.indentation === minimumDepth) { append(i); last = i; }
      append(end);
      return this.node({ type: 'list', start: values[start]!.range.start, end: values[end - 1]!.range.end, ordered: values[min]!.ordered, startNumber: values[min]!.ordered && top ? startNumber : 1, items: nodes });
    };
    return tree(0, values.length, depth, true);
  }
  private code(value: Mapped): RemarkupCodeBlock {
    const range = this.span(value); let content = value;
    const opening = /^[ \t\r\n\v\f]*```(?:[ \t\r\v\f]*\n)?/.exec(content.text);
    if (opening) { content = this.cut(content, opening[0].length); const close = /```[ \t\r\n\v\f]*$/.exec(content.text); if (close) content = this.cut(content, 0, close.index); }
    // Upstream strips terminal empty lines, then recognizes explicit options.
    content = this.cut(content, 0, trimEndIndex(content.text, '\n'));
    let lines = this.lines(content), language: string | null = null;
    const option = lines[0] && /^[ \t]*lang[ \t]*=[ \t]*([A-Za-z0-9_+-]{1,64})[ \t\r]*(?:\n)?$/.exec(lines[0].text);
    if (option) { language = option[1]!; lines = lines.slice(1); }
    let indent = 80;
    for (const line of lines) { this.charge(line.text.length); const text = line.text.replace(/\n$/, ''); if (/[^ ]/.test(text)) indent = Math.min(indent, /^ */.exec(text)![0].length); }
    const dedented = lines.map(line => line.text.startsWith(' '.repeat(indent)) ? this.cut(line, indent) : line);
    let source = this.join(dedented); source = this.cut(source, 0, trimEndIndex(source.text));
    return this.node({ type: 'code-block', ...range, language, children: this.text(source) });
  }
  private literal(value: Mapped): RemarkupLiteral { const range = this.span(value); return this.node({ type: 'literal', ...range, text: this.body.slice(range.start, range.end) }); }
  private blocks(input: Mapped[], depth: number): RemarkupBlock[] {
    this.depth(depth); const result: RemarkupBlock[] = []; let cursor = 0, paragraph: Mapped[] = [];
    const flush = () => { if (paragraph.length) { const value = this.trim(this.join(paragraph)); if (value.text) result.push(this.node({ type: 'paragraph', ...this.span(value), children: this.inline(value, depth) })); paragraph = []; } };
    while (cursor < input.length) {
      const line = input[cursor]!, text = line.text; this.charge(text.length + 1);
      if (horizontal.test(text.slice(0, trimEndIndex(text, '\r\n')))) { flush(); result.push(this.node({ type: 'rule', ...this.span(line) })); cursor++; continue; }
      const count = this.listLength(input, cursor);
      if (count) { flush(); result.push(this.list(input.slice(cursor, cursor + count), depth + 1)); cursor += count; continue; }
      if (text.startsWith('>')) {
        flush(); let end = cursor + 1; while (end < input.length && input[end]!.text.startsWith('>')) end++;
        const reply = text.startsWith('>>!'); const header = reply ? this.inline(this.trim(this.cut(line, 3)), depth + 1) : null;
        let child = input.slice(cursor + Number(reply), end).map(value => this.cut(value, 1));
        // A bare quoted CRLF is an empty line just like LF. The historical
        // first-character check overlooked CR and left every other line's
        // common quote prefix in place, hiding headings in Windows documents.
        if (child.every(value => !value.text || value.text === '\r\n' || /^[ >\n]/.test(value.text))) child = child.map(value => value.text.startsWith(' ') ? this.cut(value, 1) : value);
        while (child.length && whitespace.test(child[0]!.text)) child.shift();
        result.push(this.node({ type: 'quote', ...this.span(this.join(input.slice(cursor, end))), header, children: this.blocks(child, depth + 1) })); cursor = end; continue;
      }
      if (/^[ \t\r\n\v\f]*%%%/.test(text)) {
        flush(); let end = cursor + 1;
        if (!/%%%[ \t\r\n\v\f]*$/.test(text) || /^[ \t\r\n\v\f]*%%%[ \t\r\n\v\f]*$/.test(text)) { while (end < input.length && !/%%%[ \t\r\n\v\f]*$/.test(input[end]!.text)) end++; if (end < input.length) end++; }
        const group = input.slice(cursor, end), normalized = group.map(value => { const start = /^[ \t\r\n\v\f]*%%%/.exec(value.text)?.[0].length ?? 0, close = /%%%([ \t\r\n\v\f]*)$/.exec(value.text); return close && close.index >= start ? this.join([this.cut(value, start, close.index), this.cut(value, close.index + 3)]) : this.cut(value, start); });
        const value = this.trim(this.join(normalized)); result.push(this.node({ type: 'paragraph', ...this.span(this.join(group)), children: this.materialize(this.stream(value), false) })); cursor = end; continue;
      }
      const indented = /^[ \t\r\n\v\f]{2,}[^\n]+/.test(text);
      if (indented || /^[ \t\r\n\v\f]*```/.test(text)) {
        flush(); let end = cursor + 1;
        if (!indented) { if (!/^[ \t\r\n\v\f]*```[^\n]*```[ \t\r\n\v\f]*$/.test(text)) { while (end < input.length && !/```[ \t\r\n\v\f]*$/.test(input[end]!.text)) end++; if (end < input.length) end++; } }
        else while (end < input.length && (whitespace.test(input[end]!.text) || /^[ \t\r\n\v\f]{2,}/.test(input[end]!.text))) end++;
        result.push(this.code(this.join(input.slice(cursor, end)))); cursor = end; continue;
      }
      if (/^[A-Za-z0-9_]+[ \t\r\n\v\f]*(?:\([^)]+\)[ \t\r\n\v\f]*)?\{\{\{/.test(text)) {
        flush(); let end = cursor; while (end < input.length && !/\}\}\}[ \t\r\n\v\f]*$/.test(input[end]!.text)) end++; end = Math.min(end + 1, input.length); result.push(this.literal(this.join(input.slice(cursor, end)))); cursor = end; continue;
      }
      const underline = !whitespace.test(text) && input[cursor + 1] && /^[-=]{2,}[ \t\r\n\v\f]*$/.test(input[cursor + 1]!.text);
      if (/^(?:={1,5}|#{2,5}|# )/.test(text) || underline) {
        flush(); let title = this.trim(line), level: number;
        if (underline) level = input[cursor + 1]!.text[0] === '=' ? 2 : 3;
        else { level = Math.min(5, /^[=#]+/.exec(title.text)?.[0].length ?? 1) + 1; const prefix = /^[ =#]+/.exec(title.text)?.[0].length ?? 0; title = this.cut(title, prefix, Math.max(prefix, trimEndIndex(title.text, ' =#'))); }
        result.push(this.node({ type: 'heading', ...this.span(this.join(input.slice(cursor, cursor + (underline ? 2 : 1)))), level, children: this.inline(title, depth) })); cursor += underline ? 2 : 1; continue;
      }
      const noteMatch = note.exec(text);
      if (noteMatch) {
        flush(); let end = cursor + 1; while (end < input.length && !whitespace.test(input[end]!.text)) end++;
        const whole = this.join(input.slice(cursor, end)), value = this.trim(this.cut(whole, noteMatch[0].length));
        result.push(this.node({ type: 'note', ...this.span(whole), kind: (noteMatch[1] ?? noteMatch[2])!.toLowerCase() as RemarkupNote['kind'], showLabel: !!noteMatch[2], children: value.text ? [this.node({ type: 'paragraph', ...this.span(value), children: this.inline(value, depth) })] : [] })); cursor = end; continue;
      }
      paragraph.push(line); cursor++; if (whitespace.test(text)) flush();
    }
    flush(); return result;
  }
  parse(): RemarkupBlock[] { return this.blocks(this.lines({ text: this.body, offsets: Array.from({ length: this.body.length }, (_, i) => i) }), 0); }
}

/** Graceful complete fallback, never truncated content or a partially parsed tree.
 * Legacy bodies beyond today's authoring limit remain readable as exact text. */
export function parseRemarkup(body: string): RemarkupDocument {
  if (typeof body !== 'string') throw new TypeError('Remarkup source must be text.');
  const literal = (fallback: RemarkupFallback): RemarkupDocument => ({ format: 'phabricator.remarkup.v1', blocks: [{ type: 'literal', text: body, start: 0, end: body.length }], fallback });
  if (body.length > REMARKUP_LIMITS.bodyLength) return literal('length');
  try { return { format: 'phabricator.remarkup.v1', blocks: new Parser(body).parse(), fallback: null }; }
  catch (error) { if (error instanceof Limit) return literal(error.reason); throw error; }
}
