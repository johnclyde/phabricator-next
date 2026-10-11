import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { deflateSync, gzipSync } from 'node:zlib';
import type { SourceFile } from '../shared/types.ts';
import type { RevisionAsset } from '../shared/files.ts';
import { sourceSnapshotCanonical, validateSourceSnapshot } from '../shared/source-snapshot.ts';
import { createTexRunner, normalizeTexLog, parseTexArchive, parseTexDiagnostics, parseTexMapping, parseTexPageGeometry, texRunnerFromEnvironment, validateTexInput, type TexRunnerInput } from './tex-runner.ts';

const geometry = JSON.stringify({ pages: [{ object: '3 0 R' }], qpdf: [{}, { 'obj:3 0 R': { value: { '/Type': '/Page', '/MediaBox': [0, 0, 612, 792] } } }] });
const files: SourceFile[] = [{ path: 'paper/main.tex', content: '\\documentclass{article}\n\\begin{document}Hello\\end{document}\n' }];
function input(source: SourceFile[] = files, entrypoint = source[0]!.path, assets: NonNullable<TexRunnerInput['assets']> = []): TexRunnerInput {
  return { revisionId: 'R1', versionId: 'version-1', contentHash: createHash('sha256').update(sourceSnapshotCanonical(source, assets)).digest('hex'), files: source, ...(assets.length ? { assets } : {}), entrypoint };
}
const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
function binary(path: string, data: Buffer, mediaType: RevisionAsset['mediaType'], fileId = 'F1'): NonNullable<TexRunnerInput['assets']>[number] { return { path, fileId, sha256: digest(data), bytes: data.length, mediaType, data }; }
function png(red = 220): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, 30, 30, red, 30, 30, 0, red, 30, 30, red, 30, 30]))), chunk('IEND', Buffer.alloc(0))]);
}
// A two-pixel green JPEG fixture, encoded once; runtime verification needs no image generator.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDKooor80P5CP/Z', 'base64');
function vectorPdf(): Buffer {
  const drawing = '0 0 0.8 rg 0 0 100 40 re f\n1 1 1 rg BT /F1 10 Tf 4 15 Td (Pinned vector figure) Tj ET\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 40] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${drawing.length} >>\nstream\n${drawing}endstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
function tar(name: string, contents: string, type = '0'): Buffer {
  const header = Buffer.alloc(512); header.write(name); header.write('0000644', 100); header.write('0000000', 108); header.write('0000000', 116);
  header.write(Buffer.byteLength(contents).toString(8).padStart(11, '0'), 124); header.write('00000000000', 136); header.fill(32, 148, 156); header.write(type, 156);
  const sum = header.reduce((total, byte) => total + byte, 0); header.write(sum.toString(8).padStart(6, '0'), 148); header[154] = 0;
  return Buffer.concat([header, Buffer.from(contents), Buffer.alloc((512 - Buffer.byteLength(contents) % 512) % 512)]);
}

test('TeX runner is opt-in, pinned and limited to a local Docker Unix socket', () => {
  assert.equal(texRunnerFromEnvironment({}), null);
  assert.throws(() => createTexRunner({ image: 'compiler:latest', dockerSocket: '/run/docker.sock' }), /pinned/);
  assert.throws(() => createTexRunner({ image: `sha256:${'a'.repeat(64)}`, dockerSocket: 'tcp://example.org:2375' }), /local/);
});

test('TeX input validation verifies exact immutable UTF-8 files, paths and entrypoint', () => {
  validateTexInput(input());
  assert.throws(() => validateTexInput({ ...input(), contentHash: '0'.repeat(64) }), /digest/);
  for (const path of ['../secret.tex', '/secret.tex', 'a/../b.tex', 'a\\b.tex', 'a\u0001.tex']) assert.throws(() => validateTexInput(input([{ path, content: 'source' }])), /paths/);
  assert.throws(() => validateTexInput(input([{ path: 'a.tex', content: '\ud800' }])), /UTF-8/);
  assert.throws(() => validateTexInput(input([{ path: 'a.tex', content: '' }, { path: 'a.tex/b', content: '' }])), /directory/);
  assert.throws(() => validateTexInput(input(files, 'missing.tex')), /entrypoint/);
});

test('binary snapshot identity preserves old hashes and binds exact sorted figure identities', () => {
  const source = [{ path: 'z.tex', content: 'last' }, { path: 'a.tex', content: 'first' }];
  const legacy = JSON.stringify([{ path: 'a.tex', content: 'first' }, { path: 'z.tex', content: 'last' }]);
  assert.equal(sourceSnapshotCanonical(source), legacy); assert.equal(sourceSnapshotCanonical(source, []), legacy);
  const assets = [binary('z.png', png(), 'image/png'), binary('a.jpg', jpeg, 'image/jpeg', 'F2')];
  assert.equal(sourceSnapshotCanonical(source, assets), sourceSnapshotCanonical([...source].reverse(), [...assets].reverse()));
  const canonical = JSON.parse(sourceSnapshotCanonical(source, assets)) as { format: string; assets: RevisionAsset[] };
  assert.equal(canonical.format, 'phabricator.source.v2'); assert.deepEqual(canonical.assets.map(asset => asset.path), ['a.jpg', 'z.png']); assert.ok(!('data' in canonical.assets[0]!));
  for (const replacement of [{ ...assets[0]!, fileId: 'F3' }, binary('z.png', png(221), 'image/png')]) assert.notEqual(sourceSnapshotCanonical(source, assets), sourceSnapshotCanonical(source, [replacement, assets[1]!]));
});

test('text and binary assets share a safe namespace and independently bounded immutable bytes', () => {
  const good = binary('paper/figures/chart.png', png(), 'image/png'); validateTexInput(input(files, files[0]!.path, [good]));
  for (const path of ['paper/main.tex', 'paper', 'paper/main.tex/figure.png', 'Paper/figure.png', '../figure.png', 'paper/../figure.png', 'paper/figures\\chart.png']) assert.throws(() => validateSourceSnapshot(files, [{ ...good, path }]), /paths|directory|collide/);
  for (const [left, right] of [['é.png', 'e\u0301.png'], ['Chart.png', 'chart.png'], ['figures/one.png', 'Figures/two.png'], ['straße.png', 'strasse.png']]) assert.throws(() => validateSourceSnapshot(files, [{ ...good, path: left! }, { ...good, path: right! }]), /collide/);
  for (const replacement of [{ ...good, data: png(221) }, { ...good, bytes: good.bytes + 1 }, { ...good, mediaType: 'image/jpeg' as const }, { ...good, sha256: '0'.repeat(64) }]) assert.throws(() => validateTexInput(input(files, files[0]!.path, [replacement])), /immutable identity/);
  assert.throws(() => validateSourceSnapshot(files, [{ ...good, bytes: 16 * 1024 * 1024 + 1 }]), /identities/);
  assert.throws(() => validateSourceSnapshot(files, Array.from({ length: 101 }, (_, index) => ({ ...good, path: `${index}.png` }))), /count/);
  assert.throws(() => validateSourceSnapshot(files, Array.from({ length: 5 }, (_, index) => ({ ...good, path: `${index}.png`, bytes: 16 * 1024 * 1024 }))), /byte limit/);
  assert.throws(() => validateTexInput({ ...input(files, files[0]!.path, [good]), contentHash: input().contentHash }), /digest/);
});

test('compiler archive cannot extract symlinks, traversal, duplicates or truncated data', () => {
  assert.equal(parseTexArchive(tar('compiler.log', 'hello')).get('compiler.log')?.toString(), 'hello');
  for (const value of [tar('../compiler.log', 'secret'), tar('compiler.log', 'secret', '2'), Buffer.concat([tar('status', '0'), tar('status', '0')]), tar('result.pdf', 'data').subarray(0, 514)]) {
    assert.throws(() => parseTexArchive(value), /archive/);
  }
  const corrupt = tar('status', '0'); corrupt[0] = 0; assert.throws(() => parseTexArchive(corrupt), /archive/);
});

test('source mapping only publishes finite coordinates for exact snapshot paths and source lines', () => {
  const sync = gzipSync('SyncTeX Version:1\nInput:1:/source/paper/main.tex\nInput:2:/etc/passwd\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n(1,2:6578176,13156352:6578176,6578176,0\n(2,1:0,0:0,0,0\n(1,999:0,0:0,0,0\n}\n');
  const map = parseTexMapping(sync, geometry, files);
  assert.equal(map.points.length, 1);
  assert.deepEqual({ ...map.points[0], x: undefined, y: undefined, width: undefined, height: undefined }, { path: 'paper/main.tex', line: 2, page: 1, x: undefined, y: undefined, width: undefined, height: undefined });
  for (const coordinate of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(map.points[0]![coordinate] - 100) < 0.000001);
  assert.equal(map.units, 'pt'); assert.equal(map.origin, 'top-left');
  assert.throws(() => parseTexMapping(sync, JSON.stringify({pages:[]}), files), /page count/);
  assert.throws(() => parseTexMapping(gzipSync('x'.repeat(17 * 1024 * 1024)), geometry, files));
});

test('diagnostics bind only to snapshot paths and valid source lines', () => {
  assert.deepEqual(parseTexDiagnostics('error: /source/paper/main.tex:2: Missing control sequence\nwarning: /etc/passwd:1: Not a source', files, 'paper/main.tex'), [
    { severity: 'error', message: 'Missing control sequence', path: 'paper/main.tex', line: 2 },
    { severity: 'warning', message: 'Not a source' },
  ]);
});

test('log normalization sorts only artifact-write progress while preserving compiler diagnostics', () => {
  assert.equal(normalizeTexLog('warning: Before\nnote: Writing `z` (1 B)\nnote: Writing `a` (2 B)\nerror: After\n'), 'warning: Before\nnote: Writing `a` (2 B)\nnote: Writing `z` (1 B)\nerror: After\n');
});

test('structured page geometry rejects metadata spoofing, rotation, crop and nonstandard units', () => {
  const document = JSON.parse(geometry) as { qpdf: [unknown, Record<string, { value: Record<string, unknown> }>] };
  document.qpdf[1]['obj:9 0 R'] = { value: { '/Title': 'Pages: 999\nPage 1 size: 1 x 1 pts' } };
  assert.deepEqual(parseTexPageGeometry(JSON.stringify(document)), [{ page: 1, width: 612, height: 792 }]);
  const page = document.qpdf[1]['obj:3 0 R']!.value;
  for (const [key, value] of [['/Rotate', 90], ['/UserUnit', 2], ['/CropBox', [10, 10, 500, 700]]]) {
    assert.throws(() => parseTexPageGeometry(JSON.stringify({ ...document, qpdf: [{}, { ...document.qpdf[1], 'obj:3 0 R': { value: { ...page, [key as string]: value } } }] })), /standard point units/);
  }
});

const enabled = Boolean(process.env.PHABRICATOR_TEX_INTEGRATION);
test('real isolated compiler embeds exact PNG, JPEG and PDF figures with reproducible asset manifests', { skip: !enabled, timeout: 240_000 }, async context => {
  const runner = texRunnerFromEnvironment(); assert.ok(runner);
  const source = [{ path: 'paper/main.tex', content: '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nPinned PNG: \\includegraphics[width=30pt]{figures/chart.png}\nPinned JPEG: \\includegraphics[width=30pt]{figures/photo.jpg}\n\\includegraphics[width=150pt]{figures/vector.pdf}\nFigure date: \\filemoddate{figures/chart.png}.\n\\end{document}\n' }];
  const assets = [binary('paper/figures/chart.png', png(), 'image/png'), binary('paper/figures/photo.jpg', jpeg, 'image/jpeg', 'F2'), binary('paper/figures/vector.pdf', vectorPdf(), 'application/pdf', 'F3')];
  const request = input(source, 'paper/main.tex', assets);
  const first = await runner.run(request, context.signal); assert.equal(first.success, true, JSON.stringify({ error: first.error, diagnostics: first.diagnostics, log: Buffer.from(first.artifacts.find(a => a.kind === 'log')?.data ?? []).toString() }));
  const second = await runner.run(request, context.signal); assert.equal(second.success, true, second.error ?? '');
  for (const kind of ['pdf', 'mapping', 'manifest'] as const) assert.equal(digest(first.artifacts.find(a => a.kind === kind)!.data), digest(second.artifacts.find(a => a.kind === kind)!.data), `${kind} must reproduce with identical binary assets`);
  const manifest = JSON.parse(Buffer.from(first.artifacts.find(a => a.kind === 'manifest')!.data).toString()) as { schema: number; assets: RevisionAsset[] };
  assert.equal(manifest.schema, 2); assert.deepEqual(manifest.assets, assets.map(({ data: _data, ...asset }) => asset));
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: Uint8Array.from(first.artifacts.find(a => a.kind === 'pdf')!.data), useWorkerFetch: false, useWasm: false });
  try {
    const document = await task.promise, page = await document.getPage(1), operators = await page.getOperatorList(), text = await page.getTextContent();
    const images = operators.fnArray.flatMap((operation, index) => operation === OPS.paintImageXObject ? [page.objs.get(operators.argsArray[index][0]) as { width: number; height: number; data: Uint8Array }] : []);
    assert.equal(images.length, 2, 'The PDF contains both raster figures as image painting operations.');
    assert.deepEqual(images.map(image => [image.width, image.height]), [[2, 2], [2, 2]]);
    assert.deepEqual(Array.from(images[0]!.data), Array.from({ length: 4 }, () => [220, 30, 30]).flat(), 'Decoded PNG pixels match the pinned input.');
    assert.ok(images[1]!.data.every((value, index) => Math.abs(value - [20, 180, 70][index % 3]!) <= 2), 'Decoded JPEG pixels match the pinned input within JPEG rounding.');
    assert.ok(text.items.some(item => 'str' in item && item.str.includes('Pinned vector figure')), 'The included PDF contributes its actual vector text.');
    assert.ok(text.items.some(item => 'str' in item && item.str.includes('20000101000000')), 'Binary source file dates are fixed.');
  } finally { await task.destroy(); }
  const changed = await runner.run(input(source, 'paper/main.tex', [binary(assets[0]!.path, png(221), 'image/png'), ...assets.slice(1)]), context.signal);
  assert.equal(changed.success, true, changed.error ?? ''); assert.notEqual(digest(first.artifacts.find(a => a.kind === 'pdf')!.data), digest(changed.artifacts.find(a => a.kind === 'pdf')!.data));
  if (process.env.PHABRICATOR_TEX_FIXTURE_DIR) {
    const directory = resolve(process.env.PHABRICATOR_TEX_FIXTURE_DIR, 'figures'); await mkdir(directory, { recursive: true });
    for (const artifact of first.artifacts) await writeFile(resolve(directory, artifact.name), artifact.data);
  }
});

