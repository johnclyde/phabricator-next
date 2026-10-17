import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { AuthContext } from '../shared/auth.ts';
import type { PaperShareLink, PaperShareList, SharedPaper } from '../shared/paper-shares.ts';
import type { RevisionVersion } from '../shared/types.ts';
import { sourceSnapshotCanonical, validateSourceSnapshot } from '../shared/source-snapshot.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import type { Store } from './store.ts';
import { files, HttpError, object, string } from './validation.ts';

interface LinkRow {
  sequence: number; id: string; token_sha256: string; revision_id: string; version_id: string;
  version_number: number; content_hash: string; creator_id: string; title: string; label: string;
  created_at: string; revoked_at: string | null;
}
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const unavailable = () => new HttpError(404, 'This paper link is unavailable.', 'PAPER_SHARE_UNAVAILABLE');
const conflict = () => new HttpError(409, 'This sharing request changed. Create a new sharing request.', 'PAPER_SHARE_CHANGED');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const metadata = (row: LinkRow): PaperShareLink => ({ id: row.id, versionId: row.version_id, versionNumber: row.version_number, contentHash: row.content_hash, label: row.label, createdAt: row.created_at, revokedAt: row.revoked_at });

/** Sharing records contain only credential digests, including retry evidence. */
export function initializePaperShares(db: DatabaseSync): void {
  const schema = `
    CREATE TABLE IF NOT EXISTS paper_share_links (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64),
      revision_id TEXT NOT NULL REFERENCES entities(id),
      version_id TEXT NOT NULL REFERENCES versions(id),
      version_number INTEGER NOT NULL CHECK(version_number>0),
      content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
      creator_id TEXT NOT NULL,
      title TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS paper_share_revision ON paper_share_links(revision_id,sequence DESC);
    CREATE TABLE IF NOT EXISTS paper_share_operations (
      principal_id TEXT NOT NULL,
      request_key_sha256 TEXT NOT NULL CHECK(length(request_key_sha256)=64),
      input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
      action TEXT NOT NULL CHECK(action IN ('create','revoke')),
      link_id TEXT NOT NULL REFERENCES paper_share_links(id),
      PRIMARY KEY(principal_id,request_key_sha256)
    );
    CREATE TRIGGER IF NOT EXISTS paper_share_identity BEFORE UPDATE OF sequence,id,token_sha256,revision_id,version_id,version_number,content_hash,creator_id,title,label,created_at ON paper_share_links BEGIN SELECT RAISE(ABORT,'Paper share identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS paper_share_revocation BEFORE UPDATE OF revoked_at ON paper_share_links WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL BEGIN SELECT RAISE(ABORT,'Paper share revocation is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS paper_share_no_delete BEFORE DELETE ON paper_share_links BEGIN SELECT RAISE(ABORT,'Paper share revocations are durable'); END;
    CREATE TRIGGER IF NOT EXISTS paper_share_operation_no_update BEFORE UPDATE ON paper_share_operations BEGIN SELECT RAISE(ABORT,'Paper share retry evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS paper_share_operation_no_delete BEFORE DELETE ON paper_share_operations BEGIN SELECT RAISE(ABORT,'Paper share retry evidence is immutable'); END;
  `;
  const existing = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'paper_share_*' ORDER BY type,name").all() as { name: string }[];
  if (existing.length) {
    const canonical = new DatabaseSync(':memory:');
    try {
      canonical.exec(schema);
      const expected = canonical.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'paper_share_*' ORDER BY type,name").all() as { name: string }[];
      for (const row of existing) if (!isDeepStrictEqual(row, expected.find(item => item.name === row.name))) throw new Error(`Unexpected ${row.name} schema; paper sharing migration was not applied.`);
    } finally { canonical.close(); }
  }
  db.exec(schema);
}

