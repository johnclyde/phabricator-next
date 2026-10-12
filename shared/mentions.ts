/** Native mention extraction follows the core Remarkup rules pinned at 5720a38c.
 * This is a bounded scanner, not a renderer or custom Remarkup interpreter. */
export const MENTION_LIMITS = { bodyLength: 20_000, occurrences: 100, quoteDepth: 32 } as const;
export interface MentionToken { start: number; end: number; username: string; spelling: string }
export interface MentionBinding extends MentionToken { principalId: string | null; displayName: string | null }
export interface MentionProof {
  format: 'phabricator.mentions.v1'; bodySha256: string; tokens: MentionBinding[];
  /** Opaque binding to the scoped retry key and exact request fingerprint.
   * Absent on legacy records and direct writes without request context. */
  requestSha256?: string;
}

interface Mapped { text: string; offsets: number[] }
const slice = (value: Mapped, start: number, end = value.text.length): Mapped => ({ text: value.text.slice(start, end), offsets: value.offsets.slice(start, end) });
const join = (parts: Mapped[]): Mapped => ({ text: parts.map(part => part.text).join(''), offsets: parts.flatMap(part => part.offsets) });
const white = /^[ \t\r\n\v\f]*$/;
const trimmed = (value: Mapped): Mapped => { const first = value.text.search(/[^ \t\r\n\v\f]/); return first < 0 ? slice(value, 0, 0) : slice(value, first, value.text.replace(/[ \t\r\n\v\f]+$/, '').length); };
function replace(value: Mapped, pattern: RegExp, replacement: (match: RegExpExecArray) => string | null): Mapped {
  const parts: Mapped[] = []; let cursor = 0;
  for (const match of value.text.matchAll(pattern)) {
    const text = replacement(match); if (text === null) continue;
    const start = match.index!; parts.push(slice(value, cursor, start));
    parts.push({ text, offsets: Array.from({ length: text.length }, (_, i) => value.offsets[start + Math.min(i, match[0].length - 1)]!) });
    cursor = start + match[0].length;
  }
  parts.push(slice(value, cursor)); return join(parts);
}
function lines(value: Mapped): Mapped[] {
  const result: Mapped[] = []; let start = 0;
  for (let i = 0; i < value.text.length; i++) if (value.text[i] === '\n') { result.push(slice(value, start, i + 1)); start = i + 1; }
  if (start < value.text.length) result.push(slice(value, start)); return result;
}
const listStart = /^[ \t\r\n\v\f]*(?:[-*#]+|[1-9][0-9]*[.)]|\[\D?\])[ \t\r\n\v\f]+/;
const listContinue = /^[ \t\r\n\v\f]*(?:[-*#]+|[0-9]+[.)]|\[\D?\])[ \t\r\n\v\f]+/;
function listLength(input: Mapped[], start: number): number {
  if (!listStart.test(input[start]!.text)) return 0;
  let end = start + 1, single = true;
  while (end < input.length) {
    const text = input[end]!.text;
    if (listContinue.test(text)) { end++; single = false; continue; }
    const empty = white.test(text), indented = text.startsWith(' '), next = input[end + 1]?.text;
    if ((empty || indented) && (indented && !empty || next !== undefined && next.startsWith(' ') && !white.test(next))) { end++; continue; }
    if (empty) end++; break;
  }
  return single && end < input.length && input[start]!.text.startsWith('#') ? 0 : end - start;
}

/** End-exclusive UTF-16 offsets refer to the exact unmodified body, including @.
 * Unknown names and duplicate occurrences are retained; account resolution is
 * a separate, explicit server operation. Limits fail the entire scan. */
export function scanMentions(body: string): MentionToken[] {
  if (typeof body !== 'string' || body.length > MENTION_LIMITS.bodyLength) throw new RangeError('Mention text exceeds the 20,000 character limit.');
  const found: MentionToken[] = [];
  const inline = (original: Mapped) => {
    let value = trimmed(original);
    // Stored tokens prevent later rules from interpreting literal content.
    value = replace(value, /\$\{\{\{([^\n]+?)\}\}\}/g, () => '\x01');
    value = replace(value, /##([\s\S]+?)##|\B`([^\n]+?)`/g, () => '\x01');
    value = replace(value, /\B\[\[([^|\]]+?)(?:\|([^\]]+?))?\]\]\B/g, match => match[0].includes('\x01') ? null : '\x01');
    value = replace(value, /\B\[([^\]]+?)\]\(([ \t\r\n\v\f]*[^ \t\r\n\v\f()]*(?:(?:\([^ ()]*\))+[^ \t\r\n\v\f()]*)?[ \t\r\n\v\f]*)\)\B/g, match => {
      const uri = match[2]!.trim(); return !uri || /^["'`]/.test(uri) || match[0].includes('\x01') || !uri.includes('/') && !uri.includes('@') && !uri.startsWith('tel:') ? null : '\x01';
    });
    value = replace(value, /<[A-Za-z0-9_]{3,32}:\/\/[^ \t\r\n\v\f\x01]+?>|\{[A-Za-z0-9_]{3,32}:\/\/[^ \t\r\n\v\f\x01]+?\}|(?<![A-Za-z0-9_])[A-Za-z0-9_]{3,32}:\/\/[^ \t\r\n\v\f\x01]+/g, () => '\x01');
    for (const match of value.text.matchAll(/(?<![A-Za-z0-9_@])@([A-Za-z0-9._-]*[A-Za-z0-9_-])/g)) {
      const start = value.offsets[match.index!]!, end = value.offsets[match.index! + match[0].length - 1]! + 1;
      // Block normalization never joins pieces into an invented source token.
      if (body.slice(start, end) !== match[0]) continue;
      found.push({ start, end, username: match[1]!.toLowerCase(), spelling: match[1]! });
      if (found.length > MENTION_LIMITS.occurrences) throw new RangeError('Comments may contain at most 100 mention occurrences.');
    }
  };
  const list = (group: Mapped[]) => {
    const items: Mapped[][] = []; let current: Mapped[] = [];
    for (const line of group) { if (listContinue.test(line.text) && current.length) { items.push(current); current = []; } current.push(line); }
    if (current.length) items.push(current);
    for (const item of items) {
      let value = join(item);
      value = replace(value, / *(\n+) */g, match => match[1]!);
      value = replace(value, /(?<!\n)\n(?!\n)/g, () => ' ');
      const prefix = /^[ \t\r\n\v\f]*(?:[-*#]+|[0-9]+[.)])[ \t\r\n\v\f]*/.exec(value.text);
      if (prefix) value = slice(value, prefix[0].length);
      const checkbox = /^[ \t\r\n\v\f]*\[\D?\][ \t\r\n\v\f]*/.exec(value.text);
      if (checkbox) value = slice(value, checkbox[0].length);
      let offset = 0;
      for (const part of value.text.split(/\n{2,}/)) { inline(slice(value, offset, offset + part.length)); offset += part.length; while (value.text[offset] === '\n') offset++; }
    }
  };
  const blocks = (input: Mapped[], depth: number) => {
    let cursor = 0, paragraph: Mapped[] = [];
    const flush = () => { if (paragraph.length) inline(join(paragraph)); paragraph = []; };
    while (cursor < input.length) {
      const line = input[cursor]!, text = line.text, count = listLength(input, cursor);
      if (count) { flush(); list(input.slice(cursor, cursor + count)); cursor += count; continue; }
      if (text.startsWith('>')) {
        flush(); if (depth >= MENTION_LIMITS.quoteDepth) throw new RangeError('Mention quoting exceeds 32 nested blocks.');
        let end = cursor + 1; while (end < input.length && input[end]!.text.startsWith('>')) end++;
        const reply = text.startsWith('>>!'); if (reply) inline(slice(line, 3));
        let child = input.slice(cursor + Number(reply), end).map(value => slice(value, 1));
        const strip = child.every(value => !value.text || /^[ >\n]/.test(value.text));
        if (strip) child = child.map(value => value.text.startsWith(' ') ? slice(value, 1) : value);
        while (child.length && white.test(child[0]!.text)) child.shift();
        blocks(child, depth + 1); cursor = end; continue;
      }
      if (/^[ \t\r\n\v\f]*%%%/.test(text)) {
        flush(); let end = cursor + 1;
        if (!/%%%[ \t\r\n\v\f]*$/.test(text) || /^[ \t\r\n\v\f]*%%%[ \t\r\n\v\f]*$/.test(text)) { while (end < input.length && !/%%%[ \t\r\n\v\f]*$/.test(input[end]!.text)) end++; if (end < input.length) end++; }
        cursor = end; continue;
      }
      const indented = /^[ \t\r\n\v\f]{2,}[^\n]+/.test(text);
      if (indented || /^[ \t\r\n\v\f]*```/.test(text)) {
        flush(); let end = cursor + 1;
        // Upstream tests indentation first, even when that line has backticks.
        if (!indented && /^[ \t\r\n\v\f]*```/.test(text)) {
          if (!/^[ \t\r\n\v\f]*```[^\n]*```[ \t\r\n\v\f]*$/.test(text)) { while (end < input.length && !/```[ \t\r\n\v\f]*$/.test(input[end]!.text)) end++; if (end < input.length) end++; }
        } else { while (end < input.length && (white.test(input[end]!.text) || /^[ \t\r\n\v\f]{2,}/.test(input[end]!.text))) end++; }
        cursor = end; continue;
      }
      // Interpreters are literal inputs to independent handlers, never executed.
      if (/^[A-Za-z0-9_]+[ \t\r\n\v\f]*(?:\([^)]+\)[ \t\r\n\v\f]*)?\{\{\{/.test(text)) {
        flush(); let end = cursor; while (end < input.length && !/\}\}\}[ \t\r\n\v\f]*$/.test(input[end]!.text)) end++; cursor = Math.min(end + 1, input.length); continue;
      }
      if (/^(?:={1,5}|#{2,5}|# )/.test(text) || input[cursor + 1] && /^[-=]{2,}[ \t\r\n\v\f]*$/.test(input[cursor + 1]!.text)) {
        flush(); const prefix = /^[ =#]+/.exec(text), end = text.replace(/[ =#\r\n]+$/, '').length; inline(slice(line, prefix?.[0].length ?? 0, end));
        cursor += input[cursor + 1] && /^[-=]{2,}[ \t\r\n\v\f]*$/.test(input[cursor + 1]!.text) ? 2 : 1; continue;
      }
      if (/^(?:\((?:NOTE|IMPORTANT|WARNING)\)|(?:NOTE|IMPORTANT|WARNING):)[ \t\r\n\v\f]*/.test(text)) {
        flush(); let end = cursor + 1; while (end < input.length && !white.test(input[end]!.text)) end++;
        inline(join(input.slice(cursor, end))); cursor = end; continue;
      }
      paragraph.push(line); cursor++; if (white.test(text)) flush();
    }
    flush();
  };
  blocks(lines({ text: body, offsets: Array.from({ length: body.length }, (_, i) => i) }), 0);
  return found.sort((a, b) => a.start - b.start);
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && Object.keys(value).every(key => names.includes(key));
/** Shape/source binding only; callers verify bodySha256 using their own crypto. */
export function isMentionProof(value: unknown, body?: string): value is MentionProof {
  if (!record(value) || !keys(value, ['format', 'bodySha256', 'tokens', ...(Object.hasOwn(value, 'requestSha256') ? ['requestSha256'] : [])]) || value.format !== 'phabricator.mentions.v1' || typeof value.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.bodySha256) || !Array.isArray(value.tokens) || value.tokens.length > MENTION_LIMITS.occurrences) return false;
  if (Object.hasOwn(value, 'requestSha256') && (typeof value.requestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestSha256))) return false;
  let end = 0; const people = new Map<string, string>(), labels = new Map<string, string>();
  for (const token of value.tokens) {
    if (!record(token) || !keys(token, ['start', 'end', 'username', 'spelling', 'principalId', 'displayName']) || !Number.isSafeInteger(token.start) || !Number.isSafeInteger(token.end) || Number(token.start) < end || Number(token.end) > MENTION_LIMITS.bodyLength || Number(token.end) <= Number(token.start) + 1 || typeof token.spelling !== 'string' || !/^[A-Za-z0-9._-]*[A-Za-z0-9_-]$/.test(token.spelling) || token.username !== token.spelling.toLowerCase() || Number(token.end) - Number(token.start) !== token.spelling.length + 1) return false;
    if (token.principalId === null ? token.displayName !== null : typeof token.principalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(token.principalId) || typeof token.displayName !== 'string' || !token.displayName.length || token.displayName.length > 240 || token.displayName.includes('\0')) return false;
    const identity = JSON.stringify([token.principalId, token.displayName]); if (people.has(token.username as string) && people.get(token.username as string) !== identity) return false;
    if (typeof token.principalId === 'string') { if (labels.has(token.principalId) && labels.get(token.principalId) !== token.displayName) return false; labels.set(token.principalId, token.displayName as string); }
    people.set(token.username as string, identity); end = Number(token.end);
  }
  if (body !== undefined) {
    const bindings = value.tokens as MentionBinding[];
    try { const tokens = scanMentions(body); if (tokens.length !== bindings.length || tokens.some((token, i) => token.start !== bindings[i]!.start || token.end !== bindings[i]!.end || token.username !== bindings[i]!.username || token.spelling !== bindings[i]!.spelling)) return false; } catch { return false; }
  }
  return true;
}
