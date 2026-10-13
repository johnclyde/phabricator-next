import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Script, createContext } from 'node:vm';
import type { DatabaseSync } from 'node:sqlite';
import { HERALD_CONTENT_TYPES, evaluateHeraldRules, parseHeraldRuleInput, type HeraldAction, type HeraldActionResult, type HeraldContentType, type HeraldRule, type HeraldRuleInput, type HeraldRuleState, type HeraldRuleVersion, type HeraldSnapshot, type HeraldTranscript } from '../shared/herald.ts';
import { HttpError } from './validation.ts';

export interface HeraldAuthority { canManageGlobal: (actorId: string) => boolean; canEditObject: (actorId: string, objectId: string) => boolean; isEnabledPrincipal: (actorId: string) => boolean }
export interface HeraldHooks {
  canEvaluate: (rule: HeraldRule, snapshot: HeraldSnapshot) => boolean;
  matchesScope?: (rule: HeraldRule, snapshot: HeraldSnapshot) => boolean;
  canApply: (rule: HeraldRule, action: HeraldAction, snapshot: HeraldSnapshot) => boolean;
  apply: (rule: HeraldRule, action: HeraldAction, snapshot: HeraldSnapshot) => { changed: boolean; message: string; references?: string[] };
}
let sequence = 0;
function scope<T>(db: DatabaseSync, work: () => T, write = false): T {
  const name = `herald_${++sequence}`; db.exec(`SAVEPOINT ${name}`);
  try { if (write) db.exec('UPDATE herald_meta SET value=value WHERE 0'); const result = work(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
const invalid = () => new HttpError(409, 'Herald evidence cannot be verified.', 'HERALD_INTEGRITY');
const missing = () => new HttpError(404, 'Herald rule or transcript is unavailable.', 'HERALD_UNAVAILABLE');
function decode<T>(value: string): T { try { return JSON.parse(value) as T; } catch { throw invalid(); } }
function parse(input: unknown): HeraldRuleInput { try { return parseHeraldRuleInput(input); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid Herald rule.', 'HERALD_INVALID'); } }
function natural(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function limit(value: number | undefined): number { if (value !== undefined && (!natural(value) || value < 1 || value > 100)) throw new HttpError(400, 'Choose a page size from 1 to 100.'); return value ?? 50; }
function before(value: number | undefined): number { if (value !== undefined && (!natural(value) || value < 1)) throw new HttpError(400, 'Choose a valid page cursor.'); return value ?? Number.MAX_SAFE_INTEGER; }
function pattern(value: string): { source: string; flags: string } {
  if (value.length > 20_000 || value[0] !== '/') throw new HttpError(400, 'Use /pattern/flags for regular expressions; supported flags are i, m, s, u.');
  const last = value.lastIndexOf('/'); if (last === 0) throw new HttpError(400, 'Close the regular expression with /.');
  const source = value.slice(1, last), flags = value.slice(last + 1);
  if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) throw new HttpError(400, 'Supported regular-expression flags are i, m, s, u, without duplicates.');
  try { new RegExp(source, flags); } catch { throw new HttpError(400, 'The regular expression is invalid in the JavaScript regular-expression dialect.'); }
  return { source, flags };
}
const matchScript = new Script('values.some(value => new RegExp(source, flags).test(value))', { filename: 'herald-regexp' });
/** Only fixed code executes in the VM. Patterns and source are inert values;
 * the timeout interrupts pathological backtracking on the server thread. */
export function heraldRegexp(patternText: string, values: readonly string[], timeout = 25): boolean {
  const compiled = pattern(patternText);
  try { return matchScript.runInContext(createContext({ source: compiled.source, flags: compiled.flags, values: [...values] }, { codeGeneration: { strings: false, wasm: false } }), { timeout }) === true; }
  catch { throw new Error('Regular expression exceeded the bounded evaluation time or could not be evaluated.'); }
}
function validatePatterns(input: HeraldRuleInput): void {
  for (const condition of input.conditions) {
    if (condition.operator === 'regexp' || condition.operator === '!regexp') pattern(String(condition.value));
    if (condition.operator === 'regexp-pair') for (const value of JSON.parse(String(condition.value)) as [string, string]) pattern(value);
  }
}
export function initializeHerald(database: DatabaseSync): void {
  scope(database, () => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS herald_meta(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
      INSERT OR IGNORE INTO herald_meta(name,value) VALUES('rule',0);
      CREATE TABLE IF NOT EXISTS herald_rules(id TEXT PRIMARY KEY,number INTEGER UNIQUE NOT NULL,version INTEGER NOT NULL,content_type TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.version')=version AND json_extract(data,'$.contentType')=content_type));
      CREATE TABLE IF NOT EXISTS herald_rule_versions(rule_id TEXT NOT NULL REFERENCES herald_rules(id),version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(rule_id,version),CHECK(json_extract(data,'$.rule.id')=rule_id AND json_extract(data,'$.rule.version')=version));
      CREATE TABLE IF NOT EXISTS herald_transcripts(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,event_id TEXT NOT NULL,object_id TEXT NOT NULL,dry_run INTEGER NOT NULL CHECK(dry_run IN(0,1)),snapshot_hash TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.eventId')=event_id AND json_extract(data,'$.objectId')=object_id AND json_extract(data,'$.dryRun')=dry_run));
      CREATE UNIQUE INDEX IF NOT EXISTS herald_event_once ON herald_transcripts(event_id,object_id) WHERE dry_run=0;
      CREATE INDEX IF NOT EXISTS herald_transcripts_object ON herald_transcripts(object_id,sequence);
      CREATE TABLE IF NOT EXISTS herald_rule_state(rule_id TEXT NOT NULL REFERENCES herald_rules(id),object_id TEXT NOT NULL,applied INTEGER NOT NULL CHECK(applied IN(0,1)),matched INTEGER NOT NULL CHECK(matched IN(0,1)),PRIMARY KEY(rule_id,object_id));
    `);
    for (const table of ['herald_rule_versions', 'herald_transcripts']) database.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Herald evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Herald evidence is immutable'); END;`);
    for (const [table, columns] of Object.entries({ herald_meta: ['name', 'value'], herald_rules: ['id', 'number', 'version', 'content_type', 'data'], herald_rule_versions: ['rule_id', 'version', 'data'], herald_transcripts: ['sequence', 'id', 'event_id', 'object_id', 'dry_run', 'snapshot_hash', 'data'], herald_rule_state: ['rule_id', 'object_id', 'applied', 'matched'] })) if (!isDeepStrictEqual((database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name), columns)) throw new Error(`Unexpected ${table} schema.`);
  });
}
export class HeraldStore {
  constructor(private readonly database: DatabaseSync) {}
  private authorize(rule: Pick<HeraldRule, 'ruleType' | 'objectId' | 'authorId'>, actorId: string, authority: HeraldAuthority): void {
    if (!authority.isEnabledPrincipal(actorId) || (rule.ruleType === 'personal' ? actorId !== rule.authorId : rule.ruleType === 'global' ? !authority.canManageGlobal(actorId) : !rule.objectId || !authority.canEditObject(actorId, rule.objectId))) throw new HttpError(403, 'You cannot manage this Herald rule.', 'HERALD_FORBIDDEN');
  }
  private verify(rule: HeraldRule): HeraldRule {
    try { const { id, version, authorId, createdAt, updatedAt, ...input } = rule; if (!/^H[1-9]\d{0,14}$/.test(id) || !natural(version) || version < 1 || !authorId || !Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt)) || !isDeepStrictEqual(parseHeraldRuleInput(input), input)) throw invalid(); }
    catch { throw invalid(); } return rule;
  }
  get(id: string): HeraldRule {
    const row = this.database.prepare('SELECT version,data FROM herald_rules WHERE id=?').get(id) as { version: number; data: string } | undefined; if (!row) throw missing();
    const rule = this.verify(decode<HeraldRule>(row.data)), history = this.database.prepare('SELECT data FROM herald_rule_versions WHERE rule_id=? AND version=?').get(id, row.version) as { data: string } | undefined;
    const latest = this.database.prepare('SELECT max(version) AS version FROM herald_rule_versions WHERE rule_id=?').get(id) as { version: number };
    if (rule.id !== id || rule.version !== row.version || latest.version !== row.version || !history || !isDeepStrictEqual(decode<HeraldRuleVersion>(history.data).rule, rule)) throw invalid(); return rule;
  }
  create(input: unknown, actorId: string, authority: HeraldAuthority): HeraldRule {
    const data = parse(input); validatePatterns(data);
    return scope(this.database, () => {
      this.authorize({ ...data, authorId: actorId }, actorId, authority);
      const number = (this.database.prepare("UPDATE herald_meta SET value=value+1 WHERE name='rule' RETURNING value").get() as { value: number }).value;
      if (!Number.isSafeInteger(number) || number > 999_999_999_999_999) throw new HttpError(422, 'Herald rule identities are exhausted.');
      const now = new Date().toISOString(), rule: HeraldRule = { ...data, id: `H${number}`, version: 1, authorId: actorId, createdAt: now, updatedAt: now };
      this.database.prepare('INSERT INTO herald_rules(id,number,version,content_type,data) VALUES(?,?,?,?,?)').run(rule.id, number, rule.version, rule.contentType, JSON.stringify(rule));
      this.database.prepare('INSERT INTO herald_rule_versions(rule_id,version,data) VALUES(?,?,?)').run(rule.id, rule.version, JSON.stringify({ rule, actorId, createdAt: now } satisfies HeraldRuleVersion));
      return rule;
    }, true);
  }
  update(id: string, expectedVersion: number, input: unknown, actorId: string, authority: HeraldAuthority): HeraldRule {
    const data = parse(input); validatePatterns(data); if (!natural(expectedVersion) || expectedVersion < 1) throw new HttpError(400, 'Choose the exact rule version.');
    return scope(this.database, () => {
      const current = this.get(id); this.authorize(current, actorId, authority);
      if (current.version !== expectedVersion) throw new HttpError(409, 'Herald rule changed. Reload before saving.', 'HERALD_CHANGED');
      if (current.contentType !== data.contentType || current.ruleType !== data.ruleType || current.objectId !== data.objectId) throw new HttpError(400, 'Rule content type, type, and scope are immutable. Create another rule.');
      const { id: _id, version: _version, authorId: _author, createdAt: _created, updatedAt: _updated, ...oldInput } = current;
      if (isDeepStrictEqual(data, oldInput)) return current;
      if (!Number.isSafeInteger(current.version + 1)) throw new HttpError(422, 'Herald rule versions are exhausted.');
      const now = new Date().toISOString(), rule: HeraldRule = { ...current, ...data, version: current.version + 1, updatedAt: now };
      this.database.prepare('UPDATE herald_rules SET version=?,data=? WHERE id=?').run(rule.version, JSON.stringify(rule), id);
      this.database.prepare('INSERT INTO herald_rule_versions(rule_id,version,data) VALUES(?,?,?)').run(id, rule.version, JSON.stringify({ rule, actorId, createdAt: now } satisfies HeraldRuleVersion)); return rule;
    }, true);
  }
  list(query: { contentType?: HeraldContentType; enabled?: boolean; before?: number; limit?: number } = {}): { rules: HeraldRule[]; nextBefore: number | null } {
    const size = limit(query.limit), cursor = before(query.before);
    if (query.contentType !== undefined && !HERALD_CONTENT_TYPES.includes(query.contentType) || query.enabled !== undefined && typeof query.enabled !== 'boolean') throw new HttpError(400, 'Invalid Herald filter.');
    const rows = this.database.prepare('SELECT id,number FROM herald_rules WHERE number<? AND (? IS NULL OR content_type=?) AND (? IS NULL OR json_extract(data,\'$.enabled\')=?) ORDER BY number DESC LIMIT ?').all(cursor, query.contentType ?? null, query.contentType ?? null, query.enabled === undefined ? null : Number(query.enabled), query.enabled === undefined ? null : Number(query.enabled), size + 1) as { id: string; number: number }[];
    const page = rows.slice(0, size); return { rules: page.map(row => this.get(row.id)), nextBefore: rows.length > size ? page.at(-1)!.number : null };
  }
  history(id: string, cursor?: number, pageLimit?: number): { versions: HeraldRuleVersion[]; nextBefore: number | null } {
    this.get(id); const size = limit(pageLimit), rows = this.database.prepare('SELECT version,data FROM herald_rule_versions WHERE rule_id=? AND version<? ORDER BY version DESC LIMIT ?').all(id, before(cursor), size + 1) as { version: number; data: string }[];
    const page = rows.slice(0, size), versions = page.map(row => { const entry = decode<HeraldRuleVersion>(row.data); if (entry.rule.id !== id || entry.rule.version !== row.version) throw invalid(); this.verify(entry.rule); return entry; });
    return { versions, nextBefore: rows.length > size ? page.at(-1)!.version : null };
  }
  evaluate(snapshot: HeraldSnapshot, hooks: HeraldHooks, dryRun = false): HeraldTranscript {
    if (!snapshot.objectId || !snapshot.eventId || !snapshot.actorId || !natural(snapshot.version) || typeof snapshot.isNew !== 'boolean') throw new HttpError(400, 'Herald requires an exact authenticated event snapshot.');
    const frozen = structuredClone(snapshot), snapshotHash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
    return scope(this.database, () => {
      if (!dryRun) {
        const existing = this.database.prepare('SELECT snapshot_hash,data FROM herald_transcripts WHERE event_id=? AND object_id=? AND dry_run=0').get(frozen.eventId, frozen.objectId) as { snapshot_hash: string; data: string } | undefined;
        if (existing) { if (existing.snapshot_hash !== snapshotHash) throw new HttpError(409, 'This event was already evaluated with a different object snapshot.', 'HERALD_EVENT_CHANGED'); return decode<HeraldTranscript>(existing.data); }
      }
      const rules = (this.database.prepare('SELECT id FROM herald_rules WHERE content_type=? ORDER BY number').all(frozen.contentType) as { id: string }[]).map(row => this.get(row.id));
      const previous: Record<string, HeraldRuleState> = {};
      for (const row of this.database.prepare('SELECT rule_id,applied,matched FROM herald_rule_state WHERE object_id=?').all(frozen.objectId) as { rule_id: string; applied: number; matched: number }[]) previous[row.rule_id] = { applied: Boolean(row.applied), matched: Boolean(row.matched) };
      const evaluated = evaluateHeraldRules(rules, frozen, previous, { dryRun, canEvaluate: hooks.canEvaluate, matchesScope: hooks.matchesScope, regexp: heraldRegexp }), byId = new Map(rules.map(rule => [rule.id, rule])), actions: HeraldActionResult[] = [];
      for (const effect of evaluated.effects) {
        const rule = byId.get(effect.ruleId)!;
        if (dryRun) { actions.push({ ...effect, status: 'dry-run', message: 'This was a dry run; no action was taken.' }); continue; }
        try {
          const result = scope(this.database, () => {
            if (!hooks.canEvaluate(rule, frozen) || !hooks.canApply(rule, effect.action, frozen)) return { ...effect, status: 'forbidden' as const, message: 'Current permissions do not allow this action.' };
            if (effect.action.type === 'nothing') return { ...effect, status: 'no-effect' as const, message: 'Rule requested no action.' };
            const applied = hooks.apply(rule, structuredClone(effect.action), structuredClone(frozen));
            return { ...effect, status: applied.changed ? 'applied' as const : 'no-effect' as const, message: applied.message, ...(applied.references ? { references: applied.references } : {}) };
          }, true); actions.push(result);
        } catch (error) { actions.push({ ...effect, status: 'error', message: error instanceof HttpError ? error.message : 'Action failed; its changes were rolled back.' }); }
      }
      if (!dryRun) for (const [ruleId, state] of Object.entries(evaluated.state)) this.database.prepare('INSERT INTO herald_rule_state(rule_id,object_id,applied,matched) VALUES(?,?,?,?) ON CONFLICT(rule_id,object_id) DO UPDATE SET applied=excluded.applied,matched=excluded.matched').run(ruleId, frozen.objectId, Number(state.applied), Number(state.matched));
      const transcript: HeraldTranscript = { id: `HT-${randomUUID()}`, eventId: frozen.eventId, objectId: frozen.objectId, contentType: frozen.contentType, createdAt: new Date().toISOString(), dryRun, actorId: frozen.actorId, snapshot: frozen, rules: evaluated.rules, actions };
      this.database.prepare('INSERT INTO herald_transcripts(id,event_id,object_id,dry_run,snapshot_hash,data) VALUES(?,?,?,?,?,?)').run(transcript.id, transcript.eventId, transcript.objectId, Number(dryRun), snapshotHash, JSON.stringify(transcript)); return transcript;
    }, true);
  }
  transcript(id: string, canViewObject: (objectId: string) => boolean): HeraldTranscript {
    const row = this.database.prepare('SELECT object_id,snapshot_hash,data FROM herald_transcripts WHERE id=?').get(id) as { object_id: string; snapshot_hash: string; data: string } | undefined;
    if (!row || !canViewObject(row.object_id)) throw missing(); const value = decode<HeraldTranscript>(row.data); if (value.id !== id || value.objectId !== row.object_id || !value.snapshot || createHash('sha256').update(JSON.stringify(value.snapshot)).digest('hex') !== row.snapshot_hash) throw invalid(); return value;
  }
  transcripts(query: { objectId?: string; before?: number; limit?: number } = {}, canViewObject: (objectId: string) => boolean): { transcripts: HeraldTranscript[]; nextBefore: number | null } {
    const size = limit(query.limit), cursor = before(query.before), rows = this.database.prepare('SELECT sequence,id,object_id FROM herald_transcripts WHERE sequence<? AND (? IS NULL OR object_id=?) ORDER BY sequence DESC LIMIT 1001').all(cursor, query.objectId ?? null, query.objectId ?? null) as { sequence: number; id: string; object_id: string }[];
    const values: HeraldTranscript[] = []; let scanned = 0;
    for (const row of rows.slice(0, 1000)) { if (values.length === size) break; scanned++; if (canViewObject(row.object_id)) values.push(this.transcript(row.id, canViewObject)); }
    return { transcripts: values, nextBefore: scanned < rows.length ? rows[scanned - 1]!.sequence : null };
  }
}
