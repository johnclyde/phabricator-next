import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

export const REPOSITORY_OPERATIONS_TABLES = ['hosted_git_receives', 'repository_sync_attempts', 'repository_sync_leases', 'repository_sync_requests', 'repository_sync_targets'] as const;

/** Reconstruct a pre-46 fixture without leaving future tables behind. Never discard populated fixture data. */
export function withoutRepositoryOperationsSchema(db: DatabaseSync): DatabaseSync {
  for (const name of REPOSITORY_OPERATIONS_TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)) continue;
    assert.equal(db.prepare(`SELECT count(*) AS count FROM "${name}"`).get()!.count, 0, `${name} must be empty before constructing an old-schema fixture`);
    db.exec(`DROP TABLE "${name}"`);
  }
  return db;
}
