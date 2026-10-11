import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import type { SourceFile } from '../shared/types.ts';
import { createTexRunner, normalizeTexLog, parseTexArchive, parseTexDiagnostics, parseTexMapping, parseTexPageGeometry, texRunnerFromEnvironment, validateTexInput, type TexRunnerInput } from './tex-runner.ts';

const geometry = JSON.stringify({ pages: [{ object: '3 0 R' }], qpdf: [{}, { 'obj:3 0 R': { value: { '/Type': '/Page', '/MediaBox': [0, 0, 612, 792] } } }] });
const files: SourceFile[] = [{ path: 'paper/main.tex', content: '\\documentclass{article}\n\\begin{document}Hello\\end{document}\n' }];
function input(source: SourceFile[] = files, entrypoint = source[0]!.path): TexRunnerInput {
  return { revisionId: 'R1', versionId: 'version-1', contentHash: createHash('sha256').update(JSON.stringify([...source].sort((a, b) => a.path < b.path ? -1 : 1).map(({ path, content }) => ({ path, content })))).digest('hex'), files: source, entrypoint };
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
