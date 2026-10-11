import type { DatabaseSync } from 'node:sqlite';
import { initializeFiles } from './files.ts';

/** Rebuild the parent in place, without rewriting any child FK or evidence. */
export function migrateFiles(database: DatabaseSync): void {
  const definitions = database.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name = 'entities' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name").all() as { sql: string }[];
  database.exec('PRAGMA foreign_keys = OFF');
  let began = false;
  try {
    database.exec('BEGIN IMMEDIATE'); began = true;
    database.exec(`
      CREATE TABLE entities_new (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('project','repository','revision','task','document','file')), data TEXT NOT NULL CHECK(json_valid(data)));
      INSERT INTO entities_new(rowid, id, kind, data) SELECT rowid, id, kind, data FROM entities;
      DROP TABLE entities;
      ALTER TABLE entities_new RENAME TO entities;
    `);
    for (const definition of definitions) database.exec(definition.sql);
    initializeFiles(database);
    database.exec(`CREATE TABLE file_upload_receipts (principal_id TEXT NOT NULL, request_key TEXT NOT NULL, file_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(principal_id, request_key));`);
    if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('File migration would violate an existing relationship.');
    database.exec('PRAGMA user_version = 16; COMMIT'); began = false;
  } catch (error) {
    if (began) database.exec('ROLLBACK');
    throw error;
  } finally { database.exec('PRAGMA foreign_keys = ON'); }
}
