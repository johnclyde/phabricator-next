import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
const owned = /^(git_automation|git_receive|drydock)_/;
function snapshot(db: DatabaseSync) { return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ name: String(row.name), sql: row.sql, rows: db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all() })); }
function downgrade(db: DatabaseSync) { for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) if (owned.test(String(row.name))) db.exec(`DROP TABLE ${String(row.name)}`); db.exec('PRAGMA user_version=37'); }
test('schema38 preserves every existing schema37 table and row across upgrade and reopen', () => {
 const directory=mkdtempSync(join(tmpdir(),'phab-drydock-migration-')),path=join(directory,'workspace.sqlite'); let store=new Store({path});
 try { store.createRepository({name:'Preserved repository',description:'Operator data',remoteUrl:'https://example.invalid/keep.git',defaultBranch:'main'});downgrade(store.database);const before=snapshot(store.database);store.close();store=new Store({path});assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version,40);const after=snapshot(store.database);for(const table of before)assert.deepEqual(after.find(value=>value.name===table.name),table);for(const table of after.filter(value=>owned.test(String(value.name))))assert.deepEqual(table.rows,[]);assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(),[]);store.close();store=new Store({path});assert.deepEqual(snapshot(store.database),after);
 } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
for(const name of ['git_automation_objects','git_receive_records','drydock_blueprints','drydock_leases'])test(`schema38 rejects a ${name} collision atomically`,()=>{
 const directory=mkdtempSync(join(tmpdir(),'phab-drydock-collision-')),path=join(directory,'workspace.sqlite');let store=new Store({path});let db:DatabaseSync|undefined;
 try {downgrade(store.database);store.database.exec(`CREATE TABLE ${name}(operator_data TEXT); INSERT INTO ${name} VALUES('keep this data');`);const before=snapshot(store.database);store.close();assert.throws(()=>new Store({path}));db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,37);assert.deepEqual(snapshot(db),before);}finally{try{store.close();}catch{}db?.close();rmSync(directory,{recursive:true,force:true});}
});
