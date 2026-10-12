import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store, contentHash, docxOperationHash, parseDocxImportInput, parseDocxReimportInput, parseDocxReplaceInput } from './store.ts';
import { PolicyStore, registerFilePolicy } from './policy.ts';
import { DOCX_LIMITS, type DocxProjection, type DocxSource, type DocxVersionPins } from '../shared/docx.ts';
import { sourceSnapshotCanonical, validateDocxSource } from '../shared/source-snapshot.ts';
import { inspectDocx, replaceDocx } from './docx-package.ts';
import type { ActorAttribution, RevisionDetail } from '../shared/types.ts';

const actor: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'docx-storage' };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Storage tests deliberately use a trusted engine-output fixture. Package validity
// and actual round trips are exercised separately by docx-package tests.
const packageBytes = Buffer.from('trusted package fixture');
function projection(text = 'Alpha 😀 beta'): DocxProjection {
  return { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [{ id: 'block', part: 'word/document.xml', kind: 'paragraph', runs: [{ text, rangeId: 'range' }], text }], notes: [], comments: [], changes: [], editableRanges: [{ id: 'range', part: 'word/document.xml', blockId: 'block', text }], warnings: [] };
}
function fixture(path = ':memory:') {
  const store = new Store({ path }), policies = new PolicyStore(store.database, { principalExists: id => ['alice', 'bob'].includes(id) });
  const upload = (bytes: Uint8Array = packageBytes) => {
    const file = store.files.upload({ name: 'manuscript.docx', dataBase64: Buffer.from(bytes).toString('base64'), sha256: sha(bytes), bytes: bytes.byteLength }, actor);
    registerFilePolicy(store.database, file.id, actor.principalId); return { fileId: file.id, sha256: file.sha256, bytes: file.bytes };
  };
  const create = (shareSource = false) => {
    const sourceFile = upload(); return store.createDocxRevision({ testPlan: 'Fixture verification plan.', title: 'Exact Word manuscript', sourceFile, expectedAccessEpoch: policies.epoch(), shareSource }, packageBytes, projection(), actor);
  };
  const pins = (detail: RevisionDetail): DocxVersionPins => { const version = detail.versions.at(-1)!; return { expectedVersion: version.number, expectedVersionId: version.id, expectedContentHash: version.contentHash, expectedAccessEpoch: policies.epoch() }; };
  return { store, policies, upload, create, pins };
}
const version = (detail: RevisionDetail) => detail.versions.at(-1)!;

test('DOCX canonical identity is deterministic, binds the complete package/projection, and preserves v1/v2 bytes', () => {
  const docx: DocxSource = { format: 'docx', fileName: 'manuscript.docx', sha256: sha(packageBytes), bytes: packageBytes.length, sourceFile: { fileId: 'F1', sha256: sha(packageBytes), bytes: packageBytes.length }, projection: projection() };
  const source = [{ path: 'z.tex', content: 'z\r\n' }, { path: 'a.tex', content: '\ufeffa' }];
  assert.equal(sourceSnapshotCanonical(source), JSON.stringify([source[1], source[0]]));
  const asset = { path: 'z.png', fileId: 'F2', sha256: 'a'.repeat(64), bytes: 2, mediaType: 'image/png' as const };
  assert.equal(sourceSnapshotCanonical(source, [asset]), JSON.stringify({ format: 'phabricator.source.v2', files: [source[1], source[0]], assets: [asset] }));
  const canonical = sourceSnapshotCanonical([], [], docx);
  assert.match(canonical, /phabricator.source.v3/);
  assert.equal(canonical, sourceSnapshotCanonical([], [], Object.fromEntries(Object.entries(docx).reverse()) as unknown as DocxSource));
  for (const changed of [{ ...docx, fileName: 'renamed.docx' }, { ...docx, sourceFile: { ...docx.sourceFile, fileId: 'F2' } }, { ...docx, projection: { ...docx.projection, warnings: ['Not rendered'] } }, { ...docx, sha256: 'f'.repeat(64) }]) assert.notEqual(contentHash([], [], changed), contentHash([], [], docx));
  assert.throws(() => sourceSnapshotCanonical(source, [], docx), /cannot also/);
  assert.throws(() => sourceSnapshotCanonical([], [asset], docx), /cannot also/);
  assert.throws(() => validateDocxSource({ ...docx, projection: { ...docx.projection, editableRanges: [{ ...docx.projection.editableRanges[0]!, blockId: 'missing' }] } }), /Invalid/);
  assert.throws(() => validateDocxSource({ ...docx, projection: { ...docx.projection, warnings: ['x'.repeat(DOCX_LIMITS.projectionBytes + 1)] } }), /Invalid/);
});

