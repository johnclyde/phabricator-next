import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { docxCommand } from '../cli/docx.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import type { DocxProjection, DocxSource } from '../shared/docx.ts';
import { sourceSnapshotCanonical } from '../shared/source-snapshot.ts';

const bytes = Buffer.from('the CLI treats package bytes as opaque');
const hash = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
const projection: DocxProjection = { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [], notes: [], comments: [], changes: [], editableRanges: [], warnings: [] };
const docx: DocxSource = { format: 'docx', fileName: 'motion.docx', sha256: hash(bytes), bytes: bytes.length, sourceFile: { fileId: 'F1', sha256: hash(bytes), bytes: bytes.length }, projection };
function run(command: string, args: string[], options: PaperCLI['options'], request: PaperCLI['request'], download: PaperCLI['download'] = async () => bytes) {
  return docxCommand({ command, args, options, optionNames: Object.keys(options), request, download });
}
async function quiet(work: () => Promise<void>) {
  const log = console.log, error = console.error; const lines: string[] = [];
  console.log = console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { await work(); return lines; } finally { console.log = log; console.error = error; }
}

test('Word CLI submits exactly retained import/edit intents and request IDs, without logging quoted source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'docx-cli-')); const path = join(directory, 'intent.json');
  const input = { testPlan: 'Fixture verification plan.', sourceFile: docx.sourceFile, title: 'Motion draft', expectedAccessEpoch: 4, shareSource: false };
  const calls: unknown[][] = []; const request: PaperCLI['request'] = async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); return { saved: true } as T; };
  try {
    await writeFile(path, JSON.stringify(input));
    await quiet(async () => { await run('import-docx', [path], { 'request-id': 'same-import' }, request); await run('import-docx', [path], { 'request-id': 'same-import' }, request); });
    assert.deepEqual(calls[0], ['/api/revisions/docx', 'POST', input, 'same-import']); assert.deepEqual(calls[1], calls[0]);
    const edit = { expectedVersion: 2, expectedVersionId: 'version-id', expectedContentHash: 'a'.repeat(64), expectedAccessEpoch: 4, rangeId: 'range-1', start: 1, end: 7, quote: 'secret', replacement: 'private draft', message: 'Edited motion' };
    await writeFile(path, JSON.stringify(edit));
    const output = await quiet(async () => { await run('edit-docx', ['L1'], { intent: path, 'request-id': 'same-edit' }, request); });
    assert.deepEqual(calls[2], ['/api/revisions/L1/docx/replace', 'POST', edit, 'same-edit']);
    assert.ok(output.every(line => !line.includes('secret') && !line.includes('private draft')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Word CLI refuses unsupported intents, missing pins, symlinks and implicit sharing before transmission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'docx-cli-invalid-')); const path = join(directory, 'intent.json'); let calls = 0;
  const request: PaperCLI['request'] = async <T>() => { calls++; return {} as T; };
  try {
    const base = { testPlan: 'Fixture verification plan.', sourceFile: docx.sourceFile, title: 'Motion', expectedAccessEpoch: 4, shareSource: false };
    for (const input of [{ ...base, shareSource: undefined }, { ...base, expectedAccessEpoch: 0 }, { ...base, generatedXml: '<unsafe/>' }, { ...base, sourceFile: { ...docx.sourceFile, bytes: -1 } }]) {
      await writeFile(path, JSON.stringify(input)); await assert.rejects(run('import-docx', [path], {}, request));
    }
    await writeFile(path, JSON.stringify(base)); await symlink(path, join(directory, 'link'));
    await assert.rejects(run('import-docx', [join(directory, 'link')], {}, request));
    await writeFile(path, JSON.stringify({ sourceFile: docx.sourceFile, shareSource: false, expectedAccessEpoch: 4, message: 'Reimport' }));
    await assert.rejects(run('reimport-docx', ['L1'], { intent: path }, request), /expectedVersion/);
    await assert.rejects(run('inspect-docx', ['F1'], { output: 'surprise' }, request), /unsupported/);
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Word CLI verifies the entire snapshot and exact package before exclusive private download', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'docx-cli-download-')); const output = join(directory, 'saved.bin');
  const version = { id: 'version-id', revisionId: 'L1', number: 3, files: [], docx, contentHash: hash(sourceSnapshotCanonical([], [], docx)) };
  const source = { revision: { id: 'L1' }, version }; const request: PaperCLI['request'] = async <T>() => source as T;
  const options = { version: '3', 'version-id': version.id, 'content-hash': version.contentHash, output };
  try {
    await quiet(async () => { await run('download-docx', ['L1'], options, request); });
    assert.deepEqual(await readFile(output), bytes); assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(run('download-docx', ['L1'], options, request), /EEXIST/);
    await assert.rejects(run('download-docx', ['L1'], { ...options, output: join(directory, 'corrupt.bin') }, request, async () => Buffer.alloc(bytes.length)), /SHA-256/);
    await assert.rejects(stat(join(directory, 'corrupt.bin')), /ENOENT/);
    await assert.rejects(run('download-docx', ['L1'], { ...options, 'version-id': 'another-version' }, request), /source pins/);
    await assert.rejects(run('download-docx', ['L1'], options, async <T>() => ({ ...source, version: { ...version, docx: { ...docx, projection: { ...projection, warnings: ['changed'] } } } }) as T), /source pins/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