test('real isolated compiler rejects corrupt PNG and PDF bodies without publishing a partial PDF', { skip: !enabled, timeout: 100_000 }, async context => {
  const runner = texRunnerFromEnvironment(); assert.ok(runner);
  for (const asset of [binary('broken.png', png().subarray(0, 33), 'image/png'), binary('broken.pdf', vectorPdf().subarray(0, 40), 'application/pdf')]) {
    const source = [{ path: 'main.tex', content: `\\documentclass{article}\\usepackage{graphicx}\\begin{document}\\includegraphics{${asset.path}}\\end{document}` }];
    const request = input(source, 'main.tex', [asset]);
    validateTexInput(request); // Header recognition is intentionally not an image decoder.
    const result = await runner.run(request, context.signal); assert.equal(result.success, false, asset.path); assert.match(result.error ?? '', /TeX compilation failed/); assert.ok(!result.artifacts.some(artifact => ['pdf', 'mapping'].includes(artifact.kind)));
  }
});

test('real Tectonic may embed a header-valid damaged JPEG without certifying its raster decodability', { skip: !enabled, timeout: 100_000 }, async context => {
  const runner = texRunnerFromEnvironment(); assert.ok(runner);
  const source = [{ path: 'main.tex', content: '\\documentclass{article}\\usepackage{graphicx}\\begin{document}\\includegraphics{damaged.jpg}\\end{document}' }];
  const asset = binary('damaged.jpg', jpeg.subarray(0, 200), 'image/jpeg');
  const result = await runner.run(input(source, 'main.tex', [asset]), context.signal);
  // Tectonic copies JPEG compressed bytes without decoding them. This is a known
  // limitation, not a test that the damaged image renders or has been repaired.
  assert.equal(result.success, true, result.error ?? '');
  assert.ok(result.artifacts.reduce((total, item) => total + item.data.length, 0) < 24 * 1024 * 1024);
  const manifest = JSON.parse(Buffer.from(result.artifacts.find(item => item.kind === 'manifest')!.data).toString()) as { assets: RevisionAsset[] };
  assert.equal(manifest.assets[0]!.sha256, asset.sha256, 'The output still reports the exact supplied damaged input.');
});

