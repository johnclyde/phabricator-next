import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MENTION_LIMITS, isMentionProof, scanMentions } from '../shared/mentions.ts';
import { createCommentMentionProof, isStoredMentionProof, mentionRequestHash } from '../server/mentions.ts';

const names = (body: string) => scanMentions(body).map(token => token.spelling);
const sha = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

test('pinned MentionRemarkupRule boundaries preserve case, punctuation and exact UTF-16 spans', () => {
  const body = '😀 @Alice @alice mail@bob @@carol l@@k @bob./@CAROL... (@.Dot) @_x @-y @company.com é@Alice \\@Bob';
  assert.deepEqual(names(body), ['Alice', 'alice', 'bob', 'CAROL', '.Dot', '_x', '-y', 'company.com', 'Alice', 'Bob']);
  const tokens = scanMentions(body);
  assert.equal(tokens[0]!.start, 3); assert.equal(tokens[0]!.end, 9);
  for (const token of tokens) { assert.equal(body.slice(token.start, token.end), '@' + token.spelling); assert.equal(token.username, token.spelling.toLowerCase()); }
  assert.deepEqual(names('@ @... @a..b. x_@bob 4@bob @@@bob @one/@two'), ['a..b', 'one', 'two']);
});

test('monospace runs precede mentions and respect Remarkup nonword backtick boundary and paragraphs', () => {
  assert.deepEqual(names('`@alice` ##@bob## @carol'), ['carol']);
  assert.deepEqual(names('Code ##@alice\n@bob## @carol'), ['carol']);
  assert.deepEqual(names('`@alice ##@bob##` @carol'), ['carol']);
  assert.deepEqual(names('word`@alice` @bob'), ['alice', 'bob']);
  assert.deepEqual(names('`unclosed @alice'), ['alice']);
  assert.deepEqual(names('##@alice\n\n@bob##'), ['alice', 'bob']);
  assert.deepEqual(names('`@alice\n@bob`'), ['alice', 'bob']);
  assert.deepEqual(names('`@alice\r@bob` @carol'), ['carol'], 'PCRE dot excludes LF, not CR');
  assert.deepEqual(names('`@alice\u2028@bob` @carol'), ['carol'], 'Unicode line separators are ordinary Remarkup source characters');
  assert.deepEqual(names('${{{@alice}}} @bob'), ['bob'], 'evaluation tokens are stored before inline mentions, never executed');
});

test('fenced, indented and percent literal blocks mask whole matched blocks, including unclosed blocks', () => {
  for (const text of ['```\n@alice\n```\n@bob', '```@alice```\n@bob', '  @alice\n\n  @carol\n@bob', ' \t@alice\n@bob', '%%% @alice %%%\n@bob', '%%%\n@alice\n%%%\n@bob']) assert.deepEqual(names(text), ['bob'], text);
  for (const text of ['```\n@alice', '%%%\n@alice', '```\n%%%\n@alice']) assert.deepEqual(names(text), [], text);
  assert.deepEqual(names('%%% @alice %%%\n%%% @carol %%%\n@bob'), ['bob']);
  assert.deepEqual(names('  @alice\n  - @bob\n@carol'), ['carol'], 'an already-open indented code block owns subsequent lines');
  assert.deepEqual(names('  ```\n@alice\n```\n@bob'), ['alice'], 'two-space indentation wins over fenced-block detection upstream');
  assert.deepEqual(names('  \u2028@alice\n@bob'), ['bob']);
  assert.deepEqual(names('\t@alice\n @bob'), ['alice', 'bob'], 'one whitespace character is not the upstream two-character indent');
  assert.deepEqual(names('~~~\n@alice\n~~~'), ['alice'], 'tilde fences are not Remarkup code fences');
});

