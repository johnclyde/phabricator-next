import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { ActorAttribution, RevisionVersion } from '../shared/types.ts';
import type { CitationEvidenceInput, CitationEvidencePage, CitationEvidenceQuery, CitationEvidenceRecord, CitationEvidenceRetraction, CitationEvidenceSource, CitationEvidenceTarget } from '../shared/citation-evidence.ts';
import { citationEvidenceTarget } from '../shared/citation-evidence.ts';
import { analyzeCitations } from '../shared/citations.ts';
import { FILE_MAX_BYTES } from '../shared/files.ts';
import { sourceSnapshotCanonical, validateSourceSnapshot } from '../shared/source-snapshot.ts';
import { FileStore } from './files.ts';
import { choice, HttpError, integer, object, string } from './validation.ts';

type EvidenceRow = { sequence: number; data: string; retraction: string | null };
export interface ValidatedCitationEvidence {
  versionId: string; versionNumber: number; contentHash: string;
  target: CitationEvidenceTarget; source: CitationEvidenceSource;
}
const unavailable = () => new HttpError(404, 'Citation evidence was not found.', 'CITATION_EVIDENCE_UNAVAILABLE');
const missingVersion = () => new HttpError(404, 'The selected manuscript version was not found.', 'CITATION_VERSION_UNAVAILABLE');
const sourceMismatch = () => new HttpError(409, 'The selected immutable manuscript source does not match.', 'CITATION_SOURCE_MISMATCH');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let savepoint = 0;

function nonnegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${field} must be a nonnegative safe integer.`);
  return value;
}
function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new HttpError(400, `${field} must be a lowercase SHA-256 digest.`);
  return value;
}
function revisionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[DPL][1-9]\d{0,14}$/.test(value)) throw missingVersion();
  return value;
}
function evidenceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw unavailable();
  return value;
}
function attribution(value: ActorAttribution): ActorAttribution {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.principalId)) throw new HttpError(400, 'Invalid evidence author.');
  return { principalId: value.principalId, displayName: string(value.displayName, 'Author name', 240), credentialId: value.credentialId === null ? null : string(value.credentialId, 'Credential ID', 240), requestId: string(value.requestId, 'Request ID', 240) };
}

/** Pure shape validation, safe before authority checks or idempotency replay. */
export function parseCitationEvidenceInput(input: unknown): CitationEvidenceInput {
  const data = object(input, ['versionId', 'contentHash', 'targetId', 'source', 'verdict', 'quote', 'locator', 'note', 'attested', 'expectedAccessEpoch']);
  const source = object(data.source, ['fileId', 'sha256', 'bytes', 'mediaType']);
  if (typeof source.fileId !== 'string' || !/^F[1-9]\d{0,14}$/.test(source.fileId)) throw new HttpError(400, 'Choose a supporting File.');
  const bytes = nonnegative(source.bytes, 'Source byte length');
  if (bytes > FILE_MAX_BYTES) throw new HttpError(400, 'Supporting Files may contain at most 16 MiB.');
  if (data.attested !== true) throw new HttpError(400, 'Explicit reviewer attestation is required.', 'CITATION_ATTESTATION_REQUIRED');
  return {
    versionId: string(data.versionId, 'Version ID', 100), contentHash: digest(data.contentHash, 'Content hash'), targetId: string(data.targetId, 'Citation target ID', 4_096),
    source: { fileId: source.fileId, sha256: digest(source.sha256, 'Source hash'), bytes, mediaType: choice(source.mediaType, 'source media type', ['image/png', 'image/jpeg', 'application/pdf', 'application/octet-stream']) },
    verdict: choice(data.verdict, 'citation verdict', ['supports', 'contradicts', 'inconclusive']),
    quote: string(data.quote, 'Quoted passage', 10_000), locator: string(data.locator, 'Source locator', 1_000).trim(), note: string(data.note, 'Reviewer note', 10_000).trim(),
    attested: true, expectedAccessEpoch: nonnegative(data.expectedAccessEpoch, 'expectedAccessEpoch'),
  };
}

/** Schema only; the root Store owns migration transaction and user_version. */
export function initializeCitationEvidence(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE citation_evidence (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence>0 AND sequence<=9007199254740991),
      id TEXT NOT NULL UNIQUE, revision_id TEXT NOT NULL REFERENCES entities(id),
      version_id TEXT NOT NULL REFERENCES versions(id), source_file_id TEXT NOT NULL REFERENCES file_contents(file_id),
      target_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id
        AND json_extract(data,'$.versionId')=version_id AND json_extract(data,'$.source.fileId')=source_file_id
        AND json_extract(data,'$.target.id')=target_id AND json_extract(data,'$.state')='active'
        AND json_extract(data,'$.recordVersion')=1 AND json_extract(data,'$.basis')='reviewer-attestation')
    );
    CREATE INDEX citation_evidence_version ON citation_evidence(revision_id,version_id,sequence);
    CREATE INDEX citation_evidence_target ON citation_evidence(revision_id,version_id,target_id,sequence);
    CREATE TABLE citation_evidence_retractions (
      evidence_id TEXT PRIMARY KEY REFERENCES citation_evidence(id),
      data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE TRIGGER citation_evidence_no_update BEFORE UPDATE ON citation_evidence BEGIN SELECT RAISE(ABORT,'Citation evidence is immutable'); END;
    CREATE TRIGGER citation_evidence_no_delete BEFORE DELETE ON citation_evidence BEGIN SELECT RAISE(ABORT,'Citation evidence is immutable'); END;
    CREATE TRIGGER citation_evidence_retractions_no_update BEFORE UPDATE ON citation_evidence_retractions BEGIN SELECT RAISE(ABORT,'Citation retractions are immutable'); END;
    CREATE TRIGGER citation_evidence_retractions_no_delete BEFORE DELETE ON citation_evidence_retractions BEGIN SELECT RAISE(ABORT,'Citation retractions are immutable'); END;
  `);
}

