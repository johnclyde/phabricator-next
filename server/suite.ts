import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthContext } from '../shared/auth.ts';
import { SUITE_APPS, type SuiteAccess, type SuiteApp, type SuiteDetail, type SuiteEvent, type SuiteList, type SuiteRecord } from '../shared/suite.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import type { Store, MutationResponse } from './store.ts';
import type { SuiteContext, SuiteModule } from './suite-contract.ts';
import { choice, HttpError, integer, object, string } from './validation.ts';
import { almanacModule } from './suite-almanac.ts';
import { conpherenceModule } from './suite-conpherence.ts';
import { calendarModule } from './suite-calendar.ts';
import { slowvoteModule } from './suite-slowvote.ts';
import { phameModule } from './suite-phame.ts';
import { legalpadModule } from './suite-legalpad.ts';

const definitions = [
  ['table', 'suite_records', 'CREATE TABLE suite_records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,app TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)))'],
  ['table', 'suite_history', 'CREATE TABLE suite_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT,record_id TEXT NOT NULL REFERENCES suite_records(id),version INTEGER NOT NULL,event TEXT NOT NULL CHECK(json_valid(event)),snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),UNIQUE(record_id,version))'],
  ['index', 'suite_records_app', 'CREATE INDEX suite_records_app ON suite_records(app,sequence)'],
  ['index', 'suite_history_record', 'CREATE INDEX suite_history_record ON suite_history(record_id,sequence)'],
  ['trigger', 'suite_history_no_update', "CREATE TRIGGER suite_history_no_update BEFORE UPDATE ON suite_history BEGIN SELECT RAISE(ABORT,'Application history is immutable'); END"],
  ['trigger', 'suite_history_no_delete', "CREATE TRIGGER suite_history_no_delete BEFORE DELETE ON suite_history BEGIN SELECT RAISE(ABORT,'Application history is immutable'); END"],
  ['trigger', 'suite_records_identity', "CREATE TRIGGER suite_records_identity BEFORE UPDATE ON suite_records WHEN NEW.id<>OLD.id OR NEW.app<>OLD.app OR NEW.kind<>OLD.kind OR NEW.sequence<>OLD.sequence BEGIN SELECT RAISE(ABORT,'Application identity is immutable'); END"],
  ['trigger', 'suite_records_no_delete', "CREATE TRIGGER suite_records_no_delete BEFORE DELETE ON suite_records BEGIN SELECT RAISE(ABORT,'Application objects must be archived'); END"],
] as const;
export function initializeSuite(database: DatabaseSync): void {
  database.exec('SAVEPOINT suite_schema');
  try {
    for (const [type, name, sql] of definitions) {
      const existing = database.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').all(name) as { type: string; sql: string }[];
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/;$/, '');
      if (existing.length && (existing.length !== 1 || existing[0]!.type !== type || normalize(existing[0]!.sql) !== normalize(sql))) throw new Error(`Unexpected ${name} schema; application migration was not applied.`);
      if (!existing.length) database.exec(sql);
    }
    database.exec('RELEASE suite_schema');
  } catch (error) { database.exec('ROLLBACK TO suite_schema; RELEASE suite_schema'); throw error; }
}
const unavailable = () => new HttpError(404, 'Object was not found.');
const permissionFailure = (error: unknown) => error instanceof HttpError && [403, 404].includes(error.status);
export class SuiteService {
  private readonly modules: Map<SuiteApp, SuiteModule>;
  constructor(private readonly store: Store, private readonly auth: Auth, private readonly policies: PolicyStore, modules: SuiteModule[] = [almanacModule, conpherenceModule, calendarModule, slowvoteModule, phameModule, legalpadModule], private readonly clock = Date.now) { this.modules = new Map(modules.map(module => [module.app, module])); }
  private module(app: SuiteApp): SuiteModule { const result = this.modules.get(app); if (!result) throw unavailable(); return result; }
  private raw(id: string): SuiteRecord {
    if (!/^[A-Z][A-Z0-9]*-[a-f0-9-]{36}$/.test(id)) throw unavailable();
    const row = this.store.database.prepare('SELECT data FROM suite_records WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw unavailable();
    return JSON.parse(row.data) as SuiteRecord;
  }
  private *rows(app: SuiteApp, kind?: string): Generator<SuiteRecord> {
    // Read bounded ID batches before yielding. On older supported Node versions,
    // SQLite iterators can outlive their prepared statement during collection.
    let after = 0;
    for (;;) {
      const page = this.store.database.prepare('SELECT sequence,id FROM suite_records WHERE app=? AND sequence>? AND (? IS NULL OR kind=?) ORDER BY sequence LIMIT 100').all(app, after, kind ?? null, kind ?? null);
      for (const row of page) { after = Number(row.sequence); yield this.raw(String(row.id)); }
      if (page.length < 100) return;
    }
  }
  private context(actor: AuthContext, spaceId = 'S1'): SuiteContext {
    const viewing = new Set<string>(), editing = new Set<string>();
    const context: SuiteContext = {
      actor, now: new Date(this.clock()).toISOString(),
      get: id => {
        if (viewing.has(id) || viewing.size > 32) throw unavailable();
        viewing.add(id);
        try {
          const record = this.raw(id), module = this.module(record.app);
          this.policies.getSpace(record.access.spaceId, actor.principalId);
          const parent = module.accessSource?.(record);
          if (parent) context.get(parent);
          else if (record.access.visibility === 'members' && record.ownerId !== actor.principalId && !record.access.memberIds.includes(actor.principalId) && !record.access.editorIds.includes(actor.principalId)) throw unavailable();
          if (module.canView && !module.canView(record, context)) throw unavailable();
          return record;
        } finally { viewing.delete(id); }
      },
      list: (app, kind) => { const result: SuiteRecord[] = []; for (const record of this.rows(app, kind)) { try { result.push(context.get(record.id)); } catch (error) { if (!permissionFailure(error)) throw error; } } return result; },
      exists: (app, kind, predicate) => { for (const record of this.rows(app, kind)) if (predicate(record)) return true; return false; },
      canEdit: record => {
        try {
          const current = context.get(record.id), base = current.ownerId === actor.principalId || current.access.editorIds.includes(actor.principalId);
          if (editing.has(record.id)) return base;
          editing.add(record.id);
          try { return this.module(current.app).canEdit?.(current, context) ?? base; }
          finally { editing.delete(record.id); }
        } catch (error) { if (permissionFailure(error)) return false; throw error; }
      },
      requireEdit: record => { if (!context.canEdit(record)) throw new HttpError(403, 'You cannot edit this object.'); },
      requirePerson: id => {
        const local = this.auth.mode === 'local' && id === `local:${this.auth.workspaceId}`;
        const account = this.auth.listAccounts().find(person => person.id === id && !person.disabled);
        if ((!local && !account) || !this.policies.access(spaceId, id).view) throw new HttpError(400, 'Choose an active person who can see this Space.');
        return { id, displayName: account?.displayName ?? 'You' };
      },
    };
    return context;
  }
  private access(input: unknown, actor: AuthContext, previous?: SuiteAccess): SuiteAccess {
    const data = input === undefined ? {} : object(input, ['spaceId', 'visibility', 'memberIds', 'editorIds']);
    const spaceId = data.spaceId === undefined ? previous?.spaceId ?? 'S1' : string(data.spaceId, 'Space', 100), space = this.policies.getSpace(spaceId, actor.principalId);
    if (space.archived && spaceId !== previous?.spaceId) throw new HttpError(409, 'Archived Spaces cannot receive new objects.');
    const context = this.context(actor, spaceId);
    const ids = (value: unknown, old: string[] = []) => {
      if (value === undefined) return old;
      if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string')) throw new HttpError(400, 'Choose a list of people.');
      const selected = [...new Set(value as string[])];
      for (const id of selected) if (!old.includes(id) || spaceId !== previous?.spaceId) context.requirePerson(id);
      return selected;
    };
    return { spaceId, visibility: data.visibility === undefined ? previous?.visibility ?? 'workspace' : choice(data.visibility, 'visibility', ['workspace', 'members']), memberIds: ids(data.memberIds, previous?.memberIds), editorIds: ids(data.editorIds, previous?.editorIds) };
  }
  private page(query: URLSearchParams): { before: number; limit: number } {
    const number = (key: string, fallback: number) => query.has(key) ? integer(Number(query.get(key)), key) : fallback;
    const limit = number('limit', 50); if (limit > 100) throw new HttpError(400, 'Page size must be at most 100.');
    return { before: number('before', Number.MAX_SAFE_INTEGER), limit };
  }
  private detail(id: string, actor: AuthContext, query = new URLSearchParams()): SuiteDetail {
    const context = this.context(actor), current = context.get(id), module = this.module(current.app), page = this.page(query);
    const rows = this.store.database.prepare('SELECT sequence,event FROM suite_history WHERE record_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(id, page.before, page.limit + 1) as { sequence: number; event: string }[];
    const events = rows.slice(0, page.limit).map(row => ({ ...JSON.parse(row.event) as SuiteEvent, sequence: row.sequence }));
    const visibleEvents = module.presentEvents?.(events, current, context) ?? events;
    return { record: module.present?.(structuredClone(current), context) ?? current, events: visibleEvents, nextBefore: rows.length > page.limit ? events.at(-1)!.sequence : null, canEdit: actor.scopes.includes('write') && context.canEdit(current), accessEpoch: this.policies.epoch() };
  }
  private route(path: string) {
    const match = /^\/api\/suite\/([a-z]+)(?:\/([^/]+))?(?:\/([a-z-]+))?$/.exec(path);
    if (!match || !SUITE_APPS.includes(match[1] as SuiteApp)) throw unavailable();
    return { app: match[1] as SuiteApp, id: match[2], action: match[3] };
  }
  read(path: string, query: URLSearchParams, actor: AuthContext): SuiteDetail | SuiteList {
    this.auth.revalidate(actor, 'read');
    const route = this.route(path);
    for (const key of query.keys()) if (!(route.id ? ['before', 'limit'] : ['before', 'limit', 'q', 'kind']).includes(key)) throw new HttpError(400, 'Unknown query field.');
    if (route.action) throw unavailable();
    if (route.id) { const detail = this.detail(route.id, actor, query); if (detail.record.app !== route.app) throw unavailable(); return detail; }
    const context = this.context(actor), module = this.module(route.app), { before, limit } = this.page(query), search = query.get('q')?.toLocaleLowerCase() ?? '', kind = query.get('kind');
    if (search.length > 255 || kind && kind.length > 100) throw new HttpError(400, 'Search is too long.');
    const records: SuiteRecord[] = [];
    let cursor = before, scanned = 0, bytes = 0, more = false;
    const candidates = this.store.database.prepare('SELECT sequence,id FROM suite_records WHERE app=? AND sequence<? AND (? IS NULL OR kind=?) ORDER BY sequence DESC LIMIT 2000').all(route.app, before, kind, kind);
    for (const row of candidates) {
      try {
        const record = context.get(String(row.id));
        if (record.title.toLocaleLowerCase().includes(search)) {
          const projected = module.present?.(structuredClone(record), context) ?? record, size = Buffer.byteLength(JSON.stringify(projected));
          if (records.length && bytes + size > 4_000_000) { more = true; break; }
          records.push(projected); bytes += size;
        }
      } catch (error) { if (!permissionFailure(error)) throw error; }
      cursor = Number(row.sequence); scanned++;
      if (records.length >= limit || scanned === 2000) { more = true; break; }
    }
    return { records, nextBefore: more ? cursor : null, accessEpoch: this.policies.epoch() };
  }
  private save(record: SuiteRecord, actor: AuthContext, action: string, summary: string, create: boolean): void {
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 2_000_000) throw new HttpError(409, 'This object exceeds the current 2 MB storage limit. Export or split its content before adding more.');
    if (create) this.store.database.prepare('INSERT INTO suite_records(id,app,kind,data) VALUES(?,?,?,?)').run(record.id, record.app, record.kind, data);
    else this.store.database.prepare('UPDATE suite_records SET data=? WHERE id=?').run(data, record.id);
    const event = { recordId: record.id, version: record.version, actorId: actor.principalId, actorName: actor.displayName, action, summary: string(summary, 'History summary', 2000, true), createdAt: record.updatedAt };
    this.store.database.prepare('INSERT INTO suite_history(record_id,version,event,snapshot) VALUES(?,?,?,?)').run(record.id, record.version, JSON.stringify(event), data);
    // Membership and inherited permissions may change through application commands.
    this.store.database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
  }
  mutate(method: string, path: string, input: unknown, key: string | undefined, actor: AuthContext): MutationResponse {
    if (method !== 'POST') throw new HttpError(405, 'Use POST for application changes.');
    if (!key || key.length > 200) throw new HttpError(400, 'Changes require a bounded Idempotency-Key.');
    const route = this.route(path), module = this.module(route.app), fingerprint = createHash('sha256').update(JSON.stringify([method, path, input])).digest('hex');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Expected a JSON object.');
    return this.store.mutate(`suite:${actor.workspaceId}:${actor.principalId}:${key}`, fingerprint, () => {
      let record: SuiteRecord;
      if (!route.id) {
        const { access: supplied, ...fields } = input as Record<string, unknown>;
        const parent = module.creationAccessSource?.(fields, this.context(actor));
        const selected = this.access(parent ? this.context(actor).get(parent).access : supplied, actor), context = this.context(actor, selected.spaceId);
        context.creationAccess = selected;
        const created = module.create(fields, context);
        record = { id: `${module.prefix}-${randomUUID()}`, app: route.app, kind: string(created.kind, 'Object kind', 100), title: string(created.title, 'Title', 255), ownerId: actor.principalId, version: 1, createdAt: context.now, updatedAt: context.now, access: this.access({ ...selected, ...created.access }, actor), data: created.data };
        this.save(record, actor, 'create', created.summary ?? `Created ${record.kind}.`, true);
      } else {
        if (!route.action) throw unavailable();
        const raw = this.raw(route.id), context = this.context(actor, raw.access.spaceId), current = context.get(route.id);
        if (current.app !== route.app) throw unavailable();
        const { expectedVersion, ...fields } = input as Record<string, unknown>;
        if (integer(expectedVersion, 'Expected version') !== current.version) throw new HttpError(409, 'This object changed. Refresh and review the current version before submitting.');
        if (route.action === 'access') {
          context.requireEdit(current);
          if (module.accessSource?.(current)) throw new HttpError(409, 'Change access on the parent object.');
          const selected = object(fields, ['access']);
          record = { ...current, access: this.access(selected.access, actor, current.access), version: current.version + 1, updatedAt: context.now };
          this.save(record, actor, route.action, 'Updated object access.', false);
        } else {
          const changed = module.command(structuredClone(current), route.action, fields, context);
          record = { ...current, title: changed.title === undefined ? current.title : string(changed.title, 'Title', 255), data: changed.data, access: this.access(changed.access, actor, current.access), version: current.version + 1, updatedAt: context.now };
          this.save(record, actor, route.action, changed.summary, false);
        }
      }
      return { status: route.id ? 200 : 201, body: { recordId: record.id, version: record.version, action: route.action ?? 'create' } };
    }, () => this.auth.revalidate(actor, 'write'), (response, replayed) => {
      const receipt = response.body as { recordId: string; version: number; action: string };
      // Exact retry acknowledges its original operation. Content is freshly projected
      // under today's policies so historical receipts cannot disclose private votes.
      try { return { status: response.status, body: { ...this.detail(receipt.recordId, actor), receipt: { ...receipt, replayed } } }; }
      catch (error) {
        if (!permissionFailure(error)) throw error;
        // Leaving a conversation may revoke the caller's own access in this write.
        if (!replayed) return { status: response.status, body: { record: null, events: [], nextBefore: null, canEdit: false, accessEpoch: this.policies.epoch(), receipt: { ...receipt, replayed }, unavailable: true } };
        throw error;
      }
    });
  }
}