test('list priority and quote normalization preserve real prose mentions and mask nested code without offset drift', () => {
  const body = '  - @Alice\n    continuation @Bob\n  - `@Carol` @Dave\n\n> @Erin\n>   @Frank\n> @Grace\n\n>>! In @Heidi\n> ```\n> @Ivan\n> ```\n> @Judy';
  assert.deepEqual(names(body), ['Alice', 'Bob', 'Dave', 'Erin', 'Grace', 'Heidi', 'Judy']);
  for (const token of scanMentions(body)) assert.equal(body.slice(token.start, token.end), '@' + token.spelling);
  assert.deepEqual(names('- `code\n  @alice` @bob\n- @carol'), ['bob', 'carol'], 'single line wraps become spaces within list items');
  assert.deepEqual(names('> > Code ##@alice## @bob\n> >   @carol\n@dave'), ['bob', 'dave']);
  assert.deepEqual(names('> %%%\n> @alice\n> %%%\n@bob'), ['bob']);
  assert.deepEqual(names('# @alice\nprose @bob\n\n## @carol ##'), ['alice', 'bob', 'carol']);
});

test('document links and protocol hyperlinks are masked before mentions; rejected link syntax stays prose', () => {
  const text = '[[ /x/@alice | @bob ]] [@carol](/x) [@dave](https://host/x) https://host/@erin <https://host/@frank> {https://host/@grace} @heidi';
  assert.deepEqual(names(text), ['heidi']);
  assert.deepEqual(names('[@alice](relative) x[@bob](/path) [@carol]("/path")'), ['alice', 'bob', 'carol']);
  assert.deepEqual(names('https://host/@alice,\n@bob [[@carol]]'), ['bob']);
  assert.deepEqual(names('graphviz {{{\n@alice\n}}}\n@bob'), ['bob'], 'interpreter content is not evaluated or scanned as plain prose');
});

test('scan limits are complete failures, never truncated mention lists or unbounded quote recursion', () => {
  assert.equal(scanMentions('@alice '.repeat(MENTION_LIMITS.occurrences)).length, 100);
  assert.throws(() => scanMentions('@alice '.repeat(101)), RangeError);
  assert.deepEqual(scanMentions('x'.repeat(20_000)), []);
  assert.throws(() => scanMentions('x'.repeat(20_001)), RangeError);
  assert.throws(() => scanMentions('> '.repeat(33) + '@alice'), RangeError);
  assert.deepEqual(names('> '.repeat(32) + '@alice'), ['alice']);
  assert.deepEqual(names('@' + 'a'.repeat(10_000)), ['a'.repeat(10_000)], 'long unknown names are not truncated into registered usernames');
});

test('proof creation resolves each lowercase name once and retains repeated and unknown occurrences immutably', () => {
  const body = '@Alice @ALICE @missing `@excluded`', calls: string[] = [];
  const proof = createCommentMentionProof(body, username => { calls.push(username); return username === 'alice' ? { principalId: 'user:alice', displayName: 'Alice Original' } : null; });
  assert.deepEqual(calls, ['alice', 'missing']); assert.equal(proof.bodySha256, sha(body));
  assert.equal(proof.tokens[0]!.displayName, 'Alice Original'); assert.equal(proof.tokens[1]!.principalId, 'user:alice');
  assert.equal(proof.tokens[2]!.principalId, null); assert.equal(proof.tokens[2]!.displayName, null);
  assert.equal(isMentionProof(proof, body), true); assert.equal(isStoredMentionProof(proof, body), true);
  assert.equal(isStoredMentionProof(proof, body + ' '), false);
  assert.equal(isStoredMentionProof({ ...proof, bodySha256: '0'.repeat(64) }, body), false);
  assert.throws(() => createCommentMentionProof('@alice', () => ({ principalId: '', displayName: 'Fake' })));
  assert.throws(() => createCommentMentionProof('@alice', () => ({ principalId: 'alice', displayName: '' })));
  assert.throws(() => createCommentMentionProof('@alice', () => undefined as never));
  assert.throws(() => createCommentMentionProof('@alice', () => ({ principalId: null, displayName: null }) as never));
  assert.throws(() => createCommentMentionProof('@alice @bob', username => ({ principalId: 'same-person', displayName: username })));
});