/** Authority remains with the calling request; no method grants File access. */
export class CitationEvidenceStore {
  constructor(private readonly database: DatabaseSync, private readonly files: FileStore) {}
  private mutation<T>(work: () => T): T {
    const name = `citation_evidence_write_${++savepoint}`; this.database.exec(`SAVEPOINT ${name}`);
    try {
      // Obtain the write lock before reading immutable pins and mutable metadata.
      this.database.prepare("UPDATE sequences SET value=value WHERE name='revision'").run();
      const result = work(); this.database.exec(`RELEASE ${name}`); return result;
    } catch (error) { this.database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
  private version(id: string, selected: string): RevisionVersion {
    revisionId(id);
    const row = this.database.prepare("SELECT v.id,v.revision_id,v.number,v.data FROM versions v JOIN entities e ON e.id=v.revision_id AND e.kind='revision' WHERE v.revision_id=? AND v.id=?").get(id, selected) as { id: string; revision_id: string; number: number; data: string } | undefined;
    if (!row) throw missingVersion();
    const version = JSON.parse(row.data) as RevisionVersion;
    if (version.id !== row.id || version.revisionId !== row.revision_id || version.number !== row.number || !Number.isSafeInteger(row.number) || row.number < 1) throw sourceMismatch();
    return version;
  }
  validateCreate(id: string, input: unknown): ValidatedCitationEvidence {
    const data = parseCitationEvidenceInput(input); const version = this.version(id, data.versionId);
    try {
      if (!Array.isArray(version.files) || !version.files.length || version.files.some(file => !file || typeof file.path !== 'string' || typeof file.content !== 'string')) throw sourceMismatch();
      if (version.assets !== undefined && !Array.isArray(version.assets)) throw sourceMismatch();
      // Legacy Git imports may contain case-distinct or otherwise unusual text
      // paths. Preserve their exact identity; combined asset namespaces are new.
      if (version.assets?.length) validateSourceSnapshot(version.files, version.assets);
    }
    catch { throw sourceMismatch(); }
    if (version.contentHash !== data.contentHash || hash(sourceSnapshotCanonical(version.files, version.assets)) !== data.contentHash) throw sourceMismatch();
    const inventory = analyzeCitations(version.files);
    const target = citationEvidenceTarget(inventory, data.targetId);
    if (!target) throw new HttpError(404, 'The selected concrete citation target was not found in this version.', 'CITATION_TARGET_UNAVAILABLE');
    const file = this.files.get(data.source.fileId);
    if (file.sha256 !== data.source.sha256 || file.bytes !== data.source.bytes || file.mediaType !== data.source.mediaType) throw new HttpError(409, 'The supporting File identity does not match.', 'CITATION_FILE_MISMATCH');
    this.files.readBytes(file.id);
    return { versionId: version.id, versionNumber: version.number, contentHash: version.contentHash, target, source: { fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType } };
  }
  create(id: string, input: unknown, actor: ActorAttribution): CitationEvidenceRecord {
    return this.mutation(() => {
      const data = parseCitationEvidenceInput(input); const selected = this.validateCreate(id, data);
      const record: CitationEvidenceRecord = { id: randomUUID(), revisionId: id, ...selected, basis: 'reviewer-attestation', verdict: data.verdict, quote: data.quote, locator: data.locator, note: data.note, createdAt: new Date().toISOString(), attribution: attribution(actor), state: 'active', recordVersion: 1 };
      this.database.prepare('INSERT INTO citation_evidence(id,revision_id,version_id,source_file_id,target_id,data) VALUES(?,?,?,?,?,?)').run(record.id, id, record.versionId, record.source.fileId, record.target.id, JSON.stringify(record));
      return record;
    });
  }
  private decode(row: EvidenceRow): CitationEvidenceRecord {
    const record = JSON.parse(row.data) as CitationEvidenceRecord;
    return row.retraction ? { ...record, state: 'retracted', recordVersion: 2, retraction: JSON.parse(row.retraction) as CitationEvidenceRetraction } : record;
  }
  get(id: string, selected: string): CitationEvidenceRecord {
    revisionId(id); evidenceId(selected);
    const row = this.database.prepare('SELECT e.sequence,e.data,r.data AS retraction FROM citation_evidence e LEFT JOIN citation_evidence_retractions r ON r.evidence_id=e.id WHERE e.revision_id=? AND e.id=?').get(id, selected) as EvidenceRow | undefined;
    if (!row) throw unavailable(); return this.decode(row);
  }
  list(id: string, query: CitationEvidenceQuery, canViewFile: (fileId: string) => boolean): CitationEvidencePage {
    const data = object(query, ['versionId', 'targetId', 'before', 'limit']);
    const selected = string(data.versionId, 'Version ID', 100); this.version(id, selected);
    const targetId = data.targetId === undefined ? undefined : string(data.targetId, 'Citation target ID', 4_096);
    let cursor = data.before === undefined ? Number.MAX_SAFE_INTEGER : integer(data.before, 'before');
    const limit = data.limit === undefined ? 25 : integer(data.limit, 'limit');
    if (limit > 100) throw new HttpError(400, 'Citation evidence pages may contain at most 100 records.');
    const records: CitationEvidenceRecord[] = []; let lastVisible = cursor; let scanned = 0;
    const page = (before: number, count: number) => this.database.prepare(`SELECT e.sequence,e.data,r.data AS retraction FROM citation_evidence e LEFT JOIN citation_evidence_retractions r ON r.evidence_id=e.id WHERE e.revision_id=? AND e.version_id=? ${targetId === undefined ? '' : 'AND e.target_id=?'} AND e.sequence<? ORDER BY e.sequence DESC LIMIT ?`).all(id, selected, ...(targetId === undefined ? [] : [targetId]), before, count) as EvidenceRow[];
    for (;;) {
      const rows = page(cursor, 100);
      for (const row of rows) {
        cursor = row.sequence; scanned++; const record = this.decode(row);
        if (canViewFile(record.source.fileId)) {
          if (records.length === limit) return { records, nextBefore: lastVisible };
          records.push(record); lastVisible = cursor;
        }
        if (scanned === 1_000) return { records, nextBefore: page(cursor, 1).length ? cursor : null };
      }
      if (rows.length < 100) return { records, nextBefore: null };
    }
  }
  retract(id: string, selected: string, input: unknown, actor: ActorAttribution): CitationEvidenceRecord {
    const data = object(input, ['expectedRecordVersion', 'reason']);
    const expected = integer(data.expectedRecordVersion, 'expectedRecordVersion'); const reason = string(data.reason, 'Retraction reason', 10_000).trim();
    return this.mutation(() => {
      const current = this.get(id, selected);
      if (current.state !== 'active' || current.recordVersion !== expected) throw new HttpError(409, 'This citation evidence changed or was already retracted.', 'CITATION_EVIDENCE_CHANGED');
      const retraction: CitationEvidenceRetraction = { reason, createdAt: new Date().toISOString(), attribution: attribution(actor) };
      this.database.prepare('INSERT INTO citation_evidence_retractions(evidence_id,data) VALUES(?,?)').run(current.id, JSON.stringify(retraction));
      return { ...current, state: 'retracted', recordVersion: 2, retraction };
    });
  }
}
