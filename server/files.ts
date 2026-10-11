import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { ActorAttribution } from '../shared/types.ts';
import type { FileAttachment, FileAttachmentMode, FileAttachmentPage, FileFieldChange, FileHistory, FileImageDimensions, FileListQuery, FileMediaType, FilePage, FileRecord, FileTransaction, RevisionAsset } from '../shared/files.ts';
import { FILE_IMAGE_MAX_DIMENSION, FILE_IMAGE_MAX_PIXELS, FILE_MAX_BYTES, REVISION_ASSET_MAX_BYTES, REVISION_ASSET_MAX_COUNT } from '../shared/files.ts';
import { choice, HttpError, integer, object, string } from './validation.ts';

type JsonRow = { data: string };
type CursorRow = JsonRow & { cursor: number };
type ContentRow = { sha256: string; byte_size: number; media_type: FileMediaType; original_name: string; author_id: string; created_at: string; dimensions: string };
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const unavailable = () => new HttpError(404, 'File was not found.', 'FILE_UNAVAILABLE');
const corrupt = () => new HttpError(409, 'Stored file integrity could not be verified.', 'FILE_INTEGRITY');
let savepoint = 0;

function nonnegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${field} must be a nonnegative integer.`);
  return value;
}
function next(value: number): number {
  if (!Number.isSafeInteger(value + 1)) throw new HttpError(409, 'This file has reached the supported version limit.');
  return value + 1;
}
function name(value: unknown): string {
  const result = string(value, 'File name', 240);
  if (/[/\\\x00-\x1f\x7f]/.test(result) || /[\uD800-\uDFFF]/u.test(result) || result === '.' || result === '..') throw new HttpError(400, 'File names must not contain path separators or control characters.');
  return result;
}
function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new HttpError(400, 'File SHA-256 must contain 64 lowercase hexadecimal characters.');
  return value;
}
function fileId(value: unknown): string {
  if (typeof value !== 'string' || !/^F[1-9]\d{0,14}$/.test(value)) throw unavailable();
  return value;
}
function objectId(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:PROJ|R|T|W|[DPL])[1-9]\d{0,14}$/.test(value)) throw new HttpError(400, 'Choose an available attachment target.');
  return value;
}
function principal(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)) throw new HttpError(400, 'Invalid file author.');
  return value;
}
function pagination(before?: number, limit?: number): { before: number; limit: number } {
  const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : integer(before, 'before');
  const count = limit === undefined ? 25 : integer(limit, 'limit');
  if (count > 100) throw new HttpError(400, 'File pages may contain at most 100 results.');
  return { before: cursor, limit: count };
}
/** Filter before paging, with a bounded scan and a continuation even for an empty visible page. */
function page<T>(query: (before: number, count: number) => CursorRow[], decode: (row: CursorRow) => T, visible: (value: T) => boolean, before?: number, limit?: number): { values: T[]; nextBefore: number | null } {
  const bounds = pagination(before, limit); const values: T[] = []; let cursor = bounds.before; let lastVisible = cursor; let scanned = 0;
  for (;;) {
    const rows = query(cursor, 100);
    for (const row of rows) {
      cursor = row.cursor; scanned++;
      const value = decode(row);
      if (visible(value)) {
        if (values.length === bounds.limit) return { values, nextBefore: lastVisible };
        values.push(value); lastVisible = cursor;
      }
      if (scanned === 1_000) return { values, nextBefore: query(cursor, 1).length ? cursor : null };
    }
    if (rows.length < 100) return { values, nextBefore: null };
  }
}
function dimensions(width: number, height: number): FileImageDimensions | null {
  return width > 0 && height > 0 && width <= FILE_IMAGE_MAX_DIMENSION && height <= FILE_IMAGE_MAX_DIMENSION && width * height <= FILE_IMAGE_MAX_PIXELS ? { width, height } : null;
}
/** Header recognition only: no decoder, decompression, external process, or conversion runs during upload. */
export function inspectFileMedia(data: Uint8Array): { mediaType: FileMediaType; dimensions: FileImageDimensions | null } {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const unknown = { mediaType: 'application/octet-stream' as const, dimensions: null };
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.readUInt32BE(8) !== 13 || !bytes.subarray(12, 16).equals(Buffer.from('IHDR'))) return unknown;
    const allowedDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!allowedDepths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) return unknown;
    const size = dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    return size ? { mediaType: 'image/png', dimensions: size } : unknown;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    // Bound both work and how much attacker-controlled metadata is traversed.
    for (let segment = 0; segment < 256 && offset < Math.min(bytes.length, 1024 * 1024); segment++) {
      if (bytes[offset++] !== 0xff) return unknown;
      while (bytes[offset] === 0xff && offset < Math.min(bytes.length, 1024 * 1024)) offset++;
      if (offset >= 1024 * 1024) return unknown;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9 || marker === 0x00 || marker === 0xd8) return unknown;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return unknown;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return unknown;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || bytes[offset + 2] !== 8) return unknown;
        const components = bytes[offset + 7];
        if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) return unknown;
        const size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
        return size ? { mediaType: 'image/jpeg', dimensions: size } : unknown;
      }
      offset += length;
    }
    return unknown;
  }
  if (/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/.test(bytes.toString('latin1', 0, 10))) return { mediaType: 'application/pdf', dimensions: null };
  return unknown;
}

export function revisionAssets(input: unknown): RevisionAsset[] {
  if (!Array.isArray(input) || input.length > REVISION_ASSET_MAX_COUNT) throw new HttpError(400, `Provide at most ${REVISION_ASSET_MAX_COUNT} binary assets.`);
  const paths = new Set<string>(); let total = 0;
  return input.map(value => {
    const data = object(value, ['path', 'fileId', 'sha256', 'bytes', 'mediaType']);
    const path = string(data.path, 'Asset path', 240);
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\x7f:]/.test(path) || /[\uD800-\uDFFF]/u.test(path)) throw new HttpError(400, 'Asset paths must be safe relative paths.');
    if (paths.has(path)) throw new HttpError(400, 'Asset paths must be unique.');
    paths.add(path);
    const bytes = nonnegative(data.bytes, 'Asset byte length'); total += bytes;
    if (bytes > FILE_MAX_BYTES || total > REVISION_ASSET_MAX_BYTES) throw new HttpError(400, 'Binary assets exceed the supported byte limit.');
    return { path, fileId: fileId(data.fileId), sha256: sha256(data.sha256), bytes, mediaType: choice(data.mediaType, 'asset media type', ['image/png', 'image/jpeg', 'application/pdf']) };
  });
}

/** Schema only. The caller owns the enclosing migration transaction and entities kind expansion. */
export function initializeFiles(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE file_blobs(sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),byte_size INTEGER NOT NULL CHECK(byte_size>=0 AND byte_size<=16777216),data BLOB NOT NULL CHECK(length(data)=byte_size));
    CREATE TABLE file_contents(file_id TEXT PRIMARY KEY REFERENCES entities(id),sha256 TEXT NOT NULL REFERENCES file_blobs(sha256),byte_size INTEGER NOT NULL,media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg','application/pdf','application/octet-stream')),original_name TEXT NOT NULL,author_id TEXT NOT NULL,created_at TEXT NOT NULL,dimensions TEXT NOT NULL CHECK(json_valid(dimensions)));
    CREATE INDEX file_contents_hash ON file_contents(sha256);
    CREATE TABLE file_transactions(id TEXT PRIMARY KEY,file_id TEXT NOT NULL REFERENCES entities(id),sequence INTEGER NOT NULL CHECK(sequence>0),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(file_id,sequence));
    CREATE TABLE file_attachments(file_id TEXT NOT NULL REFERENCES file_contents(file_id),object_id TEXT NOT NULL REFERENCES entities(id),mode TEXT NOT NULL CHECK(mode IN ('attach','reference','detach')),version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(file_id,object_id));
    CREATE INDEX file_attachments_object ON file_attachments(object_id,mode,file_id);
    CREATE TRIGGER file_blobs_no_update BEFORE UPDATE ON file_blobs BEGIN SELECT RAISE(ABORT,'File bytes are immutable'); END;
    CREATE TRIGGER file_blobs_no_delete BEFORE DELETE ON file_blobs BEGIN SELECT RAISE(ABORT,'File bytes are immutable'); END;
    CREATE TRIGGER file_contents_no_update BEFORE UPDATE ON file_contents BEGIN SELECT RAISE(ABORT,'File content identities are immutable'); END;
    CREATE TRIGGER file_contents_no_delete BEFORE DELETE ON file_contents BEGIN SELECT RAISE(ABORT,'File content identities are immutable'); END;
    CREATE TRIGGER file_transactions_no_update BEFORE UPDATE ON file_transactions BEGIN SELECT RAISE(ABORT,'File history is immutable'); END;
    CREATE TRIGGER file_transactions_no_delete BEFORE DELETE ON file_transactions BEGIN SELECT RAISE(ABORT,'File history is immutable'); END;
    CREATE TRIGGER file_identity_no_update BEFORE UPDATE ON entities WHEN OLD.kind='file' AND (
      NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR json_extract(NEW.data,'$.id') IS NOT json_extract(OLD.data,'$.id') OR
      json_extract(NEW.data,'$.sha256') IS NOT json_extract(OLD.data,'$.sha256') OR json_extract(NEW.data,'$.bytes') IS NOT json_extract(OLD.data,'$.bytes') OR
      json_extract(NEW.data,'$.mediaType') IS NOT json_extract(OLD.data,'$.mediaType') OR json_extract(NEW.data,'$.originalName') IS NOT json_extract(OLD.data,'$.originalName') OR
      json_extract(NEW.data,'$.authorId') IS NOT json_extract(OLD.data,'$.authorId') OR json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt') OR
      json_extract(NEW.data,'$.dimensions') IS NOT json_extract(OLD.data,'$.dimensions')) BEGIN SELECT RAISE(ABORT,'File identity is immutable'); END;
  `);
}

