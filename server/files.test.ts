import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActorAttribution } from '../shared/types.ts';
import type { FileRecord, RevisionAsset, UploadFileInput } from '../shared/files.ts';
import { FILE_MAX_BYTES } from '../shared/files.ts';
import { FileStore, initializeFiles, inspectFileMedia, revisionAssets } from './files.ts';

const actor: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'token-1', requestId: 'request-1' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function input(bytes: Uint8Array = png, name = 'figure.png'): UploadFileInput {
  return { name, dataBase64: Buffer.from(bytes).toString('base64'), bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function fixture(path = ':memory:') {
  const db = new DatabaseSync(path); db.exec("PRAGMA foreign_keys=ON; CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('file','revision','task','document')),data TEXT NOT NULL CHECK(json_valid(data))); CREATE TABLE sequences(name TEXT PRIMARY KEY,value INTEGER NOT NULL); INSERT INTO entities VALUES('P1','revision','{}'),('T1','task','{}'),('W1','document','{}');");
  initializeFiles(db); return { db, files: new FileStore(db), close: () => db.close() };
}
function asset(file: FileRecord, path = 'figures/plot.png'): RevisionAsset {
  assert.notEqual(file.mediaType, 'application/octet-stream');
  return { path, fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType as RevisionAsset['mediaType'] };
}
function count(db: DatabaseSync, table: string): number { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }

test('full uploads create independent immutable File identities while deduplicating verified bytes', () => {
  const { db, files, close } = fixture();
  try {
    const first = files.upload(input(), actor); const second = files.upload(input(png, 'another.png'), { ...actor, principalId: 'bob' });
    assert.equal(first.id, 'F1'); assert.equal(second.id, 'F2'); assert.equal(first.sha256, second.sha256);
    assert.equal(first.authorId, 'alice'); assert.equal(second.authorId, 'bob'); assert.deepEqual(first.dimensions, { width: 1, height: 1 });
    assert.equal(count(db, 'file_blobs'), 1); assert.equal(count(db, 'file_contents'), 2); assert.equal(count(db, 'file_transactions'), 2);
    const bytes = files.readBytes(first.id); assert.deepEqual(Buffer.from(bytes), png); bytes.fill(0); assert.deepEqual(Buffer.from(files.readBytes(first.id)), png);
    assert.deepEqual(files.history(first.id).transactions[0].snapshot, first); assert.deepEqual(files.history(first.id).transactions[0].attribution, actor);
    assert.throws(() => files.upload({ sha256: first.sha256, bytes: first.bytes, name: 'hash-only.png' }, actor), /canonical base64/);
    assert.throws(() => files.resolveAssets([{ ...asset(first), fileId: 'F999' }]), /not found/);
  } finally { close(); }
});

test('upload validates canonical base64, SHA, byte limits, safe names and empty files without partial writes', () => {
  const { db, files, close } = fixture();
  try {
    const one = input(Buffer.from([1]));
    for (const invalid of [
      { ...one, dataBase64: 'AR==' }, { ...one, dataBase64: 'AQ=\n' }, { ...one, bytes: 2 }, { ...one, sha256: '0'.repeat(64) },
      { ...one, bytes: FILE_MAX_BYTES + 1 }, { ...one, bytes: -1 }, { ...one, name: '../figure.png' }, { ...one, name: 'a\\figure.png' },
      { ...one, name: 'figure\n.png' }, { ...one, name: '\ud800' }, { ...one, mediaType: 'image/png' },
    ]) assert.throws(() => files.upload(invalid, actor));
    assert.equal(count(db, 'file_blobs'), 0); assert.equal(count(db, 'file_contents'), 0);
    assert.equal(db.prepare("SELECT value FROM sequences WHERE name='file'").get(), undefined);
    const empty = files.upload(input(Buffer.alloc(0), 'empty.txt'), actor);
    assert.equal(empty.bytes, 0); assert.equal(empty.mediaType, 'application/octet-stream'); assert.equal(files.readBytes(empty.id).byteLength, 0);
    const maximum = files.upload(input(Buffer.alloc(FILE_MAX_BYTES), 'maximum.bin'), actor);
    assert.equal(maximum.bytes, FILE_MAX_BYTES); assert.equal(files.readBytes(maximum.id).byteLength, FILE_MAX_BYTES);
  } finally { close(); }
});

test('media recognition uses bytes and bounded geometry, without trusting names or decoding image payloads', () => {
  assert.deepEqual(inspectFileMedia(png), { mediaType: 'image/png', dimensions: { width: 1, height: 1 } });
  const huge = Buffer.from(png); huge.writeUInt32BE(65_535, 16); assert.equal(inspectFileMedia(huge).mediaType, 'application/octet-stream');
  const manyPixels = Buffer.from(png); manyPixels.writeUInt32BE(16_384, 16); manyPixels.writeUInt32BE(16_384, 20); assert.equal(inspectFileMedia(manyPixels).mediaType, 'application/octet-stream');
  const invalidColor = Buffer.from(png); invalidColor[25] = 7; assert.equal(inspectFileMedia(invalidColor).mediaType, 'application/octet-stream');
  // Minimal SOF header fixture tests the bounded metadata parser, not a complete JPEG image.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xc0, 0, 11, 8, 0, 12, 0, 20, 1, 1, 0x11, 0]);
  assert.deepEqual(inspectFileMedia(jpeg), { mediaType: 'image/jpeg', dimensions: { width: 20, height: 12 } });
  assert.equal(inspectFileMedia(jpeg.subarray(0, jpeg.length - 1)).mediaType, 'application/octet-stream');
  const badLength = Buffer.from(jpeg); badLength.writeUInt16BE(65535, 4); assert.equal(inspectFileMedia(badLength).mediaType, 'application/octet-stream');
  const fill = Buffer.alloc(2 * 1024 * 1024, 255); fill[1] = 0xd8; assert.equal(inspectFileMedia(fill).mediaType, 'application/octet-stream');
  assert.equal(inspectFileMedia(Buffer.from('%PDF-1.7\nfixture')).mediaType, 'application/pdf');
  assert.equal(inspectFileMedia(Buffer.from('%PDF-2.0\rfixture')).mediaType, 'application/pdf');
  assert.equal(inspectFileMedia(Buffer.from('%PDF-1.7x')).mediaType, 'application/octet-stream');
  const highBits = Buffer.from('%PDF-1.7\n'); highBits[0] |= 0x80; assert.equal(inspectFileMedia(highBits).mediaType, 'application/octet-stream');
  assert.equal(inspectFileMedia(Buffer.from('<script>arbitrary upload</script>')).mediaType, 'application/octet-stream');
});

test('metadata uses optimistic versions, records immutable history, and leaves content identities unchanged', () => {
  const { db, files, close } = fixture();
  try {
    const made = files.upload(input(), actor);
    const updated = files.update(made.id, { expectedVersion: 1, name: 'renamed.png', altText: 'Chart of results', status: 'archived' }, actor);
    assert.equal(updated.version, 2); assert.equal(updated.originalName, 'figure.png'); assert.equal(updated.name, 'renamed.png');
    assert.equal(updated.sha256, made.sha256); assert.deepEqual(Buffer.from(files.readBytes(made.id)), png);
    assert.throws(() => files.update(made.id, { expectedVersion: 1, name: 'stale.png' }, actor), /changed/);
    assert.throws(() => files.update(made.id, { expectedVersion: 2, sha256: '0'.repeat(64) }, actor), /Unknown field/);
    assert.deepEqual(files.update(made.id, { expectedVersion: 2, name: updated.name }, actor), updated);
    const history = files.history(made.id); assert.equal(history.transactions.length, 2); assert.equal(history.transactions[0].changes?.length, 3); assert.equal(history.transactions[1].snapshot?.name, made.name);
    for (const field of ['sha256', 'bytes', 'originalName', 'authorId', 'createdAt', 'dimensions', 'id', 'mediaType']) {
      const changed = { ...updated, [field]: field === 'bytes' ? 1 : 'tampered' };
      assert.throws(() => db.prepare('UPDATE entities SET data=? WHERE id=?').run(JSON.stringify(changed), made.id), /immutable/);
    }
    for (const table of ['file_blobs', 'file_contents', 'file_transactions']) {
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable/);
    }
    assert.throws(() => db.exec("UPDATE file_blobs SET data=x'00'"), /immutable/);
    assert.throws(() => db.exec("UPDATE file_contents SET author_id='bob'"), /immutable/);
    assert.throws(() => db.exec("UPDATE file_transactions SET data='{}'"), /immutable/);
  } finally { close(); }
});

test('nested mutations roll back bytes, metadata, counters and attachment history together', () => {
  const { db, files, close } = fixture();
  try {
    db.exec('BEGIN');
    const made = files.upload(input(), actor);
    files.update(made.id, { expectedVersion: 1, altText: 'Temporary' }, actor);
    files.setAttachment(made.id, { objectId: 'P1', mode: 'attach', expectedVersion: 0 }, actor);
    db.exec('ROLLBACK');
    for (const table of ['file_blobs', 'file_contents', 'file_transactions', 'file_attachments']) assert.equal(count(db, table), 0);
    const real = files.upload(input(), actor); assert.equal(real.id, 'F1');
    db.exec("CREATE TRIGGER test_fail_history BEFORE INSERT ON file_transactions WHEN json_extract(NEW.data,'$.kind')='edit' BEGIN SELECT RAISE(ABORT,'test history failed'); END;");
    assert.throws(() => files.update(real.id, { expectedVersion: 1, name: 'failed.png' }, actor), /test history failed/);
    assert.deepEqual(files.get(real.id), real); assert.equal(files.history(real.id).transactions.length, 1);
    db.exec('DROP TRIGGER test_fail_history;');
    db.exec("CREATE TRIGGER test_fail_upload BEFORE INSERT ON file_transactions WHEN json_extract(NEW.data,'$.kind')='upload' BEGIN SELECT RAISE(ABORT,'test upload failed'); END;");
    assert.throws(() => files.upload(input(Buffer.from('different bytes')), actor), /test upload failed/);
    assert.equal(count(db, 'file_blobs'), 1); assert.equal(count(db, 'file_contents'), 1); assert.equal(db.prepare("SELECT value FROM sequences WHERE name='file'").get()!.value, 1);
  } finally { close(); }
});

test('attachment modes have independent optimistic versions and filter hidden target history', () => {
  const { files, close } = fixture();
  try {
    const file = files.upload(input(), actor);
    assert.equal(files.attachment(file.id, 'P1'), null);
    const reference = files.setAttachment(file.id, { objectId: 'P1', mode: 'reference', expectedVersion: 0 }, actor);
    assert.equal(reference.version, 1); assert.deepEqual(files.attachedObjectIds(file.id), []);
    assert.throws(() => files.setAttachment(file.id, { objectId: 'P1', mode: 'attach', expectedVersion: 0 }, actor), /changed/);
    const attached = files.setAttachment(file.id, { objectId: 'P1', mode: 'attach', expectedVersion: 1, expectedAccessEpoch: 10 }, actor);
    assert.equal(attached.version, 2); assert.deepEqual(files.attachedObjectIds(file.id), ['P1']);
    files.setAttachment(file.id, { objectId: 'T1', mode: 'attach', expectedVersion: 0 }, actor);
    assert.deepEqual(files.attachedObjectIds(file.id), ['P1', 'T1']);
    assert.throws(() => files.setAttachment(file.id, { objectId: file.id, mode: 'attach', expectedVersion: 0 }, actor));
    assert.throws(() => files.setAttachment(file.id, { objectId: 'P999', mode: 'attach', expectedVersion: 0 }, actor), /not found/);
    assert.deepEqual(files.attachments(file.id, {}, id => id === 'P1').attachments.map(item => item.objectId), ['P1']);
    assert.ok(files.history(file.id, undefined, 100, id => id === 'P1').transactions.every(item => item.attachment?.objectId !== 'T1'));
    files.update(file.id, { expectedVersion: 1, status: 'archived' }, actor);
    assert.deepEqual(files.setAttachment(file.id, { objectId: 'P1', mode: 'attach', expectedVersion: 2 }, actor), attached, 'unchanged grant can be replayed while archived');
    files.setAttachment(file.id, { objectId: 'P1', mode: 'detach', expectedVersion: 2 }, actor);
    assert.deepEqual(files.attachedObjectIds(file.id), ['T1']);
    assert.throws(() => files.setAttachment(file.id, { objectId: 'P1', mode: 'attach', expectedVersion: 3 }, actor), /Restore/);
    assert.throws(() => files.setAttachment(file.id, { objectId: 'W1', mode: 'attach', expectedVersion: 0 }, actor), /Restore/);
    assert.equal(files.resolveAssets([asset(file)])[0].sha256, file.sha256, 'archival/detach do not change pinned storage identity');
    assert.equal(files.get(file.id).version, 2, 'attachment versions do not silently change metadata version');
  } finally { close(); }
});

test('asset manifests require complete exact identities, safe unique paths, and bounded totals', () => {
  const { files, close } = fixture();
  try {
    const file = files.upload(input(), actor); const pinned = asset(file);
    const resolved = files.resolveAssets([pinned]); assert.deepEqual(Buffer.from(resolved[0].data), png);
    for (const invalid of [
      { ...pinned, sha256: '0'.repeat(64) }, { ...pinned, bytes: file.bytes + 1 }, { ...pinned, mediaType: 'application/pdf' },
    ]) assert.throws(() => files.resolveAssets([invalid]), /does not match/);
    for (const path of ['/root.png', '../a.png', 'a/../b.png', 'a//b.png', 'a\\b.png', 'a:b.png', 'a\u007fb.png', '\ud800.png']) assert.throws(() => files.resolveAssets([{ ...pinned, path }]), /safe relative/);
    assert.throws(() => files.resolveAssets([pinned, pinned]), /unique/);
    assert.throws(() => files.resolveAssets(Array.from({ length: 101 }, (_, i) => ({ ...pinned, path: `figure-${i}.png` }))), /at most 100/);
    assert.throws(() => revisionAssets(Array.from({ length: 5 }, (_, i) => ({ ...pinned, path: `figure-${i}.png`, bytes: FILE_MAX_BYTES }))), /byte limit/);
    const arbitrary = files.upload(input(Buffer.from('not an image'), 'misleading.png'), actor); assert.equal(arbitrary.mediaType, 'application/octet-stream');
    assert.throws(() => files.resolveAssets([{ ...pinned, fileId: arbitrary.id, sha256: arbitrary.sha256, bytes: arbitrary.bytes, mediaType: arbitrary.mediaType }]), /asset media type/);
    assert.deepEqual(files.resolveAssets([]), []);
  } finally { close(); }
});

test('stored-byte corruption fails closed on download, deduplication and asset resolution', () => {
  const { db, files, close } = fixture();
  try {
    const file = files.upload(input(), actor);
    db.exec('DROP TRIGGER file_blobs_no_update;');
    db.prepare('UPDATE file_blobs SET data=? WHERE sha256=?').run(Buffer.alloc(file.bytes), file.sha256);
    assert.throws(() => files.readBytes(file.id), /integrity/);
    assert.throws(() => files.resolveAssets([asset(file)]), /integrity/);
    assert.throws(() => files.upload(input(), actor), /integrity/);
    assert.equal(count(db, 'file_contents'), 1); assert.equal(db.prepare("SELECT value FROM sequences WHERE name='file'").get()!.value, 1);
  } finally { close(); }
});

test('metadata and history paging filter before limiting and bound long scans of invisible files', () => {
  const { files, close } = fixture();
  try {
    for (let index = 0; index < 1_005; index++) files.upload(input(png, `figure-${index}.png`), { ...actor, principalId: index % 2 ? 'bob' : 'alice' });
    const first = files.list({ limit: 2 }, id => ['F1005', 'F1003', 'F1'].includes(id));
    assert.deepEqual(first.files.map(file => file.id), ['F1005', 'F1003']); assert.ok(first.nextBefore);
    const second = files.list({ limit: 2, before: first.nextBefore! }, id => ['F1005', 'F1003', 'F1'].includes(id));
    const third = second.nextBefore ? files.list({ limit: 2, before: second.nextBefore }, id => id === 'F1') : null;
    assert.deepEqual([...second.files, ...(third?.files ?? [])].map(file => file.id), ['F1']);
    const empty = files.list({ limit: 1 }, id => id === 'F1'); assert.deepEqual(empty.files, []); assert.ok(empty.nextBefore);
    assert.deepEqual(files.list({ before: empty.nextBefore! }, id => id === 'F1').files.map(file => file.id), ['F1']);
    assert.ok(files.list({ authorId: 'bob', name: 'figure-100', limit: 100 }).files.every(file => file.authorId === 'bob' && file.name.includes('figure-100')));
    assert.throws(() => files.list({ limit: 101 }), /at most 100/);
    files.update('F1', { expectedVersion: 1, altText: 'one' }, actor); files.update('F1', { expectedVersion: 2, altText: 'two' }, actor);
    const history = files.history('F1', undefined, 2); assert.deepEqual(history.transactions.map(item => item.sequence), [3, 2]);
    assert.deepEqual(files.history('F1', history.nextBefore!, 2).transactions.map(item => item.sequence), [1]);
    files.update('F1', { expectedVersion: 3, status: 'archived' }, actor);
    assert.deepEqual(files.list({ status: 'archived' }).files.map(file => file.id), ['F1']);
  } finally { close(); }
});

test('File identities, attachment versions and histories survive reopening storage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phabricator-files-')); const path = join(directory, 'files.sqlite');
  const first = fixture(path);
  try {
    const made = first.files.upload(input(), actor); first.files.setAttachment(made.id, { objectId: 'P1', mode: 'attach', expectedVersion: 0 }, actor);
    const before = first.files.history(made.id); first.close();
    const reopened = new DatabaseSync(path); reopened.exec('PRAGMA foreign_keys=ON;');
    try {
      const files = new FileStore(reopened); assert.deepEqual(files.get(made.id), made); assert.deepEqual(files.history(made.id), before);
      assert.equal(files.attachment(made.id, 'P1')?.version, 1); assert.deepEqual(Buffer.from(files.readBytes(made.id)), png);
      assert.equal(reopened.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally { reopened.close(); }
  } finally { if (first.db.isOpen) first.close(); rmSync(directory, { recursive: true, force: true }); }
});
