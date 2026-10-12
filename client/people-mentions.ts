import type { PublicAccount } from '../shared/auth';
import { isMentionProof, scanMentions, type MentionProof } from '../shared/mentions';

export type MentionPart = { text: string; person?: { principalId: string; displayName: string } };

/** Render bindings captured with this exact body, never today's directory. */
export async function verifiedMentionProof(body: string, value: unknown): Promise<MentionProof | null> {
  if (!isMentionProof(value, body)) return null;
  const proof: MentionProof = { ...value, tokens: value.tokens.map(token => ({ ...token })) };
  try {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const hash = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return hash === proof.bodySha256 ? proof : null;
  } catch { return null; }
}

export function mentionParts(body: string, proof: MentionProof): MentionPart[] {
  const parts: MentionPart[] = []; let offset = 0;
  for (const token of proof.tokens) {
    if (token.start > offset) parts.push({ text: body.slice(offset, token.start) });
    parts.push({ text: body.slice(token.start, token.end), ...(token.principalId !== null && token.displayName !== null ? { person: { principalId: token.principalId, displayName: token.displayName } } : {}) });
    offset = token.end;
  }
  if (offset < body.length) parts.push({ text: body.slice(offset) });
  return parts;
}

function exactUsername(username: string): boolean {
  const tokens = scanMentions(`@${username}`);
  return tokens.length === 1 && tokens[0]!.start === 0 && tokens[0]!.end === username.length + 1 && tokens[0]!.username === username.toLowerCase();
}

/** Ambiguous or unrepresentable names must never select the wrong person. */
export function mentionPeople(people: PublicAccount[], query: string): PublicAccount[] {
  const enabled = people.filter(person => !person.disabled), counts = new Map<string, number>();
  for (const person of enabled) { const name = person.username.toLowerCase(); counts.set(name, (counts.get(name) || 0) + 1); }
  const search = query.trim().toLowerCase().replace(/^@/, '');
  return enabled.filter(person => counts.get(person.username.toLowerCase()) === 1 && exactUsername(person.username) && `${person.username}\n${person.displayName}`.toLowerCase().includes(search));
}

export function insertMention(body: string, start: number, end: number, username: string, maxLength = 20000): { body: string; caret: number } {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > body.length || !exactUsername(username)) throw new Error('Choose a person and a position in the comment.');
  const splitsCharacter = (index: number) => index > 0 && index < body.length && /[\uD800-\uDBFF]/.test(body[index - 1]!) && /[\uDC00-\uDFFF]/.test(body[index]!);
  if (splitsCharacter(start) || splitsCharacter(end)) throw new Error('Place the cursor between complete characters.');
  const before = start > 0 && !/\s/.test(body[start - 1]!) ? ' ' : '', after = end === body.length || !/\s/.test(body[end]!) ? ' ' : '';
  const token = `@${username}`, added = before + token + after, next = body.slice(0, start) + added + body.slice(end);
  if (next.length > maxLength) throw new Error(`This comment can contain at most ${maxLength.toLocaleString()} characters.`);
  const tokens = scanMentions(next), at = start + before.length;
  if (!tokens.some(item => item.start === at && item.end === at + token.length && item.username === username.toLowerCase())) throw new Error('Move the cursor outside code, links, or literal text to insert a person mention.');
  return { body: next, caret: start + added.length };
}
