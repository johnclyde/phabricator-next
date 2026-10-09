import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWithAI, assertLocalModel } from '../server/ai';

test('Ollama metadata must establish a local model, including disguised cloud aliases', () => {
  assertLocalModel({ model_info: { 'general.architecture': 'llama' } });
  assert.throws(() => assertLocalModel({ remote_model: 'remote', model_info: { 'general.architecture': 'llama' } }));
  assert.throws(() => assertLocalModel({ remote_host: 'https://ollama.com', model_info: {} }));
  assert.throws(() => assertLocalModel({ model_info: {} }));
  assert.throws(() => assertLocalModel(null));
});

test('local model adapter refuses cloud metadata before transmitting document contents', async t => {
  const original = process.env.OLLAMA_MODEL;
  const originalURL = process.env.OLLAMA_URL;
  process.env.OLLAMA_MODEL = 'innocent-alias';
  delete process.env.OLLAMA_URL;
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    assert.match(String(url), /\/api\/show$/);
    bodies.push(String(options.body));
    return Response.json({ remote_host: 'https://ollama.com', remote_model: 'remote', model_info: {} });
  });
  try {
    await assert.rejects(analyzeWithAI('document', [{ path: 'motion.md', content: 'PRIVATE_DRAFT_SENTINEL' }], 'ollama'), /remote-backed/);
    assert.equal(bodies.length, 1);
    assert.ok(!bodies[0].includes('PRIVATE_DRAFT_SENTINEL'));
  } finally {
    if (original === undefined) delete process.env.OLLAMA_MODEL; else process.env.OLLAMA_MODEL = original;
    if (originalURL === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = originalURL;
  }
});

test('local model review verifies metadata then returns validated evidence without hosted fallback', async t => {
  const original = process.env.OLLAMA_MODEL;
  const originalURL = process.env.OLLAMA_URL;
  process.env.OLLAMA_MODEL = 'local-test';
  delete process.env.OLLAMA_URL;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    calls.push(String(url));
    return String(url).endsWith('/show')
      ? Response.json({ model_info: { 'general.architecture': 'llama' } })
      : Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'No actionable defect found in test snapshot.', findings: [] }) } });
  });
  try {
    const report = await analyzeWithAI('document', [{ path: 'motion.md', content: 'Sample draft.' }], 'ollama');
    assert.equal(report.provider, 'ollama');
    assert.equal(report.model, 'local-test');
    assert.deepEqual(calls, ['http://127.0.0.1:11434/api/show', 'http://127.0.0.1:11434/api/chat']);
  } finally {
    if (original === undefined) delete process.env.OLLAMA_MODEL; else process.env.OLLAMA_MODEL = original;
    if (originalURL === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = originalURL;
  }
});

test('hosted adapter requests non-stored structured evidence and never reflects provider error bodies', async t => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_MODEL;
  process.env.OPENAI_API_KEY = 'test-credential-not-real';
  process.env.OPENAI_MODEL = 'test-model';
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(options.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.input[0].role, 'user');
    assert.ok(!('tools' in body));
    if (status !== 200) return Response.json({ error: 'test-credential-not-real PRIVATE_DOCUMENT' }, { status });
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Test output with explicit limitations.', findings: [] }) }] }] });
  });
  try {
    const report = await analyzeWithAI('document', [{ path: 'motion.md', content: 'A fictional draft.' }], 'openai');
    assert.equal(report.provider, 'openai');
    status = 401;
    await assert.rejects(analyzeWithAI('document', [{ path: 'motion.md', content: 'A fictional draft.' }], 'openai'), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /test-credential-not-real|PRIVATE_DOCUMENT/);
      return true;
    });
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = originalModel;
  }
});
