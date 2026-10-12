import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { initializeNotificationTargets } from './notifications.ts';

const actor={principalId:'alice',displayName:'Alice',credentialId:null,requestId:'old-request'};
const muteTables=['task_notification_mute_history','task_notification_mute_operations','task_notification_mutes'];
function schemaSnapshot(db:DatabaseSync){const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as {type:string;name:string}[];const names=schema.filter(row=>row.type==='table').map(row=>row.name);names.push('sqlite_sequence');return{schema,rows:Object.fromEntries(names.map(name=>[name,db.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()])),foreignKeys:Object.fromEntries(names.map(name=>[name,db.prepare(`PRAGMA foreign_key_list("${name}")`).all()]))};}
function schema31(db:DatabaseSync){for(const table of muteTables)db.exec(`DROP TABLE IF EXISTS ${table}`);db.exec('PRAGMA user_version=31');}
function legacyHorizon(db:DatabaseSync,high:number,epoch:number){const key=Buffer.from(db.prepare('SELECT secret FROM notification_cursor_secret WHERE id=1').get()!.secret as Uint8Array),plain=Buffer.from(JSON.stringify({kind:'horizon',principalId:'bob',epoch,high})),payload=randomBytes(512);payload.writeUInt16BE(plain.length);plain.copy(payload,2);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('phabricator.notifications.v1'));return {iv,cipher,payload};}
function seedLegacy(store:Store){
 const d=store.createRevision({kind:'paper',title:'Legacy source',testPlan:'Inspect.',files:[{path:'paper.txt',content:'\ufeffPrivate source\r\n'}]},actor),revisionId=d.revision.id,version=d.versions[0]!,db=store.database,at='2026-10-01T00:00:00.000Z',epoch=Number(db.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value);
 const eventId=randomUUID(),deliveryId=randomUUID(),head={versionId:version.id,number:1,contentHash:version.contentHash},event={id:eventId,revisionId,kind:'commented',cause:{type:'comment',id:'historical-comment'},actor:{principalId:'alice',displayName:'Alice'},createdAt:at,head};
 db.prepare('INSERT INTO notification_events(id,revision_id,cause_type,cause_id,data) VALUES(?,?,?,?,?)').run(eventId,revisionId,'comment','historical-comment',JSON.stringify(event));db.prepare('INSERT INTO notification_deliveries(id,event_id,principal_id,read,version) VALUES(?,?,?,1,1)').run(deliveryId,eventId,'bob');
 const high=Number(db.prepare('SELECT sequence FROM notification_deliveries WHERE id=?').get(deliveryId)!.sequence),parts=legacyHorizon(db,high,epoch),encrypted=Buffer.concat([parts.cipher.update(parts.payload),parts.cipher.final()]),horizon=Buffer.concat([parts.iv,parts.cipher.getAuthTag(),encrypted]).toString('base64url');
 const input={action:'read_object' as const,revisionId,horizon,expectedAccessEpoch:epoch},inputSha256=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 const operations=[];
 for(let n=0;n<2;n++){
  const id=randomUUID(),receipt={operationId:id,inputSha256,changed:n===0,accessEpoch:epoch},raw={id,principalId:'bob',input,inputSha256,retryKeySha256:createHash('sha256').update(`old-key-${n}`).digest('hex'),attribution:{principalId:'bob',displayName:'Bob',credentialId:null,requestId:`old-${n}`},beforeReadVersion:n,afterReadVersion:1,affected:n===0?[{id:deliveryId,revisionId,before:{read:false,version:0},after:{read:true,version:1}}]:[],affectedRevisionIds:[revisionId],createdAt:at,receipt};
  db.prepare('INSERT INTO notification_operations(id,principal_id,input_sha256,before_version,after_version,data) VALUES(?,?,?,?,?,?)').run(id,'bob',inputSha256,n,1,JSON.stringify(raw));if(n===0)db.prepare('INSERT INTO notification_read_changes(notification_id,version,operation_id,before_read,after_read) VALUES(?,1,?,0,1)').run(deliveryId,id);
  db.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(`old-key-${n}`,'old-fingerprint',200,JSON.stringify(receipt),at);operations.push(raw);
 }
 db.prepare('INSERT INTO notification_read_state(principal_id,version) VALUES(?,1)').run('bob');return{revisionId,event,operations,deliveryId,input,epoch};
}

