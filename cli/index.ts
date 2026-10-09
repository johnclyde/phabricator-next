#!/usr/bin/env node
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { analyzeLocally } from '../shared/review';
import type { AppState, RevisionDetail, RevisionKind, SourceFile } from '../shared/types';

const help = `Phabricator Next — arc (initial CLI)

  npm run arc -- check [--kind paper|document|code] FILE... [--json]
  npm run arc -- diff --title "Title" --kind paper FILE...
  npm run arc -- diff --revision P2 --message "Changes" FILE...
  npm run arc -- list
  npm run arc -- show P2
  npm run arc -- review P2 [--provider local|openai|ollama]
  npm run arc -- export P2 [--version 1]

check is fully offline and never executes source. diff uploads an explicit list
of text files as a complete snapshot; omitted files are removed in that version.
export writes a JSON snapshot to stdout. --server defaults to
http://127.0.0.1:4310 (or PHABRICATOR_URL). Hosted review is always explicit.
This is not a drop-in Arcanist replacement; Git landing/patching is planned.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, strict: true,
    options: {
      kind: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' },
      revision: { type: 'string' }, message: { type: 'string' }, provider: { type: 'string', default: 'local' },
      server: { type: 'string', default: process.env.PHABRICATOR_URL || 'http://127.0.0.1:4310' },
      version: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command || command === 'help') return console.log(help);
  const server = new URL(values.server!);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password) throw new Error('Provide an HTTP(S) server URL without embedded credentials.');
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(new URL(path, server), {
      method, signal: AbortSignal.timeout(135_000), redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(value.error || `Server returned HTTP ${response.status}`);
    return value;
  };
  const kind = values.kind || 'code';
  if (!['code', 'paper', 'document'].includes(kind)) throw new Error('--kind must be code, paper or document.');
  const getDetail = (id: string | undefined) => {
    if (!id || !/^[DPL]\d+$/.test(id)) throw new Error('Provide a revision ID such as D1, P2 or L3.');
    return request<RevisionDetail>(`/api/revisions/${id}`);
  };
  if (command === 'check') {
    const files = await readSources(args);
    const review = analyzeLocally(kind as RevisionKind, files);
    if (values.json) console.log(JSON.stringify(review, null, 2));
    else {
      console.log(review.summary);
      for (const finding of review.findings) console.log(`${finding.filePath}:${finding.line} [${finding.severity}] ${finding.title}\n  ${finding.body}`);
    }
    if (review.findings.some(finding => finding.severity === 'error')) process.exitCode = 1;
    return;
  }
  if (command === 'diff') {
    const files = await readSources(args);
    let detail: RevisionDetail;
    if (values.revision) {
      const existing = await getDetail(values.revision);
      detail = await request<RevisionDetail>(`/api/revisions/${existing.revision.id}/versions`, 'POST', {
        files, message: values.message || 'Updated via arc', expectedVersion: existing.revision.currentVersion,
      });
    } else {
      if (!values.title?.trim()) throw new Error('--title is required for a new revision.');
      detail = await request<RevisionDetail>('/api/revisions', 'POST', { title: values.title, summary: values.summary || '', kind, files });
    }
    console.log(`${detail.revision.id} · v${detail.revision.currentVersion} · ${detail.revision.title}`);
    console.log(new URL(`/#${detail.revision.id}`, server).href);
    return;
  }
  if (command === 'list') {
    const state = await request<AppState>('/api/state');
    for (const revision of state.revisions) console.log(`${revision.id}\tv${revision.currentVersion}\t${revision.status}\t${revision.title}`);
    return;
  }
  if (command === 'show') return console.log(JSON.stringify(await getDetail(args[0]), null, 2));
  if (command === 'review') {
    if (!['local', 'openai', 'ollama'].includes(values.provider!)) throw new Error('--provider must be local, openai or ollama.');
    const detail = await getDetail(args[0]);
    const review = await request(`/api/revisions/${detail.revision.id}/reviews`, 'POST', { provider: values.provider, expectedVersion: detail.revision.currentVersion });
    return console.log(JSON.stringify(review, null, 2));
  }
  if (command === 'export') {
    const detail = await getDetail(args[0]);
    const number = values.version ? Number(values.version) : detail.revision.currentVersion;
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('--version must be a positive integer.');
    return console.log(JSON.stringify(await request(`/api/revisions/${detail.revision.id}/export?version=${number}`), null, 2));
  }
  throw new Error(`Unknown command: ${command}. Run npm run arc -- --help.`);
}

async function readSources(paths: string[]): Promise<SourceFile[]> {
  if (paths.length === 0 || paths.length > 50) throw new Error('Provide between 1 and 50 explicit text file paths.');
  const workingDirectory = process.cwd();
  const sourceRoot = await realpath(workingDirectory);
  const seen = new Set<string>();
  let size = 0;
  const files: SourceFile[] = [];
  for (const path of paths) {
    const absolute = resolve(path);
    const localPath = relative(workingDirectory, absolute);
    const name = localPath.split(sep).join('/');
    if (!name || localPath === '..' || name.startsWith('../') || isAbsolute(localPath) || seen.has(name)) throw new Error('Files must have unique paths within the current directory.');
    if (name.length > 240 || /[\x00-\x1f:\\]/.test(name)) throw new Error('Source paths must be at most 240 characters and contain no control characters, colons, or backslashes.');
    const forbidden = (filePath: string) => filePath.split(sep).some(part => part === '.env' || part.startsWith('.env.') || ['.git', '.ssh', '.aws'].includes(part));
    if (forbidden(absolute)) throw new Error('Credential files and private configuration directories cannot be submitted by arc.');
    seen.add(name);
    // Refuse symlinks at every component: a harmless-looking alias must never
    // bypass the explicit file boundary or credential-name exclusions.
    let component = sourceRoot;
    for (const part of localPath.split(sep)) {
      component = resolve(component, part);
      if ((await lstat(component)).isSymbolicLink()) throw new Error(`Symbolic links cannot be submitted by arc: ${name}.`);
    }
    const canonical = await realpath(absolute);
    const canonicalRelative = relative(sourceRoot, canonical);
    if (!canonicalRelative || canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative) || forbidden(canonical)) throw new Error('Source files must remain within the current directory and outside private configuration directories.');
    const expected = await lstat(canonical);
    if (!expected.isFile() || expected.size > 500_000) throw new Error(`${name} is not a text file under 500 KB.`);
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size > 500_000) throw new Error(`${name} changed while being read. Retry with a stable source file.`);
      // Bound the read even if another process grows the file after stat().
      const buffer = Buffer.alloc(500_001);
      let read = 0;
      while (read < buffer.length) {
        const result = await handle.read(buffer, read, buffer.length - read, read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      if (read > 500_000) throw new Error(`${name} exceeds 500 KB.`);
      bytes = buffer.subarray(0, read);
    } finally { await handle.close(); }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.includes('\0')) throw new Error(`${name} contains binary content.`);
    size += bytes.length;
    if (size > 1_000_000) throw new Error('Snapshot exceeds 1 MB.');
    files.push({ path: name, content });
  }
  return files;
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed.'); process.exitCode = 1; });