export class PaperShares {
  constructor(private readonly store: Store, private readonly auth: Auth, private readonly policies: PolicyStore) {}
  private paper(id: string): void {
    if (!/^P[1-9]\d{0,14}$/.test(id) || !this.store.database.prepare("SELECT 1 FROM entities WHERE id=? AND kind='revision' AND json_extract(data,'$.kind')='paper'").get(id)) throw unavailable();
  }
  private authorize(id: string, actor: AuthContext): void {
    this.auth.revalidate(actor, 'read'); this.auth.revalidate(actor, 'write');
    const access = this.policies.access(id, actor.principalId);
    if (!access.view || !access.edit || !access.managePolicy) throw unavailable();
    this.paper(id);
  }
  private enabled(principalId: string): boolean {
    if (this.auth.mode === 'local') return principalId === `local:${this.auth.workspaceId}`;
    return Boolean(this.store.database.prepare('SELECT 1 FROM auth_accounts WHERE id=? AND disabled=0').get(principalId));
  }
  private version(revisionId: string, versionId: string, contentHash: string): RevisionVersion {
    const row = this.store.database.prepare('SELECT number,data FROM versions WHERE id=? AND revision_id=?').get(versionId, revisionId) as { number: number; data: string } | undefined;
    try {
      if (!row) throw unavailable();
      const version = JSON.parse(row.data) as RevisionVersion;
      if (!version || version.id !== versionId || version.revisionId !== revisionId || version.number !== row.number || version.contentHash !== contentHash || version.docx !== undefined) throw unavailable();
      files(version.files);
      validateSourceSnapshot(version.files, version.assets ?? []);
      if (hash(sourceSnapshotCanonical(version.files, version.assets ?? [])) !== contentHash) throw unavailable();
      return version;
    } catch { throw unavailable(); }
  }
  list(id: string, actor: AuthContext, query: URLSearchParams): PaperShareList {
    return this.store.read(() => {
      this.authorize(id, actor);
      if ([...query.keys()].some(key => !['before', 'limit'].includes(key)) || query.getAll('before').length > 1 || query.getAll('limit').length > 1) throw new HttpError(400, 'Sharing links accept one before cursor and one page limit.');
      const before = query.get('before'), requested = query.get('limit');
      if (before !== null && (!/^[1-9]\d{0,14}$/.test(before) || !Number.isSafeInteger(Number(before))) || requested !== null && (!/^[1-9]\d{0,2}$/.test(requested) || Number(requested) > 100)) throw new HttpError(400, 'Choose a valid sharing link cursor and a page limit from 1 to 100.');
      const limit = requested === null ? 100 : Number(requested);
      const rows = this.store.database.prepare('SELECT * FROM paper_share_links WHERE revision_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(id, before === null ? Number.MAX_SAFE_INTEGER : Number(before), limit + 1) as unknown as LinkRow[];
      const visible = rows.slice(0, limit);
      return { links: visible.map(metadata), accessEpoch: this.policies.epoch(), nextCursor: rows.length > limit ? String(visible.at(-1)!.sequence) : null };
    });
  }
  mutate(id: string, linkId: string | null, input: unknown, key: unknown, actor: AuthContext): { status: number; body: PaperShareLink } {
    // Never send the raw credential through Store.mutate: it persists receipts.
    return this.store.transaction(() => {
      this.authorize(id, actor);
      if (!uuid(key)) throw new HttpError(400, 'Provide a UUID Idempotency-Key for this sharing request.');
      const action = linkId === null ? 'create' : 'revoke';
      const data = object(input, action === 'create' ? ['token', 'versionId', 'contentHash', 'label'] : []);
      let tokenHash = '', versionId = '', contentHash = '', label = '';
      if (action === 'create') {
        if (!validToken(data.token)) throw new HttpError(400, 'Create a new secure sharing link.');
        tokenHash = hash(data.token); versionId = string(data.versionId, 'Version identity', 100);
        if (typeof data.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.contentHash)) throw new HttpError(400, 'Choose an exact paper version.');
        contentHash = data.contentHash; label = string(data.label, 'Link name', 120, true).trim();
      } else if (!uuid(linkId)) throw unavailable();
      const keyHash = hash(key), inputHash = hash(JSON.stringify([action, id, linkId, tokenHash, versionId, contentHash, label]));
      const operation = this.store.database.prepare('SELECT action,input_sha256,link_id FROM paper_share_operations WHERE principal_id=? AND request_key_sha256=?').get(actor.principalId, keyHash) as { action: string; input_sha256: string; link_id: string } | undefined;
      if (operation) {
        if (operation.action !== action || operation.input_sha256 !== inputHash) throw conflict();
        const row = this.store.database.prepare('SELECT * FROM paper_share_links WHERE id=? AND revision_id=?').get(operation.link_id, id) as LinkRow | undefined;
        if (!row || action === 'create' && (row.creator_id !== actor.principalId || row.token_sha256 !== tokenHash || row.version_id !== versionId || row.content_hash !== contentHash || row.label !== label) || action === 'revoke' && (row.id !== linkId || row.revoked_at === null)) throw conflict();
        return { status: 200, body: metadata(row) };
      }
      if (action === 'create') {
        const version = this.version(id, versionId, contentHash);
        if (this.store.database.prepare('SELECT 1 FROM paper_share_links WHERE token_sha256=?').get(tokenHash)) throw conflict();
        linkId = randomUUID();
        this.store.database.prepare('INSERT INTO paper_share_links(id,token_sha256,revision_id,version_id,version_number,content_hash,creator_id,title,label,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(linkId, tokenHash, id, versionId, version.number, contentHash, actor.principalId, this.store.revisionMetadata.state(id).title, label, new Date().toISOString());
      } else {
        const row = this.store.database.prepare('SELECT * FROM paper_share_links WHERE id=? AND revision_id=?').get(linkId, id) as LinkRow | undefined;
        if (!row) throw unavailable();
        if (row.revoked_at === null) this.store.database.prepare('UPDATE paper_share_links SET revoked_at=? WHERE id=?').run(new Date().toISOString(), linkId);
      }
      this.store.database.prepare('INSERT INTO paper_share_operations(principal_id,request_key_sha256,input_sha256,action,link_id) VALUES(?,?,?,?,?)').run(actor.principalId, keyHash, inputHash, action, linkId);
      const row = this.store.database.prepare('SELECT * FROM paper_share_links WHERE id=?').get(linkId) as unknown as LinkRow;
      return { status: action === 'create' ? 201 : 200, body: metadata(row) };
    });
  }
  read(input: unknown): SharedPaper {
    const data = object(input, ['token']);
    if (!validToken(data.token)) throw unavailable();
    return this.store.read(() => {
      const row = this.store.database.prepare('SELECT * FROM paper_share_links WHERE token_sha256=? AND revoked_at IS NULL').get(hash(data.token as string)) as LinkRow | undefined;
      if (!row || !this.enabled(row.creator_id)) throw unavailable();
      const access = this.policies.access(row.revision_id, row.creator_id);
      if (!access.view || !access.edit || !access.managePolicy) throw unavailable();
      this.paper(row.revision_id);
      const version = this.version(row.revision_id, row.version_id, row.content_hash);
      if (version.number !== row.version_number) throw unavailable();
      return { title: row.title, versionNumber: version.number, contentHash: version.contentHash, files: version.files.map(({ path, content }) => ({ path, content })) };
    });
  }
}