test('proof guard rejects invented spans, code mentions, overlap, inconsistent repeat identities and unknown fields', () => {
  const body = '@Alice @ALICE `@alice`', proof = createCommentMentionProof(body, () => ({ principalId: 'alice', displayName: 'Alice' }));
  const variants: unknown[] = [null, {}, { ...proof, more: true }, { ...proof, tokens: proof.tokens.slice(1) }, { ...proof, tokens: [...proof.tokens].reverse() }, { ...proof, tokens: [{ ...proof.tokens[0]!, start: -1 }, proof.tokens[1]] }, { ...proof, tokens: [{ ...proof.tokens[0]!, end: 5 }, proof.tokens[1]] }, { ...proof, tokens: [{ ...proof.tokens[0]!, username: 'ALICE' }, proof.tokens[1]] }, { ...proof, tokens: [{ ...proof.tokens[0]!, principalId: null }, proof.tokens[1]] }, { ...proof, tokens: [proof.tokens[0], { ...proof.tokens[1]!, displayName: 'Renamed' }] }, { ...proof, tokens: [proof.tokens[0], { ...proof.tokens[1]!, extra: 1 }] }, { ...proof, tokens: [...proof.tokens, { ...proof.tokens[0]!, start: 15, end: 21, spelling: 'alice', username: 'alice' }] }];
  for (const value of variants) assert.equal(isMentionProof(value, body), false, JSON.stringify(value));
  assert.equal(isMentionProof(undefined, body), false, 'legacy absence is not invented proof');
  assert.equal(isMentionProof({ format: 'phabricator.mentions.v1', bodySha256: sha('plain'), tokens: [] }, 'plain'), true);
  assert.equal(isMentionProof(proof), true, 'shape-only guard deliberately does not claim cryptographic binding');
});

test('optional immutable request proof binds exact scoped key, route and input without rewriting legacy proofs', () => {
  const input = { body: '@Alice', versionId: 'version-one', filePath: 'paper.tex', line: 1 };
  const fingerprint = sha(JSON.stringify(['POST', '/api/revisions/P1/comments', input]));
  const digest = mentionRequestHash('workspace:alice:key-one', fingerprint);
  assert.equal(digest, sha(JSON.stringify(['workspace:alice:key-one', fingerprint])));
  assert.equal(mentionRequestHash(undefined, fingerprint), sha(JSON.stringify([null, fingerprint])));
  for (const changed of [
    mentionRequestHash('workspace:alice:key-two', fingerprint),
    mentionRequestHash('workspace:bob:key-one', fingerprint),
    mentionRequestHash(undefined, fingerprint),
    mentionRequestHash('workspace:alice:key-one', sha(JSON.stringify(['POST', '/api/revisions/P1/threads/thread-two/replies', input]))),
    mentionRequestHash('workspace:alice:key-one', sha(JSON.stringify(['POST', '/api/revisions/P1/comments', { ...input, versionId: 'version-two' }]))),
    mentionRequestHash('workspace:alice:key-one', sha(JSON.stringify(['POST', '/api/revisions/P1/comments', { ...input, line: 2 }]))),
  ]) assert.notEqual(changed, digest);
  const resolver = () => ({ principalId: 'alice', displayName: 'Alice' });
  const legacy = createCommentMentionProof(input.body, resolver), proof = createCommentMentionProof(input.body, resolver, digest);
  assert.equal(Object.hasOwn(legacy, 'requestSha256'), false);
  assert.deepEqual(proof, { ...legacy, requestSha256: digest });
  assert.equal(isMentionProof(proof, input.body), true); assert.equal(isStoredMentionProof(proof, input.body), true);
  for (const requestSha256 of [undefined, null, '', 'A'.repeat(64), '0'.repeat(63), 5]) assert.equal(isMentionProof({ ...proof, requestSha256 }, input.body), false);
  for (const bad of [null, '', 'A'.repeat(64), '0'.repeat(63), 5]) assert.throws(() => createCommentMentionProof(input.body, () => { throw new Error('Resolver must not run'); }, bad as never), /Invalid mention request digest/);
  assert.throws(() => mentionRequestHash(null as never, fingerprint), /Invalid mention request context/);
  assert.throws(() => mentionRequestHash(undefined, undefined as never), /Invalid mention request context/);
});
