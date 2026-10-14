import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { FullTextIndex } from '../shared/search-index.ts';
import { isDeepStrictEqual } from 'node:util';
import type { AuthContext } from '../shared/auth.ts';
import { parseSearchQuery, type SearchQuery, type SearchRequest, type SearchResult, type SearchPage, type SavedSearchQuery, type SavedSearchDetail, type SavedSearchList, type SavedSearchReceipt } from '../shared/search.ts';
import type { RevisionVersion } from '../shared/types.ts';
import type { SuiteRecord } from '../shared/suite.ts';
import type { LegalpadData } from '../shared/legalpad.ts';
import type { Auth } from './auth.ts';
import type { Store, MutationResponse } from './store.ts';
import type { PolicyStore } from './policy.ts';
import type { SuiteService } from './suite.ts';
import { AccessLayer } from './access.ts';
import { HttpError, integer, object, string } from './validation.ts';

const schema = [
  ['table', 'search_queries', 'CREATE TABLE search_queries(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name_key TEXT NOT NULL,visibility TEXT NOT NULL CHECK(visibility IN (\'private\',\'workspace\')),version INTEGER NOT NULL CHECK(version>0),deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),data TEXT NOT NULL CHECK(json_valid(data)))'],
  ['index', 'search_queries_names', 'CREATE UNIQUE INDEX search_queries_names ON search_queries(owner_id,name_key) WHERE deleted=0'],
  ['table', 'search_query_operations', 'CREATE TABLE search_query_operations(key_sha256 TEXT PRIMARY KEY,owner_id TEXT NOT NULL,fingerprint TEXT NOT NULL,query_id TEXT NOT NULL REFERENCES search_queries(id),version INTEGER NOT NULL,action TEXT NOT NULL,status INTEGER NOT NULL)'],
  ['trigger', 'search_queries_identity', "CREATE TRIGGER search_queries_identity BEFORE UPDATE ON search_queries WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id BEGIN SELECT RAISE(ABORT,'Search query identity is immutable'); END"],
  ['trigger', 'search_queries_no_delete', "CREATE TRIGGER search_queries_no_delete BEFORE DELETE ON search_queries BEGIN SELECT RAISE(ABORT,'Search queries must retain tombstones'); END"],
  ['trigger', 'search_operations_no_update', "CREATE TRIGGER search_operations_no_update BEFORE UPDATE ON search_query_operations BEGIN SELECT RAISE(ABORT,'Search query operations are immutable'); END"],
  ['trigger', 'search_operations_no_delete', "CREATE TRIGGER search_operations_no_delete BEFORE DELETE ON search_query_operations BEGIN SELECT RAISE(ABORT,'Search query operations are immutable'); END"],
] as const;
export function initializeSearch(database: DatabaseSync): void {
  database.exec('SAVEPOINT search_schema');
  try {
    for (const [type, name, sql] of schema) {
      const rows = database.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').all(name) as { type: string; sql: string }[];
      const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/;$/, '');
      if (rows.length && (rows.length !== 1 || rows[0]!.type !== type || normalize(rows[0]!.sql) !== normalize(sql))) throw new Error(`Unexpected ${name} schema; search migration was not applied.`);
      if (!rows.length) database.exec(sql);
    }
    database.exec('RELEASE search_schema');
  } catch (error) { database.exec('ROLLBACK TO search_schema; RELEASE search_schema'); throw error; }
}
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = () => new HttpError(404, 'Saved query is unavailable.');
const queryInput = (input: unknown): SearchQuery => { try { return parseSearchQuery(input); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid search.'); } };
export function searchRequest(params: URLSearchParams): SearchRequest {
  const allowed = ['text', 'kinds', 'statuses', 'priorities', 'ownerIds', 'projectIds', 'createdAfter', 'createdBefore', 'updatedAfter', 'updatedBefore', 'order', 'limit', 'cursor'];
  const input: Record<string, unknown> = {};
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new HttpError(400, 'Use unique supported search parameters.');
    if (key === 'limit' || key === 'cursor') continue;
    const value = params.get(key)!;
    if (['kinds', 'statuses', 'priorities', 'ownerIds', 'projectIds'].includes(key)) { try { input[key] = JSON.parse(value); } catch { throw new HttpError(400, `${key} must be a JSON array.`); } }
    else input[key] = value;
  }
  const limitText = params.get('limit');
  if (limitText !== null && !/^[1-9]\d*$/.test(limitText)) throw new HttpError(400, 'Page size must be a positive integer.');
  const limit = limitText === null ? 50 : integer(Number(limitText), 'Page size');
  if (limit > 100) throw new HttpError(400, 'Page size must be at most 100.');
  const cursor = params.get('cursor'); if (cursor !== null && (cursor.length > 2000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor))) throw new HttpError(400, 'Invalid search cursor.');
  return { ...queryInput(input), limit, cursor };
}
interface SearchDocument extends Omit<SearchResult, 'snippet'> { text: string }
interface QueryRow { id: string; owner_id: string; name_key: string; visibility: string; version: number; deleted: number; data: string }
interface Cursor { query: string; snapshot: string; offset: number; principal: string; epoch: number }
/** The index is a single-request positional full-text snapshot, populated only with currently
 * authorized projections. No stale or another principal's corpus influences
 * snippets, counts, ranking or page boundaries. */
