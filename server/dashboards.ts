import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { dashboardDefinition, isDashboardId, parseDashboardDefinition, type Dashboard, type DashboardDefinition, type DashboardHome } from '../shared/dashboards.ts';
import { HttpError } from './validation.ts';

const definitions = [
  ['table', 'dashboard_records', 'CREATE TABLE dashboard_records(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),deleted INTEGER NOT NULL CHECK(deleted IN(0,1)),data TEXT NOT NULL CHECK(json_valid(data)))'],
  ['table', 'dashboard_history', 'CREATE TABLE dashboard_history(dashboard_id TEXT NOT NULL REFERENCES dashboard_records(id),version INTEGER NOT NULL CHECK(version>0),snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),PRIMARY KEY(dashboard_id,version))'],
  ['table', 'dashboard_homes', 'CREATE TABLE dashboard_homes(principal_id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>0),dashboard_id TEXT REFERENCES dashboard_records(id))'],
  ['table', 'dashboard_operations', 'CREATE TABLE dashboard_operations(principal_id TEXT NOT NULL,request_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL CHECK(json_valid(receipt)),PRIMARY KEY(principal_id,request_hash))'],
  ['trigger', 'dashboard_records_identity', "CREATE TRIGGER dashboard_records_identity BEFORE UPDATE ON dashboard_records WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.version<>OLD.version+1 OR OLD.deleted=1 BEGIN SELECT RAISE(ABORT,'Dashboard identity and tombstones are immutable'); END"],
  ['trigger', 'dashboard_records_no_delete', "CREATE TRIGGER dashboard_records_no_delete BEFORE DELETE ON dashboard_records BEGIN SELECT RAISE(ABORT,'Dashboards require tombstones'); END"],
  ['trigger', 'dashboard_history_no_update', "CREATE TRIGGER dashboard_history_no_update BEFORE UPDATE ON dashboard_history BEGIN SELECT RAISE(ABORT,'Dashboard history is immutable'); END"],
  ['trigger', 'dashboard_history_no_delete', "CREATE TRIGGER dashboard_history_no_delete BEFORE DELETE ON dashboard_history BEGIN SELECT RAISE(ABORT,'Dashboard history is immutable'); END"],
  ['trigger', 'dashboard_operations_no_update', "CREATE TRIGGER dashboard_operations_no_update BEFORE UPDATE ON dashboard_operations BEGIN SELECT RAISE(ABORT,'Dashboard operations are immutable'); END"],
  ['trigger', 'dashboard_operations_no_delete', "CREATE TRIGGER dashboard_operations_no_delete BEFORE DELETE ON dashboard_operations BEGIN SELECT RAISE(ABORT,'Dashboard operations are immutable'); END"],
] as const;
export function initializeDashboards(database: DatabaseSync): void {
  database.exec('SAVEPOINT dashboard_schema');
  try {
    for (const [type, name, sql] of definitions) {
      const rows = database.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').all(name) as { type: string; sql: string }[];
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/;$/, '');
      if (rows.length && (rows.length !== 1 || rows[0]!.type !== type || normalize(rows[0]!.sql) !== normalize(sql))) throw new Error(`Unexpected ${name} schema; dashboard migration was not applied.`);
      if (!rows.length) database.exec(sql);
    }
    database.exec('RELEASE dashboard_schema');
  } catch (error) { database.exec('ROLLBACK TO dashboard_schema; RELEASE dashboard_schema'); throw error; }
}
export interface DashboardOperation { id: string | null; version: number; action: 'create' | 'update' | 'delete' | 'home' }
const unavailable = () => new HttpError(404, 'Dashboard was not found.');
const invalid = () => new HttpError(409, 'Dashboard evidence cannot be verified.');
export class DashboardStore {
  constructor(private readonly database: DatabaseSync, private readonly clock = Date.now) {}
  private raw(id: string): Dashboard {
    if (!isDashboardId(id)) throw unavailable();
    const row = this.database.prepare('SELECT owner_id,version,deleted,data FROM dashboard_records WHERE id=?').get(id) as { owner_id: string; version: number; deleted: number; data: string } | undefined;
    if (!row) throw unavailable();
    let value: Dashboard;
    try { value = JSON.parse(row.data) as Dashboard; dashboardDefinition(value); } catch { throw invalid(); }
    if (value.id !== id || value.ownerId !== row.owner_id || value.version !== row.version || value.deleted !== Boolean(row.deleted)
      || !Number.isSafeInteger(value.version) || value.version < 1 || !value.ownerId || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) throw invalid();
    const history = this.database.prepare('SELECT snapshot FROM dashboard_history WHERE dashboard_id=? AND version=?').get(id, value.version) as { snapshot: string } | undefined;
    if (!history || history.snapshot !== row.data) throw invalid();
    return value;
  }
  get(id: string, principal: string): Dashboard {
    const value = this.raw(id);
    if (value.deleted || value.ownerId !== principal && value.visibility !== 'workspace') throw unavailable();
    return value;
  }
  requireOwner(id: string, principal: string, tombstone = false): Dashboard {
    const value = this.raw(id);
    if (value.ownerId !== principal || value.deleted && !tombstone) throw unavailable(); return value;
  }
  list(principal: string): Dashboard[] {
    const result: Dashboard[] = [];
    for (const row of this.database.prepare('SELECT id FROM dashboard_records WHERE deleted=0 ORDER BY rowid DESC').all()) {
      const value = this.raw(String(row.id)); if (value.ownerId === principal || value.visibility === 'workspace') result.push(value);
    }
    return result;
  }
  home(principal: string): DashboardHome {
    const row = this.database.prepare('SELECT dashboard_id,version FROM dashboard_homes WHERE principal_id=?').get(principal) as { dashboard_id: string | null; version: number } | undefined;
    if (!row) return { dashboardId: null, version: 0 };
    if (!Number.isSafeInteger(row.version) || row.version < 1) throw invalid();
    // Preserve the preference version while retiring the unavailable identifier.
    if (row.dashboard_id) { try { this.get(row.dashboard_id, principal); } catch (error) { if (!(error instanceof HttpError) || error.status !== 404) throw error; return { dashboardId: null, version: row.version }; } }
    return { dashboardId: row.dashboard_id, version: row.version };
  }
  setHome(principal: string, id: string | null, expectedVersion: number): DashboardHome {
    const before = this.home(principal);
    if (expectedVersion !== before.version || !Number.isSafeInteger(before.version + 1)) throw new HttpError(409, 'Your home dashboard preference changed. Refresh before saving.');
    if (id) this.get(id, principal);
    this.database.prepare('INSERT INTO dashboard_homes(principal_id,version,dashboard_id) VALUES(?,?,?) ON CONFLICT(principal_id) DO UPDATE SET version=excluded.version,dashboard_id=excluded.dashboard_id').run(principal, before.version + 1, id);
    return { dashboardId: id, version: before.version + 1 };
  }
  create(principal: string, definition: DashboardDefinition): Dashboard {
    const now = new Date(this.clock()).toISOString();
    const value: Dashboard = { ...parseDashboardDefinition(definition), id: `DASH-${randomUUID()}`, ownerId: principal, version: 1, deleted: false, createdAt: now, updatedAt: now };
    this.database.prepare('INSERT INTO dashboard_records(id,owner_id,version,deleted,data) VALUES(?,?,?,0,?)').run(value.id, principal, 1, JSON.stringify(value));
    this.saveHistory(value); return value;
  }
  update(principal: string, id: string, definition: DashboardDefinition | null, expectedVersion: number): Dashboard {
    const before = this.requireOwner(id, principal);
    if (before.version !== expectedVersion || !Number.isSafeInteger(before.version + 1)) throw new HttpError(409, 'This dashboard changed. Refresh and review the current version before saving.');
    const value: Dashboard = { ...before, ...(definition ? parseDashboardDefinition(definition) : {}), deleted: !definition, version: before.version + 1, updatedAt: new Date(this.clock()).toISOString() };
    this.database.prepare('UPDATE dashboard_records SET version=?,deleted=?,data=? WHERE id=?').run(value.version, Number(value.deleted), JSON.stringify(value), id);
    this.saveHistory(value);
    if (before.visibility !== value.visibility || value.deleted) this.database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
    return value;
  }
  private saveHistory(value: Dashboard): void { this.database.prepare('INSERT INTO dashboard_history(dashboard_id,version,snapshot) VALUES(?,?,?)').run(value.id, value.version, JSON.stringify(value)); }
  operation(principal: string, hash: string, fingerprint: string): DashboardOperation | null {
    const row = this.database.prepare('SELECT fingerprint,receipt FROM dashboard_operations WHERE principal_id=? AND request_hash=?').get(principal, hash) as { fingerprint: string; receipt: string } | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new HttpError(409, 'This request ID was already used for different dashboard changes.');
    let receipt: DashboardOperation;
    try { receipt = JSON.parse(row.receipt) as DashboardOperation; } catch { throw invalid(); }
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'action,id,version' || !['create', 'update', 'delete', 'home'].includes(receipt.action) || !Number.isSafeInteger(receipt.version) || receipt.version < 1 || receipt.id !== null && !isDashboardId(receipt.id)) throw invalid();
    if (receipt.action !== 'home') {
      if (!receipt.id) throw invalid();
      const owner = this.requireOwner(receipt.id, principal, true);
      const historical = this.database.prepare('SELECT snapshot FROM dashboard_history WHERE dashboard_id=? AND version=?').get(receipt.id, receipt.version) as { snapshot: string } | undefined;
      if (!historical) throw invalid();
      const snapshot = JSON.parse(historical.snapshot) as Dashboard;
      if (snapshot.id !== receipt.id || snapshot.ownerId !== owner.ownerId || snapshot.version !== receipt.version || snapshot.deleted !== (receipt.action === 'delete') || receipt.action === 'create' && receipt.version !== 1) throw invalid();
    }
    return receipt;
  }
  recordOperation(principal: string, hash: string, fingerprint: string, receipt: DashboardOperation): void {
    this.database.prepare('INSERT INTO dashboard_operations(principal_id,request_hash,fingerprint,receipt) VALUES(?,?,?,?)').run(principal, hash, fingerprint, JSON.stringify(receipt));
  }
}
