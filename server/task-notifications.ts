import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { isRevisionAuthorId } from '../shared/revision-authorship.ts';
import { isRevisionMetadataAttribution } from '../shared/revision-metadata.ts';
import { NOTIFICATION_LIMITS } from '../shared/notifications.ts';
import { isTaskNotificationId, isTaskMuteState, isTaskMuteTransaction, taskMuteInput, validTaskMuteResult } from '../shared/task-notifications.ts';
import type { TaskMuteState, TaskMuteInput, TaskMuteSnapshot, TaskMuteHistory, TaskMuteReceipt, TaskMuteTransaction } from '../shared/task-notifications.ts';
import type { ActorAttribution } from '../shared/types.ts';
import { HttpError } from './validation.ts';

export interface TaskMuteOperation {
  id: string; taskId: string; principalId: string; input: TaskMuteInput; inputSha256: string; retryKeySha256: string | null;
  attribution: ActorAttribution; before: TaskMuteState; after: TaskMuteState; transactionId: string | null; createdAt: string; receipt: TaskMuteReceipt;
}
interface HistoryRow { id: string; task_id: string; principal_id: string; version: number; operation_id: string; data: string }
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new HttpError(409, 'This private task notification history cannot be verified.', 'TASK_MUTE_INVALID_RECEIPT');
const changed = () => new HttpError(409, 'Task notification preferences or access changed. Reload before saving.', 'TASK_MUTE_CHANGED');
const keys = (value: object, expected: string[]) => isDeepStrictEqual(Object.keys(value).sort(), expected.sort());
function parse(value: unknown): TaskMuteInput { try { return taskMuteInput(value); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid task mute action.'); } }
function decode<T>(value: string): T { try { return JSON.parse(value) as T; } catch { throw invalid(); } }
export function taskMuteInputHash(input: TaskMuteInput): string { return createHash('sha256').update(JSON.stringify(parse(input))).digest('hex'); }
let serial = 0;
function scope<T>(db: DatabaseSync, work: () => T, writer = false): T {
  const name = `task_mute_${++serial}`; db.exec(`SAVEPOINT ${name}`);
  try { if (writer) db.exec('UPDATE task_notification_mutes SET version=version WHERE 0'); const result = work(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
const schema = `
  CREATE TABLE IF NOT EXISTS task_notification_mutes(task_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,muted INTEGER NOT NULL CHECK(muted IN(0,1)),version INTEGER NOT NULL CHECK(version>0),updated_at TEXT NOT NULL,PRIMARY KEY(task_id,principal_id));
  CREATE TABLE IF NOT EXISTS task_notification_mute_operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
  CREATE TABLE IF NOT EXISTS task_notification_mute_history(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),operation_id TEXT NOT NULL UNIQUE REFERENCES task_notification_mute_operations(id),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(task_id,principal_id,version));
  CREATE INDEX IF NOT EXISTS task_notification_mutes_active ON task_notification_mutes(task_id,muted,principal_id);
  CREATE TRIGGER IF NOT EXISTS task_notification_mutes_identity BEFORE UPDATE OF task_id,principal_id ON task_notification_mutes BEGIN SELECT RAISE(ABORT,'Task mute identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS task_notification_mutes_no_delete BEFORE DELETE ON task_notification_mutes BEGIN SELECT RAISE(ABORT,'Task mute preferences are durable'); END;
  ${['task_notification_mute_operations', 'task_notification_mute_history'].map(table => `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Task mute evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Task mute evidence is immutable'); END;`).join('\n')}
`;
export function initializeTaskNotifications(db: DatabaseSync): void {
  const canonical = new DatabaseSync(':memory:');
  try {
    canonical.exec(schema);
    const objects = canonical.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'task_notification_*' OR tbl_name GLOB 'task_notification_*'").all();
    for (const existing of db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'task_notification_*' OR tbl_name GLOB 'task_notification_*'").all()) if (!objects.some(expected => isDeepStrictEqual(existing, expected))) throw new Error('Conflicting private task notification schema; migration was not applied.');
    scope(db, () => db.exec(schema));
  } finally { canonical.close(); }
}

export class TaskNotificationsStore {
  constructor(private readonly database: DatabaseSync) {}
  private task(id: string): void { if (!isTaskNotificationId(id) || !this.database.prepare("SELECT 1 FROM entities WHERE id=? AND kind='task'").get(id)) throw new HttpError(404, 'Task is unavailable.', 'TASK_UNAVAILABLE'); }
  private principal(id: string): void { if (!isRevisionAuthorId(id)) throw new HttpError(400, 'An authenticated task notification recipient is required.'); }
  private epoch(): number { const value = (this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number }).value; if (!natural(value)) throw invalid(); return value; }
  private transaction(row: HistoryRow): TaskMuteTransaction {
    const value = decode<TaskMuteTransaction>(row.data);
    if (!isTaskMuteTransaction(value) || value.id !== row.id || value.taskId !== row.task_id || value.principalId !== row.principal_id || value.version !== row.version || !uuid(row.operation_id)) throw invalid();
    return value;
  }
  private stateAt(taskId: string, principalId: string, version: number): TaskMuteState {
    if (!natural(version)) throw invalid();
    if (version === 0) return { muted: false, version: 0, updatedAt: null };
    const row = this.database.prepare('SELECT * FROM task_notification_mute_history WHERE task_id=? AND principal_id=? AND version=?').get(taskId, principalId, version) as unknown as HistoryRow | undefined;
    if (!row) throw invalid(); const transaction = this.transaction(row);
    const previous = version === 1 ? false : (() => { const prior = this.database.prepare('SELECT * FROM task_notification_mute_history WHERE task_id=? AND principal_id=? AND version=?').get(taskId, principalId, version - 1) as unknown as HistoryRow | undefined; if (!prior) throw invalid(); return this.transaction(prior).after; })();
    if (transaction.before !== previous) throw invalid();
    return { muted: transaction.after, version, updatedAt: transaction.createdAt };
  }
  private state(taskId: string, principalId: string): TaskMuteState {
    this.task(taskId); this.principal(principalId);
    const row = this.database.prepare('SELECT muted,version,updated_at FROM task_notification_mutes WHERE task_id=? AND principal_id=?').get(taskId, principalId) as { muted: number; version: number; updated_at: string } | undefined;
    const latest = (this.database.prepare('SELECT coalesce(max(version),0) AS version FROM task_notification_mute_history WHERE task_id=? AND principal_id=?').get(taskId, principalId) as { version: number }).version;
    const state = row ? { muted: !!row.muted, version: row.version, updatedAt: row.updated_at } : { muted: false, version: 0, updatedAt: null };
    if (row && ![0, 1].includes(row.muted) || !isTaskMuteState(state) || state.version !== latest || !isDeepStrictEqual(state, this.stateAt(taskId, principalId, state.version))) throw invalid();
    return state;
  }
  snapshot(taskId: string, principalId: string): TaskMuteSnapshot { return scope(this.database, () => ({ taskId, principalId, ...this.state(taskId, principalId), accessEpoch: this.epoch() })); }
  history(taskId: string, principalId: string, query: { before?: number; limit?: number; expectedMuteVersion?: number } = {}): TaskMuteHistory {
    return scope(this.database, () => {
      const state = this.state(taskId, principalId), limit = query.limit ?? 25;
      if (Object.keys(query).some(key => !['before', 'limit', 'expectedMuteVersion'].includes(key)) || !natural(limit) || limit < 1 || limit > 100 || query.before !== undefined && (!natural(query.before) || query.before < 1) || query.expectedMuteVersion !== undefined && !natural(query.expectedMuteVersion)) throw new HttpError(400, 'Choose valid task mute history bounds.');
      if (query.expectedMuteVersion !== undefined && query.expectedMuteVersion !== state.version) throw changed();
      const rows = this.database.prepare('SELECT * FROM task_notification_mute_history WHERE task_id=? AND principal_id=? AND (? IS NULL OR version<?) ORDER BY version DESC LIMIT ?').all(taskId, principalId, query.before ?? null, query.before ?? null, limit + 1) as unknown as HistoryRow[];
      const entries = rows.slice(0, limit).map(row => this.transaction(row));
      return { taskId, principalId, version: state.version, entries, nextBefore: rows.length > limit ? entries.at(-1)!.version : null, accessEpoch: this.epoch() };
    });
  }
  mutedPeople(taskId: string): string[] {
    this.task(taskId);
    const rows = this.database.prepare('SELECT principal_id FROM task_notification_mutes WHERE task_id=? ORDER BY principal_id LIMIT ?').all(taskId, NOTIFICATION_LIMITS.recipients + 1) as { principal_id: string }[];
    if (rows.length > NOTIFICATION_LIMITS.recipients) throw new HttpError(422, 'Task mute routing exceeds the complete notification limit.', 'NOTIFICATION_LIMIT');
    // Verify both cache values: filtering muted=1 before proof validation would
    // turn a corrupted false cache bit into an unauthorized delivery.
    return rows.flatMap(row => this.state(taskId, row.principal_id).muted ? [row.principal_id] : []);
  }
  mutate(taskId: string, principalId: string, input: TaskMuteInput, attribution: ActorAttribution, retryKeySha256: string | null = null): TaskMuteReceipt {
    const request = parse(input);
    if (!isRevisionMetadataAttribution(attribution) || attribution.principalId !== principalId || retryKeySha256 !== null && !digest(retryKeySha256)) throw new HttpError(400, 'Authenticated task mute attribution is required.');
    return scope(this.database, () => {
      const before = this.state(taskId, principalId), epoch = this.epoch();
      if (request.expectedMuteVersion !== before.version || request.expectedAccessEpoch !== epoch) throw changed();
      const muted = request.action === 'mute', changedValue = muted !== before.muted, now = new Date().toISOString(), operationId = randomUUID();
      const after: TaskMuteState = changedValue ? { muted, version: before.version + 1, updatedAt: now } : { ...before };
      if (!isTaskMuteState(after)) throw new HttpError(409, 'The task mute preference version limit was reached.');
      const transaction: TaskMuteTransaction | null = changedValue ? { id: randomUUID(), taskId, principalId, version: after.version, before: before.muted, after: after.muted, createdAt: now, attribution: { ...attribution } } : null;
      const inputSha256 = taskMuteInputHash(request), receipt: TaskMuteReceipt = { taskId, operationId, inputSha256, changed: changedValue, accessEpoch: epoch };
      const operation: TaskMuteOperation = { id: operationId, taskId, principalId, input: request, inputSha256, retryKeySha256, attribution: { ...attribution }, before, after, transactionId: transaction?.id ?? null, createdAt: now, receipt };
      this.database.prepare('INSERT INTO task_notification_mute_operations(id,task_id,principal_id,input_sha256,data) VALUES(?,?,?,?,?)').run(operationId, taskId, principalId, inputSha256, JSON.stringify(operation));
      if (transaction) {
        this.database.prepare('INSERT INTO task_notification_mute_history(id,task_id,principal_id,version,operation_id,data) VALUES(?,?,?,?,?,?)').run(transaction.id, taskId, principalId, transaction.version, operationId, JSON.stringify(transaction));
        this.database.prepare('INSERT INTO task_notification_mutes(task_id,principal_id,muted,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(task_id,principal_id) DO UPDATE SET muted=excluded.muted,version=excluded.version,updated_at=excluded.updated_at').run(taskId, principalId, Number(muted), after.version, now);
      }
      return receipt;
    }, true);
  }
  operationPrincipalId(id: string): string { if (!uuid(id)) throw invalid(); const row = this.database.prepare('SELECT principal_id FROM task_notification_mute_operations WHERE id=?').get(id) as { principal_id: string } | undefined; if (!row || !isRevisionAuthorId(row.principal_id)) throw invalid(); return row.principal_id; }
  operationTaskId(id: string): string { if (!uuid(id)) throw invalid(); const row = this.database.prepare('SELECT task_id FROM task_notification_mute_operations WHERE id=?').get(id) as { task_id: string } | undefined; if (!row || !isTaskNotificationId(row.task_id)) throw invalid(); return row.task_id; }
  operation(id: string): TaskMuteOperation {
    return scope(this.database, () => {
      this.operationPrincipalId(id);
      const row = this.database.prepare('SELECT task_id,principal_id,input_sha256,data FROM task_notification_mute_operations WHERE id=?').get(id) as { task_id: string; principal_id: string; input_sha256: string; data: string };
      const op = decode<TaskMuteOperation>(row.data);
      try {
        if (!op || !keys(op, ['id', 'taskId', 'principalId', 'input', 'inputSha256', 'retryKeySha256', 'attribution', 'before', 'after', 'transactionId', 'createdAt', 'receipt']) || op.id !== id || op.taskId !== row.task_id || op.principalId !== row.principal_id || !isTaskNotificationId(op.taskId) || !isRevisionAuthorId(op.principalId) || !isTaskMuteState(op.before) || !isTaskMuteState(op.after) || !isRevisionMetadataAttribution(op.attribution) || op.attribution.principalId !== op.principalId || op.retryKeySha256 !== null && !digest(op.retryKeySha256) || !Number.isFinite(Date.parse(op.createdAt))) throw invalid();
        const input = parse(op.input), before = this.stateAt(op.taskId, op.principalId, op.before.version), desired = input.action === 'mute', didChange = before.muted !== desired;
        const after = didChange ? { muted: desired, version: before.version + 1, updatedAt: op.createdAt } : { ...before };
        if (!isDeepStrictEqual(input, op.input) || op.inputSha256 !== row.input_sha256 || op.inputSha256 !== taskMuteInputHash(input) || input.expectedMuteVersion !== before.version || !isDeepStrictEqual(op.before, before) || !isDeepStrictEqual(op.after, after) || !isDeepStrictEqual(op.after, this.stateAt(op.taskId, op.principalId, op.after.version))) throw invalid();
        const changes = this.database.prepare('SELECT * FROM task_notification_mute_history WHERE operation_id=?').all(id) as unknown as HistoryRow[];
        if (didChange) {
          if (changes.length !== 1 || !uuid(op.transactionId) || !isDeepStrictEqual(this.transaction(changes[0]!), { id: op.transactionId, taskId: op.taskId, principalId: op.principalId, version: after.version, before: before.muted, after: desired, createdAt: op.createdAt, attribution: op.attribution })) throw invalid();
        } else if (op.transactionId !== null || changes.length) throw invalid();
        if (!validTaskMuteResult(op.receipt, op.taskId) || !isDeepStrictEqual(op.receipt, { taskId: op.taskId, operationId: id, inputSha256: op.inputSha256, changed: didChange, accessEpoch: input.expectedAccessEpoch })) throw invalid();
        return op;
      } catch { throw invalid(); }
    });
  }
}
