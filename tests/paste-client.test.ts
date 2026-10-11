import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pasteLineOffsets, pasteLines, pasteReceiptMatches, pasteTokenLines, safePasteTokens, type PasteIntent } from '../client/paste-client';
import type { PasteRecord } from '../shared/pastes';

test('paste line ranges preserve BOM, CRLF, CR, LF, emoji and final blank line exactly', () => {
  const content = '\uFEFFalpha\r\nbeta\rgamma😀\n'; const lines = pasteLines(content);
  assert.deepEqual(lines.map(line => line.text), ['\uFEFFalpha', 'beta', 'gamma😀', '']);
  assert.equal(lines.map(line => content.slice(line.start, line.end)).join(''), content);
  assert.equal(content.slice(lines[1]!.start, lines[2]!.end), 'beta\rgamma😀\n');
});
test('highlighted text is decoded into verified safe tokens without interpreting HTML', () => {
  const source = '<script>alert("x")</script>\r\nconst x = 2;';
  const html = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\r\n<span class="hljs-keyword">const</span> x = <span class="hljs-number">2</span>;';
  const tokens = safePasteTokens(html, source); assert.equal(tokens.map(token => token.text).join(''), source); assert.equal(tokens.find(token => token.text === 'const')?.classes[0], 'hljs-keyword');
  const lines = pasteTokenLines(tokens, pasteLines(source)); assert.deepEqual(lines.map(line => line.map(token => token.text).join('')), ['<script>alert("x")</script>', 'const x = 2;']);
  for (const unsafe of ['<img src=x onerror=alert(1)>', '<span onclick="alert(1)">x</span>', '<span class="hljs-keyword">wrong</span>', '<span class="hljs-keyword">x']) assert.deepEqual(safePasteTokens(unsafe, source), [{ text: source, classes: [] }]);
});
test('paste receipts pin metadata/source edits and comment content versions', () => {
  const record: PasteRecord = { id: 'PA1', title: 'Example', language: 'typescript', status: 'active', authorId: 'U1', version: 2, contentVersion: 2, contentHash: 'hash', bytes: 1, lineCount: 1, createdAt: '', updatedAt: '' };
  const intent: PasteIntent = { id: 'request', kind: 'edit', path: '/api/pastes/PA1', method: 'PATCH', body: { expectedVersion: 1, title: 'Example', content: 'x', language: 'typescript' }, contentHash: 'hash', draftKey: 'paste-draft:PA1:1:1', draft: {} };
  assert.equal(pasteReceiptMatches(record, intent), true); for (const patch of [{ id: 'PA2' }, { title: 'Wrong' }, { version: 3 }, { contentHash: 'later' }, { language: 'python' }]) assert.equal(pasteReceiptMatches({ ...record, ...patch }, intent), false);
  const comment = { id: 't', pasteId: 'PA1', sequence: 2, pasteVersion: 2, contentVersion: 1, contentHash: 'old', kind: 'comment' as const, createdAt: '', attribution: { principalId: 'U1', displayName: 'User', credentialId: null, requestId: 'q' }, comment: 'On old text' }; const commentIntent: PasteIntent = { ...intent, kind: 'comment', path: '/api/pastes/PA1/comments', method: 'POST', body: { contentVersion: 1, body: 'On old text' } };
  assert.equal(pasteReceiptMatches(comment, commentIntent), true); assert.equal(pasteReceiptMatches({ ...comment, contentVersion: 2 }, commentIntent), false);
});


test('newline-heavy 1 MiB source has compact offsets, bounded preview and exact late range', () => {
  const source = '\n'.repeat(1024 * 1024 - 4) + 'tail', offsets = pasteLineOffsets(source), lines = pasteLines(source, 5000, offsets);
  assert.ok(offsets instanceof Uint32Array); assert.equal(offsets.length - 1, 1024 * 1024 - 3); assert.equal(lines.length, 5000);
  assert.equal(source.slice(offsets[offsets.length - 2], offsets[offsets.length - 1]), 'tail'); assert.equal(source.slice(offsets[offsets.length - 3], offsets[offsets.length - 1]), '\ntail');
});
