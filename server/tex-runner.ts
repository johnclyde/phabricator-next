import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { SourceFile } from '../shared/types.ts';
import type { RevisionAsset } from '../shared/files.ts';
import { sourceSnapshotCanonical, validateSourceSnapshot } from '../shared/source-snapshot.ts';
import { inspectFileMedia } from './files.ts';

export const TEX_RUNNER_POLICY_VERSION = 'tex-container-v1';
export const TEX_BUNDLE_SHA256 = 'b99f6292ac4ac5ef74566f7ba044491adbf67096f4b020855a6de0ad192d32f8';
export interface TexToolchain { engine: string; image: string; bundle: string }
export interface TexRunnerInput { revisionId: string; versionId: string; contentHash: string; files: SourceFile[]; assets?: (RevisionAsset & { data: Uint8Array })[]; entrypoint: string }
export interface TexDiagnostic { severity: 'error' | 'warning' | 'info'; message: string; path?: string; line?: number }
export interface TexArtifact { kind: 'pdf' | 'log' | 'manifest' | 'synctex' | 'mapping'; name: string; mediaType: string; data: Uint8Array }
export interface TexRunnerResult { success: boolean; artifacts: TexArtifact[]; diagnostics: TexDiagnostic[]; error: string | null }
export interface TexRunner { toolchain: TexToolchain; run(input: TexRunnerInput, signal: AbortSignal): Promise<TexRunnerResult> }
export interface TexRunnerConfig { image: string; dockerSocket: string; workDir?: string }
export interface TexMapping { origin: 'top-left'; units: 'pt'; pages: { page: number; width: number; height: number }[]; points: { path: string; line: number; page: number; x: number; y: number; width: number; height: number }[] }

const MAX_LOG = 524_288;
const MAX_ARCHIVE = 24 * 1024 * 1024;
const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const abortError = () => new DOMException('Paper compilation canceled.', 'AbortError');

export function texRunnerFromEnvironment(env: NodeJS.ProcessEnv = process.env): TexRunner | null {
  if (!env.PHABRICATOR_TEX_IMAGE && !env.PHABRICATOR_TEX_DOCKER_SOCKET) return null;
  return createTexRunner({ image: env.PHABRICATOR_TEX_IMAGE ?? '', dockerSocket: env.PHABRICATOR_TEX_DOCKER_SOCKET ?? '', workDir: env.PHABRICATOR_TEX_WORK_DIR });
}

