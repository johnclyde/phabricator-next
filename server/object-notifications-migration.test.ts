import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { initializeObjectSubscriptions } from './object-subscriptions.ts';
import type { ActorAttribution } from '../shared/types.ts';

const alice:ActorAttribution={principalId:'alice',displayName:'Alice',credentialId:null,requestId:'old-source'},bob:ActorAttribution={...alice,principalId:'bob',displayName:'Bob'};
const tables=['object_mute_transactions','object_subscription_transactions','object_subscriptions','object_mutes','object_subscription_operations'];
const epoch=(s:Store)=>Number(s.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value);
function snapshot(db:DatabaseSync){const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as {type:string;name:string}[],names=schema.filter(row=>row.type==='table').map(row=>row.name);names.push('sqlite_sequence');return {schema,rows:Object.fromEntries(names.map(name=>[name,db.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()])),foreignKeys:Object.fromEntries(names.map(name=>[name,db.prepare(`PRAGMA foreign_key_list("${name}")`).all()]))};}
function downgrade(s:Store){for(const name of tables)s.database.exec(`DROP TABLE ${name}`);s.database.exec('PRAGMA user_version=32');}
function seed(s:Store){
 const w=s.createDocument({title:'Wiki original',slug:'/',content:'Exact source\r\n😀'},alice),p=s.pastes.create({title:'Paste original',content:'\ufeffExact paste\r\n'},alice);s.pastes.comment(p.id,{contentVersion:1,body:'Earlier comment'},bob);
 const d=s.createRevision({kind:'paper',title:'Revision',testPlan:'Inspect.',files:[{path:'paper.txt',content:'Body'}]},alice),t=s.createTask({title:'Task',ownerId:'bob'},alice);
 s.notifications.configure({eligible:id=>['alice','bob'].includes(id),canView:()=>true});
 s.revisionSubscriptions.mutate(d.revision.id,{action:'subscribe',principalId:'bob',expectedSubscriptionVersion:0,expectedAuthorVersion:s.revisionAuthorship.state(d.revision.id).version,expectedReviewerVersion:s.revisionReviewers.state(d.revision.id).version,expectedAccessEpoch:epoch(s)},bob,{principalId:'bob',displayName:'Bob'});
 s.notifications.emit({revisionId:d.revision.id,kind:'commented',cause:{type:'legacy',id:'old-revision'},attribution:alice});s.updateTask(t.id,{title:'Old task edit',expectedVersion:t.version},alice);
 const inbox=s.notifications.list('bob',{},epoch(s)),input={action:'read_through' as const,horizon:inbox.horizon,expectedAccessEpoch:epoch(s)};
 const receipt=s.mutate('old-read','original-fingerprint',()=>({status:200,body:s.notifications.mutate('bob',input,bob)}));
 return {w,p,input,receipt,operationId:(receipt.body as {operationId:string}).operationId};
}

test('schema33 preserves every schema32 row, rowid, schema object and historical read receipt without backfilling follows',()=>{
 const dir=mkdtempSync(join(tmpdir(),'object-notifications-migration-')),path=join(dir,'db.sqlite');let s=new Store({path});
 try{const old=seed(s);downgrade(s);s.database.exec("CREATE TABLE operator_notes(note TEXT);INSERT INTO operator_notes VALUES('Keep exact record')");const before=snapshot(s.database);s.close();s=new Store({path});assert.equal(s.database.prepare('PRAGMA user_version').get()!.user_version,35);
  const after=snapshot(s.database);for(const [name,data] of Object.entries(before.rows)){assert.deepEqual(after.rows[name],data,name);assert.deepEqual(after.foreignKeys[name],before.foreignKeys[name],name);}for(const value of before.schema)assert.deepEqual(after.schema.find(row=>row.name===value.name),value,value.name);for(const name of tables)assert.deepEqual(after.rows[name],[],'no fabricated following from old authors, editors or comments');
  assert.equal(s.objectSubscriptions.effective(old.w.id,'alice'),false);assert.equal(s.objectSubscriptions.effective(old.p.id,'alice'),true,'immutable Paste author is an automatic role, not backfilled history');assert.equal(s.objectSubscriptions.effective(old.p.id,'bob'),false);assert.deepEqual(s.notifications.operation(old.operationId).input,old.input);assert.deepEqual(s.replay('old-read','original-fingerprint'),old.receipt);
  const stable=snapshot(s.database);initializeObjectSubscriptions(s.database);assert.deepEqual(snapshot(s.database),stable);s.close();s=new Store({path});assert.deepEqual(snapshot(s.database),stable);
  assert.deepEqual(s.database.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(s.database.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
 }finally{if(s.database.isOpen)s.close();rmSync(dir,{recursive:true,force:true});}
});

test('schema33 conflicting preference tables, constraints, indexes and triggers roll back the entire migration',()=>{
 for(const collision of ['table','constraints','index','trigger'] as const){const dir=mkdtempSync(join(tmpdir(),'object-notifications-collision-')),path=join(dir,'db.sqlite'),s=new Store({path});let db:DatabaseSync|undefined;
  try{seed(s);downgrade(s);s.database.exec({table:"CREATE TABLE object_mutes(operator_note TEXT);INSERT INTO object_mutes VALUES('Untouched')",constraints:"CREATE TABLE object_mutes(object_id TEXT,principal_id TEXT,version INTEGER,data TEXT)",index:'CREATE INDEX object_subscription_collision ON entities(kind)',trigger:'CREATE TRIGGER object_mute_transactions_no_update BEFORE UPDATE ON entities BEGIN SELECT 1; END'}[collision]);const before=snapshot(s.database);s.close();assert.throws(()=>new Store({path}),/schema/);db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,32);assert.deepEqual(snapshot(db),before);
  }finally{if(s.database.isOpen)s.close();db?.close();rmSync(dir,{recursive:true,force:true});}
 }
});
