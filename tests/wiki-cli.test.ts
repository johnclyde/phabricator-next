import test from 'node:test';
import assert from 'node:assert/strict';
import { wikiCommand } from '../cli/wiki.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';

async function run(command: string, args: string[], options: PaperCLI['options'], result: unknown = { documents: [], nextAfter: null, nextBefore: null }) {
  const calls: string[] = [], output: string[] = [];
  const prior = console.log; console.log = (...values: unknown[]) => output.push(values.join(' '));
  try {
    const handled = await wikiCommand({ command, args, options, optionNames: Object.keys(options), request: async <T>(path: string) => { calls.push(path); return result as T; }, download: async () => { throw new Error('Unexpected download.'); } });
    return { handled, calls, output };
  } finally { console.log = prior; }
}

test('wiki CLI requests one bounded page with canonical repeated path constraints and explicit continuation', async () => {
  const after = 'a'.repeat(70);
  const result = await run('wiki', [], { status: 'deleted,moved', 'parent-path': ['Research', 'Guides'], 'ancestor-path': ['Archive'], query: 'Literal % text', order: 'oldest', limit: '3', after }, { documents: [], nextAfter: 'b'.repeat(70), nextBefore: null });
  assert.equal(result.calls.length, 1);
  const url = new URL(result.calls[0]!, 'http://localhost');
  assert.equal(url.pathname, '/api/documents');
  assert.deepEqual(url.searchParams.getAll('statuses'), ['deleted', 'moved']);
  assert.deepEqual(url.searchParams.getAll('parentPaths'), ['research/', 'guides/']);
  assert.deepEqual(url.searchParams.getAll('ancestorPaths'), ['archive/']);
  assert.equal(url.searchParams.get('queryKey'), 'all');
  assert.equal(url.searchParams.get('query'), 'Literal % text');
  assert.equal(url.searchParams.get('after'), after);
  assert.equal(url.searchParams.get('limit'), '3');
  assert.match(result.output.join('\n'), /More documents: --after b{70}/);
});

test('wiki CLI defaults to Active and rejects ambiguous, wrong-kind and unbounded arguments before requests', async () => {
  const result = await run('wiki', [], {}); assert.match(result.calls[0]!, /queryKey=active/);
  for (const options of [{ status: 'bogus' }, { order: 'relevance' }, { limit: '101' }, { after: '2' }, { after: 'a'.repeat(70), before: 'b'.repeat(70) }, { query: 'x'.repeat(1001) }, { 'parent-path': Array(101).fill('x') }]) await assert.rejects(run('wiki', [], options));
  await assert.rejects(run('wiki-document', ['P1'], {}));
  await assert.rejects(run('wiki-document', ['W1'], { limit: '5' }));
  await assert.rejects(run('wiki-version', ['W1'], {}));
  await assert.rejects(run('wiki-history', ['W1'], { before: 'opaque' }));
  assert.equal((await run('unrelated', [], {})).handled, false);
});

test('wiki CLI distinguishes content version numbers from opaque discovery cursors and checks response identity', async () => {
  const history = await run('wiki-history', ['W7'], { before: '9', limit: '2' }, { versions: [], nextBefore: null });
  assert.equal(history.calls[0], '/api/documents/W7/history?limit=2&before=9');
  const transactions = await run('wiki-transactions', ['W7'], { before: '10' }, { transactions: [], nextBefore: null });
  assert.equal(transactions.calls[0], '/api/documents/W7/transactions?before=10');
  const version = await run('wiki-version', ['W7'], { version: '3' }, { documentId: 'W7', number: 3 });
  assert.equal(version.calls[0], '/api/documents/W7/versions/3');
  await assert.rejects(run('wiki-version', ['W7'], { version: '3' }, { documentId: 'W7', number: 4 }), /another document or version/);
  await assert.rejects(run('wiki-document', ['W7'], {}, { document: { id: 'W8' } }), /another document/);
});

test('wiki terminal rows escape source control characters and directional overrides', async () => {
  const result = await run('wiki', [], {}, { documents: [{ id: 'W1', title: 'Title\u001b[2J\u202e', path: 'page/', status: 'active', version: 2, published: { version: 1 } }], nextAfter: null, nextBefore: null });
  assert.ok(!/[\u001b\u202e]/.test(result.output.join('')));
  assert.match(result.output.join(''), /\\u001b\[2J\\u202e/);
});
