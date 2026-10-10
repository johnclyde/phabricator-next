import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFile, type ReadyComparison } from '../shared/comparison.ts';
import { comparisonLineRows } from '../client/comparison-lines.ts';

function comparison(before: string | null, after: string | null): ReadyComparison {
  const file = (content: string | null) => content === null ? null : { path: 'source.ts', content };
  const result = compareFile(file(before), file(after), 'lines');
  if (result.status !== 'ready') assert.fail(`Expected ready, got ${result.reason}`);
  return result;
}

function rowsFor(before: string | null, after: string | null) {
  const value = comparison(before, after), rows = comparisonLineRows(value);
  assert.equal(rows.filter(row => row.kind !== 'added').map(row => row.text).join(''), before || '');
  assert.equal(rows.filter(row => row.kind !== 'removed').map(row => row.text).join(''), after || '');
  let oldLine = 0, newLine = 0;
  for (const row of rows) {
    assert.equal(row.beforeLine, row.kind === 'added' ? null : ++oldLine);
    assert.equal(row.afterLine, row.kind === 'removed' ? null : ++newLine);
    assert.equal((before || '').slice(row.before.start, row.before.end), row.kind === 'added' ? '' : row.text);
    assert.equal((after || '').slice(row.after.start, row.after.end), row.kind === 'removed' ? '' : row.text);
    assert.equal(row.passageIndex === null, row.kind === 'unchanged');
    if (row.passageIndex !== null) {
      const passage = value.passages[row.passageIndex]!;
      assert.ok(row.before.start >= passage.before.start && row.before.end <= passage.before.end);
      assert.ok(row.after.start >= passage.after.start && row.after.end <= passage.after.end);
    }
  }
  return rows;
}

test('line rows preserve both source line numbers and never fabricate a target for removals', () => {
  const rows = rowsFor('first\nremoved\nlast\n', 'first\nadded\nextra\nlast\n');
  assert.deepEqual(rows.map(row => [row.kind, row.beforeLine, row.afterLine, row.passageIndex]), [
    ['unchanged', 1, 1, null], ['removed', 2, null, 0], ['added', null, 2, 0], ['added', null, 3, 0], ['unchanged', 3, 4, null],
  ]);
});

test('CRLF, Unicode, blank lines and missing final newlines remain exact row text', () => {
  const rows = rowsFor('😀 e\u0301\r\n\r\nold', '😀 é\r\n\r\nnew\n');
  assert.ok(rows.some(row => row.text === '\r\n' && row.ending === 'crlf'));
  assert.ok(rows.some(row => row.text === 'old' && row.ending === 'none'));
  assert.ok(rows.some(row => row.text === 'new\n' && row.ending === 'lf'));
  assert.equal(rows.filter(row => row.text === '\r\n').length, 1, 'no phantom empty row appears after a terminator');
  rowsFor('\n', '\n'); rowsFor('a\r', 'a\r\n');
});

test('deleted-only files have no target comment line and empty files have no invented row', () => {
  const deleted = rowsFor('one\r\ntwo', null);
  assert.deepEqual(deleted.map(row => row.beforeLine), [1, 2]);
  assert.ok(deleted.every(row => row.afterLine === null && row.kind === 'removed'));
  const added = rowsFor(null, 'one\n'); assert.equal(added[0]!.afterLine, 1); assert.equal(added[0]!.beforeLine, null);
  assert.deepEqual(rowsFor('', ''), []); assert.deepEqual(rowsFor(null, ''), []); assert.deepEqual(rowsFor('', null), []);
});

test('reverse comparisons swap line-number sides and disjoint passages stay mapped in order', () => {
  const before = 'A\nold B\nC\nold D\n', after = 'A\nnew B\nC\nnew D\n';
  const forward = rowsFor(before, after), reverse = rowsFor(after, before);
  assert.deepEqual(forward.filter(row => row.kind === 'removed').map(row => row.beforeLine), reverse.filter(row => row.kind === 'added').map(row => row.afterLine));
  assert.deepEqual(forward.filter(row => row.kind === 'removed').map(row => row.passageIndex), [0, 1]);
});

test('bounded ready inputs expand linearly and row conversion does not mutate comparison evidence', () => {
  const text = `${'line\n'.repeat(3_999)}last`;
  const source = comparison(text, text), original = structuredClone(source), rows = comparisonLineRows(source);
  assert.equal(rows.length, 4_000); assert.equal(rows.at(-1)!.ending, 'none');
  assert.deepEqual(source, original);
  const word = compareFile({ path: 'source.ts', content: 'one word' }, { path: 'source.ts', content: 'two words' }, 'words');
  if (word.status !== 'ready') assert.fail('word fixture must be ready');
  assert.throws(() => comparisonLineRows(word), /literal line/);
});
