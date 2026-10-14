import test from 'node:test';
import assert from 'node:assert/strict';
import { FullTextIndex } from '../shared/search-index.ts';

const corpus = [
  { id: 'T1', title: 'A legal motion', text: 'The evidence is current. Procedural fairness matters.' },
  { id: 'T2', title: 'A legal question', text: 'A motion about evidence. This obsolete proposal is withdrawn.' },
  { id: 'T3', title: 'Study', text: 'Legal motion evidentiary hearing.' },
  { id: 'W1', title: 'Café notes', text: 'Résumé unicode studies in Καλημέρα and 日本語.' },
];
const ids = (index: FullTextIndex, query: string) => index.search(query).map(item => corpus[item.index]!.id).sort();
test('positional phrases do not cross fields and exclusions/prefixes use exact token positions', () => {
  const index = new FullTextIndex(corpus);
  assert.deepEqual(ids(index, '"legal motion"'), ['T1', 'T3']);
  assert.deepEqual(ids(index, 'legal motion'), ['T1', 'T2', 'T3']);
  assert.deepEqual(ids(index, 'legal evid* -obsolete'), ['T1', 'T3']);
  assert.deepEqual(ids(index, '"legal mot"*'), ['T1', 'T3']);
  assert.deepEqual(ids(index, '"question a"'), []);
  assert.deepEqual(ids(index, 'cafe resume'), ['W1']);
  assert.deepEqual(ids(index, 'καλημέρα'), ['W1']);
  assert.deepEqual(ids(index, '日本語'), ['W1']);
  assert.deepEqual(ids(index, 'evidence -"motion about"'), ['T1']);
  assert.deepEqual(ids(index, 'legal -never*'), ['T1', 'T2', 'T3']);
  assert.deepEqual(ids(index, 'doesnotexist'), []);
  assert.equal(index.search('').length, 4);
});
test('BM25 boosts title occurrences and snippets center matching body tokens without markup insertion', () => {
  const index = new FullTextIndex([{ id: 'T1', title: 'cosmology', text: 'Ordinary body' }, { id: 'T2', title: 'Ordinary', text: 'cosmology body' }]);
  assert.ok(index.search('cosmology').find(match => match.index === 0)!.rank < index.search('cosmology').find(match => match.index === 1)!.rank);
  const body = `${'unrelated '.repeat(80)}needle <script>literal</script> ${'following '.repeat(80)}`;
  const excerpt = new FullTextIndex([{ id: 'T9', title: 'Long', text: body }]).search('needle')[0]!.snippet;
  assert.ok(excerpt.includes('needle')); assert.ok(excerpt.startsWith('…')); assert.ok(excerpt.endsWith('…')); assert.ok(excerpt.length <= 504);
  assert.ok(!excerpt.includes('<mark>'));
});
