import { createHash } from 'node:crypto';
import { isMentionProof, scanMentions, type MentionProof } from '../shared/mentions.ts';
import { isRevisionAuthor } from '../shared/revision-authorship.ts';

export type MentionResolver = (username: string) => { principalId: string; displayName: string } | null;
/** Bind immutable mention resolution to one scoped request without storing its
 * raw retry key. The fingerprint already covers method, path and exact input. */
export function mentionRequestHash(key: string | undefined, fingerprint: string): string {
  if (key !== undefined && typeof key !== 'string' || typeof fingerprint !== 'string') throw new TypeError('Invalid mention request context.');
  return createHash('sha256').update(JSON.stringify([key ?? null, fingerprint]), 'utf8').digest('hex');
}
/** Call inside the owning writer transaction. The resolver owns eligibility and
 * current object visibility; this helper never queries an account or source. */
export function createCommentMentionProof(body: string, resolveUsername: MentionResolver, requestSha256?: string): MentionProof {
  if (requestSha256 !== undefined && (typeof requestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(requestSha256))) throw new TypeError('Invalid mention request digest.');
  const people = new Map<string, ReturnType<MentionResolver>>();
  const tokens = scanMentions(body).map(token => {
    if (!people.has(token.username)) {
      const person = resolveUsername(token.username);
      if (person !== null && !isRevisionAuthor(person)) throw new Error('Mention resolution returned an invalid immutable identity.');
      people.set(token.username, person === null ? null : { ...person });
    }
    const person = people.get(token.username)!;
    return { ...token, principalId: person?.principalId ?? null, displayName: person?.displayName ?? null };
  });
  const proof: MentionProof = { format: 'phabricator.mentions.v1', bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'), tokens, ...(requestSha256 === undefined ? {} : { requestSha256 }) };
  if (!isMentionProof(proof, body)) throw new Error('Mention resolution returned an invalid immutable identity.');
  return proof;
}
export function isStoredMentionProof(value: unknown, body: string): value is MentionProof {
  return isMentionProof(value, body) && value.bodySha256 === createHash('sha256').update(body, 'utf8').digest('hex');
}