/** Only local Unix sockets are accepted. Docker credentials, remote contexts and pull operations are not inherited. */
export function createTexRunner(config: TexRunnerConfig): TexRunner {
  if (!/^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(config.image)) throw new Error('Paper compiler image must be pinned by its SHA-256 digest.');
  if (!isAbsolute(config.dockerSocket) || config.dockerSocket.includes('\0')) throw new Error('Paper compiler requires an absolute local Docker Unix socket path.');
  const workDir = resolve(config.workDir ?? '.data/tex-worker');
  if (workDir.includes(',') || workDir.includes('\0')) throw new Error('Compiler work directory must be a safe local mount path.');
  const toolchain = Object.freeze({ engine: 'Tectonic 0.17.0', image: config.image, bundle: `sha256:${TEX_BUNDLE_SHA256}` });
  const docker = (args: string[], limit: number, signal?: AbortSignal, timeout = 15_000) => executeDocker(config.dockerSocket, args, limit, signal, timeout);
  return { toolchain, async run(input, signal) {
    validateTexInput(input);
    // Retain an owned snapshot across asynchronous runtime checks and filesystem writes.
    input = { ...input, files: input.files.map(file => ({ ...file })), ...(input.assets ? { assets: input.assets.map(asset => ({ ...asset, data: Uint8Array.from(asset.data) })) } : {}) };
    validateTexInput(input);
    if (signal.aborted) throw abortError();
    let directory: string | undefined;
    const container = `phab-tex-${randomUUID()}`;
    let output: { stdout: Buffer; stderr: Buffer; code: number | null } | undefined;
    let log = '';
    try {
      if (!(await lstat(config.dockerSocket)).isSocket()) throw new Error('The configured local Docker socket is unavailable.');
      const info = await docker(['info', '--format', '{{json .}}'], 256_000, signal);
      if (info.code !== 0) throw new Error('The local Docker compiler runtime is unavailable.');
      const host = JSON.parse(info.stdout.toString()) as Record<string, unknown>;
      if (host.OSType !== 'linux' || host.MemoryLimit !== true || host.SwapLimit !== true || host.CpuCfsQuota !== true || host.PidsLimit !== true
        || !Array.isArray(host.SecurityOptions) || !host.SecurityOptions.some(option => typeof option === 'string' && option.startsWith('name=seccomp'))) throw new Error('The compiler runtime does not enforce the required Linux resource and syscall limits.');
      const inspection = await docker(['image', 'inspect', config.image, '--format', '{{json .Config.Labels}}'], 64_000, signal);
      if (inspection.code !== 0) throw new Error('The pinned compiler image is not installed locally.');
      const labels = JSON.parse(inspection.stdout.toString()) as Record<string, string> | null;
      if (labels?.['org.phabricator.tex.engine'] !== toolchain.engine || labels?.['org.phabricator.tex.policy'] !== TEX_RUNNER_POLICY_VERSION
        || labels?.['org.phabricator.tex.bundle'] !== TEX_BUNDLE_SHA256) throw new Error('The installed compiler image does not match the required toolchain and isolation policy.');
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      if ((await lstat(workDir)).isSymbolicLink() || await realpath(workDir) !== workDir) throw new Error('Compiler work directory must not contain symbolic links.');
      directory = await mkdtemp(join(workDir, 'compile-'));
      const source = join(directory, 'source');
      await mkdir(source, { mode: 0o755 });
      for (const file of input.files) {
        await mkdir(dirname(join(source, file.path)), { recursive: true, mode: 0o755 });
        await writeFile(join(source, file.path), file.content, { encoding: 'utf8', mode: 0o444, flag: 'wx' });
        await chmod(join(source, file.path), 0o444);
        await utimes(join(source, file.path), 946684800, 946684800);
      }
      for (const asset of input.assets ?? []) {
        await mkdir(dirname(join(source, asset.path)), { recursive: true, mode: 0o755 });
        await writeFile(join(source, asset.path), asset.data, { mode: 0o444, flag: 'wx' });
        await chmod(join(source, asset.path), 0o444);
        await utimes(join(source, asset.path), 946684800, 946684800);
      }
      const sourceDirectories = new Set([source]);
      for (const file of [...input.files, ...(input.assets ?? [])]) { let parent = dirname(join(source, file.path)); while (parent.startsWith(`${source}/`)) { sourceDirectories.add(parent); parent = dirname(parent); } }
      // A restrictive service umask must not prevent the container's unprivileged UID
      // from reading its source mount. The enclosing work directory stays private.
      for (const path of sourceDirectories) { await chmod(path, 0o755); await utimes(path, 946684800, 946684800); }
      // The mount is read-only in the container; the enclosing temporary directory remains private on the host.
      await chmod(directory, 0o755);
      output = await docker(['run', '--rm', '--pull=never', '--name', container, '--label', `org.phabricator.tex.version=${input.versionId}`, '--network=none', '--ipc=none', '--read-only',
        '--user', '65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--cpus=1',
        '--memory=768m', '--memory-swap=768m', '--ulimit', 'nofile=128:128', '--ulimit', 'fsize=16777216:16777216',
        '--log-driver=none', '--tmpfs', '/work:rw,noexec,nosuid,nodev,size=134217728,mode=1777',
        '--mount', `type=bind,source=${source},target=/source,readonly`, '--workdir=/source', '--entrypoint=/opt/compile.sh',
        config.image, input.entrypoint], MAX_ARCHIVE, signal, 75_000);
      const entries = parseTexArchive(output.stdout);
      log = normalizeTexLog((entries.get('compiler.log') ?? output.stderr).subarray(0, MAX_LOG).toString('utf8'));
      while (Buffer.byteLength(log) > MAX_LOG) log = log.slice(0, -1);
      const diagnostics = parseTexDiagnostics(log, input.files, input.entrypoint);
      const status = entries.get('status')?.toString('utf8').trim();
      if (output.code !== 0 || status !== '0') {
        const error = status === '137' || output.code === 137 ? 'Compilation exceeded its time or memory limit.' : 'TeX compilation failed. See the compiler diagnostics.';
        return failed(error, log, diagnostics);
      }
      const pdf = entries.get('result.pdf');
      const synctex = entries.get('result.synctex.gz');
      if (!pdf?.subarray(0, 5).equals(Buffer.from('%PDF-')) || !synctex || pdf.length > 16 * 1024 * 1024 || synctex.length > 4 * 1024 * 1024) throw new Error('Compiler output is missing, malformed, or exceeds the artifact limits.');
      const mapping = parseTexMapping(synctex, entries.get('pages.json')?.toString('utf8') ?? '', input.files);
      const artifacts: TexArtifact[] = [
        { kind: 'pdf', name: 'paper.pdf', mediaType: 'application/pdf', data: pdf },
        { kind: 'synctex', name: 'paper.synctex.gz', mediaType: 'application/gzip', data: synctex },
        { kind: 'mapping', name: 'source-map.json', mediaType: 'application/json', data: Buffer.from(JSON.stringify(mapping)) },
        { kind: 'log', name: 'compiler.log', mediaType: 'text/plain; charset=utf-8', data: Buffer.from(log) },
      ];
      const manifest = { schema: input.assets?.length ? 2 : 1, revisionId: input.revisionId, versionId: input.versionId, contentHash: input.contentHash, entrypoint: input.entrypoint, toolchain,
        files: [...input.files].sort((a, b) => a.path < b.path ? -1 : 1).map(file => ({ path: file.path, sha256: digest(file.content), bytes: Buffer.byteLength(file.content) })),
        ...(input.assets?.length ? { assets: [...input.assets].sort((a, b) => a.path < b.path ? -1 : 1).map(({ path, fileId, sha256, bytes, mediaType }) => ({ path, fileId, sha256, bytes, mediaType })) } : {}),
        artifacts: [...artifacts].sort((a, b) => a.kind < b.kind ? -1 : 1).map(artifact => ({ kind: artifact.kind, sha256: digest(artifact.data), bytes: artifact.data.length })) };
      artifacts.push({ kind: 'manifest', name: 'manifest.json', mediaType: 'application/json', data: Buffer.from(JSON.stringify(manifest)) });
      return { success: true, artifacts, diagnostics, error: null };
    } catch (error) {
      if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') throw abortError();
      const message = error instanceof Error ? error.message : 'The isolated compiler could not complete this build.';
      return failed(message, log, []);
    } finally {
      // Killing the CLI alone does not kill its container. The inner timeout also bounds orphaned runs if this process crashes.
      await docker(['rm', '--force', container], 64_000, undefined, 10_000).catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  } };
}

function failed(error: string, log: string, diagnostics: TexDiagnostic[]): TexRunnerResult {
  return { success: false, error, diagnostics: diagnostics.length ? diagnostics : [{ severity: 'error', message: error }],
    artifacts: [{ kind: 'log', name: 'compiler.log', mediaType: 'text/plain; charset=utf-8', data: Buffer.from(log || error) }] };
}

export function validateTexInput(input: TexRunnerInput): void {
  if (!input.revisionId || !input.versionId || input.revisionId.length > 240 || input.versionId.length > 240 || !/^[a-f0-9]{64}$/.test(input.contentHash)) throw new Error('An exact immutable source version is required.');
  if (input.files.length < 1 || input.files.length > 100) throw new Error('Provide between 1 and 100 source files.');
  validateSourceSnapshot(input.files, input.assets);
  const names = new Set<string>();
  let bytes = 0;
  for (const file of input.files) {
    if (file.content.includes('\0') || file.content.length > 500_000 || Buffer.from(file.content).toString('utf8') !== file.content) throw new Error('Source files must contain bounded valid UTF-8 text.');
    names.add(file.path); bytes += Buffer.byteLength(file.content);
  }
  if (bytes > 1_500_000 || !names.has(input.entrypoint) || !input.entrypoint.endsWith('.tex')) throw new Error('Select an existing .tex entrypoint within the bounded source snapshot.');
  for (const asset of input.assets ?? []) {
    if (!(asset.data instanceof Uint8Array) || asset.data.byteLength !== asset.bytes || digest(asset.data) !== asset.sha256
      || inspectFileMedia(asset.data).mediaType !== asset.mediaType) throw new Error('Binary asset bytes do not match their immutable identity and media type.');
  }
  if (digest(sourceSnapshotCanonical(input.files, input.assets)) !== input.contentHash) throw new Error('Source content does not match the immutable version digest.');
}

function executeDocker(socket: string, args: string[], maxBytes: number, signal?: AbortSignal, timeoutMs = 15_000): Promise<{ stdout: Buffer; stderr: Buffer; code: number | null }> {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    // Never inherit credential helpers, remote DOCKER_HOST/context, or arbitrary Docker options.
    const child = spawn('docker', ['--host', `unix://${socket}`, ...args], { env: { PATH: process.env.PATH, HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let total = 0, failure: Error | undefined;
    const terminate = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const onAbort = () => terminate(abortError());
    const timer = setTimeout(() => terminate(new Error('The isolated compiler exceeded its operation deadline.')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (target: Buffer[], part: Buffer) => { total += part.length; if (total > maxBytes) terminate(new Error('The isolated compiler exceeded its output limit.')); else target.push(part); };
    child.stdout.on('data', (part: Buffer) => collect(stdout, part));
    child.stderr.on('data', (part: Buffer) => collect(stderr, part));
    child.on('error', error => { failure = error; });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (failure) reject(failure); else resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code }); });
  });
}