test('imports retain verified package bytes without manufacturing a File or implicitly sharing', () => {
  const { store, policies, create } = fixture();
  try {
    const detail = create(), current = version(detail), bytes = store.docxBytes(detail.revision.id, current.id);
    assert.equal(detail.revision.kind, 'document'); assert.match(detail.revision.id, /^L\d+$/); assert.deepEqual(current.files, []); assert.equal(current.assets, undefined);
    assert.equal(current.docx!.fileName, 'manuscript.docx'); assert.equal(current.contentHash, contentHash([], [], current.docx)); assert.deepEqual(current.attribution, actor);
    assert.deepEqual(Buffer.from(bytes), packageBytes); bytes.fill(0); assert.deepEqual(Buffer.from(store.docxBytes(detail.revision.id, current.id)), packageBytes);
    assert.equal(store.files.list({ status: 'all' }).files.length, 1); assert.deepEqual(store.files.attachments(current.docx!.sourceFile.fileId).attachments, []);
    assert.equal(policies.access(detail.revision.id, 'alice').view, true); assert.equal(policies.access(detail.revision.id, 'bob').view, false);
    const other = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'document', title: 'Other source', files: [{ path: 'prose.md', content: 'Other' }] });
    assert.throws(() => store.docxBytes(other.revision.id, current.id), { code: 'DOCX_VERSION_UNAVAILABLE' });
  } finally { store.close(); }
});

test('import validates exact source and attribution before any partial writes', () => {
  const { store, policies, upload } = fixture();
  try {
    const sourceFile = upload(), input = { testPlan: 'Fixture verification plan.', title: 'Import', sourceFile, expectedAccessEpoch: policies.epoch(), shareSource: false };
    for (const bad of [{ ...input, sourceFile: { ...sourceFile, bytes: sourceFile.bytes + 1 } }, { ...input, sourceFile: { ...sourceFile, sha256: '0'.repeat(64) } }, { ...input, expectedAccessEpoch: input.expectedAccessEpoch + 1 }]) assert.throws(() => store.createDocxRevision(bad, packageBytes, projection(), actor));
    assert.throws(() => store.createDocxRevision(input, Buffer.from('changed source bytes'), projection(), actor), { code: 'DOCX_SOURCE_MISMATCH' });
    assert.throws(() => store.createDocxRevision(input, packageBytes, projection(), undefined as unknown as ActorAttribution), /authenticated/);
    assert.throws(() => store.createDocxRevision(input, packageBytes, { ...projection(), format: 'forged' } as unknown as DocxProjection, actor), { code: 'DOCX_SOURCE_MISMATCH' });
    assert.equal(store.state({ configured: false, model: null }).revisions.length, 0);
    assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM revision_docx_packages').get()!.n, 0);
    assert.equal(store.database.prepare("SELECT value FROM sequences WHERE name='revision'").get(), undefined);
    store.files.update(sourceFile.fileId, { expectedVersion: 1, status: 'archived' }, actor);
    assert.throws(() => store.createDocxRevision(input, packageBytes, projection(), actor), { code: 'DOCX_FILE_ARCHIVED' });
  } finally { store.close(); }
});

test('replacement creates a new package version, retains original source access and rejects stale or split Unicode ranges', () => {
  const { store, create, pins } = fixture();
  try {
    const before = create(), old = version(before), input = { ...pins(before), rangeId: 'range', start: 0, end: 5, quote: 'Alpha', replacement: 'Gamma', message: 'Fix opening' };
    const changed = Buffer.from('trusted edited package fixture'), next = store.replaceDocxVersion(before.revision.id, input, changed, projection('Gamma 😀 beta'), actor), current = version(next);
    assert.equal(next.revision.currentVersion, 2); assert.equal(next.revision.status, 'needs_review'); assert.notEqual(current.contentHash, old.contentHash);
    assert.deepEqual(current.docx!.sourceFile, old.docx!.sourceFile); assert.deepEqual(next.versions[0], old); assert.deepEqual(Buffer.from(store.docxBytes(next.revision.id, current.id)), changed);
    assert.deepEqual(Buffer.from(store.docxBytes(next.revision.id, old.id)), packageBytes); assert.equal(store.files.list({ status: 'all' }).files.length, 1);
    assert.throws(() => store.replaceDocxVersion(next.revision.id, input, changed, projection('Gamma 😀 beta'), actor), /changed/);
    const pin = pins(next);
    for (const bad of [{ start: 6, end: 7, quote: '\ud83d' }, { start: 7, end: 7, quote: '' }, { start: 0, end: 5, quote: 'wrong' }]) assert.throws(() => store.replaceDocxVersion(next.revision.id, { ...input, ...pin, ...bad }, changed, projection(), actor));
    assert.equal(store.detail(next.revision.id).versions.length, 2);
  } finally { store.close(); }
});

