import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { readRequestIntent } from './request-intent';
import type { PaperCLI } from './paper-builds';
import type { DocxInspection } from '../shared/docx';
import { DOCX_LIMITS } from '../shared/docx';
import type { Revision, RevisionVersion } from '../shared/types';
import { sourceSnapshotCanonical } from '../shared/source-snapshot';

const commands = new Set(['inspect-docx', 'import-docx', 'reimport-docx', 'edit-docx', 'download-docx']);
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The Word request must be a JSON object.');
  return value as Record<string, unknown>;
};
export async function readDocxIntent(path: string): Promise<Record<string, unknown>> {
  return readRequestIntent(path, 'Word request');
}

/** Explicit immutable intents survive retries; no command silently selects the latest head. */
export async function docxCommand({ command, args, options, optionNames, request, download }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const downloadCommand = command === 'download-docx'; const inspection = command === 'inspect-docx'; const creation = command === 'import-docx';
  const allowed = new Set(['server', 'help', 'json', ...(downloadCommand ? ['version', 'version-id', 'content-hash', 'output'] : inspection ? [] : ['intent', 'request-id'])]);
  if (optionNames.some(name => !allowed.has(name))) throw new Error(`${command} received an unsupported option.`);
  if (args.length !== 1) throw new Error(`Provide ${creation ? 'one Word request JSON file' : 'one exact object ID'}.`);
  const id = args[0]!; const option = (name: string) => typeof options[name] === 'string' ? options[name] as string : undefined;
  const positive = (value: unknown, label: string) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
    return value;
  };
  if (!creation && !(inspection ? /^F[1-9]\d{0,14}$/ : /^L[1-9]\d{0,14}$/).test(id)) throw new Error(inspection ? 'Choose a File ID such as F1.' : 'Choose a Word document revision such as L1.');
  if (inspection) {
    const result = await request<DocxInspection>(`/api/files/${id}/docx`);
    if (result.sourceFile.fileId !== id || result.projection.format !== 'phabricator.docx.projection.v1') throw new Error('The Word inspection response identifies a different File or projection.');
    console.log(JSON.stringify(result, null, 2)); return true;
  }
  if (downloadCommand) {
    const rawVersion = option('version'); const number = Number(rawVersion); const versionId = option('version-id'); const hash = option('content-hash'); const output = option('output');
    if (!rawVersion || !/^[1-9]\d*$/.test(rawVersion) || !Number.isSafeInteger(number) || !versionId || !hash || !/^[a-f0-9]{64}$/.test(hash) || !output || output === '-') throw new Error('Download requires exact --version, --version-id, --content-hash and a new --output file.');
    const result = await request<{ revision: Revision; version: RevisionVersion }>(`/api/revisions/${id}/export?version=${number}`);
    const version = result.version; const docx = version?.docx;
    if (result.revision.id !== id || version.revisionId !== id || version.number !== number || version.id !== versionId || version.contentHash !== hash || !docx || docx.format !== 'docx'
      || !/^[a-f0-9]{64}$/.test(docx.sha256) || !Number.isSafeInteger(docx.bytes) || docx.bytes < 1 || docx.bytes > DOCX_LIMITS.compressedBytes
      || digest(sourceSnapshotCanonical(version.files, version.assets, docx)) !== hash) throw new Error('The exported Word version differs from the inspected source pins.');
    const bytes = await download(`/api/revisions/${id}/docx/${encodeURIComponent(versionId)}/download`, docx.bytes);
    if (bytes.byteLength !== docx.bytes || digest(bytes) !== docx.sha256) throw new Error('Word package size or SHA-256 differs from the immutable version. Nothing was written.');
    const handle = await open(output, 'wx', 0o600); try { await handle.writeFile(bytes); } finally { await handle.close(); }
    console.log(JSON.stringify({ revisionId: id, versionId, version: number, output, sha256: docx.sha256, bytes: docx.bytes }, null, 2)); return true;
  }
  if (creation && option('intent')) throw new Error('import-docx accepts its request file as the sole positional argument.');
  const intentPath = creation ? id : option('intent'); if (!intentPath) throw new Error('--intent must name the original Word request JSON file.');
  const input = await readDocxIntent(intentPath);
  const fields = creation ? ['title', 'summary', 'sourceFile', 'expectedAccessEpoch', 'shareSource', 'access']
    : command === 'reimport-docx' ? ['sourceFile', 'shareSource', 'message', 'expectedVersion', 'expectedVersionId', 'expectedContentHash', 'expectedAccessEpoch']
      : ['rangeId', 'start', 'end', 'quote', 'replacement', 'message', 'expectedVersion', 'expectedVersionId', 'expectedContentHash', 'expectedAccessEpoch'];
  if (Object.keys(input).some(key => !fields.includes(key))) throw new Error('The Word request contains unsupported fields.');
  positive(input.expectedAccessEpoch, 'expectedAccessEpoch');
  if (!creation) {
    positive(input.expectedVersion, 'expectedVersion');
    if (typeof input.expectedVersionId !== 'string' || !input.expectedVersionId || typeof input.expectedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedContentHash)) throw new Error('Word changes require exact expectedVersionId and expectedContentHash pins.');
    if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('Word changes require a version message.');
  }
  if (creation || command === 'reimport-docx') {
    const source = record(input.sourceFile);
    if (Object.keys(source).some(key => !['fileId', 'sha256', 'bytes'].includes(key)) || typeof source.fileId !== 'string' || !/^F[1-9]\d{0,14}$/.test(source.fileId) || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256) || positive(source.bytes, 'sourceFile.bytes') > DOCX_LIMITS.compressedBytes || typeof input.shareSource !== 'boolean') throw new Error('The request must pin an inspected File and explicitly choose shareSource true or false.');
    if (creation && (typeof input.title !== 'string' || !input.title.trim())) throw new Error('A Word import requires a title.');
  } else if (typeof input.rangeId !== 'string' || !input.rangeId || typeof input.start !== 'number' || !Number.isSafeInteger(input.start) || input.start < 0 || typeof input.end !== 'number' || !Number.isSafeInteger(input.end) || input.end <= input.start || typeof input.quote !== 'string' || input.quote.length !== input.end - input.start || typeof input.replacement !== 'string' || input.replacement.length > DOCX_LIMITS.replacementLength) throw new Error('The replacement must identify one inspected text range and its exact quote.');
  const requestId = option('request-id') ?? randomUUID(); if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
  const path = creation ? '/api/revisions/docx' : `/api/revisions/${id}/docx/${command === 'reimport-docx' ? 'import' : 'replace'}`;
  console.error(`Word request: ${JSON.stringify({ path, requestId, intentPath, intentSha256: digest(JSON.stringify(input)) })}. Retain this exact request file and ID to recover an uncertain result.`);
  const result = await request<unknown>(path, 'POST', input, requestId);
  console.log(JSON.stringify(result, null, 2)); return true;
}