/** Parse only the fixed ordinary-file transport, never extract a compiler-controlled archive to disk. */
export function parseTexArchive(archive: Uint8Array): Map<string, Buffer> {
  const buffer = Buffer.from(archive), entries = new Map<string, Buffer>();
  const allowed = new Map([['compiler.log', MAX_LOG + 4096], ['status', 16], ['result.pdf', 16 * 1024 * 1024], ['result.synctex.gz', 4 * 1024 * 1024], ['pages.json', 4 * 1024 * 1024]]);
  if (buffer.length > MAX_ARCHIVE || buffer.length % 512 !== 0) throw new Error('Compiler archive exceeds the output limit or is truncated.');
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim();
    const sumText = header.subarray(148, 156).toString('ascii').replace(/\0.*$/s, '').trim();
    if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(sumText)) throw new Error('Malformed compiler archive.');
    const size = Number.parseInt(sizeText, 8), checksum = Number.parseInt(sumText, 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (actual !== checksum || ![0, 48].includes(header[156]!) || header.subarray(157, 257).some(byte => byte !== 0) || header.subarray(345, 500).some(byte => byte !== 0)
      || !allowed.has(name) || entries.has(name) || size > allowed.get(name)! || offset + 512 + size > buffer.length) throw new Error('Unsafe or malformed compiler archive entry.');
    entries.set(name, buffer.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function parseTexDiagnostics(log: string, files: SourceFile[], entrypoint: string): TexDiagnostic[] {
  const paths = new Map(files.map(file => [file.path, file.content.split('\n').length]));
  const result: TexDiagnostic[] = [];
  for (const raw of log.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const match = /^(error|warning): (?:(.*?):([0-9]+): )?(.*)$/.exec(line);
    if (!match) continue;
    const path = match[2]?.replace(/^\/source\//, '') ?? entrypoint;
    const sourceLine = Number(match[3]);
    result.push({ severity: match[1] as 'error' | 'warning', message: match[4]!.slice(0, 2000),
      ...(paths.has(path) && sourceLine > 0 && sourceLine <= paths.get(path)! ? { path, line: sourceLine } : {}) });
    if (result.length >= 100) break;
  }
  return result;
}

/** Tectonic iterates a hash map when reporting saved artifacts. Only those consecutive progress lines are sorted. */
export function normalizeTexLog(log: string): string {
  return log.replace(/(?:^note: Writing `[^\n]+\n)+/gm, group => group.trimEnd().split('\n').sort().join('\n') + '\n');
}

/** qpdf emits structured page objects, so PDF title metadata cannot impersonate geometry. */
export function parseTexPageGeometry(text: string): TexMapping['pages'] {
  const document = JSON.parse(text) as { pages?: { object?: unknown }[]; qpdf?: unknown[] };
  if (!Array.isArray(document.pages) || document.pages.length < 1 || document.pages.length > 1000 || !Array.isArray(document.qpdf)) throw new Error('Invalid PDF page count.');
  const objects = document.qpdf[1] as Record<string, { value?: unknown }> | undefined;
  if (!objects || typeof objects !== 'object') throw new Error('Invalid PDF page objects.');
  const dereference = (value: unknown): unknown => typeof value === 'string' && /^\d+ \d+ R$/.test(value) ? objects[`obj:${value}`]?.value : value;
  const result: TexMapping['pages'] = [];
  for (let index = 0; index < document.pages.length; index++) {
    let node = dereference(document.pages[index]!.object) as Record<string, unknown> | undefined;
    if (!node || typeof node !== 'object' || node['/Type'] !== '/Page') throw new Error('Invalid PDF page object.');
    const inherited: Record<string, unknown> = {};
    const seen = new Set<unknown>();
    const userUnit = dereference(node['/UserUnit']) ?? 1;
    while (node) {
      if (seen.has(node) || seen.size > 64) throw new Error('Invalid PDF page ancestry.');
      seen.add(node);
      for (const key of ['/MediaBox', '/CropBox', '/Rotate']) if (!(key in inherited) && key in node) inherited[key] = dereference(node[key]);
      if (!node['/Parent']) break;
      node = dereference(node['/Parent']) as Record<string, unknown> | undefined;
      if (!node || typeof node !== 'object') throw new Error('Invalid PDF page ancestry.');
    }
    const media = inherited['/MediaBox'], crop = inherited['/CropBox'] ?? media;
    if (!Array.isArray(media) || media.length !== 4 || !media.every(n => typeof n === 'number' && Number.isFinite(n))
      || !Array.isArray(crop) || crop.length !== 4 || !crop.every((n, position) => n === media[position])
      || media[0] !== 0 || media[1] !== 0 || media[2] <= 0 || media[3] <= 0 || media[2] > 14_400 || media[3] > 14_400
      || (inherited['/Rotate'] ?? 0) !== 0 || userUnit !== 1) throw new Error('Source navigation currently requires unrotated, uncropped PDF pages with standard point units.');
    result.push({ page: index + 1, width: media[2] as number, height: media[3] as number });
  }
  return result;
}

export function parseTexMapping(compressed: Uint8Array, pdfGeometry: string, files: SourceFile[]): TexMapping {
  const text = gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8');
  const pages = parseTexPageGeometry(pdfGeometry);
  const magnification = Number(/^Magnification:(\d+)$/m.exec(text)?.[1]);
  const unit = Number(/^Unit:(\d+)$/m.exec(text)?.[1]);
  const xOffset = Number(/^X Offset:(-?\d+)$/m.exec(text)?.[1]);
  const yOffset = Number(/^Y Offset:(-?\d+)$/m.exec(text)?.[1]);
  if (![magnification, unit, xOffset, yOffset].every(Number.isFinite) || magnification <= 0 || unit <= 0) throw new Error('Invalid SyncTeX coordinate units.');
  const factor = unit * magnification / 1000 / 65781.76;
  const lines = new Map(files.map(file => [file.path, file.content.split('\n').length]));
  const sources = new Map<number, string>();
  let inputRecords = 0;
  for (const match of text.matchAll(/^Input:(\d+):(.+)$/gm)) {
    if (++inputRecords > 10_000) throw new Error('SyncTeX input table exceeds its limit.');
    const absolute = posix.normalize(match[2]!);
    const path = absolute.startsWith('/source/') ? absolute.slice(8) : absolute.replace(/^\.\//, '');
    if (lines.has(path)) sources.set(Number(match[1]), path);
  }
  const points: TexMapping['points'] = [];
  let page = 0, records = 0;
  for (const record of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (++records > 500_000) throw new Error('SyncTeX record count exceeds its limit.');
    const line = record[0].replace(/\n$/, '');
    const sheet = /^\{(\d+)$/.exec(line);
    if (sheet) { page = Number(sheet[1]); continue; }
    if (line === '}') { page = 0; continue; }
    // Boxes, rules and kerns carry source locations; all numbers are checked before publication.
    const match = /^[\[(rkhgvx$](\d+),(\d+)(?:,\d+)?:([-\d]+),([-\d]+)(?::([-\d]+)(?:,([-\d]+),([-\d]+))?)?$/.exec(line);
    if (!match || !pages[page - 1]) continue;
    const path = sources.get(Number(match[1])), sourceLine = Number(match[2]);
    if (!path || sourceLine < 1 || sourceLine > lines.get(path)!) continue;
    const sheetInfo = pages[page - 1]!;
    const rawX = (Number(match[3]) * unit + xOffset) * magnification / 1000 / 65781.76;
    const baseline = (Number(match[4]) * unit + yOffset) * magnification / 1000 / 65781.76;
    const width = Math.max(0, Number(match[5] ?? 0) * factor), ascent = Math.max(0, Number(match[6] ?? 0) * factor), depth = Math.max(0, Number(match[7] ?? 0) * factor);
    if (![rawX, baseline, width, ascent, depth].every(Number.isFinite)) continue;
    const x = Math.max(0, Math.min(sheetInfo.width, rawX)), y = Math.max(0, Math.min(sheetInfo.height, baseline - ascent));
    points.push({ path, line: sourceLine, page, x, y, width: Math.min(width, sheetInfo.width - x), height: Math.min(ascent + depth, sheetInfo.height - y) });
    if (points.length > 100_000) throw new Error('SyncTeX mapping exceeds the location limit.');
  }
  return { origin: 'top-left', units: 'pt', pages, points };
}
