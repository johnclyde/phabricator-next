import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { citationCommand } from '../cli/citations.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import type { CitationEvidenceInput, CitationEvidenceRecord } from '../shared/citation-evidence.ts';

const input: CitationEvidenceInput = { versionId: 'exact-version', contentHash: 'a'.repeat(64), targetId: JSON.stringify(['citation', 'main.tex', 6, 9, 'key']),
  source: { fileId: 'F1', sha256: 'b'.repeat(64), bytes: 100, mediaType: 'application/pdf' }, verdict: 'inconclusive', quote: '  Exact quoted passage.\n', locator: 'p. 3', note: 'The passage does not resolve the claim.', attested: true, expectedAccessEpoch: 1 };
const recordId = '9216bfbb-eab3-42ce-bb4a-c30d8017053d';
function receipt(body: CitationEvidenceInput = input): CitationEvidenceRecord {
  return { id: recordId, revisionId: 'P1', versionId: body.versionId, versionNumber: 1, contentHash: body.contentHash,
    target: { id: body.targetId, kind: 'citation', key: 'key', filePath: 'main.tex', start: 6, end: 9, line: 1 }, source: body.source,
    basis: 'reviewer-attestation', verdict: body.verdict, quote: body.quote, locator: body.locator, note: body.note,
    createdAt: '2026-10-10T00:00:00.000Z', attribution: { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'write' }, state: 'active', recordVersion: 1 };
}
function context(command: string, options: PaperCLI['options'] = {}, args = ['P1']) {
  const calls: { path: string; method?: string; body?: unknown; key?: string }[] = [];
  const cli: PaperCLI = { command, args, options, optionNames: Object.keys(options), download: async () => { throw new Error('Unexpected binary download'); },
    request: async <T>(path: string, method?: string, body?: unknown, key?: string) => { calls.push({ path, method, body, key }); return receipt(body as CitationEvidenceInput | undefined) as T; } };
  return { cli, calls };
}
async function capture(work: (output: string[], errors: string[]) => Promise<void>): Promise<void> {
  const log = console.log, error = console.error, output: string[] = [], errors: string[] = [];
  console.log = (...values: unknown[]) => { output.push(values.join(' ')); }; console.error = (...values: unknown[]) => { errors.push(values.join(' ')); };
  try { await work(output, errors); } finally { console.log = log; console.error = error; }
}

test('citation CLI requires explicit version pins and preserves target query identity without choosing a newer head', async () => capture(async output => {
  const setup = context('citations'); await assert.rejects(citationCommand(setup.cli), /--version/); assert.equal(setup.calls.length, 0);
  setup.cli.options = { version: '2', json: true }; setup.cli.optionNames = ['version', 'json'];
  setup.cli.request = async <T>(path: string) => { assert.equal(path, '/api/revisions/P1/citations?version=2'); return { revisionId: 'P1', version: { number: 3 } } as T; };
  await assert.rejects(citationCommand(setup.cli), /different manuscript version/);
  const listing = context('citation-evidence', { 'version-id': input.versionId, 'target-id': input.targetId, limit: '100' });
  listing.cli.request = async <T>(path: string) => { const url = new URL(path, 'http://127.0.0.1'); assert.equal(url.searchParams.get('versionId'), input.versionId); assert.equal(url.searchParams.get('targetId'), input.targetId); return { records: [], nextBefore: null } as T; };
  assert.equal(await citationCommand(listing.cli), true); assert.match(output.join(''), /records/);
  listing.cli.options.limit = '101'; await assert.rejects(citationCommand(listing.cli), /100/);
  const invalid = context('citation-record', {}, ['P1', '../state']); await assert.rejects(citationCommand(invalid.cli), /UUID/); assert.equal(invalid.calls.length, 0);
}));

test('citation CLI retains exact request identity, never logs quoted evidence, and checks the immutable receipt', async () => capture(async (_output, errors) => {
  const directory = await mkdtemp(join(tmpdir(), 'citation-cli-'));
  try {
    const path = join(directory, 'evidence.json'); await writeFile(path, JSON.stringify(input));
    const setup = context('record-citation', { evidence: path, 'request-id': 'original-inspection' });
    await assert.rejects(citationCommand(setup.cli), /attest-inspected/); assert.equal(setup.calls.length, 0);
    setup.cli.options['attest-inspected'] = true; setup.cli.optionNames.push('attest-inspected');
    assert.equal(await citationCommand(setup.cli), true); assert.equal(await citationCommand(setup.cli), true);
    assert.equal(setup.calls.length, 2); assert.deepEqual(setup.calls[0], setup.calls[1]); assert.deepEqual(setup.calls[0]?.body, input);
    assert.equal(setup.calls[0]?.key, 'original-inspection'); assert.equal(errors.length, 2); assert.equal(errors[0], errors[1]);
    assert.ok(!errors.join('').includes('Exact quoted passage')); assert.ok(!errors.join('').includes(input.note)); assert.match(errors[0]!, /inputHash/);
    setup.cli.request = async <T>() => ({ ...receipt(), quote: 'Different evidence' }) as T;
    await assert.rejects(citationCommand(setup.cli), /exact source inspection/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));

test('citation CLI rejects symlink, oversize, invalid UTF-8 and unsupported evidence input before contacting a server', async () => capture(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'citation-cli-'));
  try {
    const path = join(directory, 'evidence.json'); await writeFile(path, JSON.stringify(input));
    const link = join(directory, 'linked.json'); await symlink(path, link);
    const setup = context('record-citation', { evidence: link, 'attest-inspected': true });
    await assert.rejects(citationCommand(setup.cli)); setup.cli.options.evidence = path;
    await writeFile(path, Buffer.alloc(131_073)); await assert.rejects(citationCommand(setup.cli), /at most/);
    await writeFile(path, Buffer.from([0xff])); await assert.rejects(citationCommand(setup.cli));
    for (const change of [{ attested: false }, { source: { ...input.source, bytes: 17 * 1024 * 1024 } }, { verdict: 'verified' }, { provider: 'AI' }, { quote: '  ' }]) {
      await writeFile(path, JSON.stringify({ ...input, ...change })); await assert.rejects(citationCommand(setup.cli));
    }
    assert.equal(setup.calls.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));

test('citation retraction requires an explicit record version and retains original source inspection in the receipt', async () => capture(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'citation-cli-'));
  try {
    const path = join(directory, 'reason.txt'); await writeFile(path, ' Source locator needs correction.\n');
    const setup = context('retract-citation', { 'reason-file': path, version: '1', 'request-id': 'retract-one' }, ['P1', recordId]);
    setup.cli.request = async <T>(url: string, method?: string, body?: unknown, key?: string) => {
      assert.equal(url, `/api/revisions/P1/citation-evidence/${recordId}/retract`); assert.equal(method, 'POST'); assert.equal(key, 'retract-one');
      assert.deepEqual(body, { expectedRecordVersion: 1, reason: 'Source locator needs correction.' });
      return { ...receipt(), state: 'retracted', recordVersion: 2, retraction: { reason: 'Source locator needs correction.', createdAt: receipt().createdAt, attribution: receipt().attribution } } as T;
    };
    assert.equal(await citationCommand(setup.cli), true);
    setup.cli.request = async <T>() => receipt() as T; await assert.rejects(citationCommand(setup.cli), /retraction/);
    delete setup.cli.options.version; await assert.rejects(citationCommand(setup.cli), /--version/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));
