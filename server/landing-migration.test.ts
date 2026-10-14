import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table').map(row => String(row.name));
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) tables.push('sqlite_sequence');
  return { schema, rows: Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()])) };
}
function downgrade(db: DatabaseSync) {
  for (const name of ['revision_landing_events', 'revision_landing_preparations', 'revision_landings']) db.exec(`DROP TABLE ${name}`);
  db.exec('PRAGMA user_version=38');
}
test('schema39 preserves every schema38 table, row and schema object across upgrade and reopen', () => {
  const dir=mkdtempSync(join(tmpdir(),'landing-migration-')),path=join(dir,'workspace.sqlite');let store=new Store({path});
  try {
    store.createRepository({name:'Preserved source',description:'Keep exact bytes',remoteUrl:'https://example.invalid/repo.git',defaultBranch:'main'});
    downgrade(store.database);store.database.exec("CREATE TABLE operator_data(note TEXT); INSERT INTO operator_data VALUES('Keep exact data');");
    const before=snapshot(store.database);store.close();store=new Store({path});const after=snapshot(store.database);
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version,44);
    for(const item of before.schema)assert.deepEqual(after.schema.find(row=>row.name===item.name),item);
    for(const [table,rows]of Object.entries(before.rows))assert.deepEqual(after.rows[table],rows,table);
    for(const table of ['revision_landings','revision_landing_preparations','revision_landing_events'])assert.deepEqual(after.rows[table],[]);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
    store.close();store=new Store({path});assert.deepEqual(snapshot(store.database),after);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
for(const [name,sql]of Object.entries({table:"CREATE TABLE revision_landings(operator_data TEXT); INSERT INTO revision_landings VALUES('keep');",constraints:'CREATE TABLE revision_landings(id TEXT,revision_id TEXT,owner_id TEXT,input_sha256 TEXT,data TEXT);',trigger:'CREATE TRIGGER revision_landing_events_no_update BEFORE UPDATE ON entities BEGIN SELECT 1; END;'}))test(`schema39 rejects ${name} collisions without changing prior data`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'landing-collision-')),path=join(dir,'workspace.sqlite');let store=new Store({path});let db:DatabaseSync|undefined;
 try{downgrade(store.database);store.database.exec(sql);const before=snapshot(store.database);store.close();assert.throws(()=>new Store({path}));db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,38);assert.deepEqual(snapshot(db),before);}finally{try{store.close();}catch{}db?.close();rmSync(dir,{recursive:true,force:true});}
});
