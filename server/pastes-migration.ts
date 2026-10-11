import type { DatabaseSync } from 'node:sqlite';
import { initializePastes } from './pastes.ts';

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** Expand the parent in place, preserving rowids, dependent schema and child FKs. */
export function migratePastes(database: DatabaseSync): void {
  if (database.prepare('PRAGMA user_version').get()!.user_version !== 17) throw new Error('Paste migration requires schema 17.');
  const parent = database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='entities'").get() as { sql: string };
  const definitions = database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND (type IN ('view','trigger') OR (type='index' AND tbl_name='entities')) ORDER BY rowid").all() as { type: string; name: string; sql: string }[];
  const columns = database.prepare('PRAGMA table_xinfo(entities)').all() as { name: string; hidden: number }[];
  // Retain any operator-added columns and constraints instead of rebuilding a
  // reduced approximation of the existing parent table.
  let widened = false;
  const create = parent.sql.replace(/^(CREATE\s+TABLE\s+)(?:"entities"|`entities`|\[entities\]|entities)(?=\s|\()/i, '$1entities_paste_new').replace(/CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/i, (_match, kinds: string) => {
    if (!['project', 'repository', 'revision', 'task', 'document', 'file'].every(kind => kinds.includes(`'${kind}'`)) || kinds.includes("'paste'")) throw new Error('Unexpected entities kind constraint at schema 17.');
    widened = true; return `CHECK(kind IN (${kinds},'paste'))`;
  });
  if (!widened || !/^CREATE\s+TABLE\s+entities_paste_new\b/i.test(create)) throw new Error('Unsupported entities schema; no migration was performed.');
  const copied = ['rowid', ...columns.filter(column => column.hidden === 0).map(column => column.name)].map(quoted).join(',');
  database.exec('PRAGMA foreign_keys=OFF'); let began = false;
  try {
    database.exec('BEGIN IMMEDIATE'); began = true;
    // Views and triggers on other tables may reference entities. Temporarily
    // remove them so ALTER does not observe the intentionally absent parent.
    for (const definition of definitions.filter(item => item.type === 'trigger')) database.exec(`DROP TRIGGER ${quoted(definition.name)}`);
    for (const definition of definitions.filter(item => item.type === 'view')) database.exec(`DROP VIEW ${quoted(definition.name)}`);
    database.exec(`${create}; INSERT INTO entities_paste_new(${copied}) SELECT ${copied} FROM entities; DROP TABLE entities; ALTER TABLE entities_paste_new RENAME TO entities;`);
    for (const type of ['index', 'view', 'trigger']) for (const definition of definitions.filter(item => item.type === type)) database.exec(definition.sql);
    initializePastes(database);
    if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Paste migration would violate an existing relationship.');
    database.exec('PRAGMA user_version=18; COMMIT'); began = false;
  } catch (error) { if (began) database.exec('ROLLBACK'); throw error; }
  finally { database.exec('PRAGMA foreign_keys=ON'); }
}
