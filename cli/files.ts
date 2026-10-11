import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename } from 'node:path';
import type { PaperCLI } from './paper-builds';
import type { FileDetail, FilePage, FileRecord, RevisionAsset } from '../shared/files';
import { FILE_MAX_BYTES } from '../shared/files';
import type { Revision, RevisionVersion } from '../shared/types';
import { sourceSnapshotCanonical, validateSourceSnapshot } from '../shared/source-snapshot';

const commands = new Set(['files', 'file', 'upload-file', 'upload-receipt', 'edit-file', 'attach-file', 'download-file', 'file-history', 'set-figures']);
const escape = (value: unknown) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function readBounded(path: string, max: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error(`Choose a regular file no larger than ${max} bytes.`);
    const bytes = Buffer.alloc(max + 1); let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > max) throw new Error('The file grew beyond the upload limit.');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
function verifiedFile(file: FileRecord, id?: string): void {
  if (!file || !/^F[1-9]\d{0,14}$/.test(file.id) || (id && file.id !== id) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > FILE_MAX_BYTES) throw new Error('The file response does not match a bounded immutable File.');
}

export async function fileCommand({ command, args, options, optionNames, request, download }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const extra: Record<string, string[]> = {
    files: ['before', 'limit', 'name', 'author', 'status'], file: [], 'file-history': ['before', 'limit'],
    'upload-file': ['name', 'alt-text', 'request-id'], 'upload-receipt': [], 'download-file': ['output'],
    'edit-file': ['version', 'name', 'alt-text', 'status', 'request-id'], 'attach-file': ['object', 'mode', 'version', 'access-epoch', 'request-id'],
    'set-figures': ['assets-manifest', 'version', 'version-id', 'content-hash', 'access-epoch', 'share-assets', 'message', 'request-id'],
  };
  const allowed = new Set(['server', 'json', 'help', ...extra[command]!]);
  if (optionNames.some(name => !allowed.has(name))) throw new Error(`${command} received an unsupported option. Use --help.`);
  const option = (name: string) => typeof options[name] === 'string' ? options[name] as string : undefined;
  const number = (name: string, optional = false, zero = false): number | undefined => {
    const value = option(name); if (value === undefined && optional) return;
    const result = Number(value);
    if (!value || !/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(result) || result < (zero ? 0 : 1)) throw new Error(`--${name} requires ${zero ? 'a nonnegative' : 'a positive'} integer.`);
    return result;
  };
  const id = args[0];
  if (args.length !== (command === 'files' ? 0 : 1)) throw new Error(`Unexpected arguments for ${command}.`);
  if (!['files', 'upload-file', 'upload-receipt', 'set-figures'].includes(command) && !/^F[1-9]\d{0,14}$/.test(id ?? '')) throw new Error('Choose a File ID such as F1.');
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const printFile = (value: FileRecord) => options.json ? print(value) : console.log(`${value.id}\t${escape(value.name)}\t${value.bytes} bytes\t${escape(value.mediaType)}\t${escape(value.status)}\nv${value.version} SHA-256 ${value.sha256}`);
  if (command === 'files' || command === 'file-history') {
    const query = new URLSearchParams();
    for (const name of ['before', 'limit']) { const value = number(name, true); if (value !== undefined) query.set(name, String(value)); }
    for (const name of ['name', 'author', 'status']) if (option(name) !== undefined) query.set(name === 'author' ? 'authorId' : name, option(name)!);
    const response = await request<FilePage>(`${command === 'files' ? '/api/files' : `/api/files/${id}/history`}${query.size ? `?${query}` : ''}`);
    if (options.json || command === 'file-history') print(response);
    else { for (const file of response.files) { verifiedFile(file); printFile(file); } if (response.nextBefore !== null) console.log(`More files: --before ${response.nextBefore}`); }
    return true;
  }
  if (command === 'file') { const result = await request<FileDetail>(`/api/files/${id}`); verifiedFile(result.file, id); options.json ? print(result) : printFile(result.file); return true; }
  if (command === 'upload-receipt') {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id!)) throw new Error('Provide the original upload request ID.');
    const result = await request<FileRecord>(`/api/files/uploads/${id}`); verifiedFile(result); printFile(result); return true;
  }
  if (command === 'download-file') {
    const output = option('output'); if (!output || output === '-') throw new Error('--output must name a new local file.');
    const { file } = await request<FileDetail>(`/api/files/${id}`); verifiedFile(file, id);
    const data = await download(`/api/files/${id}/data`, file.bytes);
    if (data.byteLength !== file.bytes || sha(data) !== file.sha256) throw new Error('File bytes do not match the immutable SHA-256 and length. Nothing was written.');
    const handle = await open(output, 'wx', 0o600); try { await handle.writeFile(data); } finally { await handle.close(); }
    print({ id, output, bytes: file.bytes, sha256: file.sha256 }); return true;
  }
  const requestId = option('request-id') ?? randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
  let path = `/api/files/${id}`; let method = 'POST'; let input: unknown;
  if (command === 'upload-file') {
    const data = await readBounded(id!, FILE_MAX_BYTES);
    input = { name: option('name') ?? basename(id!), ...(option('alt-text') !== undefined ? { altText: option('alt-text') } : {}), dataBase64: data.toString('base64'), sha256: sha(data), bytes: data.byteLength };
    path = '/api/files';
  } else if (command === 'edit-file') {
    const fields = ['name', 'alt-text', 'status'].filter(name => option(name) !== undefined); if (!fields.length) throw new Error('Choose a name, alt text, or active/archived status change.');
    if (option('status') && !['active', 'archived'].includes(option('status')!)) throw new Error('--status must be active or archived.');
    input = { expectedVersion: number('version'), ...Object.fromEntries(fields.map(name => [name === 'alt-text' ? 'altText' : name, option(name)])) }; method = 'PATCH';
  } else if (command === 'attach-file') {
    const target = option('object'); const mode = option('mode');
    if (!/^(?:PROJ|R|T|W|[DPL])[1-9]\d{0,14}$/.test(target ?? '') || !['attach', 'reference', 'detach'].includes(mode ?? '')) throw new Error('Choose --object and --mode attach|reference|detach. Attaching shares the File with that object’s viewers, within the File Space.');
    input = { objectId: target, mode, expectedVersion: number('version', false, true), ...(mode === 'attach' ? { expectedAccessEpoch: number('access-epoch') } : {}) }; path += '/attachments';
  } else {
    if (!/^[DPL][1-9]\d{0,14}$/.test(id ?? '')) throw new Error('Choose a revision ID.');
    const manifest = option('assets-manifest'); const version = number('version'); const versionId = option('version-id'); const contentHash = option('content-hash');
    const epoch = number('access-epoch'); const message = option('message');
    if (!manifest || !versionId || !/^[a-f0-9]{64}$/.test(contentHash ?? '') || !message) throw new Error('set-figures requires --assets-manifest, exact --version/--version-id/--content-hash, --access-epoch, and --message.');
    const assets = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(manifest, 100_000))) as RevisionAsset[];
    if (!Array.isArray(assets)) throw new Error('The figure manifest must be a JSON array. Use [] to remove figures explicitly.');
    validateSourceSnapshot([], assets);
    const source = await request<{ revision: Revision; version: RevisionVersion }>(`/api/revisions/${id}/export?version=${version}`);
    if (source.revision.id !== id || source.version.revisionId !== id || source.version.number !== version || source.version.id !== versionId || source.version.contentHash !== contentHash) throw new Error('The exported source differs from the exact reviewed pins.');
    if (createHash('sha256').update(sourceSnapshotCanonical(source.version.files, source.version.assets)).digest('hex') !== contentHash) throw new Error('The exported source bytes differ from the reviewed content hash.');
    validateSourceSnapshot(source.version.files, assets);
    input = { files: source.version.files, assets, message, expectedVersion: version, expectedVersionId: versionId, expectedContentHash: contentHash, expectedAccessEpoch: epoch, ...(options['share-assets'] ? { shareAssets: true } : {}) };
    path = `/api/revisions/${id}/versions`;
  }
  const metadata = input as Record<string, unknown>;
  console.error(`File request: ${JSON.stringify({ path, method, requestId, ...Object.fromEntries(Object.entries(metadata).filter(([key]) => !['dataBase64', 'files'].includes(key))) })}. Retain these inputs and request ID for an uncertain-result retry.`);
  const result = await request<FileRecord>(path, method, input, requestId);
  if (command === 'upload-file' || command === 'edit-file') {
    verifiedFile(result, command === 'edit-file' ? id : undefined);
    if (command === 'upload-file' && (result.sha256 !== metadata.sha256 || result.bytes !== metadata.bytes)) throw new Error('The upload receipt does not match the submitted bytes. Retain the request ID and inspect the upload receipt.');
    printFile(result);
  } else print(result);
  return true;
}