test('no-op replacement preserves the exact version and rejects a changed package or projection', () => {
  const { store, create, pins } = fixture();
  try {
    const before = create(), input = { ...pins(before), rangeId: 'range', start: 0, end: 5, quote: 'Alpha', replacement: 'Alpha', message: 'Same text' };
    assert.deepEqual(store.replaceDocxVersion(before.revision.id, input, packageBytes, projection(), actor), before);
    assert.throws(() => store.replaceDocxVersion(before.revision.id, input, Buffer.from('not unchanged'), projection(), actor), { code: 'DOCX_SOURCE_MISMATCH' });
    assert.throws(() => store.replaceDocxVersion(before.revision.id, input, packageBytes, projection('New projection'), actor), { code: 'DOCX_SOURCE_MISMATCH' });
    assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM revision_docx_packages').get()!.n, 1);
  } finally { store.close(); }
});

test('sharing is explicit, historical sources gate access after reimport, and revocation is immediate', () => {
  const { store, policies, create, upload, pins } = fixture();
  try {
    const first = create(true), old = version(first); assert.equal(policies.access(first.revision.id, 'bob').view, true);
    assert.equal(store.files.attachment(old.docx!.sourceFile.fileId, first.revision.id)?.mode, 'attach');
    const secondBytes = Buffer.from('another original package'), sourceFile = upload(secondBytes);
    const next = store.createDocxVersion(first.revision.id, { ...pins(first), sourceFile, shareSource: true, message: 'Reimport edited Word package' }, secondBytes, projection('New original'), actor);
    assert.equal(policies.access(next.revision.id, 'bob').view, true); assert.equal(version(next).docx!.sourceFile.fileId, sourceFile.fileId);
    store.files.setAttachment(old.docx!.sourceFile.fileId, { objectId: next.revision.id, mode: 'detach', expectedVersion: 1 }, actor);
    assert.equal(policies.access(next.revision.id, 'bob').view, false, 'old imported source still gates all historical document content');
    assert.equal(policies.access(next.revision.id, 'alice').view, true);
    assert.equal(policies.access(sourceFile.fileId, 'bob').view, false, 'a circular document grant cannot bypass the hidden historical source');
  } finally { store.close(); }
});

test('repeated historical package dependencies do not exhaust the graph budget', () => {
  const { store, policies, create } = fixture();
  try {
    const detail = create(true), initial = version(detail);
    const insert = store.database.prepare('INSERT INTO versions(id,revision_id,number,data) VALUES(?,?,?,?)');
    store.transaction(() => { for (let number = 2; number <= 1222; number++) { const item = { ...initial, id: randomUUID(), number }; insert.run(item.id, item.revisionId, number, JSON.stringify(item)); } });
    assert.equal(policies.access(detail.revision.id, 'bob').view, true);
  } finally { store.close(); }
});

test('DOCX packages and version snapshots are immutable, and reads detect corrupt persisted bytes', () => {
  const { store, create } = fixture();
  try {
    const detail = create(), current = version(detail);
    for (const sql of ['UPDATE revision_docx_packages SET data=data', 'DELETE FROM revision_docx_packages', 'UPDATE versions SET data=data', 'DELETE FROM versions']) assert.throws(() => store.database.exec(sql), /immutable/);
    store.database.exec('DROP TRIGGER revision_docx_packages_no_update');
    store.database.prepare('UPDATE revision_docx_packages SET data=?').run(Buffer.alloc(packageBytes.length));
    assert.throws(() => store.docxBytes(detail.revision.id, current.id), { code: 'DOCX_SOURCE_MISMATCH' });
  } finally { store.close(); }
});

test('a failed package write rolls back revision, sequence, attachment, epoch and activity together', () => {
  const { store, policies, upload } = fixture();
  try {
    const sourceFile = upload(), epoch = policies.epoch();
    store.database.exec("CREATE TRIGGER reject_docx BEFORE INSERT ON revision_docx_packages BEGIN SELECT RAISE(ABORT,'injected package failure'); END;");
    assert.throws(() => store.createDocxRevision({ testPlan: 'Fixture verification plan.', title: 'Atomic import', sourceFile, expectedAccessEpoch: epoch, shareSource: true }, packageBytes, projection(), actor), /injected package failure/);
    assert.equal(policies.epoch(), epoch); assert.deepEqual(store.files.attachments(sourceFile.fileId).attachments, []); assert.deepEqual(store.activities(), []);
    assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM versions').get()!.n, 0); assert.equal(store.database.prepare("SELECT value FROM sequences WHERE name='revision'").get(), undefined);
    store.database.exec('DROP TRIGGER reject_docx');
    assert.equal(store.createDocxRevision({ testPlan: 'Fixture verification plan.', title: 'Atomic import', sourceFile, expectedAccessEpoch: epoch, shareSource: true }, packageBytes, projection(), actor).revision.id, 'L1');
  } finally { store.close(); }
});

