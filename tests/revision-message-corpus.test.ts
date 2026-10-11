import test from 'node:test';
import assert from 'node:assert/strict';
import { REVISION_MESSAGE_LABELS, revisionMessageCorpusHeader, validateRevisionMessageCorpus } from '../shared/revision-message-corpus.ts';

test('metadata bodies reject enabled core commit-message headers and aliases, including empty fields', () => {
  for (const label of REVISION_MESSAGE_LABELS) {
    for (const ending of ['', ' literal value']) {
      assert.equal(revisionMessageCorpusHeader(`${label}:${ending}`), label);
      assert.throws(() => validateRevisionMessageCorpus(`Opening paragraph.\r\n${label.toUpperCase()}:${ending}\r\n`, 'Summary'), /reserved commit-message header/);
      assert.throws(() => validateRevisionMessageCorpus(`${label.toLowerCase()}:${ending}`, 'Test Plan'), /reserved commit-message header/);
    }
  }
});

test('only exact line-start labels and colon placement are structural, preserving literal body text', () => {
  for (const value of ['', ' ', '0', 'Summary of the manuscript', 'The Test Plan: stays inline.', 'Summary : literal', ' Tests: indented', '\tReviewers: code', '> Projects: quoted', 'Custom Field: allowed', 'test  plan: literal', 'Subscribership: literal']) {
    assert.equal(revisionMessageCorpusHeader(value), null, value);
    assert.doesNotThrow(() => validateRevisionMessageCorpus(value, 'Summary'));
  }
  assert.equal(revisionMessageCorpusHeader('Introduction\nSummary:\nSummary:'), 'Summary');
});

test('upstream line splitting recognizes LF and CRLF, not lone CR or Unicode line separators', () => {
  for (const separator of ['\n', '\r\n']) assert.equal(revisionMessageCorpusHeader(`Paragraph${separator}Tests: run`), 'Tests');
  for (const separator of ['\r', '\u2028', '\u2029']) assert.equal(revisionMessageCorpusHeader(`Paragraph${separator}Tests: literal`), null);
  assert.equal(revisionMessageCorpusHeader('Tests: literal\u2028continued'), 'Tests');
  assert.equal(revisionMessageCorpusHeader('Tas\u212As: literal'), null, 'ASCII core labels do not acquire Unicode aliases');
});
