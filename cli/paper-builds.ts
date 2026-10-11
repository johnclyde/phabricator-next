import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { PaperArtifactKind, PaperBuild, PaperBuildDetail, PaperBuildInput, PaperBuildPage } from '../shared/paper-builds';

const commands = new Set(['compile', 'builds', 'build', 'cancel-build', 'retry-build', 'download-build']);
const kinds: PaperArtifactKind[] = ['pdf', 'log', 'manifest', 'synctex', 'mapping'];
const safe = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
type Options = Record<string, string | boolean | string[] | undefined>;
export interface PaperCLI {
  command: string;
  args: string[];
  options: Options;
  optionNames: string[];
  request: <T>(path: string, method?: string, body?: unknown, requestId?: string) => Promise<T>;
  download: (path: string, maxBytes: number) => Promise<Uint8Array>;
}
function textOption(options: Options, key: string): string | undefined { const value = options[key]; return typeof value === 'string' ? value : undefined; }
function positive(value: string | undefined, name: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return;
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number) || number > max) throw new Error(`--${name} must be an integer from 1 to ${max}.`);
  return number;
}
function sameSource(build: PaperBuild, revisionId: string, input: PaperBuildInput): boolean {
  return build.revisionId === revisionId && build.versionId === input.versionId && build.contentHash === input.contentHash && build.entrypoint === input.entrypoint && build.toolchainId === input.toolchainId;
}
function printBuild(build: PaperBuild, json: boolean): void {
  if (json) { console.log(JSON.stringify(build, null, 2)); return; }
  console.log(`${safe(build.id)}\t${safe(build.revisionId)} v${build.versionNumber}\t${safe(build.status)}\t${safe(build.entrypoint)}`);
  console.log(`Source: ${safe(build.versionId)} ${safe(build.contentHash)}\nToolchain: ${safe(build.toolchainId)}`);
  if (build.error) console.log(safe(build.error));
  for (const diagnostic of build.diagnostics) console.log(`[${safe(diagnostic.severity)}] ${diagnostic.path ? `${safe(diagnostic.path)}${diagnostic.line ? `:${diagnostic.line}` : ''}: ` : ''}${safe(diagnostic.message)}`);
}