test('generic text edits and review cannot silently operate on DOCX snapshots; import shapes reject client projections', () => {
  const { store, create, pins } = fixture();
  try {
    const detail = create(), current = version(detail);
    assert.throws(() => store.createVersion(detail.revision.id, { expectedVersion: 1, files: [{ path: 'lost.md', content: 'Flattened' }], message: 'Discard package' }), { code: 'DOCX_OPERATION_UNSUPPORTED' });
    assert.throws(() => store.saveReview(detail.revision.id, 1, { summary: 'Empty files', findings: [], provider: 'local', model: 'local' }), { code: 'DOCX_OPERATION_UNSUPPORTED' });
    assert.throws(() => parseDocxImportInput({ testPlan: 'Fixture verification plan.', title: 'Spoof', sourceFile: current.docx!.sourceFile, shareSource: false, expectedAccessEpoch: 1, projection: projection() }), /Unknown field/);
    assert.throws(() => parseDocxReimportInput({ ...pins(detail), sourceFile: current.docx!.sourceFile, shareSource: false, message: 'Spoof', bytes: [1] }), /Unknown field/);
    assert.throws(() => parseDocxReplaceInput({ ...pins(detail), rangeId: 'range', start: 0, end: 1, quote: 'A', replacement: 'B', message: 'Spoof', xml: '<bad/>' }), /Unknown field/);
    assert.equal(store.detail(detail.revision.id).versions.length, 1);
  } finally { store.close(); }
});

test('schema18 to19 is additive and preserves all existing raw rows, schema and foreign keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'docx-migration-')), path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Legacy bytes', kind: 'document', files: [{ path: 'old.md', content: '\ufeffExact\r\nsource 😀' }] }, actor);
    store.database.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run('old', 'old-request', 201, '{ "keep" : "formatting" }', '2025-01-01');
    store.database.exec("DROP TABLE wiki_conduit_receipts; DROP TABLE wiki_content_identifiers; DROP TABLE wiki_document_identifiers; DROP TABLE wiki_transactions; DROP TABLE wiki_publication; DROP TABLE wiki_cursor_secret; DROP TABLE wiki_locations; DROP TABLE revision_docx_packages; DROP TRIGGER docx_versions_no_update; DROP TRIGGER docx_versions_no_delete; CREATE VIEW legacy_versions AS SELECT id,data FROM versions; CREATE INDEX legacy_versions_number ON versions(number); PRAGMA user_version=18;");
    const schemas = store.database.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
    const tables = (store.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name);
    const rows = new Map(tables.map(name => [name, store.database.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()]));
    store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 33);
    for (const schema of schemas) assert.equal(store.database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(schema.name)!.sql, schema.sql, schema.name);
    for (const [name, before] of rows) assert.deepEqual(store.database.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all(), before, name);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(store.database.prepare('SELECT * FROM revision_docx_packages').all(), []);
    store.close(); store = new Store({ path }); assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 33);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema19 failure is atomic and leaves schema18 reopenable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'docx-migration-failure-')), path = join(directory, 'workspace.sqlite'); const first = new Store({ path });
  first.database.exec('DROP TABLE wiki_conduit_receipts; DROP TABLE wiki_content_identifiers; DROP TABLE wiki_document_identifiers; DROP TABLE wiki_transactions; DROP TABLE wiki_publication; DROP TABLE wiki_cursor_secret; DROP TABLE wiki_locations; DROP TABLE revision_docx_packages; DROP TRIGGER docx_versions_no_update; DROP TRIGGER docx_versions_no_delete; PRAGMA user_version=18;'); first.close();
  const exec = DatabaseSync.prototype.exec;
  try {
    DatabaseSync.prototype.exec = function(sql: string) { if (sql.includes('PRAGMA user_version = 19')) { exec.call(this, sql.replace('PRAGMA user_version = 19;', '')); throw new Error('injected schema19 failure'); } return exec.call(this, sql); };
    assert.throws(() => new Store({ path }), /injected schema19 failure/);
  } finally { DatabaseSync.prototype.exec = exec; }
  try {
    const db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 18); assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='revision_docx_packages'").get(), undefined); db.close();
    const reopened = new Store({ path }); assert.equal(reopened.database.prepare('PRAGMA user_version').get()!.user_version, 33); reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('real parsed Word import and tracked replacement persist exact original and exported package identities', async () => {
  const { store, policies, upload, pins } = fixture();
  try {
    const original = readFileSync(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url)), parsed = await inspectDocx(original), sourceFile = upload(original);
    const detail = store.createDocxRevision({ testPlan: 'Fixture verification plan.', title: 'Real DOCX fixture', sourceFile, expectedAccessEpoch: policies.epoch(), shareSource: false }, original, parsed, actor);
    assert.deepEqual(Buffer.from(store.docxBytes(detail.revision.id, version(detail).id)), original);
    const range = parsed.editableRanges.find(item => item.text === 'The original result is clear.'); assert.ok(range);
    const input = { ...pins(detail), rangeId: range.id, start: 4, end: 12, quote: 'original', replacement: 'revised', message: 'Revise claim' };
    const changed = await replaceDocx(original, input, { author: actor.displayName, date: '2026-10-11T12:00:00Z' });
    const saved = store.replaceDocxVersion(detail.revision.id, input, changed.bytes, changed.projection, actor), current = version(saved);
    assert.equal(current.docx!.sha256, sha(changed.bytes)); assert.deepEqual(current.docx!.projection, changed.projection); assert.deepEqual(current.docx!.sourceFile, sourceFile);
    assert.deepEqual(Buffer.from(store.docxBytes(detail.revision.id, current.id)), Buffer.from(changed.bytes));
    assert.deepEqual(await inspectDocx(store.docxBytes(detail.revision.id, current.id)), changed.projection);
    assert.deepEqual(saved.versions[0]!.docx!.projection, parsed); assert.equal(store.files.list().files.length, 1);
  } finally { store.close(); }
});

