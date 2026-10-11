import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { PaperCLI } from './paper-builds';
import { FILE_MAX_BYTES } from '../shared/files';
import type { CitationEvidenceInput, CitationEvidencePage, CitationEvidenceRecord, CitationInventoryResponse } from '../shared/citation-evidence';

const commands = new Set(['citations', 'citation-evidence', 'citation-record', 'record-citation', 'retract-citation']);
const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
async function readText(path: string, maximum = 131_072): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > maximum) throw new Error(`Choose a regular input file of at most ${maximum} bytes.`);
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) { const part = await handle.read(buffer, length, buffer.length - length, null); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length > maximum) throw new Error('Input grew beyond its limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('The evidence file contains an invalid object or unsupported field.');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > maximum) throw new Error(`${name} must contain 1–${maximum} characters.`);
  return value;
}
function evidenceInput(value: unknown): CitationEvidenceInput {
  const row = object(value, ['versionId', 'contentHash', 'targetId', 'source', 'verdict', 'quote', 'locator', 'note', 'attested', 'expectedAccessEpoch']);
  const source = object(row.source, ['fileId', 'sha256', 'bytes', 'mediaType']);
  if (row.attested !== true || !['supports', 'contradicts', 'inconclusive'].includes(String(row.verdict))) throw new Error('Include an explicit attestation and a supported verdict.');
  if (typeof source.fileId !== 'string' || !/^F[1-9]\d{0,14}$/.test(source.fileId) || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)
    || !Number.isSafeInteger(source.bytes) || Number(source.bytes) < 0 || Number(source.bytes) > FILE_MAX_BYTES || !['image/png', 'image/jpeg', 'application/pdf', 'application/octet-stream'].includes(String(source.mediaType))) throw new Error('Include exact immutable supporting File pins.');
  if (typeof row.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.contentHash) || !Number.isSafeInteger(row.expectedAccessEpoch) || Number(row.expectedAccessEpoch) < 0) throw new Error('Include the exact manuscript hash and reviewed access epoch.');
  return { versionId: text(row.versionId, 'Version ID', 100), contentHash: row.contentHash, targetId: text(row.targetId, 'Target ID', 4096),
    source: { fileId: source.fileId, sha256: source.sha256, bytes: Number(source.bytes), mediaType: source.mediaType as CitationEvidenceInput['source']['mediaType'] },
    verdict: row.verdict as CitationEvidenceInput['verdict'], quote: text(row.quote, 'Quote', 10_000), locator: text(row.locator, 'Locator', 1000).trim(), note: text(row.note, 'Note', 10_000).trim(), attested: true, expectedAccessEpoch: Number(row.expectedAccessEpoch) };
}

export async function citationCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const extras: Record<string, string[]> = { citations: ['version'], 'citation-evidence': ['version-id', 'target-id', 'before', 'limit'], 'citation-record': [], 'record-citation': ['evidence', 'attest-inspected', 'request-id'], 'retract-citation': ['version', 'reason-file', 'request-id'] };
  const allowed = new Set(['server', 'json', 'help', ...extras[command]!]);
  if (optionNames.some(name => !allowed.has(name))) throw new Error(`${command} received an unsupported option. Use --help.`);
  const option = (name: string) => typeof options[name] === 'string' ? options[name] as string : undefined;
  const number = (name: string, optional = false): number | undefined => {
    const value = option(name); if (value === undefined && optional) return;
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`--${name} requires a positive integer.`);
    return Number(value);
  };
  const [id, recordId] = args;
  if (!/^[DPL][1-9]\d{0,14}$/.test(id ?? '') || args.length !== (['citation-record', 'retract-citation'].includes(command) ? 2 : 1)) throw new Error('Choose a revision ID and only the documented arguments.');
  if (recordId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(recordId)) throw new Error('Choose a citation record UUID.');
  const collection = `/api/revisions/${id}/citation-evidence`;
  if (command === 'citations') {
    const version = number('version');
    const result = await request<CitationInventoryResponse>(`/api/revisions/${id}/citations?version=${version}`);
    if (result.revisionId !== id || result.version.number !== version) throw new Error('The citation inventory belongs to a different manuscript version.');
    if (options.json) print(result);
    else {
      console.log(`${id} version ${version}: ${result.index.entries.length} bibliography entries; ${result.index.citations.length} citation uses. ${result.index.complete ? 'Literal snapshot inventory complete.' : 'Inventory incomplete; inspect diagnostics.'}`);
      console.log('Matching bibliography keys do not verify a source or its support for a claim. TeX is not expanded.');
      for (const entry of result.index.entries) console.log(`ENTRY\t${safe(entry.key)}\t${safe(entry.filePath)}:${entry.line}\t${safe(entry.fields.find(field => field.name === 'title')?.value ?? entry.type)}`);
      for (const item of result.index.citations) console.log(`USE\t${safe(item.key)}\t${safe(item.filePath)}:${item.line}\t${item.resolution}`);
      for (const item of result.index.diagnostics) console.log(`${safe(item.filePath)}:${item.line} [${item.severity}] ${safe(item.message)}`);
    }
    return true;
  }
  if (command === 'citation-evidence') {
    const query = new URLSearchParams({ versionId: text(option('version-id'), '--version-id', 100) });
    if (option('target-id') !== undefined) query.set('targetId', text(option('target-id'), '--target-id', 4096));
    for (const name of ['before', 'limit']) { const value = number(name, true); if (value !== undefined) query.set(name, String(value)); }
    if (Number(query.get('limit')) > 100) throw new Error('--limit may not exceed 100.');
    print(await request<CitationEvidencePage>(`${collection}?${query}`)); return true;
  }
  if (command === 'citation-record') { print(await request(`${collection}/${recordId}`)); return true; }
  const requestId = option('request-id') ?? randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
  let path = collection; let body: CitationEvidenceInput | { expectedRecordVersion: number; reason: string };
  if (command === 'record-citation') {
    if (options['attest-inspected'] !== true) throw new Error('--attest-inspected is required to record your explicit source inspection.');
    const source = option('evidence'); if (!source) throw new Error('--evidence must name a JSON input file.');
    body = evidenceInput(JSON.parse(await readText(source)));
  } else {
    const source = option('reason-file'); if (!source) throw new Error('--reason-file must name a UTF-8 file.');
    body = { expectedRecordVersion: number('version')!, reason: text(await readText(source, 40_000), 'Retraction reason', 10_000).trim() }; path += `/${recordId}/retract`;
  }
  const inputHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  console.error(`Citation request: ${JSON.stringify({ path, requestId, inputHash })}. Keep the input file and retry unchanged with this request ID if the outcome is uncertain.`);
  const result = await request<CitationEvidenceRecord>(path, 'POST', body, requestId);
  if (result.revisionId !== id || result.basis !== 'reviewer-attestation') throw new Error('The receipt does not match the submitted evidence. Retain its request ID.');
  if ('targetId' in body) {
    if (result.versionId !== body.versionId || result.contentHash !== body.contentHash || result.target.id !== body.targetId || !isDeepStrictEqual(result.source, body.source)
      || result.verdict !== body.verdict || result.quote !== body.quote || result.locator !== body.locator || result.note !== body.note || result.state !== 'active' || result.recordVersion !== 1) throw new Error('The receipt does not match the exact source inspection. Retain its request ID.');
  } else if (result.id !== recordId || result.state !== 'retracted' || result.recordVersion !== body.expectedRecordVersion + 1 || result.retraction?.reason !== body.reason) throw new Error('The receipt does not match the retraction. Retain its request ID.');
  print(result); return true;
}