/** Returns false for unrelated commands; validates the complete intent before making a request. */
export async function paperCommand({ command, args, options, optionNames, request, download }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const allowed = new Set(['server', 'json', 'help', ...(command === 'compile' ? ['version-id', 'content-hash', 'entrypoint', 'toolchain-id', 'request-id'] : command === 'builds' ? ['before', 'limit'] : command === 'download-build' ? ['artifact', 'output'] : command === 'cancel-build' || command === 'retry-build' ? ['request-id'] : [])]);
  if (optionNames.some(name => !allowed.has(name))) throw new Error(`${command} received an unsupported option. Use --help for its exact arguments.`);
  const [revisionId, buildId] = args;
  const individual = !['compile', 'builds'].includes(command);
  if (!revisionId || !/^P[1-9]\d{0,14}$/.test(revisionId) || args.length !== (individual ? 2 : 1)) throw new Error(`Provide one paper revision ID such as P2${individual ? ' and its build ID' : ''}.`);
  if (individual && (!buildId || !/^[A-Za-z0-9_-]{1,100}$/.test(buildId))) throw new Error('Provide the exact build ID returned by compile or builds.');
  const root = `/api/revisions/${revisionId}/paper-builds`;
  const path = individual ? `${root}/${buildId}` : root;
  const json = options.json === true;
  if (command === 'builds') {
    const before = positive(textOption(options, 'before'), 'before'); const limit = positive(textOption(options, 'limit'), 'limit', 100);
    const query = new URLSearchParams(); if (before !== undefined) query.set('before', String(before)); if (limit !== undefined) query.set('limit', String(limit));
    const page = await request<PaperBuildPage>(`${root}${query.size ? `?${query}` : ''}`);
    if (json) console.log(JSON.stringify(page, null, 2));
    else {
      console.log(page.configuration.available ? `Toolchain: ${safe(page.configuration.toolchainId || '')}` : `Compilation unavailable: ${safe(page.configuration.reason || 'The operator has not configured an isolated worker.')}`);
      for (const build of page.builds) console.log(`${safe(build.id)}\t${revisionId} v${build.versionNumber}\t${safe(build.status)}\t${safe(build.entrypoint)}`);
      if (page.nextBefore !== null) console.log(`More builds: --before ${page.nextBefore}`);
    }
    return true;
  }
  if (command === 'build') {
    const detail = await request<PaperBuildDetail>(path);
    if (detail.build.id !== buildId || detail.build.revisionId !== revisionId) throw new Error('The build response does not match the requested paper and build.');
    printBuild(detail.build, json); return true;
  }
  if (command === 'download-build') {
    const kind = textOption(options, 'artifact') as PaperArtifactKind | undefined; const output = textOption(options, 'output');
    if (!kind || !kinds.includes(kind) || !output || output === '-') throw new Error('--artifact must be pdf, log, manifest, synctex, or mapping; --output must name a new file. Binary data is never printed to the terminal.');
    const { build } = await request<PaperBuildDetail>(path);
    if (build.id !== buildId || build.revisionId !== revisionId) throw new Error('The build response does not match the requested paper and build.');
    const artifact = build.artifacts.find(item => item.kind === kind);
    if (!artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > 32 * 1024 * 1024 || (kind === 'pdf' && build.status !== 'succeeded')) throw new Error('The requested artifact is unavailable or exceeds the download limit.');
    const bytes = await download(`${path}/artifacts/${kind}`, artifact.bytes);
    if (bytes.byteLength !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Artifact size or SHA-256 differs from its immutable build metadata. No output file was written.');
    // Exclusive create refuses existing files and symlinks; server-supplied names never choose a local path.
    const handle = await open(output, 'wx', 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    const receipt = { revisionId, buildId, kind, output, bytes: artifact.bytes, sha256: artifact.sha256 };
    console.log(json ? JSON.stringify(receipt, null, 2) : `Saved ${safe(kind)} to ${safe(output)} (${artifact.bytes} bytes, SHA-256 ${artifact.sha256}).`);
    return true;
  }
  const requestId = textOption(options, 'request-id') ?? randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('--request-id must contain 1–200 letters, numbers, dots, underscores, colons, or hyphens.');
  let input: PaperBuildInput | Record<string, never> = {};
  if (command === 'compile') {
    const versionId = textOption(options, 'version-id'); const contentHash = textOption(options, 'content-hash'); const entrypoint = textOption(options, 'entrypoint'); const toolchainId = textOption(options, 'toolchain-id');
    if (!versionId || !/^[A-Za-z0-9_-]{1,100}$/.test(versionId) || !contentHash || !/^[a-f0-9]{64}$/.test(contentHash) || !toolchainId || !/^[a-f0-9]{64}$/.test(toolchainId)) throw new Error('--version-id, --content-hash and --toolchain-id are required exact pins. Read them from export and builds; compile never selects a newer version or toolchain.');
    if (!entrypoint || entrypoint.length > 240 || !entrypoint.endsWith('.tex') || /[\u0000-\u001f\u007f-\u009f:\\]/.test(entrypoint) || entrypoint.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('--entrypoint must be a relative .tex source path within the saved snapshot.');
    input = { versionId, contentHash, entrypoint, toolchainId };
  }
  const mutationPath = command === 'compile' ? root : `${path}/${command === 'cancel-build' ? 'cancel' : 'retry'}`;
  const original = command === 'retry-build' ? (await request<PaperBuildDetail>(path)).build : undefined;
  if (original && (original.id !== buildId || original.revisionId !== revisionId)) throw new Error('The build response does not match the requested paper and build.');
  console.error(`Paper build request: ${JSON.stringify({ path: mutationPath, requestId, body: input })}. Keep these exact inputs and request ID when retrying an uncertain result.`);
  const build = await request<PaperBuild>(mutationPath, 'POST', input, requestId);
  if (build.revisionId !== revisionId || (command === 'compile' && !sameSource(build, revisionId, input as PaperBuildInput)) || (command === 'cancel-build' && build.id !== buildId) || (original && (build.id === original.id || !sameSource(build, revisionId, original)))) throw new Error('The saved receipt does not match the requested paper build. Retain the request ID and inspect the result before submitting another request.');
  printBuild(build, json); return true;
}