test('immutable DOCX operation provenance binds complete import, reimport and replacement requests', () => {
  const { store, policies, upload, pins } = fixture();
  try {
    const sourceFile = upload(), input = { testPlan: 'Fixture verification plan.', title: 'Exact request', sourceFile, expectedAccessEpoch: policies.epoch(), shareSource: false };
    const imported = store.createDocxRevision(input, packageBytes, projection(), actor);
    assert.deepEqual(version(imported).docxOperation, { kind: 'import', inputSha256: docxOperationHash(input) });
    assert.equal(docxOperationHash(input), docxOperationHash({ ...input, summary: '' }), 'normalized optional summary uses one request identity');
    assert.notEqual(docxOperationHash(input), docxOperationHash({ ...input, shareSource: true }));
    const reimportInput = { ...pins(imported), sourceFile, shareSource: false, message: 'Same actor and message' };
    const reimported = store.createDocxVersion(imported.revision.id, reimportInput, packageBytes, projection(), actor);
    assert.deepEqual(version(reimported).docxOperation, { kind: 'reimport', inputSha256: docxOperationHash(reimportInput) });
    const replaceInput = { ...pins(reimported), rangeId: 'range', start: 0, end: 5, quote: 'Alpha', replacement: 'Gamma', message: 'Same actor and message' };
    const changed = store.replaceDocxVersion(imported.revision.id, replaceInput, Buffer.from('edited package'), projection('Gamma 😀 beta'), actor);
    const provenance = version(changed).docxOperation!;
    assert.deepEqual(provenance, { kind: 'replace', inputSha256: docxOperationHash(replaceInput) });
    for (const altered of [{ ...replaceInput, replacement: 'Omega' }, { ...replaceInput, rangeId: 'other range' }, { ...replaceInput, expectedContentHash: 'f'.repeat(64) }, { ...replaceInput, message: `${replaceInput.message} ` }]) assert.notEqual(provenance.inputSha256, docxOperationHash(altered));
    assert.throws(() => store.database.prepare("UPDATE versions SET data=json_set(data,'$.docxOperation.inputSha256',?) WHERE id=?").run('f'.repeat(64), version(changed).id), /immutable/);
    const noop = { ...replaceInput, ...pins(changed), quote: 'Gamma', replacement: 'Gamma' };
    const unchanged = store.replaceDocxVersion(imported.revision.id, noop, Buffer.from('edited package'), projection('Gamma 😀 beta'), actor);
    assert.deepEqual(version(unchanged).docxOperation, provenance, 'no-op never rewrites original mutation provenance');
  } finally { store.close(); }
});