test('real isolated compiler handles nested files, bibliography, deterministic PDF/map and diagnostics', { skip: !enabled, timeout: 240_000 }, async () => {
  const runner = texRunnerFromEnvironment(); assert.ok(runner);
  const fixture: SourceFile[] = [
    { path: 'paper/main.tex', content: '\\documentclass{article}\n\\begin{document}\n\\input{sections/body}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n' },
    { path: 'paper/sections/body.tex', content: '\\section{An immutable paper}\nA reproducible claim~\\cite{knuth}. File date: \\filemoddate{main.tex}.\n' },
    { path: 'paper/refs.bib', content: '@book{knuth,author={Donald Knuth},title={The TeXbook},year={1984},publisher={Addison-Wesley}}\n' },
  ];
  const first = await runner.run(input(fixture), new AbortController().signal);
  assert.equal(first.success, true, JSON.stringify({ error: first.error, diagnostics: first.diagnostics, log: Buffer.from(first.artifacts.find(a => a.kind === 'log')?.data ?? []).toString() }));
  const second = await runner.run(input(fixture), new AbortController().signal); assert.equal(second.success, true, second.error ?? '');
  if (process.env.PHABRICATOR_TEX_FIXTURE_DIR) {
    await mkdir(process.env.PHABRICATOR_TEX_FIXTURE_DIR, { recursive: true });
    for (const artifact of first.artifacts) await writeFile(resolve(process.env.PHABRICATOR_TEX_FIXTURE_DIR, artifact.name), artifact.data);
    for (const artifact of second.artifacts) await writeFile(resolve(process.env.PHABRICATOR_TEX_FIXTURE_DIR, `second-${artifact.name}`), artifact.data);
    await writeFile(resolve(process.env.PHABRICATOR_TEX_FIXTURE_DIR, 'source.json'), JSON.stringify(fixture));
  }
  for (const kind of ['pdf', 'mapping', 'manifest'] as const) assert.equal(createHash('sha256').update(first.artifacts.find(a => a.kind === kind)!.data).digest('hex'), createHash('sha256').update(second.artifacts.find(a => a.kind === kind)!.data).digest('hex'), `${kind} must be deterministic`);
  const map = JSON.parse(Buffer.from(first.artifacts.find(a => a.kind === 'mapping')!.data).toString()) as { points: { path: string; line: number }[] };
  assert.ok(map.points.some(point => point.path === 'paper/sections/body.tex' && point.line === 2));
  const bad = await runner.run(input([{ path: 'bad.tex', content: '\\documentclass{article}\n\\begin{document}\n\\NoSuchControlSequence\n\\end{document}' }]), new AbortController().signal);
  assert.equal(bad.success, false); assert.ok(bad.diagnostics.some(d => d.path === 'bad.tex' && d.line === 3));
});