test('schema32 preserves all schema31 records and exact legacy read receipts while projecting generic targets',()=>{
 const directory=mkdtempSync(join(tmpdir(),'notification-target-migration-')),path=join(directory,'store.sqlite');let store=new Store({path});
 try{const old=seedLegacy(store);schema31(store.database);store.database.exec("CREATE TABLE operator_notes(note TEXT); INSERT INTO operator_notes VALUES('Untouched exact operator state')");const before=schemaSnapshot(store.database);store.close();store=new Store({path});
  assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version,34);const after=schemaSnapshot(store.database);for(const [name,rows]of Object.entries(before.rows)){assert.deepEqual(after.rows[name],rows,name);assert.deepEqual(after.foreignKeys[name],before.foreignKeys[name],name);}for(const row of before.schema)assert.deepEqual(after.schema.find(value=>value.name===row.name),row,row.name);for(const table of muteTables)assert.deepEqual(after.rows[table],[]);
  const stable=schemaSnapshot(store.database);initializeNotificationTargets(store.database);assert.deepEqual(schemaSnapshot(store.database),stable);store.close();store=new Store({path});assert.deepEqual(schemaSnapshot(store.database),stable);
  store.notifications.configure({eligible:id=>['alice','bob'].includes(id),canView:()=>true});const inbox=store.notifications.list('bob',{},old.epoch);assert.equal(inbox.items[0]!.event.objectId,old.revisionId);assert.deepEqual(inbox.items[0]!.event.context,{kind:'revision',head:old.event.head});assert.equal(inbox.items[0]!.read,true);
  for(let i=0;i<old.operations.length;i++){const original=old.operations[i]!,projected=store.notifications.operation(original.id);assert.deepEqual(projected.input,original.input);assert.deepEqual(projected.affectedObjectIds,[old.revisionId]);assert.deepEqual(projected.receipt,original.receipt);assert.deepEqual(store.replay(`old-key-${i}`,'old-fingerprint'),{status:200,body:original.receipt});assert.equal(store.database.prepare('SELECT data FROM notification_operations WHERE id=?').get(original.id)!.data,JSON.stringify(original));}
  const task=store.createTask({title:'New task after upgrade',ownerId:'bob'},actor);store.notifications.emit({objectId:task.id,kind:'task_updated',cause:{type:'test',id:'new-after-legacy'},attribution:actor});const currentEpoch=Number(store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value),mixed=store.notifications.list('bob',{},currentEpoch);assert.ok(mixed.items.some(item=>item.event.objectId===task.id&&item.event.context.kind==='task'));
  const newRead=store.notifications.mutate('bob',{action:'read_object',objectId:task.id,horizon:mixed.horizon,expectedAccessEpoch:currentEpoch},{principalId:'bob',displayName:'Bob',credentialId:null,requestId:'new'});assert.deepEqual(store.notifications.operation(newRead.operationId).affectedObjectIds,[task.id]);assert.deepEqual(store.notifications.operation(old.operations[0]!.id).receipt,old.operations[0]!.receipt);
  assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
 }finally{if(store.database.isOpen)store.close();rmSync(directory,{recursive:true,force:true});}
});

test('schema32 private-target collisions roll back without changing any schema31 event or receipt bytes',()=>{
 for(const collision of ['table','constraints','index','trigger'] as const){const directory=mkdtempSync(join(tmpdir(),'notification-target-collision-')),path=join(directory,'store.sqlite');const store=new Store({path});let db:DatabaseSync|undefined;
  try{seedLegacy(store);schema31(store.database);store.database.exec({table:"CREATE TABLE task_notification_mutes(operator_note TEXT); INSERT INTO task_notification_mutes VALUES('Keep')",constraints:"CREATE TABLE task_notification_mutes(task_id TEXT,principal_id TEXT,muted INTEGER,version INTEGER,updated_at TEXT); INSERT INTO task_notification_mutes VALUES('T1','operator',1,1,'keep')",index:'CREATE INDEX task_notification_mute_operations_generation ON entities(kind)',trigger:'CREATE TRIGGER task_notification_mute_history_no_delete BEFORE DELETE ON entities BEGIN SELECT 1; END'}[collision]);const before=schemaSnapshot(store.database);store.close();assert.throws(()=>new Store({path}),/task_notification|schema/);db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,31);assert.deepEqual(schemaSnapshot(db),before);
  }finally{if(store.database.isOpen)store.close();db?.close();rmSync(directory,{recursive:true,force:true});}
 }
});
