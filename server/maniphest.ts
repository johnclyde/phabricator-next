import type { DatabaseSync } from 'node:sqlite';
import type { Task, TaskFieldChange } from '../shared/types.ts';
import { DEFAULT_MANIPHEST_CONFIG, type ManiphestConfig, type TaskCustomValue, type TaskFieldDefinition, type TaskFormDefinition } from '../shared/maniphest.ts';
import { HttpError, integer, object, string } from './validation.ts';

const definitions = [
  ['table', 'maniphest_config', 'CREATE TABLE maniphest_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)))'],
  ['table', 'maniphest_config_history', 'CREATE TABLE maniphest_config_history(version INTEGER PRIMARY KEY CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)),actor_id TEXT,created_at TEXT NOT NULL)'],
  ['trigger', 'maniphest_config_history_no_update', "CREATE TRIGGER maniphest_config_history_no_update BEFORE UPDATE ON maniphest_config_history BEGIN SELECT RAISE(ABORT,'Task configuration history is immutable'); END"],
  ['trigger', 'maniphest_config_history_no_delete', "CREATE TRIGGER maniphest_config_history_no_delete BEFORE DELETE ON maniphest_config_history BEGIN SELECT RAISE(ABORT,'Task configuration history is immutable'); END"],
] as const;
export function initializeManiphest(db: DatabaseSync): void {
  db.exec('SAVEPOINT maniphest_schema');
  try {
    for (const [type, name, sql] of definitions) {
      const row = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(name) as { type: string; sql: string } | undefined;
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/;$/, '');
      if (row && (row.type !== type || normalize(row.sql) !== normalize(sql))) throw new Error(`Unexpected ${name} schema; task configuration migration was not applied.`);
      if (!row) db.exec(sql);
    }
    if (!db.prepare('SELECT 1 FROM maniphest_config WHERE singleton=1').get()) {
      const json = JSON.stringify(DEFAULT_MANIPHEST_CONFIG);
      db.prepare('INSERT INTO maniphest_config(singleton,version,data) VALUES(1,1,?)').run(json);
      db.prepare('INSERT INTO maniphest_config_history(version,data,actor_id,created_at) VALUES(1,?,NULL,?)').run(json, new Date().toISOString());
    }
    readManiphestConfig(db);
    db.exec('RELEASE maniphest_schema');
  } catch (error) { db.exec('ROLLBACK TO maniphest_schema; RELEASE maniphest_schema'); throw error; }
}
export function readManiphestConfig(db: DatabaseSync): ManiphestConfig {
  const row = db.prepare('SELECT version,data FROM maniphest_config WHERE singleton=1').get() as { version: number; data: string } | undefined;
  if (!row) throw new HttpError(409, 'Task configuration is unavailable.');
  const config = JSON.parse(row.data) as ManiphestConfig;
  const evidence = db.prepare('SELECT data FROM maniphest_config_history WHERE version=?').get(row.version) as { data: string } | undefined;
  if (config.version !== row.version || !evidence || evidence.data !== row.data) throw new HttpError(409, 'Task configuration history cannot be verified.');
  return config;
}
function bool(value: unknown, name: string): boolean { if (typeof value !== 'boolean') throw new HttpError(400, `${name} must be true or false.`); return value; }
function key(value: unknown): string { const result = string(value, 'Key', 64); if (!/^[a-z][a-z0-9_]*$/.test(result) || ['constructor', 'prototype', '__proto__'].includes(result)) throw new HttpError(400, 'Use a lowercase key with letters, digits, and underscores.'); return result; }
function list<T>(value: unknown, name: string, max: number, parse: (entry: unknown) => T, min = 0): T[] { if (!Array.isArray(value) || value.length < min || value.length > max) throw new HttpError(400, `${name} must contain between ${min} and ${max} entries.`); return value.map(parse); }
function unique<T extends { key: string }>(entries: T[], name: string): T[] { if (new Set(entries.map(item => item.key)).size !== entries.length) throw new HttpError(400, `${name} keys must be unique.`); return entries; }
export function taskPoints(value: unknown): number | null { if (value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000 || Number(value.toFixed(2)) !== value) throw new HttpError(400, 'Points must be empty or a nonnegative number with at most two decimal places (up to 1,000,000).'); return value; }
function customValue(field: TaskFieldDefinition, value: unknown): TaskCustomValue {
  if (value === null || value === '') { if (field.required) throw new HttpError(400, `${field.name} is required.`); return null; }
  if (field.type === 'text') return string(value, field.name, 20000, !field.required);
  if (field.type === 'boolean') return bool(value, field.name);
  if (field.type === 'integer') { if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new HttpError(400, `${field.name} must be an integer.`); return value; }
  if (typeof value !== 'string' || !field.options.includes(value)) throw new HttpError(400, `Choose an available value for ${field.name}.`); return value;
}
export function parseTaskCustomFields(value: unknown, config: ManiphestConfig, current?: Task): Record<string, TaskCustomValue> {
  const fields = object(value, config.fields.map(field => field.key));
  const result = { ...(current?.customFields ?? {}) };
  for (const [name, entry] of Object.entries(fields)) { const field = config.fields.find(field => field.key === name)!; if (field.disabled) { if (!current || JSON.stringify(current.customFields?.[name]) !== JSON.stringify(entry)) throw new HttpError(400, `${field.name} is disabled.`); continue; } result[name] = customValue(field, entry); }
  if (!current) for (const field of config.fields) if (!field.disabled && field.required && (result[field.key] === undefined || result[field.key] === null || result[field.key] === '')) throw new HttpError(400, `${field.name} is required.`);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
export function parseManiphestConfig(value: unknown, previous: ManiphestConfig): ManiphestConfig {
  const data = object(value, ['expectedVersion', 'statuses', 'priorities', 'fields', 'forms']);
  if (integer(data.expectedVersion, 'Configuration version') !== previous.version) throw new HttpError(409, 'Task configuration changed. Reload before saving.');
  const statuses = unique(list(data.statuses, 'Statuses', 100, entry => { const item = object(entry, ['key', 'name', 'closed', 'disabled']); return { key: key(item.key), name: string(item.name, 'Status name', 80), closed: bool(item.closed, 'Closed'), disabled: bool(item.disabled, 'Disabled') }; }, 1), 'Status');
  const priorities = unique(list(data.priorities, 'Priorities', 100, entry => { const item = object(entry, ['key', 'name', 'rank', 'disabled']); if (typeof item.rank !== 'number' || !Number.isSafeInteger(item.rank) || Math.abs(item.rank) > 1_000_000) throw new HttpError(400, 'Priority rank must be an integer between -1,000,000 and 1,000,000.'); return { key: key(item.key), name: string(item.name, 'Priority name', 80), rank: item.rank, disabled: bool(item.disabled, 'Disabled') }; }, 1), 'Priority');
  const fields = unique(list(data.fields, 'Custom fields', 100, entry => { const item = object(entry, ['key', 'name', 'type', 'required', 'disabled', 'options']); if (!['text', 'integer', 'boolean', 'select'].includes(String(item.type))) throw new HttpError(400, 'Choose a supported custom field type.'); const options = list(item.options, 'Field options', 200, option => string(option, 'Option', 200)); if (new Set(options).size !== options.length || item.type === 'select' && !options.length || item.type !== 'select' && options.length) throw new HttpError(400, 'Select fields need unique options; other types do not have options.'); return { key: key(item.key), name: string(item.name, 'Field name', 100), type: item.type as TaskFieldDefinition['type'], required: bool(item.required, 'Required'), disabled: bool(item.disabled, 'Disabled'), options }; }), 'Custom field');
  for (const old of previous.statuses) { const next = statuses.find(item => item.key === old.key); if (!next || next.closed !== old.closed) throw new HttpError(400, 'Keep existing status keys and their open/closed meaning. Disable unused statuses instead.'); }
  for (const old of previous.priorities) if (!priorities.some(item => item.key === old.key)) throw new HttpError(400, 'Keep existing priority keys. Disable unused priorities instead.');
  for (const old of previous.fields) { const next = fields.find(item => item.key === old.key); if (!next || next.type !== old.type || old.options.some(option => !next.options.includes(option))) throw new HttpError(400, 'Keep existing custom field keys, types, and options. Disable unused fields instead.'); }
  if (statuses.find(item => item.key === 'open')?.disabled || statuses.find(item => item.key === 'duplicate')?.disabled || priorities.find(item => item.key === 'normal')?.disabled) throw new HttpError(400, 'The default Open, Duplicate, and Normal choices must remain enabled.');
  const config: ManiphestConfig = { version: previous.version + 1, statuses, priorities, fields, forms: [] };
  if (!Number.isSafeInteger(config.version)) throw new HttpError(409, 'Task configuration reached its version limit.');
  const allowed = ['description', 'status', 'priority', 'ownerId', 'projectIds', 'points', ...fields.map(field => `custom:${field.key}`)];
  config.forms = unique(list(data.forms, 'Forms', 100, entry => {
    const item = object(entry, ['key', 'name', 'description', 'fields', 'defaults', 'disabled']);
    const selected = list(item.fields, 'Form fields', 106, field => string(field, 'Form field', 80));
    if (new Set(selected).size !== selected.length || selected.some(field => !allowed.includes(field))) throw new HttpError(400, 'Form fields must name distinct available fields.');
    const defaults = object(item.defaults, ['status', 'priority', 'points', 'customFields']); const parsed: TaskFormDefinition['defaults'] = {};
    if (defaults.status !== undefined) { if (typeof defaults.status !== 'string' || !statuses.some(status => status.key === defaults.status && !status.disabled && status.key !== 'duplicate')) throw new HttpError(400, 'Choose an enabled form default status.'); parsed.status = defaults.status; }
    if (defaults.priority !== undefined) { if (typeof defaults.priority !== 'string' || !priorities.some(priority => priority.key === defaults.priority && !priority.disabled)) throw new HttpError(400, 'Choose an enabled form default priority.'); parsed.priority = defaults.priority; }
    if (defaults.points !== undefined) parsed.points = taskPoints(defaults.points);
    if (defaults.customFields !== undefined) parsed.customFields = parseTaskCustomFields(defaults.customFields, config, {} as Task);
    const disabled = bool(item.disabled, 'Disabled');
    if (!disabled) for (const field of fields) if (!field.disabled && field.required && !selected.includes(`custom:${field.key}`) && parsed.customFields?.[field.key] == null) throw new HttpError(400, `Enabled forms must show or provide a default for ${field.name}.`);
    return { key: key(item.key), name: string(item.name, 'Form name', 100), description: string(item.description, 'Form description', 2000, true), fields: selected, defaults: parsed, disabled };
  }, 1), 'Form');
  if (!config.forms.some(form => form.key === 'default' && !form.disabled)) throw new HttpError(400, 'Keep an enabled default form.');
  for (const old of previous.forms) if (!config.forms.some(form => form.key === old.key)) throw new HttpError(400, 'Keep existing form keys. Disable unused forms instead.');
  return config;
}
export function writeManiphestConfig(db: DatabaseSync, input: unknown, actorId: string): ManiphestConfig {
  const current = readManiphestConfig(db), config = parseManiphestConfig(input, current), json = JSON.stringify(config);
  db.prepare('INSERT INTO maniphest_config_history(version,data,actor_id,created_at) VALUES(?,?,?,?)').run(config.version, json, actorId, new Date().toISOString());
  db.prepare('UPDATE maniphest_config SET version=?,data=? WHERE singleton=1 AND version=?').run(config.version, json, current.version);
  return config;
}
export function taskFormInput(data: Record<string, unknown>, config: ManiphestConfig, current?: Task): Record<string, unknown> {
  if (data.expectedConfigVersion !== undefined && integer(data.expectedConfigVersion, 'Task configuration version') !== config.version) throw new HttpError(409, 'Task configuration changed. Review the current form before saving.');
  if (current) { if (data.formKey !== undefined) throw new HttpError(400, 'Forms apply only to new tasks.'); return data; }
  const formKey = data.formKey === undefined ? 'default' : string(data.formKey, 'Task form', 64), form = config.forms.find(item => item.key === formKey && !item.disabled);
  if (!form) throw new HttpError(400, 'The selected task form is unavailable.');
  return { ...form.defaults, ...data, customFields: { ...form.defaults.customFields, ...object(data.customFields ?? {}, config.fields.map(field => field.key)) } };
}
export function taskManiphestValues(data: Record<string, unknown>, current: Task | undefined, config: ManiphestConfig): Pick<Task, 'status' | 'statusClosed' | 'priority' | 'points' | 'customFields'> {
  const status = data.status === undefined ? current?.status ?? 'open' : string(data.status, 'Status', 64);
  const statusDef = config.statuses.find(item => item.key === status);
  if (!statusDef || (statusDef.disabled || status === 'duplicate') && current?.status !== status) throw new HttpError(400, status === 'duplicate' ? 'Use the merge action to mark a task duplicate.' : 'Choose an enabled task status.');
  const priority = data.priority === undefined ? current?.priority ?? 'normal' : string(data.priority, 'Priority', 64);
  const priorityDef = config.priorities.find(item => item.key === priority);
  if (!priorityDef || priorityDef.disabled && current?.priority !== priority) throw new HttpError(400, 'Choose an enabled task priority.');
  return { status, statusClosed: statusDef.closed, priority, points: data.points === undefined ? current?.points ?? null : taskPoints(data.points), customFields: data.customFields === undefined && current ? current.customFields ?? {} : parseTaskCustomFields(data.customFields ?? {}, config, current) };
}
export function taskChanges(current: Task, values: Partial<Task>, fields: TaskFieldChange['field'][]): TaskFieldChange[] {
  const value = (input: unknown): string | null => input == null ? null : typeof input === 'string' ? input : JSON.stringify(input);
  return fields.filter(field => field !== 'projectId' && JSON.stringify(current[field] ?? (field === 'customFields' ? {} : null)) !== JSON.stringify(values[field] ?? (field === 'customFields' ? {} : null))).map(field => ({ field, oldValue: value(field === 'projectId' ? null : current[field]), newValue: value(field === 'projectId' ? null : values[field]) }));
}