test('real compiler refuses host reads and uncached packages; shell escape cannot create a host file', { skip: !enabled, timeout: 180_000 }, async () => {
  const runner = texRunnerFromEnvironment(); assert.ok(runner);
  const secretPath = resolve(process.env.PHABRICATOR_TEX_WORK_DIR ?? '.data/tex-worker', 'host-sentinel.tex');
  await mkdir(resolve(secretPath, '..'), { recursive: true }); await writeFile(secretPath, 'HOST SENTINEL MUST NOT BE READ');
  const escaped = await runner.run(input([{ path: 'escape.tex', content: `\\documentclass{article}\\begin{document}\\input{${secretPath}}\\end{document}` }]), new AbortController().signal);
  assert.equal(escaped.success, false);
  const packageResult = await runner.run(input([{ path: 'missing.tex', content: '\\documentclass{article}\\usepackage{phabricator-nonexistent-package}\\begin{document}x\\end{document}' }]), new AbortController().signal);
  assert.equal(packageResult.success, false);
  const shell = await runner.run(input([{ path: 'shell.tex', content: `\\documentclass{article}\\begin{document}\\immediate\\write18{touch /work/escape-marker}\\newread\\probe\\openin\\probe=/work/escape-marker \\ifeof\\probe Shell escape is disabled.\\else\\errmessage{SHELL ESCAPE EXECUTED}\\fi\\closein\\probe\\end{document}` }]), new AbortController().signal);
  assert.equal(shell.success, true, shell.error ?? '');
  assert.equal(await readFile(secretPath, 'utf8'), 'HOST SENTINEL MUST NOT BE READ');
});

