import type { MentionProof } from '../shared/mentions';
import type { RemarkupText } from '../shared/remarkup';
import type { MentionPart } from './people-mentions';

/** Only whole, verified source-span bindings can enhance a parsed text leaf. */
export function remarkupMentionParts(body: string, node: RemarkupText, proof: MentionProof | null): MentionPart[] {
  if (!proof || node.text !== body.slice(node.start, node.end)) return [{ text: node.text }];
  const parts: MentionPart[] = []; let offset = node.start;
  for (const token of proof.tokens) {
    if (token.start < node.start || token.end > node.end) continue;
    if (token.start > offset) parts.push({ text: body.slice(offset, token.start) });
    parts.push({ text: body.slice(token.start, token.end), ...(token.principalId !== null && token.displayName !== null ? { person: { principalId: token.principalId, displayName: token.displayName } } : {}) });
    offset = token.end;
  }
  if (offset < node.end) parts.push({ text: body.slice(offset, node.end) });
  return parts;
}
