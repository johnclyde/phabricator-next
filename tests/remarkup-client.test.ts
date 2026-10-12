import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scanMentions, type MentionProof } from '../shared/mentions';
import { parseRemarkup, type RemarkupNode } from '../shared/remarkup';
import { remarkupMentionParts } from '../client/remarkup-rendering';
import { verifiedMentionProof } from '../client/people-mentions';

function proof(body: string): MentionProof {
  return { format: 'phabricator.mentions.v1', bodySha256: createHash('sha256').update(body).digest('hex'), tokens: scanMentions(body).map(token => ({ ...token, principalId: token.username === 'bob' ? 'person-bob' : null, displayName: token.username === 'bob' ? 'Original Bob' : null })) };
}

test('formatted leaves use original UTF16 spans and captured identities without normalizing spelling', async () => {
  const body = '😀\r\n> **Read @BoB and @missing**\r\n', start = body.indexOf('Read'), end = body.indexOf('**', start);
  const verified = await verifiedMentionProof(body, proof(body));
  const parts = remarkupMentionParts(body, { type: 'text', start, end, text: body.slice(start, end) }, verified);
  assert.equal(parts.map(part => part.text).join(''), 'Read @BoB and @missing');
  assert.deepEqual(parts.filter(part => part.person), [{ text: '@BoB', person: { principalId: 'person-bob', displayName: 'Original Bob' } }]);
});

test('a partial source span never manufactures a person chip across syntax nodes', async () => {
  const body = 'Read @bob.', verified = await verifiedMentionProof(body, proof(body));
  for (const [start, end] of [[0, 7], [6, body.length], [0, 5]]) {
    const parts = remarkupMentionParts(body, { type: 'text', start: start!, end: end!, text: body.slice(start, end) }, verified);
    assert.equal(parts.map(part => part.text).join(''), body.slice(start, end)); assert.equal(parts.some(part => part.person), false);
  }
});

test('legacy, suppressed and mismatched leaves stay exact literal text', async () => {
  const body = 'Read @bob.', node = { type: 'text' as const, start: 0, end: body.length, text: body };
  assert.deepEqual(remarkupMentionParts(body, node, null), [{ text: body }]);
  assert.deepEqual(remarkupMentionParts(body, { ...node, text: 'Changed @bob.' }, await verifiedMentionProof(body, proof(body))), [{ text: 'Changed @bob.' }]);
  const wrongHash = { ...proof(body), bodySha256: '0'.repeat(64) };
  assert.deepEqual(remarkupMentionParts(body, node, await verifiedMentionProof(body, wrongHash)), [{ text: body }]);
});

test('formatting preserves whole underscore-bearing usernames for captured, unknown and legacy mentions', async () => {
  const body = '**Read @al__ice** and @not__known.';
  const saved: MentionProof = { ...proof(body), tokens: scanMentions(body).map(token => ({ ...token, principalId: token.username === 'al__ice' ? 'person-captured' : null, displayName: token.username === 'al__ice' ? 'Captured Person' : null })) };
  const verified = await verifiedMentionProof(body, saved), parsed = parseRemarkup(body);
  const leaves: Extract<RemarkupNode, { type: 'text' }>[] = [];
  const visit = (node: RemarkupNode): void => {
    if (node.type === 'text') leaves.push(node);
    if ('children' in node) node.children.forEach(visit);
    if (node.type === 'list') node.items.forEach(visit);
    if (node.type === 'quote') node.header?.forEach(visit);
  };
  parsed.blocks.forEach(visit);
  const bound = leaves.flatMap(node => remarkupMentionParts(body, node, verified));
  assert.deepEqual(bound.filter(part => part.person), [{ text: '@al__ice', person: { principalId: 'person-captured', displayName: 'Captured Person' } }]);
  assert.equal(bound.map(part => part.text).join(''), 'Read @al__ice and @not__known.');
  assert.equal(leaves.flatMap(node => remarkupMentionParts(body, node, null)).map(part => part.text).join(''), 'Read @al__ice and @not__known.');
});