test('real container confines an uncanceled infinite expansion and enforces its own deadline', { skip: !enabled, timeout: 100_000 }, async () => {
  const runner = texRunnerFromEnvironment(); assert.ok(runner);
  const request = { ...input([{ path: 'loop.tex', content: '\\documentclass{article}\\begin{document}\\def\\forever{\\forever}\\forever\\end{document}' }]), versionId: randomUUID() };
  const docker = async (...args: string[]) => (await promisify(execFile)('docker', ['--host', `unix://${process.env.PHABRICATOR_TEX_DOCKER_SOCKET}`, ...args], { timeout: 10_000, env: { PATH: process.env.PATH, HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' } })).stdout;
  const start = Date.now();
  const compilation = runner.run(request, new AbortController().signal);
  let id = '';
  for (let attempt = 0; attempt < 30 && !id; attempt++) { id = (await docker('ps', '--filter', `label=org.phabricator.tex.version=${request.versionId}`, '--format', '{{.ID}}')).trim(); if (!id) await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.ok(id, 'The real compilation container must be observable while the engine runs.');
  const inspection = JSON.parse(await docker('inspect', id))[0] as { HostConfig: Record<string, unknown>; Config: { User: string }; Mounts: { Type: string; RW: boolean; Destination: string }[] };
  assert.equal(inspection.HostConfig.NetworkMode, 'none'); assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspection.HostConfig.CapDrop, ['ALL']); assert.equal(inspection.Config.User, '65534:65534');
  assert.equal(inspection.HostConfig.PidsLimit, 32); assert.equal(inspection.HostConfig.Memory, 768 * 1024 * 1024);
  assert.equal(inspection.HostConfig.MemorySwap, 768 * 1024 * 1024); assert.equal(inspection.HostConfig.NanoCpus, 1_000_000_000);
  assert.deepEqual(inspection.Mounts.filter(mount => mount.Type === 'bind').map(({ RW, Destination }) => ({ RW, Destination })), [{ RW: false, Destination: '/source' }]);
  const result = await compilation; assert.equal(result.success, false); assert.match(result.error ?? '', /time or memory limit/);
  assert.ok(Date.now() - start >= 55_000 && Date.now() - start < 90_000);
  assert.equal((await docker('ps', '-a', '--filter', `label=org.phabricator.tex.version=${request.versionId}`, '--format', '{{.ID}}')).trim(), '');
});

test('real compiler bounds output flooding without publishing a partial PDF', { skip: !enabled, timeout: 100_000 }, async () => {
  const runner = texRunnerFromEnvironment(); assert.ok(runner);
  const source = '\\documentclass{article}\\begin{document}\\loop\\message{' + 'flood '.repeat(160) + '}\\iftrue\\repeat\\end{document}';
  const result = await runner.run(input([{ path: 'flood.tex', content: source }]), new AbortController().signal);
  assert.equal(result.success, false); assert.ok(!result.artifacts.some(artifact => artifact.kind === 'pdf'));
  assert.ok(result.artifacts.every(artifact => artifact.data.length <= 524_288));
});

test('real compiler cancellation terminates an infinite expansion', { skip: !enabled, timeout: 45_000 }, async () => {
  const runner = texRunnerFromEnvironment(); assert.ok(runner); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try { await assert.rejects(runner.run(input([{ path: 'loop.tex', content: '\\documentclass{article}\\begin{document}\\def\\forever{\\forever}\\forever\\end{document}' }]), controller.signal), { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
});

test('real page specials cannot publish an incorrect rotated, cropped or rescaled source map', { skip: !enabled, timeout: 240_000 }, async context => {
  const runner = texRunnerFromEnvironment(); assert.ok(runner);
  for (const special of ['/Rotate 90', '/CropBox [10 10 500 700]', '/UserUnit 2']) {
    const result = await runner.run(input([{ path: 'geometry.tex', content: `\\documentclass{article}\\begin{document}\\special{pdf:put @thispage << ${special} >>}A page with custom geometry.\\end{document}` }]), context.signal);
    assert.equal(result.success, false, special);
    assert.match(result.error ?? '', /standard point units/);
    assert.ok(!result.artifacts.some(artifact => artifact.kind === 'mapping'));
  }
});
