import { createHash, randomUUID } from 'node:crypto';
import type { AuthContext } from '../shared/auth.ts';
import type { ActorAttribution, Task } from '../shared/types.ts';
import type { ManiphestBulkInput, ManiphestBulkPreview, ManiphestBulkReceipt, ManiphestReport, ManiphestReportRow } from '../shared/maniphest.ts';
import { isTaskClosed } from '../shared/tasks.ts';
import { AccessLayer } from './access.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import type { Store, MutationResponse } from './store.ts';
import { readManiphestConfig, taskManiphestValues, writeManiphestConfig } from './maniphest.ts';
import { HttpError, integer, object, string } from './validation.ts';

export function parseManiphestBulk(input: unknown): ManiphestBulkInput {
  const data = object(input, ['expectedConfigVersion', 'expectedAccessEpoch', 'tasks', 'changes']);
  if (!Array.isArray(data.tasks) || !data.tasks.length || data.tasks.length > 1000) throw new HttpError(400, 'Choose between 1 and 1,000 tasks for one atomic bulk edit.');
  const tasks = data.tasks.map(value => { const task = object(value, ['id', 'expectedVersion']); const id = string(task.id, 'Task ID', 50); if (!/^T[1-9]\d*$/.test(id)) throw new HttpError(400, 'Choose valid task IDs.'); return { id, expectedVersion: integer(task.expectedVersion, 'Task version') }; });
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new HttpError(400, 'Choose each task once.');
  const changes = object(data.changes, ['status', 'priority', 'ownerId', 'points', 'customFields']);
  if (!Object.keys(changes).length) throw new HttpError(400, 'Choose at least one field to edit.');
  if (changes.ownerId !== undefined && changes.ownerId !== null && typeof changes.ownerId !== 'string') throw new HttpError(400, 'Choose a valid owner.');
  return { expectedConfigVersion: integer(data.expectedConfigVersion, 'Configuration version'), expectedAccessEpoch: integer(data.expectedAccessEpoch, 'Access epoch'), tasks, changes: changes as ManiphestBulkInput['changes'] };
}
export class ManiphestService {
  constructor(private readonly store: Store, private readonly auth: Auth, private readonly policies: PolicyStore, private readonly admins: readonly string[] = []) {}
  private manager(context: AuthContext): boolean { return context.scopes.includes('write') && (context.kind === 'local' || this.admins.includes(context.principalId)); }
  private requireManager(context: AuthContext): void { if (!this.manager(context)) throw new HttpError(403, 'Task configuration requires an operator-designated task administrator.'); }
  private access(context: AuthContext): AccessLayer { return new AccessLayer(this.store, this.auth, this.policies, context); }
  read(path: string, query: URLSearchParams, context: AuthContext): unknown {
    return this.store.read(() => {
      this.auth.revalidate(context, 'read'); const config = readManiphestConfig(this.store.database), accessEpoch = this.policies.epoch();
      if (path === '/api/maniphest/config' && [...query].length) throw new HttpError(400, 'Task configuration does not accept query parameters.');
      if (path === '/api/maniphest/config') return { config, canConfigure: this.manager(context), accessEpoch };
      if (path === '/api/maniphest/config/history') {
        this.requireManager(context);
        if ([...query.keys()].some(key => key !== 'before') || query.getAll('before').length > 1) throw new HttpError(400, 'Choose one before version.');
        const before = query.has('before') ? integer(Number(query.get('before')), 'Before version') : config.version + 1;
        const rows = this.store.database.prepare('SELECT version,data,actor_id,created_at FROM maniphest_config_history WHERE version<? ORDER BY version DESC LIMIT 51').all(before) as { version: number; data: string; actor_id: string | null; created_at: string }[];
        return { versions: rows.slice(0, 50).map(row => ({ config: JSON.parse(row.data), actorId: row.actor_id, createdAt: row.created_at })), nextBefore: rows.length > 50 ? rows[49]!.version : null, accessEpoch };
      }
      if (path === '/api/maniphest/report') return this.report(query, context);
      throw new HttpError(404, 'Task endpoint was not found.');
    });
  }
  private preview(input: ManiphestBulkInput, context: AuthContext): ManiphestBulkPreview {
    const config = readManiphestConfig(this.store.database), access = this.access(context), accessEpoch = this.policies.epoch();
    if (input.expectedConfigVersion !== config.version || input.expectedAccessEpoch !== accessEpoch) throw new HttpError(409, 'Task configuration or access changed. Reload before reviewing this bulk edit.');
    const tasks = input.tasks.map(pin => {
      access.authorize('PATCH', `/api/tasks/${pin.id}`, input.changes);
      const raw = this.store.taskDetail(pin.id).task;
      if (raw.version !== pin.expectedVersion) throw new HttpError(409, 'A selected task changed. Reload and review the entire bulk edit again.');
      const values = taskManiphestValues(input.changes as Record<string, unknown>, raw, config);
      const before = access.task(pin.id).task;
      const after: Task = { ...before, ...values, ...(input.changes.ownerId !== undefined ? { ownerId: input.changes.ownerId } : {}) };
      return { id: pin.id, title: before.title, before, after };
    });
    return { input, tasks, accessEpoch };
  }
  mutate(method: string, path: string, input: unknown, rawKey: string | undefined, context: AuthContext): MutationResponse {
    if (method === 'POST' && path === '/api/maniphest/bulk/preview') return this.store.read(() => { this.auth.revalidate(context, 'write'); return { status: 200, body: this.preview(parseManiphestBulk(input), context) }; });
    const configure = method === 'PUT' && path === '/api/maniphest/config', bulk = method === 'POST' && path === '/api/maniphest/bulk';
    if (!configure && !bulk) throw new HttpError(404, 'Task endpoint was not found.');
    if (!rawKey || rawKey.length > 200 || /[\x00-\x20\x7f]/.test(rawKey)) throw new HttpError(400, 'Task configuration and bulk edits require an Idempotency-Key of at most 200 characters without whitespace.');
    const parsed = bulk ? parseManiphestBulk(input) : null, access = this.access(context);
    const authorize = () => { this.auth.revalidate(context, 'write'); if (configure) this.requireManager(context); else for (const task of parsed!.tasks) access.authorize('PATCH', `/api/tasks/${task.id}`, parsed!.changes); };
    this.store.read(authorize);
    const retryKey = context.kind === 'local' ? rawKey : `${context.workspaceId}:${context.principalId}:${rawKey}`, fingerprint = createHash('sha256').update(JSON.stringify([method, path, input])).digest('hex');
    const actor: ActorAttribution = { principalId: context.principalId, displayName: context.displayName, credentialId: context.credentialId, requestId: randomUUID() };
    return this.store.mutate(retryKey, fingerprint, () => {
      if (configure) return { status: 200, body: { config: writeManiphestConfig(this.store.database, input, context.principalId), canConfigure: true, accessEpoch: this.policies.epoch() } };
      this.preview(parsed!, context);
      // All pins have been checked under the same writer lock. A dependency's
      // status may advance another selected task; use that resulting version
      // without confusing it with a concurrent or unreviewed edit.
      for (const pin of parsed!.tasks) { const task = this.store.taskDetail(pin.id).task; this.store.updateTask(pin.id, { ...parsed!.changes, expectedConfigVersion: parsed!.expectedConfigVersion, expectedVersion: task.version }, actor); }
      const receipt: ManiphestBulkReceipt = { operationId: actor.requestId, tasks: parsed!.tasks.map(pin => ({ id: pin.id, version: this.store.taskDetail(pin.id).task.version })), accessEpoch: this.policies.epoch() };
      return { status: 200, body: receipt };
    }, authorize, response => {
      // Receipts contain identifiers and resulting versions only. Reassignment
      // can surrender access on a fresh write; no task content is returned.
      if (configure) return { status: response.status, body: { ...(response.body as object), accessEpoch: this.policies.epoch(), canConfigure: this.manager(context) } };
      const saved = response.body as ManiphestBulkReceipt;
      if (!saved || !Array.isArray(saved.tasks) || saved.tasks.length !== parsed!.tasks.length || saved.tasks.some((task, index) => task.id !== parsed!.tasks[index]!.id || !Number.isSafeInteger(task.version))) throw new HttpError(409, 'This saved bulk edit receipt cannot be verified.');
      return { status: 200, body: { ...saved, accessEpoch: this.policies.epoch() } };
    });
  }
  private report(query: URLSearchParams, context: AuthContext): ManiphestReport {
    for (const key of query.keys()) if (query.getAll(key).length > 1 || !['groupBy', 'status', 'ownerId', 'projectId', 'createdAfter', 'createdBefore'].includes(key)) throw new HttpError(400, 'Unknown task report filter.');
    const groupBy = query.get('groupBy') ?? 'status'; if (!['status', 'priority', 'owner', 'project'].includes(groupBy)) throw new HttpError(400, 'Choose a report grouping.');
    const access = this.access(context), state = access.state({ configured: false, model: null }), config = readManiphestConfig(this.store.database);
    const bounds = ['createdAfter', 'createdBefore'].map(key => { const value = query.get(key); if (value !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new HttpError(400, 'Report dates must use YYYY-MM-DD.'); return value; });
    const rows = new Map<string, ManiphestReportRow>(), empty = () => ({ tasks: 0, open: 0, closed: 0, points: 0, openPoints: 0, closedPoints: 0 }), totals = empty();
    const add = (row: ReturnType<typeof empty>, task: Task) => { const closed = isTaskClosed(task), points = task.points ?? 0; row.tasks++; row.points += points; if (closed) { row.closed++; row.closedPoints += points; } else { row.open++; row.openPoints += points; } };
    for (const task of state.tasks) {
      if (query.has('status') && task.status !== query.get('status') || query.has('ownerId') && task.ownerId !== (query.get('ownerId') || null) || query.has('projectId') && !task.projectIds.includes(query.get('projectId')!) || bounds[0] && task.createdAt.slice(0, 10) < bounds[0] || bounds[1] && task.createdAt.slice(0, 10) > bounds[1]) continue;
      add(totals, task);
      const keys = groupBy === 'project' ? task.projectIds.length ? task.projectIds : [''] : [groupBy === 'owner' ? task.ownerId ?? '' : task[groupBy as 'status' | 'priority']];
      for (const key of keys) {
        const label = groupBy === 'status' ? config.statuses.find(item => item.key === key)?.name ?? key : groupBy === 'priority' ? config.priorities.find(item => item.key === key)?.name ?? key : groupBy === 'owner' ? key ? state.principals.find(person => person.id === key)?.displayName ?? 'Unavailable member' : 'Unassigned' : key ? state.projects.find(project => project.id === key)?.name ?? 'Unavailable project' : 'No visible project';
        const row = rows.get(key) ?? { key, label, ...empty() }; add(row, task); rows.set(key, row);
      }
    }
    const round = (row: ReturnType<typeof empty>) => { row.points = Math.round(row.points * 100) / 100; row.openPoints = Math.round(row.openPoints * 100) / 100; row.closedPoints = Math.round(row.closedPoints * 100) / 100; };
    round(totals); rows.forEach(round);
    return { groupBy: groupBy as ManiphestReport['groupBy'], rows: [...rows.values()].sort((a, b) => a.label.localeCompare(b.label)), totals, accessEpoch: this.policies.epoch() };
  }
}
