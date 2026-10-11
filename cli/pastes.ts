import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { PaperCLI } from './paper-builds';
import { PASTE_MAX_BYTES, PASTE_MAX_COMMENT, PASTE_MAX_LANGUAGE, PASTE_MAX_TITLE, validatePasteContent, type CreatePasteInput, type PasteDetail, type PasteHistory, type PastePage, type PasteRecord, type PasteTransaction, type PasteVersion, type PasteVersionsPage, type UpdatePasteInput } from '../shared/pastes';

const commands = new Set(['pastes', 'paste', 'create-paste', 'edit-paste', 'paste-version', 'paste-versions', 'paste-history', 'comment-paste', 'archive-paste', 'download-paste']);
const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
async function readText(path: string, maximum: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > maximum) throw new Error(`Choose a regular UTF-8 input file of at most ${maximum} bytes.`);
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, null); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length > maximum) throw new Error('Input grew beyond its byte limit.');
    // ignoreBOM preserves U+FEFF instead of silently stripping an initial BOM.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}
function text(value: string, name: string, maximum: number): string {
  if (value.length > maximum || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) throw new Error(`${name} must be valid text of at most ${maximum} characters without NUL.`);
  return value;
}
function record(value: PasteRecord, id?: string): void {
  if (!value || !/^PA[1-9]\d{0,14}$/.test(value.id) || id !== undefined && value.id !== id || !/^[a-f0-9]{64}$/.test(value.contentHash)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > PASTE_MAX_BYTES || !Number.isSafeInteger(value.version) || value.version < 1 || !Number.isSafeInteger(value.contentVersion) || value.contentVersion < 1 || value.contentVersion > value.version) throw new Error('The Paste receipt does not identify a bounded immutable content version. Keep the request ID.');
}
function version(value: PasteVersion, id: string, number: number): void {
  if (!value || value.pasteId !== id || value.number !== number || typeof value.content !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('The Paste content belongs to a different version.');
  const checked = validatePasteContent(value.content);
  if (checked.bytes !== value.bytes || checked.lineCount !== value.lineCount || digest(value.content) !== value.sha256) throw new Error('The Paste content does not match its immutable hash, byte length, or line count.');
}

/** Explicit file inputs and exact versions keep uncertain retries reproducible. */
export async function pasteCommand({ command, args, options, optionNames, request, download }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const extras: Record<string, string[]> = {
    pastes: ['query', 'author', 'language', 'status', 'created-after', 'created-before', 'before', 'limit'], paste: [],
    'create-paste': ['title', 'language', 'space', 'request-id'], 'edit-paste': ['version', 'title', 'language', 'content-file', 'status', 'request-id'],
    'paste-version': ['version'], 'paste-versions': ['before', 'limit'], 'paste-history': ['before', 'limit'],
    'comment-paste': ['version', 'comment-file', 'request-id'], 'archive-paste': ['version', 'status', 'request-id'], 'download-paste': ['version', 'output'],
  };
  const allowed = new Set(['server', 'json', 'help', ...extras[command]!]);
  if (optionNames.some(name => !allowed.has(name))) throw new Error(`${command} received an unsupported option. Use --help.`);
  const option = (name: string) => typeof options[name] === 'string' ? options[name] as string : undefined;
  const number = (name: string, optional = false, maximum = Number.MAX_SAFE_INTEGER): number | undefined => {
    const value = option(name); if (value === undefined && optional) return;
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new Error(`--${name} requires a positive integer no greater than ${maximum}.`);
    return Number(value);
  };
  if (args.length !== (command === 'pastes' ? 0 : 1)) throw new Error(`Unexpected arguments for ${command}.`);
  const id = args[0];
  if (!['pastes', 'create-paste'].includes(command) && !/^PA[1-9]\d{0,14}$/.test(id ?? '')) throw new Error('Choose a Paste ID such as PA1; P1 identifies a manuscript.');
  const path = command === 'pastes' || command === 'create-paste' ? '/api/pastes' : `/api/pastes/${id}`;
  if (['pastes', 'paste-history', 'paste-versions'].includes(command)) {
    const query = new URLSearchParams();
    for (const name of ['before', 'limit']) { const value = number(name, true, name === 'limit' ? 100 : Number.MAX_SAFE_INTEGER); if (value !== undefined) query.set(name, String(value)); }
    for (const name of ['query', 'author', 'language', 'status', 'created-after', 'created-before']) if (option(name) !== undefined) {
      const value = option(name)!;
      if (name === 'status' && !['active', 'archived', 'all'].includes(value)) throw new Error('--status requires active, archived, or all.');
      if (name.startsWith('created-') && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) throw new Error(`--${name} requires an ISO date and time.`);
      query.set(name === 'author' ? 'authorId' : name === 'created-after' ? 'createdAfter' : name === 'created-before' ? 'createdBefore' : name, text(value, `--${name}`, name === 'language' ? PASTE_MAX_LANGUAGE : 1_000));
    }
    const result = await request<PastePage | PasteHistory | PasteVersionsPage>(`${path}${command === 'paste-history' ? '/history' : command === 'paste-versions' ? '/versions' : ''}${query.size ? `?${query}` : ''}`);
    if (options.json || !('pastes' in result)) print(result);
    else { for (const paste of result.pastes) { record(paste); console.log(`${paste.id}\t${safe(paste.title)}\t${safe(paste.status)}\tv${paste.version} content ${paste.contentVersion}\t${paste.bytes} bytes`); } if (result.nextBefore !== null) console.log(`More pastes: --before ${result.nextBefore}`); }
    return true;
  }
  if (command === 'paste') {
    const result = await request<PasteDetail>(path); record(result.paste, id); version(result.version, id!, result.paste.contentVersion);
    if (result.version.sha256 !== result.paste.contentHash || result.version.bytes !== result.paste.bytes) throw new Error('The Paste detail has inconsistent content metadata.');
    print(result); return true;
  }
  if (command === 'paste-version' || command === 'download-paste') {
    const selected = number('version')!, output = option('output');
    if (command === 'download-paste' && (!output || output === '-')) throw new Error('--output must name a new local file. Raw Paste content is never printed to the terminal.');
    const result = await request<{ version: PasteVersion; accessEpoch?: number }>(`${path}/versions/${selected}`); version(result.version, id!, selected);
    if (command === 'paste-version') { print(result); return true; }
    const data = await download(`${path}/raw?version=${selected}`, result.version.bytes);
    if (data.byteLength !== result.version.bytes || digest(data) !== result.version.sha256) throw new Error('Raw Paste bytes differ from the exact version hash or length. No output was written.');
    const handle = await open(output!, 'wx', 0o600); try { await handle.writeFile(data); } finally { await handle.close(); }
    print({ id, version: selected, output, bytes: data.byteLength, sha256: result.version.sha256 }); return true;
  }
  const requestId = option('request-id') ?? randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
  let body: CreatePasteInput | UpdatePasteInput | { contentVersion: number; body: string }, method = 'POST', mutationPath = path;
  if (command === 'comment-paste') {
    const input = option('comment-file'); if (!input) throw new Error('--comment-file must name an explicit UTF-8 file.');
    const comment = text(await readText(input, PASTE_MAX_COMMENT * 4), 'Comment', PASTE_MAX_COMMENT).trim(); if (!comment) throw new Error('The comment must not be empty.');
    body = { contentVersion: number('version')!, body: comment }; mutationPath += '/comments';
  } else {
    const changes: Omit<UpdatePasteInput, 'expectedVersion'> = {};
    if (option('title') !== undefined) changes.title = text(option('title')!, 'Title', PASTE_MAX_TITLE).trim();
    if (option('language') !== undefined) changes.language = text(option('language')!, 'Language', PASTE_MAX_LANGUAGE).trim() || null;
    if (option('status') !== undefined || command === 'archive-paste') { const status = option('status') ?? 'archived'; if (status !== 'active' && status !== 'archived') throw new Error('--status requires active or archived.'); changes.status = status; }
    const input = command === 'create-paste' ? id : option('content-file');
    if (input !== undefined) changes.content = validatePasteContent(await readText(input, PASTE_MAX_BYTES)).content;
    if (command === 'create-paste') {
      const space = option('space'); if (space !== undefined && !/^S[1-9]\d{0,14}$/.test(space)) throw new Error('--space requires a Space ID.');
      body = { ...changes, content: changes.content!, ...(space ? { access: { spaceId: space } } : {}) };
    } else {
      if (!Object.keys(changes).length) throw new Error('Choose an explicit title, language, content file, or status change.');
      body = { expectedVersion: number('version')!, ...changes }; method = 'PATCH';
    }
  }
  console.error(`Paste request: ${JSON.stringify({ path: mutationPath, method, requestId, inputHash: digest(JSON.stringify(body)) })}. Keep the input file and retry unchanged with this request ID if the outcome is uncertain.`);
  if ('body' in body) {
    const result = await request<PasteTransaction>(mutationPath, method, body, requestId);
    if (result.pasteId !== id || result.kind !== 'comment' || result.contentVersion !== body.contentVersion || result.comment !== body.body) throw new Error('The Paste comment receipt does not match the exact version and comment. Retain its request ID.');
    print(result); return true;
  }
  const result = await request<PasteRecord>(mutationPath, method, body, requestId); record(result, command === 'create-paste' ? undefined : id);
  if (('expectedVersion' in body ? result.version !== body.expectedVersion && result.version !== body.expectedVersion + 1 : result.version !== 1 || result.contentVersion !== 1 || result.status !== 'active' || result.title !== (body.title ?? '') || result.language !== (body.language ?? null))
    || body.title !== undefined && result.title !== body.title || body.language !== undefined && result.language !== body.language
    || 'status' in body && body.status !== undefined && result.status !== body.status
    || body.content !== undefined && (result.contentHash !== digest(body.content) || result.bytes !== Buffer.byteLength(body.content))) throw new Error('The Paste receipt does not match the exact submitted changes. Retain its request ID.');
  print(result); return true;
}