export class SearchService {
  private readonly cursorKey = randomBytes(32);
  constructor(private readonly store: Store, private readonly auth: Auth, private readonly policies: PolicyStore, private readonly suite?: SuiteService) {}
  private visibleQuery(query: SavedSearchQuery, actor: AuthContext): boolean {
    return (query.ownerId === actor.principalId || query.visibility === 'workspace') && query.query.projectIds.every(id => this.policies.access(id, actor.principalId).view);
  }
  private row(id: string): QueryRow {
    if (!/^SQ-[a-f0-9-]{36}$/.test(id)) throw unavailable();
    const row = this.store.database.prepare('SELECT * FROM search_queries WHERE id=?').get(id) as QueryRow | undefined;
    if (!row) throw unavailable(); return row;
  }
  private saved(row: QueryRow): SavedSearchQuery {
    const value = JSON.parse(row.data) as SavedSearchQuery;
    if (value.id !== row.id || value.ownerId !== row.owner_id || value.visibility !== row.visibility || value.version !== row.version || value.name.normalize('NFKC').trim().toLocaleLowerCase() !== row.name_key || !isDeepStrictEqual(queryInput(value.query), value.query)) throw new HttpError(409, 'Saved query does not match its recorded identity.');
    return value;
  }
  private savedDetail(id: string, actor: AuthContext): SavedSearchDetail {
    const row = this.row(id), query = this.saved(row);
    if (row.deleted || !this.visibleQuery(query, actor)) throw unavailable();
    return { query, canEdit: query.ownerId === actor.principalId && actor.scopes.includes('write'), accessEpoch: this.policies.epoch() };
  }
  read(path: string, params: URLSearchParams, actor: AuthContext): SearchPage | SavedSearchDetail | SavedSearchList {
    return this.store.read(() => {
      this.auth.revalidate(actor, 'read');
      if (path === '/api/search') return this.search(searchRequest(params), actor);
      if ([...params.keys()].length) throw new HttpError(400, 'Saved query requests do not accept query parameters.');
      if (path === '/api/search/queries') {
        const rows = this.store.database.prepare("SELECT * FROM search_queries WHERE deleted=0 AND (owner_id=? OR visibility='workspace') ORDER BY name_key,id").all(actor.principalId) as unknown as QueryRow[];
        return { queries: rows.map(row => this.saved(row)).filter(query => this.visibleQuery(query, actor)), accessEpoch: this.policies.epoch() };
      }
      const match = /^\/api\/search\/queries\/(SQ-[a-f0-9-]{36})$/.exec(path); if (!match) throw unavailable(); return this.savedDetail(match[1]!, actor);
    });
  }
  private documents(actor: AuthContext, request: SearchQuery): SearchDocument[] {
    const access = new AccessLayer(this.store, this.auth, this.policies, actor), state = access.state({ configured: false, model: null }), docs: SearchDocument[] = [];
    const wanted = (kind: SearchResult['kind']) => !request.kinds.length || request.kinds.includes(kind);
    const put = (item: Pick<SearchDocument, 'id' | 'kind' | 'title' | 'text'> & Partial<SearchDocument>) => docs.push({ id: item.id, kind: item.kind, title: item.title, text: item.text, href: item.href ?? `#${item.id}`, status: item.status ?? null, priority: item.priority ?? null, ownerId: item.ownerId ?? null, projectIds: item.projectIds ?? [], createdAt: item.createdAt ?? null, updatedAt: item.updatedAt ?? null });
    if (wanted('task')) for (const task of state.tasks) {
      const comments = this.store.database.prepare("SELECT json_extract(data,'$.comment') AS body FROM task_transactions WHERE task_id=? AND json_extract(data,'$.kind')='comment'").all(task.id).map(row => typeof row.body === 'string' ? row.body : '');
      const custom = (task as typeof task & { customFields?: Record<string, unknown> }).customFields ?? {};
      put({ ...task, kind: 'task', text: [task.description, ...Object.values(custom).flatMap(value => Array.isArray(value) ? value : [value]), ...comments].filter(value => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').join('\n') });
    }
    for (const revision of state.revisions) {
      const kind = revision.kind === 'code' ? 'revision' : revision.kind;
      if (!wanted(kind)) continue;
      const row = this.store.database.prepare('SELECT data FROM versions WHERE revision_id=? AND number=?').get(revision.id, revision.currentVersion) as { data: string } | undefined;
      const version = row ? JSON.parse(row.data) as RevisionVersion : null;
      const comments = this.store.database.prepare('SELECT json_extract(data,\'$.body\') AS body FROM comments WHERE revision_id=? AND json_extract(data,\'$.versionId\')=?').all(revision.id, version?.id ?? '').map(item => typeof item.body === 'string' ? item.body : '');
      put({ id: revision.id, kind, title: revision.title, text: [revision.summary, revision.testPlan ?? '', ...(version?.files.flatMap(file => [file.path, file.content]) ?? []), ...comments].join('\n'), status: revision.status, ownerId: revision.authorId ?? null, projectIds: revision.projectIds ?? [], createdAt: revision.createdAt, updatedAt: revision.updatedAt });
    }
    if (wanted('wiki')) for (const document of state.documents) if (!document.location || document.location.status === 'active') put({ ...document, kind: 'wiki', text: `${document.slug}\n${document.content}`, status: 'active' });
    if (wanted('project')) for (const project of state.projects) put({ id: project.id, kind: 'project', title: project.displayName, text: [project.description, project.name, project.primarySlug, ...project.aliases].filter(Boolean).join('\n'), status: project.status, ownerId: project.authorId, projectIds: [project.id], createdAt: project.createdAt, updatedAt: project.updatedAt });
    if (wanted('repository')) for (const repository of state.repositories) put({ id: repository.id, kind: 'repository', title: repository.name, text: [repository.description, repository.remoteUrl, repository.defaultBranch].join('\n') });
    if (wanted('paste')) for (const paste of state.pastes ?? []) { const current = access.paste(paste.id); put({ ...paste, kind: 'paste', text: current.version.content, ownerId: paste.authorId }); }
    if (wanted('file')) for (const file of state.files ?? []) put({ ...file, kind: 'file', title: file.name, text: [file.altText, file.originalName, file.mediaType].join('\n'), ownerId: file.authorId });
    if (this.suite) for (const row of this.store.database.prepare('SELECT id,app FROM suite_records ORDER BY sequence').all()) {
      if (!wanted(String(row.app) as SearchResult['kind'])) continue;
      let record: SuiteRecord;
      try { record = this.suite.importDetail(String(row.id), actor).record; }
      catch (error) { if (error instanceof HttpError && [403, 404].includes(error.status)) continue; throw error; }
      const data = record.data, bodies = (field: string, key: string) => Array.isArray(data[field]) ? (data[field] as Record<string, unknown>[]).map(item => typeof item[key] === 'string' ? item[key] : '').join('\n') : '';
      let text = '', status = typeof data.status === 'string' ? data.status : null;
      if (record.app === 'almanac') text = `${data.description ?? ''}\n${data.address ?? ''}\n${JSON.stringify(data.properties ?? {})}`;
      if (record.app === 'conpherence') { text = `${data.topic ?? ''}\n${bodies('messages', 'body')}`; status = data.archived ? 'archived' : 'active'; }
      if (record.app === 'calendar') text = `${data.description ?? ''}\n${data.location ?? ''}\n${bodies('comments', 'body')}`;
      if (record.app === 'slowvote') { text = `${data.description ?? ''}\n${bodies('choices', 'label')}`; status = data.closed ? 'closed' : 'open'; }
      if (record.app === 'phame') { if (record.kind !== 'blog' && data.status !== 'published') continue; text = `${data.description ?? ''}\n${data.subtitle ?? ''}\n${data.body ?? ''}\n${bodies('comments', 'body')}`; }
      if (record.app === 'legalpad') { const current = (data as LegalpadData).versions.at(-1); text = `${current?.preamble ?? ''}\n${current?.text ?? ''}\n${bodies('comments', 'text')}`; }
      put({ id: record.id, kind: record.app, title: record.title, text, href: `#${record.app}/${record.id}`, status, ownerId: record.ownerId, createdAt: record.createdAt, updatedAt: record.updatedAt });
    }
    return docs;
  }
  private search(request: SearchRequest, actor: AuthContext): SearchPage {
    const { limit, cursor, ...query } = request, epoch = this.policies.epoch();
    const owners = query.ownerIds.map(id => id === 'me' ? actor.principalId : id === 'none' ? 'unassigned' : id);
    // Invalid or newly private filters produce no matches rather than disclose
    // whether the object exists. The query itself was supplied by the caller.
    const projectsVisible = query.projectIds.every(id => this.policies.access(id, actor.principalId).view);
    const docs = this.documents(actor, query).filter(item => projectsVisible
      && (!query.statuses.length || item.status !== null && query.statuses.includes(item.status))
      && (!query.priorities.length || item.priority !== null && query.priorities.includes(item.priority))
      && (!owners.length || owners.includes(item.ownerId ?? 'unassigned'))
      && (!query.projectIds.length || query.projectIds.every(id => item.projectIds.includes(id)))
      && (!query.createdAfter || item.createdAt !== null && item.createdAt >= query.createdAfter)
      && (!query.createdBefore || item.createdAt !== null && item.createdAt < query.createdBefore)
      && (!query.updatedAfter || item.updatedAt !== null && item.updatedAt >= query.updatedAfter)
      && (!query.updatedBefore || item.updatedAt !== null && item.updatedAt < query.updatedBefore));
    const snapshot = sha(docs), queryHash = sha([query, limit]); let offset = 0;
    if (cursor) {
      const [encoded, signature] = cursor.split('.'), expected = createHmac('sha256', this.cursorKey).update(encoded!).digest();
      const supplied = Buffer.from(signature!, 'base64url');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(400, 'Invalid search cursor.');
      let saved: Cursor; try { saved = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as Cursor; } catch { throw new HttpError(400, 'Invalid search cursor.'); }
      if (saved.principal !== actor.principalId || saved.query !== queryHash) throw new HttpError(400, 'Search cursor belongs to a different query.');
      if (saved.epoch !== epoch || saved.snapshot !== snapshot) throw new HttpError(409, 'Search results changed. Start again from the first page.', 'SEARCH_RESULTS_CHANGED');
      if (!Number.isSafeInteger(saved.offset) || saved.offset < 1 || saved.offset > docs.length) throw new HttpError(400, 'Invalid search cursor.'); offset = saved.offset;
    }
    const ranked = new FullTextIndex(docs).search(query.text).map(row => ({ document: docs[row.index]!, rank: row.rank, snippet: row.snippet }));
    ranked.sort((a, b) => {
      let compare = 0;
      if (query.order === 'relevance') compare = a.rank - b.rank;
      else if (query.order === 'title') compare = a.document.title.localeCompare(b.document.title, 'en');
      else { const key = query.order === 'updated' ? 'updatedAt' : 'createdAt'; compare = (b.document[key] ?? '').localeCompare(a.document[key] ?? ''); }
      return compare || a.document.id.localeCompare(b.document.id, 'en');
    });
    const items = ranked.slice(offset, offset + limit).map(({ document: { text: _text, ...item }, snippet }) => ({ ...item, snippet }));
    let nextCursor: string | null = null;
    if (offset + limit < ranked.length) { const data: Cursor = { query: queryHash, snapshot, offset: offset + limit, principal: actor.principalId, epoch }; const encoded = Buffer.from(JSON.stringify(data)).toString('base64url'); nextCursor = `${encoded}.${createHmac('sha256', this.cursorKey).update(encoded).digest('base64url')}`; }
    return { query, items, total: ranked.length, nextCursor, accessEpoch: epoch };
  }

  mutate(method: string, path: string, input: unknown, rawKey: string | undefined, actor: AuthContext): MutationResponse {
    if (method !== 'POST') throw new HttpError(405, 'Use POST for saved query changes.');
    if (!rawKey || rawKey.length > 200 || /[\u0000-\u001f]/u.test(rawKey)) throw new HttpError(400, 'Saved query changes require a bounded Idempotency-Key.');
    const match = /^\/api\/search\/queries(?:\/(SQ-[a-f0-9-]{36})(?:\/(delete))?)?$/.exec(path); if (!match) throw unavailable();
    const id = match[1], action = !id ? 'create' : match[2] ? 'delete' : 'update';
    const value = object(input, action === 'delete' ? ['expectedVersion'] : action === 'create' ? ['name', 'visibility', 'query'] : ['expectedVersion', 'name', 'visibility', 'query']);
    const expectedVersion = action === 'create' ? null : integer(value.expectedVersion, 'Expected version');
    const name = action === 'delete' ? null : string(value.name, 'Query name', 100).trim();
    const query = action === 'delete' ? null : queryInput(value.query);
    const visibility = value.visibility;
    if (action !== 'delete' && visibility !== 'private' && visibility !== 'workspace') throw new HttpError(400, 'Choose private or workspace query visibility.');
    const key = `search-query:${actor.workspaceId}:${actor.principalId}:${rawKey}`, keyHash = sha(key), fingerprint = sha([method, path, value]);
    const authorize = () => {
      this.auth.revalidate(actor, 'write');
      if (id) { const current = this.row(id); if (current.owner_id !== actor.principalId) throw unavailable(); }
      if (query && query.projectIds.some(projectId => !this.policies.access(projectId, actor.principalId).view)) throw new HttpError(404, 'A selected project is unavailable.');
    };
    return this.store.mutate(key, fingerprint, () => {
      const now = new Date().toISOString(); let saved: SavedSearchQuery;
      if (id) {
        const row = this.row(id); if (row.deleted) throw unavailable();
        saved = this.saved(row);
        if (expectedVersion !== saved.version) throw new HttpError(409, 'This saved query changed. Refresh before editing.', 'SEARCH_QUERY_CHANGED');
        saved = { ...saved, version: saved.version + 1, updatedAt: now, ...(action === 'delete' ? {} : { name: name!, query: query!, visibility: visibility as 'private' | 'workspace' }) };
      } else saved = { id: `SQ-${randomUUID()}`, ownerId: actor.principalId, name: name!, query: query!, visibility: visibility as 'private' | 'workspace', version: 1, createdAt: now, updatedAt: now };
      if (!Number.isSafeInteger(saved.version) || !Number.isSafeInteger(this.policies.epoch() + 1)) throw new HttpError(409, 'This workspace has reached the supported version limit.');
      const nameKey = saved.name.normalize('NFKC').trim().toLocaleLowerCase();
      if (action !== 'delete' && this.store.database.prepare('SELECT 1 FROM search_queries WHERE owner_id=? AND name_key=? AND deleted=0 AND id<>?').get(actor.principalId, nameKey, saved.id)) throw new HttpError(409, 'You already have a saved query with that name.');
      if (id) this.store.database.prepare('UPDATE search_queries SET name_key=?,visibility=?,version=?,deleted=?,data=? WHERE id=?').run(nameKey, saved.visibility, saved.version, action === 'delete' ? 1 : 0, JSON.stringify(saved), id);
      else this.store.database.prepare('INSERT INTO search_queries(id,owner_id,name_key,visibility,version,deleted,data) VALUES(?,?,?,?,?,0,?)').run(saved.id, saved.ownerId, nameKey, saved.visibility, saved.version, JSON.stringify(saved));
      this.store.database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
      const status = action === 'create' ? 201 : 200;
      this.store.database.prepare('INSERT INTO search_query_operations VALUES(?,?,?,?,?,?,?)').run(keyHash, actor.principalId, fingerprint, saved.id, saved.version, action, status);
      return { status, body: { id: saved.id, version: saved.version, action } };
    }, authorize, (response, replayed) => {
      const operation = this.store.database.prepare('SELECT * FROM search_query_operations WHERE key_sha256=?').get(keyHash);
      if (!operation || operation.owner_id !== actor.principalId || operation.fingerprint !== fingerprint || operation.action !== action || operation.status !== response.status || !isDeepStrictEqual(response.body, { id: operation.query_id, version: operation.version, action }) || id && operation.query_id !== id) throw new HttpError(409, 'Saved query receipt does not match the original operation.');
      const row = this.row(String(operation.query_id));
      if (row.owner_id !== actor.principalId) throw unavailable();
      const current = this.saved(row);
      const body: SavedSearchReceipt = { query: row.deleted || !this.visibleQuery(current, actor) ? null : current, receipt: { id: current.id, version: Number(operation.version), action, replayed }, accessEpoch: this.policies.epoch() };
      return { status: response.status, body };
    });
  }
}
