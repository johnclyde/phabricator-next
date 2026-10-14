import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { initializeNotifications } from './notifications.ts';
const actor={principalId:'alice',displayName:'Alice',credentialId:'key',requestId:'migration'};
const tables=['notification_read_changes','notification_operations','notification_deliveries','notification_events','notification_read_state','notification_cursor_secret'];
function downgrade(db:DatabaseSync){db.exec('DROP TABLE mail_outbox');for(const table of tables)db.exec(`DROP TABLE ${table}`);db.exec('PRAGMA user_version=30');}
function snapshot(db:DatabaseSync){const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as {type:string;name:string}[];const names=schema.filter(r=>r.type==='table').map(r=>r.name);names.push('sqlite_sequence');return{schema,rows:Object.fromEntries(names.map(name=>[name,db.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()])),foreignKeys:Object.fromEntries(names.map(name=>[name,db.prepare(`PRAGMA foreign_key_list("${name}")`).all()]))};}

test('schema31 preserves every schema30 row, source, policy, receipt, sequence and schema object without historical delivery',()=>{
 const directory=mkdtempSync(join(tmpdir(),'notifications-migration-')),path=join(directory,'workspace.sqlite');let store=new Store({path});
 try{const d=store.createRevision({kind:'paper',title:'Historical paper',summary:'\ufeffExact summary\r\n',testPlan:'Read source.',files:[{path:'paper.tex',content:'\ufeffSource\r\n'}]},actor);store.createComment(d.revision.id,{versionId:d.versions[0]!.id,body:'Old discussion'},actor);store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run('old','old',201,JSON.stringify(d),d.revision.createdAt);downgrade(store.database);store.database.exec("CREATE TABLE operator_data(note TEXT); INSERT INTO operator_data VALUES('Keep me exactly')");const before=snapshot(store.database);store.close();store=new Store({path});const after=snapshot(store.database);
 assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version,43);for(const [table,rows]of Object.entries(before.rows)){assert.deepEqual(after.rows[table],rows,table);assert.deepEqual(after.foreignKeys[table],before.foreignKeys[table],table);}for(const row of before.schema)assert.deepEqual(after.schema.find(r=>r.name===row.name),row,row.name);
 for(const name of tables.filter(t=>t!=='notification_cursor_secret'))assert.deepEqual(after.rows[name],[]);assert.equal(after.rows.notification_cursor_secret!.length,1);assert.deepEqual(store.replay('old','old'),{status:201,body:d});const stable=snapshot(store.database);initializeNotifications(store.database);assert.deepEqual(snapshot(store.database),stable);store.close();store=new Store({path});assert.deepEqual(snapshot(store.database),stable);assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
 }finally{if(store.database.isOpen)store.close();rmSync(directory,{recursive:true,force:true});}
});

test('schema31 collision rejects atomically and preserves the operator table and complete schema30 state',()=>{
 for(const collision of ['table','constraints','index','trigger'] as const) {
 const directory=mkdtempSync(join(tmpdir(),'notifications-collision-')),path=join(directory,'workspace.sqlite');const store=new Store({path});let db:DatabaseSync|undefined;
 try{store.createRevision({kind:'code',title:'Keep',testPlan:'Inspect.',files:[{path:'one.ts',content:'one'}]},actor);downgrade(store.database);store.database.exec({table:"CREATE TABLE notification_events(operator_note TEXT); INSERT INTO notification_events VALUES('Custom data')",constraints:"CREATE TABLE notification_deliveries(sequence INTEGER,id TEXT,event_id TEXT,principal_id TEXT,read INTEGER,version INTEGER); INSERT INTO notification_deliveries VALUES(1,'operator','data','keep',0,0)",index:"CREATE INDEX notification_deliveries_person ON entities(kind)",trigger:"CREATE TRIGGER notification_delivery_no_delete BEFORE DELETE ON entities BEGIN SELECT 1; END"}[collision]);const before=snapshot(store.database);store.close();assert.throws(()=>new Store({path}),/notification_|column|schema/);db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,30);assert.deepEqual(snapshot(db),before);db.exec({table:'DROP TABLE notification_events',constraints:'DROP TABLE notification_deliveries',index:'DROP INDEX notification_deliveries_person',trigger:'DROP TRIGGER notification_delivery_no_delete'}[collision]);db.close();db=undefined;const repaired=new Store({path});assert.equal(repaired.database.prepare('PRAGMA user_version').get()!.user_version,43);repaired.close();
 }finally{if(store.database.isOpen)store.close();db?.close();rmSync(directory,{recursive:true,force:true});}
 }
});