/** Storage and validation only. Every public call must be wrapped in the request's current authority checks. */
export class FileStore {
  constructor(private readonly database: DatabaseSync) {}
  private mutation<T>(work: () => T): T {
    const key = `file_write_${++savepoint}`; this.database.exec(`SAVEPOINT ${key}`);
    try {
      // The first mutation creates its counter lazily so schema upgrades do not
      // rewrite pre-existing sequence evidence. The upsert also obtains a lock.
      this.database.prepare("INSERT INTO sequences(name,value) VALUES('file',0) ON CONFLICT(name) DO UPDATE SET value=value").run();
      const result = work(); this.database.exec(`RELEASE ${key}`); return result;
    } catch (error) { this.database.exec(`ROLLBACK TO ${key}; RELEASE ${key}`); throw error; }
  }
  get(id: string): FileRecord {
    fileId(id);
    const row = this.database.prepare("SELECT data FROM entities WHERE id=? AND kind='file'").get(id) as JsonRow | undefined;
    if (!row) throw unavailable();
    const file = JSON.parse(row.data) as FileRecord;
    const content = this.database.prepare('SELECT * FROM file_contents WHERE file_id=?').get(id) as ContentRow | undefined;
    if (!content || file.id !== id || file.sha256 !== content.sha256 || file.bytes !== content.byte_size || file.mediaType !== content.media_type || file.originalName !== content.original_name || file.authorId !== content.author_id || file.createdAt !== content.created_at || JSON.stringify(file.dimensions) !== content.dimensions) throw corrupt();
    return file;
  }
  upload(input: unknown, attribution: ActorAttribution): FileRecord {
    const data = object(input, ['name', 'altText', 'dataBase64', 'sha256', 'bytes']);
    const originalName = name(data.name); const altText = data.altText === undefined ? '' : string(data.altText, 'Alt text', 10_000, true);
    const authorId = principal(attribution.principalId); const expectedHash = sha256(data.sha256); const length = nonnegative(data.bytes, 'File byte length');
    if (length > FILE_MAX_BYTES) throw new HttpError(413, 'Files may contain at most 16 MiB.');
    if (typeof data.dataBase64 !== 'string' || data.dataBase64.length !== 4 * Math.ceil(length / 3)) throw new HttpError(400, 'File data must be canonical base64 matching its byte length.');
    const bytes = Buffer.from(data.dataBase64, 'base64');
    if (bytes.length !== length || bytes.toString('base64') !== data.dataBase64 || digest(bytes) !== expectedHash) throw new HttpError(400, 'File bytes do not match the supplied SHA-256 and byte length.', 'FILE_UPLOAD_MISMATCH');
    const media = inspectFileMedia(bytes);
    return this.mutation(() => {
      const sequence = this.database.prepare("SELECT value FROM sequences WHERE name='file'").get() as { value: number };
      if (!Number.isSafeInteger(sequence.value) || sequence.value < 0 || sequence.value >= 999_999_999_999_999) throw new HttpError(409, 'The supported file identifier limit has been reached.');
      const id = `F${sequence.value + 1}`; const now = new Date().toISOString();
      this.database.prepare("UPDATE sequences SET value=? WHERE name='file'").run(sequence.value + 1);
      const existing = this.database.prepare('SELECT byte_size,data FROM file_blobs WHERE sha256=?').get(expectedHash) as { byte_size: number; data: Uint8Array } | undefined;
      if (existing && (existing.byte_size !== length || !Buffer.from(existing.data).equals(bytes))) throw corrupt();
      if (!existing) {
        // Some supported Node SQLite versions bind an empty Uint8Array as NULL.
        if (length === 0) this.database.prepare('INSERT INTO file_blobs(sha256,byte_size,data) VALUES(?,0,zeroblob(0))').run(expectedHash);
        else this.database.prepare('INSERT INTO file_blobs(sha256,byte_size,data) VALUES(?,?,?)').run(expectedHash, length, bytes);
      }
      const file: FileRecord = { id, sha256: expectedHash, bytes: length, ...media, originalName, authorId, createdAt: now, name: originalName, altText, status: 'active', version: 1, updatedAt: now };
      this.database.prepare("INSERT INTO entities(id,kind,data) VALUES(?,'file',?)").run(id, JSON.stringify(file));
      this.database.prepare('INSERT INTO file_contents(file_id,sha256,byte_size,media_type,original_name,author_id,created_at,dimensions) VALUES(?,?,?,?,?,?,?,?)').run(id, expectedHash, length, media.mediaType, originalName, authorId, now, JSON.stringify(media.dimensions));
      this.append(file, { kind: 'upload', snapshot: file }, attribution, now);
      return file;
    });
  }
  list(query: FileListQuery = {}, visible: (id: string) => boolean = () => true): FilePage {
    const input = object(query, ['before', 'limit', 'name', 'authorId', 'status']);
    const status = input.status === undefined ? 'active' : choice(input.status, 'file status', ['active', 'archived', 'all']);
    const filters = ["kind='file'"]; const params: (string | number)[] = [];
    if (status !== 'all') { filters.push("json_extract(data,'$.status')=?"); params.push(status); }
    if (input.name !== undefined) { filters.push("instr(lower(json_extract(data,'$.name')),lower(?))>0"); params.push(string(input.name, 'File name filter', 240, true)); }
    if (input.authorId !== undefined) { filters.push("json_extract(data,'$.authorId')=?"); params.push(principal(input.authorId)); }
    const result = page((cursorQuery, count) => this.database.prepare(`SELECT rowid AS cursor,data FROM entities WHERE ${filters.join(' AND ')} AND rowid<? ORDER BY rowid DESC LIMIT ?`).all(...params, cursorQuery, count) as CursorRow[], row => JSON.parse(row.data) as FileRecord, file => visible(file.id), query.before, query.limit);
    return { files: result.values, nextBefore: result.nextBefore };
  }
  update(id: string, input: unknown, attribution: ActorAttribution): FileRecord {
    const data = object(input, ['expectedVersion', 'name', 'altText', 'status']);
    const expected = integer(data.expectedVersion, 'expectedVersion');
    if (Object.keys(data).every(key => key === 'expectedVersion')) throw new HttpError(400, 'At least one file field is required.');
    return this.mutation(() => {
      const current = this.get(id);
      if (current.version !== expected) throw new HttpError(409, 'This file changed. Reload before saving.');
      const updated: FileRecord = { ...current, name: data.name === undefined ? current.name : name(data.name), altText: data.altText === undefined ? current.altText : string(data.altText, 'Alt text', 10_000, true), status: data.status === undefined ? current.status : choice(data.status, 'file status', ['active', 'archived']) };
      const changes: FileFieldChange[] = [];
      for (const field of ['name', 'altText', 'status'] as const) if (updated[field] !== current[field]) changes.push({ field, oldValue: current[field], newValue: updated[field] });
      if (!changes.length) return current;
      updated.version = next(current.version); updated.updatedAt = new Date().toISOString();
      this.database.prepare("UPDATE entities SET data=? WHERE id=? AND kind='file'").run(JSON.stringify(updated), id);
      this.append(updated, { kind: 'edit', changes }, attribution, updated.updatedAt); return updated;
    });
  }
  readBytes(id: string): Uint8Array {
    const file = this.get(id);
    const blob = this.database.prepare('SELECT byte_size,data FROM file_blobs WHERE sha256=?').get(file.sha256) as { byte_size: number; data: Uint8Array } | undefined;
    if (!blob || blob.byte_size !== file.bytes || blob.data.byteLength !== file.bytes || digest(blob.data) !== file.sha256) throw corrupt();
    return Uint8Array.from(blob.data);
  }
  resolveAssets(input: unknown): Array<RevisionAsset & { data: Uint8Array }> {
    return revisionAssets(input).map(asset => {
      const file = this.get(asset.fileId);
      if (file.sha256 !== asset.sha256 || file.bytes !== asset.bytes || file.mediaType !== asset.mediaType) throw new HttpError(409, 'A binary asset does not match its immutable File identity.', 'ASSET_IDENTITY_MISMATCH');
      return { ...asset, data: this.readBytes(asset.fileId) };
    });
  }
  attachment(id: string, target: string): FileAttachment | null {
    fileId(id); objectId(target);
    const row = this.database.prepare('SELECT data FROM file_attachments WHERE file_id=? AND object_id=?').get(id, target) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as FileAttachment : null;
  }
  attachedObjectIds(id: string): string[] {
    fileId(id);
    return (this.database.prepare("SELECT object_id FROM file_attachments WHERE file_id=? AND mode='attach' ORDER BY object_id").all(id) as { object_id: string }[]).map(row => row.object_id);
  }
  attachments(id: string, query: { before?: number; limit?: number } = {}, visibleObject: (id: string) => boolean = () => true): FileAttachmentPage {
    this.get(id); object(query, ['before', 'limit']);
    const result = page((cursor, count) => this.database.prepare('SELECT rowid AS cursor,data FROM file_attachments WHERE file_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(id, cursor, count) as CursorRow[], row => JSON.parse(row.data) as FileAttachment, item => visibleObject(item.objectId), query.before, query.limit);
    return { attachments: result.values, nextBefore: result.nextBefore };
  }
  setAttachment(id: string, input: unknown, attribution: ActorAttribution): FileAttachment {
    const data = object(input, ['objectId', 'mode', 'expectedVersion', 'expectedAccessEpoch']);
    const target = objectId(data.objectId); const mode = choice(data.mode, 'attachment mode', ['attach', 'reference', 'detach']);
    const expected = nonnegative(data.expectedVersion, 'expectedVersion'); principal(attribution.principalId);
    if (data.expectedAccessEpoch !== undefined) nonnegative(data.expectedAccessEpoch, 'expectedAccessEpoch');
    return this.mutation(() => {
      const file = this.get(id);
      if (!this.database.prepare("SELECT 1 FROM entities WHERE id=? AND kind<>'file'").get(target)) throw new HttpError(404, 'Attachment target was not found.', 'OBJECT_UNAVAILABLE');
      const current = this.attachment(id, target);
      if ((current?.version ?? 0) !== expected) throw new HttpError(409, 'This file attachment changed. Reload before saving.');
      if (current?.mode === mode) return current;
      if (file.status === 'archived' && mode === 'attach') throw new HttpError(409, 'Restore this File before creating another attachment.');
      const now = new Date().toISOString();
      const attachment: FileAttachment = { fileId: id, objectId: target, mode, version: next(current?.version ?? 0), attacherId: attribution.principalId, createdAt: current?.createdAt ?? now, updatedAt: now };
      this.database.prepare('INSERT INTO file_attachments(file_id,object_id,mode,version,data) VALUES(?,?,?,?,?) ON CONFLICT(file_id,object_id) DO UPDATE SET mode=excluded.mode,version=excluded.version,data=excluded.data').run(id, target, mode, attachment.version, JSON.stringify(attachment));
      this.append(file, { kind: 'attachment', attachment: { ...attachment, oldMode: current?.mode ?? null } }, attribution, now);
      return attachment;
    });
  }
  history(id: string, before?: number, limit?: number, visibleObject: (id: string) => boolean = () => true): FileHistory {
    this.get(id);
    const result = page((cursor, count) => this.database.prepare('SELECT sequence AS cursor,data FROM file_transactions WHERE file_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(id, cursor, count) as CursorRow[], row => JSON.parse(row.data) as FileTransaction, item => !item.attachment || visibleObject(item.attachment.objectId), before, limit);
    return { transactions: result.values, nextBefore: result.nextBefore };
  }
  private append(file: FileRecord, fields: Pick<FileTransaction, 'kind' | 'snapshot' | 'changes' | 'attachment'>, attribution: ActorAttribution, createdAt: string): void {
    principal(attribution.principalId);
    const row = this.database.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM file_transactions WHERE file_id=?').get(file.id) as { sequence: number };
    const transaction: FileTransaction = { ...fields, id: randomUUID(), fileId: file.id, sequence: next(row.sequence), fileVersion: file.version, createdAt, attribution };
    this.database.prepare('INSERT INTO file_transactions(id,file_id,sequence,data) VALUES(?,?,?,?)').run(transaction.id, file.id, transaction.sequence, JSON.stringify(transaction));
  }
}
