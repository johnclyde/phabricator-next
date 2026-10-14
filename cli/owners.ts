import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isOwnersId, isOwnersRepositoryId, ownersDefinition, ownersPath, parseOwnersWrite, validOwnersReceipt, type OwnersPackage } from '../shared/owners';
import type { OwnersRoutingRecord } from '../shared/owners-routing';
import type { PaperCLI } from './paper-builds';
import { readRequestIntent } from './request-intent';

const commands = new Set(['owners', 'owners-history', 'resolve-owners', 'owners-routing', 'create-owners', 'edit-owners']);
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function validPackage(value: unknown): value is OwnersPackage {
  try {
    if (!record(value) || !isOwnersId(value.id) || typeof value.creatorId !== 'string' || !value.creatorId || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return false;
    const pkg = value as unknown as OwnersPackage;
    return isDeepStrictEqual(pkg, { ...ownersDefinition(pkg), id: pkg.id, creatorId: pkg.creatorId, version: pkg.version, createdAt: pkg.createdAt, updatedAt: pkg.updatedAt });
  } catch { return false; }
}
const validEpoch = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const validSourceId = (value: unknown): value is string => typeof value === 'string' && /^(?:[DPL][1-9]\d{0,14}|GC-[a-f0-9]{64})$/.test(value);
function positive(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error('Provide a positive --' + label + ' no greater than ' + max + '.');
  return value;
}
function validRouting(value: unknown, objectId: string): boolean {
  if (!record(value) || !validEpoch(value.accessEpoch) || !Array.isArray(value.records) || value.nextBefore !== null && (!Number.isSafeInteger(value.nextBefore) || Number(value.nextBefore) < 1)) return false;
  return value.records.every((item: unknown) => {
    if (!record(item) || !record(item.source) || !Array.isArray(item.packages) || typeof item.id !== 'string' || !/^OR-[a-f0-9]{64}$/.test(item.id) || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.actorId !== 'string' || !item.actorId) return false;
    const source = item.source;
    if (source.objectId !== objectId || !['revision', 'commit'].includes(String(source.kind)) || !isOwnersRepositoryId(source.repositoryId) || typeof source.versionId !== 'string' || !source.versionId || typeof source.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.contentHash) || !Array.isArray(source.paths) || !source.paths.every(path => typeof path === 'string') || typeof source.eventId !== 'string' || !source.eventId || !['submitted-files', 'previous-version', 'git-baseline', 'receive'].includes(String(source.basis)) || source.baseVersionId !== null && typeof source.baseVersionId !== 'string') return false;
    return item.packages.every((entry: OwnersRoutingRecord['packages'][number]) => record(entry) && validPackage(entry.package) && ['applied', 'unchanged', 'skipped', 'unavailable'].includes(entry.status) && typeof entry.mode === 'string' && typeof entry.reason === 'string' && [entry.paths, entry.ownerIds, entry.eligibleIds, entry.appliedIds].every(list => Array.isArray(list) && list.every(id => typeof id === 'string')));
  });
}

/** Reads exact authorized projections; mutations submit only explicit version-pinned intent files. */
export async function ownersCommand({ command, args, options, optionNames, request }: PaperCLI): Promise<boolean> {
  if (!commands.has(command)) return false;
  const writing = command === 'create-owners' || command === 'edit-owners', updating = command === 'edit-owners';
  const allowed = ['server', 'json', 'help', ...(writing ? ['intent', 'request-id'] : command === 'owners-routing' ? ['before', 'limit'] : [])];
  if (optionNames.some(name => !allowed.includes(name)) || new Set(optionNames).size !== optionNames.length) throw new Error('Use unique supported Owners options.');
  const id = args[0];
  if (writing) {
    if (updating ? args.length !== 1 || !isOwnersId(id) : args.length !== 0) throw new Error('Provide exactly one OWN package ID when editing, and no ID when creating.');
    if (typeof options.intent !== 'string' || !options.intent) throw new Error('Provide --intent REQUEST.json containing the exact package definition and observed versions.');
    const input = parseOwnersWrite(await readRequestIntent(options.intent, 'Owners request', 2_000_000), updating);
    const requestId = options['request-id'] ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Invalid --request-id.');
    const path = '/api/owners' + (updating ? '/' + id : ''), method = updating ? 'PUT' : 'POST';
    console.error(safeJson({ path, requestId, intentPath: options.intent, inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), recovery: 'Retain the exact request file and ID to retry an uncertain Owners change. Package and access versions are never refreshed automatically.' }));
    const result = await request<unknown>(path, method, input, requestId);
    if (!validOwnersReceipt(result, path, method, input)) throw new Error('The Owners receipt does not match the exact request. Retain the request file and ID for an explicit retry.');
    console.log(safeJson(result)); return true;
  }
  let path: string;
  if (command === 'resolve-owners') {
    if (!isOwnersRepositoryId(id) || args.length < 2 || args.length > 10_001) throw new Error('Provide one repository ID and one or more literal repository paths.');
    const paths = args.slice(1).map(ownersPath);
    path = '/api/owners/resolve?' + new URLSearchParams({ repositoryId: id, paths: JSON.stringify(paths) }).toString();
  } else if (command === 'owners-routing') {
    if (args.length !== 1 || !validSourceId(id)) throw new Error('Provide an exact revision ID or GC commit ID for routing evidence.');
    const query = new URLSearchParams(), before = positive(options.before, 'before'), limit = positive(options.limit, 'limit', 100);
    if (before) query.set('before', before); if (limit) query.set('limit', limit);
    path = '/api/owners-routing/' + id + (query.size ? '?' + query.toString() : '');
  } else {
    if (command === 'owners' ? args.length > 1 || id !== undefined && !isOwnersId(id) : args.length !== 1 || !isOwnersId(id)) throw new Error('Provide an exact OWN package ID, or omit it to list packages.');
    path = '/api/owners' + (id ? '/' + id : '') + (command === 'owners-history' ? '/history' : '');
  }
  const result = await request<unknown>(path);
  let valid = record(result) && validEpoch(result.accessEpoch);
  if (valid && record(result)) {
    if (command === 'owners-routing') valid = validRouting(result, id!);
    else if (command === 'resolve-owners') valid = Array.isArray(result.matches) && result.matches.every(entry => record(entry) && validPackage(entry.package) && Array.isArray(entry.paths) && entry.paths.every(value => typeof value === 'string' && args.slice(1).map(ownersPath).includes(value)));
    else if (command === 'owners-history') valid = Array.isArray(result.history) && result.history.every(entry => record(entry) && validPackage(entry.package) && entry.package.id === id && typeof entry.actorId === 'string' && typeof entry.actorName === 'string');
    else if (id) valid = validPackage(result.package) && result.package.id === id && typeof result.canEdit === 'boolean';
    else valid = Array.isArray(result.packages) && result.packages.every(validPackage) && typeof result.canCreate === 'boolean';
  }
  if (!valid) throw new Error('The Owners response is invalid or does not match the requested identity.');
  console.log(safeJson(result)); return true;
}
