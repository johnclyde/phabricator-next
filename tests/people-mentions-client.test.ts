import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scanMentions, type MentionProof } from '../shared/mentions';
import { insertMention, mentionParts, mentionPeople, verifiedMentionProof } from '../client/people-mentions';

function proof(body: string): MentionProof {
  return { format: 'phabricator.mentions.v1', bodySha256: createHash('sha256').update(body).digest('hex'), tokens: scanMentions(body).map(token => ({ ...token, principalId: token.username === 'alice' ? 'person-alice' : null, displayName: token.username === 'alice' ? 'Alice <researcher>' : null })) };
}

test('stored mention rendering verifies exact body digest and preserves spelling, repeats, Unicode and unresolved text', async () => {
  const body = '😀 Please @Alice review <script>x</script>. Again @alice; @missing remains literal.\r\n';
  const saved = proof(body), verified = await verifiedMentionProof(body, saved);
  assert.deepEqual(verified, saved);
  const parts = mentionParts(body, verified!);
  assert.equal(parts.map(part => part.text).join(''), body);
  assert.deepEqual(parts.filter(part => part.person).map(part => part.text), ['@Alice', '@alice']);
  assert.equal(parts.find(part => part.text === '@missing')?.person, undefined);
  assert.equal(parts.find(part => part.person)?.person?.displayName, 'Alice <researcher>');
  const bound = { ...saved, requestSha256: 'a'.repeat(64) };
  assert.deepEqual(await verifiedMentionProof(body, bound), bound);
});

test('legacy bodies and malformed or substituted proof remain literal without directory resolution', async () => {
  const body = 'Please @alice.', saved = proof(body);
  assert.equal(await verifiedMentionProof(body, undefined), null);
  assert.equal(await verifiedMentionProof(body, { ...saved, requestSha256: 'invalid' }), null);
  assert.equal(await verifiedMentionProof(body, { ...saved, bodySha256: '0'.repeat(64) }), null);
  assert.equal(await verifiedMentionProof(`${body} changed`, saved), null);
  assert.equal(await verifiedMentionProof(body, { ...saved, tokens: [{ ...saved.tokens[0]!, start: 0 }] }), null);
  assert.equal(await verifiedMentionProof(body, { ...saved, tokens: [...saved.tokens, saved.tokens[0]!] }), null);
  assert.equal(await verifiedMentionProof(body, { ...saved, tokens: [{ ...saved.tokens[0]!, username: 'bob' }] }), null);
  assert.equal(await verifiedMentionProof('`@alice`', proof('@alice')), null);
});

test('a pending digest verifies a captured proof rather than a later mutation of its source object', async () => {
  const body = 'Read @alice.', saved = proof(body), pending = verifiedMentionProof(body, saved);
  saved.tokens[0]!.displayName = 'A later unrelated identity';
  assert.equal((await pending)!.tokens[0]!.displayName, 'Alice <researcher>');
});

test('picker directory excludes disabled, ambiguous and unrepresentable usernames without changing typed comments', () => {
  const people = [
    { id: 'alice', username: 'alice', displayName: 'Alice Researcher', disabled: false },
    { id: 'bob', username: 'bob', displayName: 'Bob Editor', disabled: true },
    { id: 'local-a', username: 'local', displayName: 'Local mode', disabled: false },
    { id: 'local-b', username: 'LOCAL', displayName: 'Real local', disabled: false },
    { id: 'period', username: 'trailing.', displayName: 'Trailing dot', disabled: false },
  ];
  assert.deepEqual(mentionPeople(people, '').map(person => person.id), ['alice']);
  assert.deepEqual(mentionPeople(people, '@ALICE').map(person => person.id), ['alice']);
  assert.deepEqual(mentionPeople(people, 'researcher').map(person => person.id), ['alice']);
  assert.deepEqual(mentionPeople(people, 'missing'), []);
});

test('mention insertion preserves text outside the selected range and returns the exact next caret', () => {
  assert.deepEqual(insertMention('Hello world.', 6, 11, 'alice'), { body: 'Hello @alice .', caret: 13 });
  assert.deepEqual(insertMention('😀 prose\r\n', 2, 2, 'Alice'), { body: '😀 @Alice prose\r\n', caret: 9 });
  assert.deepEqual(insertMention('', 0, 0, 'alice'), { body: '@alice ', caret: 7 });
  assert.deepEqual(insertMention('x\ny', 2, 2, 'alice'), { body: 'x\n@alice y', caret: 9 });
});

test('insertion refuses code and literal ranges, split surrogate pairs, unsupported names and limits without changing draft', () => {
  assert.throws(() => insertMention('`code`', 2, 2, 'alice'), /outside code/);
  assert.throws(() => insertMention('Use ##code##', 8, 8, 'alice'), /outside code/);
  assert.throws(() => insertMention('%%%literal%%%', 5, 5, 'alice'), /outside code/);
  assert.throws(() => insertMention('😀', 1, 1, 'alice'), /complete characters/);
  assert.throws(() => insertMention('', 0, 0, 'trailing.'), /Choose a person/);
  assert.throws(() => insertMention('short', 5, 5, 'alice', 10), /at most 10/);
  assert.throws(() => insertMention('@alice '.repeat(100), 700, 700, 'alice'), /100/);
});
