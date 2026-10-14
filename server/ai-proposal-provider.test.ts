import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { aiProposalHead, aiProposalResult, applyAIProposal, AI_PROPOSAL_LIMITS, type AIProposalGenerateInput } from '../shared/ai-proposals.ts';
import type { RevisionVersion } from '../shared/types.ts';
import { contentHash } from './store.ts';
import { aiProposalSource, AI_PROPOSAL_PROMPT, AI_PROPOSAL_SCHEMA, AIProposalProviderError, generateAIProposal, parseOpenAIProposal } from './ai-proposal-provider.ts';

function version(content = 'Teh result.', path = 'paper.tex'): RevisionVersion { const files = [{ path, content }]; return { id: randomUUID(), revisionId: 'P1', number: 1, files, message: 'Fixture', createdAt: '2026-10-14T00:00:00Z', contentHash: contentHash(files) }; }
function input(v: RevisionVersion, provider: 'openai' | 'ollama' = 'openai'): AIProposalGenerateInput { return { provider, model: provider === 'openai' ? 'hosted-test-model' : 'local-test-model', instruction: 'Correct only supported errors.', expectedHead: aiProposalHead(v), expectedAccessEpoch: 1, scope: null, allowHosted: provider === 'openai' }; }
const result = { summary: 'No supported edits.', limitations: 'No external evidence was verified.', edits: [] };
const envelope = (value: unknown = result) => ({ id: 'response-test', model: 'resolved-test-model', status: 'completed', output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
async function configured(work: () => Promise<void>) {
  const previous = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_MODEL: process.env.OPENAI_MODEL, OLLAMA_MODEL: process.env.OLLAMA_MODEL, OLLAMA_URL: process.env.OLLAMA_URL }, previousFetch = fetch;
  process.env.OPENAI_API_KEY = 'test-only-do-not-use'; process.env.OPENAI_MODEL = 'hosted-test-model'; process.env.OLLAMA_MODEL = 'local-test-model'; process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
  try { await work(); } finally { globalThis.fetch = previousFetch; for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
test('hosted generation explicitly submits strict structured output with no storage, tools or automatic retries', async () => configured(async () => {
  const v = version(), request = input(v), source = aiProposalSource('paper', v, request); let calls = 0;
  globalThis.fetch = async (url, init) => { calls++; assert.equal(String(url), 'https://api.openai.com/v1/responses'); assert.equal(init!.redirect, 'error'); assert.ok(init!.signal); const body = JSON.parse(String(init!.body)); assert.equal(body.store, false); assert.equal(body.model, request.model); assert.equal(body.text.format.strict, true); assert.deepEqual(body.text.format.schema, AI_PROPOSAL_SCHEMA); assert.equal('tools' in body, false); assert.equal('maxItems' in body.text.format.schema.properties.edits, false); assert.deepEqual(JSON.parse(body.input[0].content), source); return Response.json(envelope()); };
  assert.deepEqual(await generateAIProposal(request, source), { result, responseModel: 'resolved-test-model', providerResponseId: 'response-test' }); assert.equal(calls, 1);
}));
test('refusal, truncation, mixed messages and invalid JSON never become partial proposals', () => {
  for (const response of [{ ...envelope(), status: 'incomplete' }, { ...envelope(), error: { message: 'secret' } }, { ...envelope(), incomplete_details: { reason: 'max_output_tokens' } }, { ...envelope(), output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private' }] }] }, { ...envelope(), output: [...envelope().output, ...envelope().output] }, { ...envelope(), output: [{ type: 'message', content: [{ type: 'output_text', text: '{' }] }] }]) assert.throws(() => parseOpenAIProposal(response), AIProposalProviderError);
});
test('transport interruption is uncertain and provider errors cannot reflect source or credentials', async () => configured(async () => {
  const v = version(), request = input(v), source = aiProposalSource('paper', v, request); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Secret credential and source'); };
  await assert.rejects(generateAIProposal(request, source), error => error instanceof AIProposalProviderError && error.outcome === 'uncertain' && !error.message.includes('Secret')); assert.equal(calls, 1);
  globalThis.fetch = async () => Response.json({ error: 'private source echoed here' }, { status: 400 });
  await assert.rejects(generateAIProposal(request, source), error => error instanceof AIProposalProviderError && error.outcome === 'failed' && !error.message.includes('private source'));
  const controller = new AbortController(); controller.abort(); calls = 0; globalThis.fetch = async () => { calls++; return Response.json(envelope()); }; await assert.rejects(generateAIProposal(request, source, controller.signal)); assert.equal(calls, 0);
}));
test('local generation verifies installed weights before sending any source and rejects remote aliases', async () => configured(async () => {
  const v = version(), request = input(v, 'ollama'), source = aiProposalSource('paper', v, request); const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init!.body)) }); return Response.json({ model_info: { 'general.architecture': 'llama' }, remote_host: 'https://remote.invalid' }); };
  await assert.rejects(generateAIProposal(request, source), error => error instanceof AIProposalProviderError && error.outcome === 'failed'); assert.equal(calls.length, 1); assert.match(calls[0]!.url, /\/api\/show$/); assert.deepEqual(calls[0]!.body, { model: request.model });
  calls.length = 0; globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init!.body)) }); assert.equal(init!.redirect, 'error'); return String(url).endsWith('/show') ? Response.json({ model_info: { 'general.architecture': 'llama' } }) : Response.json({ done: true, done_reason: 'stop', model: 'local-test-model', message: { content: JSON.stringify(result) } }); };
  const generated = await generateAIProposal(request, source); assert.deepEqual(generated.result, result); assert.equal(calls.length, 2); assert.equal(calls[1]!.body.stream, false); assert.equal(calls[1]!.body.model, request.model);
  process.env.OLLAMA_URL = 'https://external.invalid'; calls.length = 0; await assert.rejects(generateAIProposal(request, source)); assert.equal(calls.length, 0);
}));
test('local metadata latency cannot bypass a fresh source-dispatch authorization check', async () => configured(async () => {
  const v = version(), request = input(v, 'ollama'), source = aiProposalSource('paper', v, request); let release!: (value: Response) => void, calls = 0, authorized = true;
  globalThis.fetch = async () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const pending = generateAIProposal(request, source, undefined, () => { if (!authorized) throw new Error('Source access changed.'); });
  assert.equal(calls, 1); authorized = false; release(Response.json({ model_info: { 'general.architecture': 'llama' } }));
  await assert.rejects(pending, /Source access changed/); assert.equal(calls, 1);
}));
test('payload bounds reject the entire source or output rather than clipping an edit set', async () => configured(async () => {
  const large = version('x'.repeat(AI_PROPOSAL_LIMITS.sourceBytes)); assert.throws(() => aiProposalSource('paper', large, input(large)), /payload limit/);
  const v = version(), request = input(v); globalThis.fetch = async () => new Response('x'.repeat(AI_PROPOSAL_LIMITS.responseBytes + 1)); await assert.rejects(generateAIProposal(request, aiProposalSource('paper', v, request)), /payload limit/);
  assert.throws(() => aiProposalResult({ ...result, summary: 'x'.repeat(AI_PROPOSAL_LIMITS.resultBytes + 1) }, v, null), /oversized/);
}));
test('portable validation accepts hundreds of explained disjoint edits without a passage-count cap', () => {
  const v = version('a '.repeat(650)), edits = Array.from({ length: 650 }, (_, index) => ({ filePath: 'paper.tex', start: index * 2, end: index * 2 + 1, quote: 'a', replacement: 'b', explanation: `Requested correction at occurrence ${index + 1}.` }));
  const proposal = aiProposalResult({ ...result, summary: 'Complete requested replacements.', edits }, v, null); assert.equal(proposal.edits.length, 650); assert.equal(applyAIProposal(v, proposal)[0]!.content, 'b '.repeat(650));
});
test('fixed editorial evaluation fixtures exercise supported corrections and truthful abstention, not live model quality', () => {
  const cases = [
    { name: 'known spelling defect', source: 'Teh result.', edits: [{ filePath: 'paper.tex', start: 0, end: 3, quote: 'Teh', replacement: 'The', explanation: 'Correct the misspelled article.' }], expected: 'The result.' },
    { name: 'unsupported claim needs evidence rather than invented citations', source: 'This intervention always cures the disease.', edits: [], expected: 'This intervention always cures the disease.' },
    { name: 'unrequested cosmetic changes are unnecessary', source: 'We measured the response twice.', edits: [], expected: 'We measured the response twice.' },
    { name: 'truthful no-change result', source: 'Let x be a positive integer.', edits: [], expected: 'Let x be a positive integer.' },
  ];
  for (const item of cases) { const v = version(item.source), parsed = aiProposalResult({ summary: item.name, limitations: 'This fixture does not verify external evidence or evaluate a live model.', edits: item.edits }, v, null); assert.equal(parsed.edits.length ? applyAIProposal(v, parsed)[0]!.content : v.files[0]!.content, item.expected); }
  assert.match(AI_PROPOSAL_PROMPT, /Do not invent facts/); assert.match(AI_PROPOSAL_PROMPT, /empty edits array/); assert.match(AI_PROPOSAL_PROMPT, /Do not make cosmetic changes unless requested/);
});
