import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActorAttribution, RevisionVersion, SourceFile } from '../shared/types.ts';
import type { CitationEvidenceInput, CitationEvidenceRecord } from '../shared/citation-evidence.ts';
import type { FileRecord } from '../shared/files.ts';
import { analyzeCitations } from '../shared/citations.ts';
import { sourceSnapshotCanonical } from '../shared/source-snapshot.ts';
import { FileStore, initializeFiles } from './files.ts';
import { CitationEvidenceStore, initializeCitationEvidence, parseCitationEvidenceInput } from './citation-evidence.ts';

const actor: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'token-alice', requestId: 'request-evidence' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: null, requestId: 'retract-evidence' };
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sourceFiles: SourceFile[] = [{ path: 'main.tex', content: 'A claim \\cite{proof}.\n' }, { path: 'references.bib', content: '@article{proof,\n title={Original report},\n author={A. Researcher},\n year={2020}\n}\n' }];

function fixture(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE versions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),number INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,number));
    CREATE TABLE sequences(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
    INSERT INTO entities VALUES('P1','revision','{}'),('P2','revision','{}');
  `);
  initializeFiles(db); initializeCitationEvidence(db);
  const files = new FileStore(db); const evidence = new CitationEvidenceStore(db, files);
  function upload(content = '%PDF-1.4\nThe measured effect was positive.\n'): FileRecord {
    const bytes = Buffer.from(content); return files.upload({ name: 'supporting-report.pdf', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: digest(bytes) }, actor);
  }
  function saveVersion(number = 1, inputFiles = sourceFiles, revisionId = 'P1', assets: RevisionVersion['assets'] = undefined): RevisionVersion {
    const version: RevisionVersion = { id: randomUUID(), revisionId, number, files: inputFiles, ...(assets ? { assets } : {}), contentHash: digest(sourceSnapshotCanonical(inputFiles, assets)), message: 'Saved source', createdAt: new Date().toISOString() };
    db.prepare('INSERT INTO versions(id,revision_id,number,data) VALUES(?,?,?,?)').run(version.id, revisionId, number, JSON.stringify(version)); return version;
  }
  function input(version: RevisionVersion, file: FileRecord, kind: 'entry' | 'citation' = 'entry'): CitationEvidenceInput {
    const inventory = analyzeCitations(version.files); const target = kind === 'entry' ? inventory.entries[0] : inventory.citations[0];
    assert.ok(target, 'fixture must expose a concrete citation target');
    return { versionId: version.id, contentHash: version.contentHash, targetId: target.id, source: { fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType }, verdict: 'supports', quote: '  The measured effect\nwas positive.  ', locator: '  page 12, paragraph 3  ', note: '  I read the supporting report.  ', attested: true, expectedAccessEpoch: 1 };
  }
  return { db, files, evidence, upload, saveVersion, input, close: () => db.close() };
}

function count(db: DatabaseSync, table = 'citation_evidence'): number { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }

test('evidence pins the exact target and File identity, preserves quoted text, and never grants File access', () => {
  const { db, files, evidence, upload, saveVersion, input, close } = fixture();
  try {
    const version = saveVersion(); const file = upload(); const request = input(version, file);
    const beforeFile = files.get(file.id); const beforeHistory = files.history(file.id);
    const selected = evidence.validateCreate('P1', request);
    const record = evidence.create('P1', request, actor);
    assert.deepEqual(record.source, request.source); assert.deepEqual(record.target, selected.target);
    assert.equal(record.target.kind, 'entry'); assert.equal(record.target.key, 'proof'); assert.equal(record.versionNumber, 1);
    assert.equal(record.quote, request.quote); assert.equal(record.locator, 'page 12, paragraph 3'); assert.equal(record.note, 'I read the supporting report.');
    assert.equal(record.basis, 'reviewer-attestation'); assert.equal(record.state, 'active'); assert.equal(record.recordVersion, 1);
    assert.deepEqual(record.attribution, actor); assert.deepEqual(evidence.get('P1', record.id), record);
    assert.deepEqual(files.get(file.id), beforeFile); assert.deepEqual(files.history(file.id), beforeHistory); assert.equal(count(db, 'file_attachments'), 0);
    assert.equal('expectedAccessEpoch' in record, false); assert.equal('attested' in record, false);
    files.update(file.id, { expectedVersion: 1, name: 'Renamed supporting report', status: 'archived' }, actor);
    assert.deepEqual(evidence.get('P1', record.id), record, 'mutable metadata does not rewrite the evidence source');
    const occurrence = evidence.create('P1', { ...input(version, file, 'citation'), verdict: 'inconclusive' }, bob);
    assert.equal(occurrence.target.kind, 'citation'); assert.equal(occurrence.verdict, 'inconclusive');
    assert.throws(() => evidence.get('P2', record.id), { status: 404, code: 'CITATION_EVIDENCE_UNAVAILABLE' });
  } finally { close(); }
});

test('historical source selection never follows current text and recomputes text and asset identity', () => {
  const { db, evidence, upload, saveVersion, input, close } = fixture();
  try {
    const file = upload(); const old = saveVersion(); const request = input(old, file);
    const current = saveVersion(2, sourceFiles.map(item => ({ ...item, content: `\n${item.content}` })));
    const record = evidence.create('P1', request, actor);
    assert.equal(record.versionId, old.id); assert.equal(record.contentHash, old.contentHash); assert.equal(record.versionNumber, 1);
    assert.throws(() => evidence.create('P1', { ...request, versionId: current.id }, actor), { status: 409, code: 'CITATION_SOURCE_MISMATCH' });
    assert.throws(() => evidence.create('P1', { ...request, targetId: input(current, file).targetId }, actor), { status: 404, code: 'CITATION_TARGET_UNAVAILABLE' });
    assert.throws(() => evidence.create('P2', request, actor), { status: 404, code: 'CITATION_VERSION_UNAVAILABLE' });
    assert.throws(() => evidence.create('P1', { ...request, versionId: 'absent' }, actor), { status: 404, code: 'CITATION_VERSION_UNAVAILABLE' });
    const asset = { path: 'figure.pdf', fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: 'application/pdf' as const };
    const withAsset = saveVersion(3, sourceFiles, 'P1', [asset]);
    assert.equal(evidence.create('P1', input(withAsset, file), actor).contentHash, withAsset.contentHash);
    db.prepare('UPDATE versions SET data=? WHERE id=?').run(JSON.stringify({ ...withAsset, assets: [{ ...asset, path: 'different.pdf' }] }), withAsset.id);
    assert.throws(() => evidence.create('P1', input(withAsset, file), actor), { status: 409, code: 'CITATION_SOURCE_MISMATCH' });
    db.prepare('UPDATE versions SET data=? WHERE id=?').run(JSON.stringify({ ...old, files: [{ path: 'main.tex', content: 'tampered' }] }), old.id);
    assert.throws(() => evidence.create('P1', request, actor), { status: 409, code: 'CITATION_SOURCE_MISMATCH' });
    assert.equal(count(db), 2, 'invalid pin attempts never write records');
  } finally { close(); }
});

test('supporting File pins and actual blob integrity are checked without accepting a hash-only claim', () => {
  const { db, evidence, upload, saveVersion, input, close } = fixture();
  try {
    const version = saveVersion(); const file = upload(); const request = input(version, file);
    for (const source of [{ ...request.source, sha256: '0'.repeat(64) }, { ...request.source, bytes: file.bytes + 1 }, { ...request.source, mediaType: 'application/octet-stream' }]) {
      assert.throws(() => evidence.create('P1', { ...request, source }, actor), { status: 409, code: 'CITATION_FILE_MISMATCH' });
    }
    assert.throws(() => evidence.create('P1', { ...request, source: { ...request.source, fileId: 'F9999' } }, actor), { status: 404, code: 'FILE_UNAVAILABLE' });
    db.exec('DROP TRIGGER file_blobs_no_update;');
    db.prepare('UPDATE file_blobs SET data=? WHERE sha256=?').run(Buffer.alloc(file.bytes, 65), file.sha256);
    assert.throws(() => evidence.create('P1', request, actor), { status: 409, code: 'FILE_INTEGRITY' });
    assert.equal(count(db), 0);
  } finally { close(); }
});

test('legacy Git text-only names remain exact even when the newer binary namespace would reject them', () => {
  const { evidence, upload, saveVersion, input, close } = fixture();
  try {
    const files = [
      { path: 'A.tex', content: 'A claim \\cite{proof}.' },
      { path: 'a.tex', content: 'A distinct case-sensitive source path.' },
      { path: 'notes:old.tex', content: 'A legacy Git filename.' },
      sourceFiles[1]!,
    ];
    const version = saveVersion(1, files); const request = input(version, upload());
    const record = evidence.create('P1', request, actor);
    assert.equal(record.contentHash, digest(sourceSnapshotCanonical(files)));
    assert.equal(record.target.filePath, 'references.bib');
    assert.equal(evidence.create('P1', { ...request, targetId: analyzeCitations(files).citations[0]!.id }, actor).target.filePath, 'A.tex');
  } finally { close(); }
});

test('fresh attestation requires a concrete citation target even when diagnostics are truncated', () => {
  const { evidence, upload, saveVersion, input, db, close } = fixture();
  try {
    const version = saveVersion(1, [{ path: 'main.tex', content: `${Array.from({ length: 1_100 }, () => '\\cite{\\generated}').join('\n')}\n\\nocite{*}\n\\cite{missing}\n` }]);
    const inventory = analyzeCitations(version.files); const file = upload();
    const base = input(version, file, 'citation');
    const dynamic = inventory.citations[1_099]!; const wildcard = inventory.citations.find(item => item.key === '*')!; const literal = inventory.citations.find(item => item.key === 'missing')!;
    assert.ok(dynamic && wildcard && literal, 'the fixture reaches targets after the diagnostic cap');
    assert.equal(inventory.diagnostics.some(item => item.start === dynamic.start && item.code === 'dynamic_key'), false);
    for (const target of [dynamic, wildcard]) assert.throws(() => evidence.create('P1', { ...base, targetId: target.id }, actor), { status: 404, code: 'CITATION_TARGET_UNAVAILABLE' });
    assert.equal(evidence.create('P1', { ...base, targetId: literal.id }, actor).target.key, 'missing', 'a literal unresolved citation is still an exact occurrence');
    assert.equal(count(db), 1);
  } finally { close(); }
});

test('pure input validation bounds required text and requires an explicit attestation', () => {
  const { evidence, upload, saveVersion, input, db, close } = fixture();
  try {
    const valid = input(saveVersion(), upload());
    assert.equal(parseCitationEvidenceInput(valid).quote, valid.quote);
    for (const invalid of [
      { ...valid, attested: false }, { ...valid, attested: undefined }, { ...valid, quote: ' \n ' }, { ...valid, quote: 'x'.repeat(10_001) },
      { ...valid, locator: '' }, { ...valid, locator: 'x'.repeat(1_001) }, { ...valid, note: '' }, { ...valid, note: 'x'.repeat(10_001) },
      { ...valid, verdict: 'verified' }, { ...valid, source: { sha256: valid.source.sha256 } }, { ...valid, expectedAccessEpoch: -1 },
      { ...valid, expectedAccessEpoch: undefined }, { ...valid, contentHash: valid.contentHash.toUpperCase() }, { ...valid, url: 'https://example.com/claim' },
      { ...valid, source: { ...valid.source, bytes: 16 * 1024 * 1024 + 1 } }, { ...valid, targetId: 'x'.repeat(4_097) },
    ]) assert.throws(() => evidence.create('P1', invalid, actor), { status: 400 });
    assert.equal(count(db), 0);
  } finally { close(); }
});

test('retraction is a separate one-time append and both records reject update and delete', () => {
  const { db, evidence, upload, saveVersion, input, close } = fixture();
  try {
    const record = evidence.create('P1', input(saveVersion(), upload()), actor);
    const original = (db.prepare('SELECT data FROM citation_evidence WHERE id=?').get(record.id) as { data: string }).data;
    assert.throws(() => evidence.retract('P1', record.id, { expectedRecordVersion: 2, reason: 'Wrong version' }, actor), { status: 409, code: 'CITATION_EVIDENCE_CHANGED' });
    const retracted = evidence.retract('P1', record.id, { expectedRecordVersion: 1, reason: '  I misread the reported result.  ' }, bob);
    assert.equal(retracted.state, 'retracted'); assert.equal(retracted.recordVersion, 2);
    assert.equal(retracted.retraction?.reason, 'I misread the reported result.'); assert.deepEqual(retracted.retraction?.attribution, bob);
    assert.deepEqual(evidence.get('P1', record.id), retracted);
    assert.equal((db.prepare('SELECT data FROM citation_evidence WHERE id=?').get(record.id) as { data: string }).data, original);
    for (const version of [1, 2]) assert.throws(() => evidence.retract('P1', record.id, { expectedRecordVersion: version, reason: 'Again' }, actor), { status: 409, code: 'CITATION_EVIDENCE_CHANGED' });
    for (const table of ['citation_evidence', 'citation_evidence_retractions']) {
      assert.throws(() => db.exec(`UPDATE ${table} SET data='{}'`), /immutable/);
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable/);
    }
    assert.equal(count(db), 1); assert.equal(count(db, 'citation_evidence_retractions'), 1);
  } finally { close(); }
});

test('nested mutations roll back evidence, retractions and sequence allocation together', () => {
  const { db, evidence, upload, saveVersion, input, close } = fixture();
  try {
    const request = input(saveVersion(), upload());
    db.exec('BEGIN'); const rolledBack = evidence.create('P1', request, actor); db.exec('ROLLBACK');
    assert.equal(count(db), 0); assert.throws(() => evidence.get('P1', rolledBack.id), { status: 404, code: 'CITATION_EVIDENCE_UNAVAILABLE' });
    const record = evidence.create('P1', request, actor);
    assert.equal((db.prepare('SELECT sequence FROM citation_evidence WHERE id=?').get(record.id) as { sequence: number }).sequence, 1);
    db.exec('BEGIN'); evidence.retract('P1', record.id, { expectedRecordVersion: 1, reason: 'Rolled back' }, actor); db.exec('ROLLBACK');
    assert.equal(evidence.get('P1', record.id).state, 'active'); assert.equal(count(db, 'citation_evidence_retractions'), 0);
    db.exec("CREATE TRIGGER fail_evidence_insert BEFORE INSERT ON citation_evidence BEGIN SELECT RAISE(ABORT,'injected write failure'); END;");
    assert.throws(() => evidence.create('P1', request, actor), /injected write failure/); assert.equal(count(db), 1);
  } finally { close(); }
});

test('pagination filters current File visibility before limits and stays scoped to version and target', () => {
  const { evidence, upload, saveVersion, input, close } = fixture();
  try {
    const first = saveVersion(); const second = saveVersion(2); const visible = upload(); const hidden = upload();
    const a = evidence.create('P1', input(first, visible), actor);
    evidence.create('P1', input(first, hidden), actor);
    const b = evidence.create('P1', input(first, visible), actor);
    const citation = evidence.create('P1', input(first, visible, 'citation'), actor);
    evidence.create('P1', input(second, visible), actor);
    evidence.retract('P1', b.id, { expectedRecordVersion: 1, reason: 'Withdrawn' }, actor);
    const canView = (id: string) => id === visible.id;
    const page = evidence.list('P1', { versionId: first.id, targetId: a.target.id, limit: 1 }, canView);
    assert.deepEqual(page.records.map(record => [record.id, record.state]), [[b.id, 'retracted']]); assert.ok(page.nextBefore);
    const next = evidence.list('P1', { versionId: first.id, targetId: a.target.id, limit: 1, before: page.nextBefore! }, canView);
    assert.deepEqual(next.records.map(record => record.id), [a.id]); assert.equal(next.nextBefore, null);
    assert.deepEqual(evidence.list('P1', { versionId: first.id }, canView).records.map(record => record.id), [citation.id, b.id, a.id]);
    assert.deepEqual(evidence.list('P1', { versionId: first.id }, () => false), { records: [], nextBefore: null });
    for (const query of [{ versionId: first.id, limit: 101 }, { versionId: first.id, before: 0 }, { versionId: first.id, limit: 1.5 }, { versionId: first.id, unknown: true }]) assert.throws(() => evidence.list('P1', query, canView), { status: 400 });
    assert.throws(() => evidence.list('P2', { versionId: first.id }, canView), { status: 404, code: 'CITATION_VERSION_UNAVAILABLE' });
  } finally { close(); }
});

test('a long hidden prefix has bounded visibility checks and a continuation even with no visible records', () => {
  const { db, evidence, upload, saveVersion, input, close } = fixture();
  try {
    const version = saveVersion(); const visible = upload(); const hidden = upload();
    const original = evidence.create('P1', input(version, visible), actor);
    db.exec('BEGIN');
    for (let index = 0; index < 1_005; index++) {
      const record: CitationEvidenceRecord = { ...original, id: randomUUID(), source: { fileId: hidden.id, sha256: hidden.sha256, bytes: hidden.bytes, mediaType: hidden.mediaType } };
      db.prepare('INSERT INTO citation_evidence(id,revision_id,version_id,source_file_id,target_id,data) VALUES(?,?,?,?,?,?)').run(record.id, record.revisionId, record.versionId, hidden.id, record.target.id, JSON.stringify(record));
    }
    db.exec('COMMIT');
    let checks = 0; const visibleFile = (id: string) => { checks++; return id === visible.id; };
    const page = evidence.list('P1', { versionId: version.id }, visibleFile);
    assert.deepEqual(page.records, []); assert.equal(checks, 1_000); assert.ok(page.nextBefore);
    const next = evidence.list('P1', { versionId: version.id, before: page.nextBefore! }, visibleFile);
    assert.deepEqual(next.records.map(record => record.id), [original.id]); assert.equal(next.nextBefore, null);
  } finally { close(); }
});

test('evidence and retractions survive reopening without rewriting immutable records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-evidence-')); const path = join(directory, 'workspace.sqlite');
  let db: DatabaseSync | undefined;
  try {
    const first = fixture(path); const record = first.evidence.create('P1', first.input(first.saveVersion(), first.upload()), actor);
    const retracted = first.evidence.retract('P1', record.id, { expectedRecordVersion: 1, reason: 'Correction' }, actor); first.close();
    db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
    const evidence = new CitationEvidenceStore(db, new FileStore(db));
    assert.deepEqual(evidence.get('P1', record.id), retracted);
    assert.deepEqual(evidence.list('P1', { versionId: record.versionId }, () => true).records, [retracted]);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
