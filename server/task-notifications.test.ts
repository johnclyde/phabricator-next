import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { taskMuteInputHash } from './task-notifications.ts';
import { isTaskMuteHistory, isTaskMuteSnapshot, validTaskMuteResult } from '../shared/task-notifications.ts';
import type { TaskMuteInput } from '../shared/task-notifications.ts';
import type { ActorAttribution } from '../shared/types.ts';

const alice:ActorAttribution={principalId:'alice',displayName:'Alice',credentialId:null,requestId:'alice-request'};
const bob:ActorAttribution={principalId:'bob',displayName:'Bob',credentialId:'bob-key',requestId:'bob-request'};
function fixture(){const store=new Store({path:':memory:'}),task=store.createTask({title:'Private preference target',description:'Exact description\r\n',ownerId:'bob'},alice),other=store.createTask({title:'Separate task'},alice);return{store,id:task.id,other:other.id,engine:store.taskNotifications};}
const epoch=(store:Store)=>Number(store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value);
function input(store:Store,id:string,actor:ActorAttribution,action:'mute'|'unmute'):TaskMuteInput{return{action,expectedMuteVersion:store.taskNotifications.snapshot(id,actor.principalId).version,expectedAccessEpoch:epoch(store)};}
const counts=(store:Store)=>['task_notification_mutes','task_notification_mute_operations','task_notification_mute_history'].map(table=>store.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
function publicRows(store:Store){return Object.fromEntries(['entities','task_transactions','task_subscriptions','task_dependencies','task_projects','activity','notification_events','notification_deliveries'].filter(table=>store.database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)).map(table=>[table,store.database.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()]));}

test('private task mute changed and no-op receipts remain exact after later transitions without public side effects',()=>{const f=fixture();try{
 const before=publicRows(f.store),baseline=f.engine.snapshot(f.id,'bob');assert.ok(isTaskMuteSnapshot(baseline,f.id,'bob'));assert.deepEqual(baseline,{taskId:f.id,principalId:'bob',muted:false,version:0,updatedAt:null,accessEpoch:epoch(f.store)});
 const zeroInput=input(f.store,f.id,bob,'unmute'),zero=f.engine.mutate(f.id,'bob',zeroInput,bob,'0'.repeat(64));assert.equal(zero.changed,false);assert.deepEqual(counts(f.store),[0,1,0]);
 const firstInput=input(f.store,f.id,bob,'mute'),first=f.engine.mutate(f.id,'bob',firstInput,bob,'a'.repeat(64));const firstState=f.engine.snapshot(f.id,'bob');assert.equal(firstState.version,1);assert.equal(firstState.muted,true);assert.ok(validTaskMuteResult(first,f.id));
 const noopInput=input(f.store,f.id,bob,'mute'),noop=f.engine.mutate(f.id,'bob',noopInput,bob,'b'.repeat(64)),secondNoop=f.engine.mutate(f.id,'bob',noopInput,bob,'c'.repeat(64));assert.equal(noop.changed,false);assert.equal(secondNoop.changed,false);assert.deepEqual(f.engine.snapshot(f.id,'bob'),firstState);assert.deepEqual(counts(f.store),[1,4,1]);
 f.engine.mutate(f.id,'bob',input(f.store,f.id,bob,'unmute'),bob);f.engine.mutate(f.id,'bob',input(f.store,f.id,bob,'mute'),bob);assert.equal(f.engine.snapshot(f.id,'bob').version,3);
 for(const [receipt,request,key]of [[zero,zeroInput,'0'],[first,firstInput,'a'],[noop,noopInput,'b'],[secondNoop,noopInput,'c']] as const){const operation=f.engine.operation(receipt.operationId);assert.deepEqual(operation.receipt,receipt);assert.deepEqual(operation.input,request);assert.equal(operation.inputSha256,taskMuteInputHash(request));assert.equal(operation.retryKeySha256,key.repeat(64));assert.equal(f.engine.operationPrincipalId(operation.id),'bob');}
 assert.deepEqual(publicRows(f.store),before);assert.deepEqual(f.engine.snapshot(f.id,'alice'),{...baseline,principalId:'alice'});assert.deepEqual(f.engine.mutedPeople(f.id),['bob']);assert.deepEqual(f.engine.mutedPeople(f.other),[]);
}finally{f.store.close();}});

test('per-person CAS, access epoch and authenticated self identity reject stale or forged preferences atomically',()=>{const f=fixture();try{
 const request=input(f.store,f.id,bob,'mute');assert.throws(()=>f.engine.mutate(f.id,'bob',request,alice),{status:400});assert.throws(()=>f.engine.mutate(f.id,'bob',{...request,principalId:'alice'} as TaskMuteInput,bob),{status:400});assert.throws(()=>f.engine.mutate(f.id,'bob',request,bob,'not-a-digest'),{status:400});assert.deepEqual(counts(f.store),[0,0,0]);
 f.engine.mutate(f.id,'bob',request,bob);const saved=counts(f.store);assert.throws(()=>f.engine.mutate(f.id,'bob',request,bob),{code:'TASK_MUTE_CHANGED'});assert.deepEqual(counts(f.store),saved);
 const fresh=input(f.store,f.id,bob,'unmute');f.store.database.exec("UPDATE policy_meta SET value=value+1 WHERE name='epoch'");assert.throws(()=>f.engine.mutate(f.id,'bob',fresh,bob),{code:'TASK_MUTE_CHANGED'});assert.deepEqual(counts(f.store),saved);
 f.engine.mutate(f.id,'alice',input(f.store,f.id,alice,'mute'),alice);assert.equal(f.engine.snapshot(f.id,'alice').version,1);assert.equal(f.engine.snapshot(f.id,'bob').version,1);assert.throws(()=>f.engine.snapshot('T999','bob'),{code:'TASK_UNAVAILABLE'});assert.throws(()=>f.engine.snapshot(f.id,''),{status:400});
}finally{f.store.close();}});

test('private history is owner scoped, bounded, pinned and stable after unrelated task edits',()=>{const f=fixture();try{
 for(let n=0;n<5;n++)f.engine.mutate(f.id,'bob',input(f.store,f.id,bob,n%2?'unmute':'mute'),bob);f.engine.mutate(f.id,'alice',input(f.store,f.id,alice,'mute'),alice);
 const one=f.engine.history(f.id,'bob',{limit:2,expectedMuteVersion:5});assert.ok(isTaskMuteHistory(one,f.id,'bob'));assert.deepEqual(one.entries.map(e=>e.version),[5,4]);assert.equal(one.nextBefore,4);const two=f.engine.history(f.id,'bob',{limit:2,before:one.nextBefore!,expectedMuteVersion:5});assert.deepEqual(two.entries.map(e=>e.version),[3,2]);const three=f.engine.history(f.id,'bob',{limit:2,before:two.nextBefore!,expectedMuteVersion:5});assert.deepEqual(three.entries.map(e=>e.version),[1]);assert.equal(three.nextBefore,null);assert.deepEqual(f.engine.history(f.id,'alice').entries.map(e=>e.version),[1]);
 const task=f.store.taskDetail(f.id).task;f.store.updateTask(f.id,{title:'Changed independently',expectedVersion:task.version},alice);assert.deepEqual(f.engine.history(f.id,'bob',{limit:2,expectedMuteVersion:5}),one);
 for(const query of [{limit:0},{limit:101},{before:0},{before:-1},{expectedMuteVersion:4},{unexpected:1}])assert.throws(()=>f.engine.history(f.id,'bob',query));
 f.engine.mutate(f.id,'bob',input(f.store,f.id,bob,'unmute'),bob);assert.throws(()=>f.engine.history(f.id,'bob',{before:two.nextBefore!,expectedMuteVersion:5}),{code:'TASK_MUTE_CHANGED'});
}finally{f.store.close();}});

test('immutable private evidence and transaction rollback protect all preference side effects',()=>{const f=fixture();try{
 f.store.database.exec("CREATE TRIGGER fixture_reject_task_mute BEFORE INSERT ON task_notification_mutes BEGIN SELECT RAISE(ABORT,'injected mute failure'); END");assert.throws(()=>f.engine.mutate(f.id,'bob',input(f.store,f.id,bob,'mute'),bob),/injected mute failure/);assert.deepEqual(counts(f.store),[0,0,0]);f.store.database.exec('DROP TRIGGER fixture_reject_task_mute');
 assert.throws(()=>f.store.transaction(()=>{f.engine.mutate(f.id,'bob',input(f.store,f.id,bob,'mute'),bob);f.engine.mutate(f.other,'bob',input(f.store,f.other,bob,'mute'),bob);throw new Error('whole operation failed');}),/whole operation failed/);assert.deepEqual(counts(f.store),[0,0,0]);
 f.engine.mutate(f.id,'bob',input(f.store,f.id,bob,'mute'),bob);for(const table of ['task_notification_mute_operations','task_notification_mute_history']){assert.throws(()=>f.store.database.exec(`UPDATE ${table} SET data=data`),/immutable/);assert.throws(()=>f.store.database.exec(`DELETE FROM ${table}`),/immutable/);}assert.throws(()=>f.store.database.exec('DELETE FROM task_notification_mutes'),/durable/);assert.throws(()=>f.store.database.exec("UPDATE task_notification_mutes SET principal_id='alice'"),/immutable/);
}finally{f.store.close();}});

test('canonical private operation verification rejects altered identity, intent, state, attribution and evidence links',()=>{const f=fixture();try{
 const receipt=f.engine.mutate(f.id,'bob',input(f.store,f.id,bob,'mute'),bob,'a'.repeat(64));f.engine.mutate(f.id,'bob',input(f.store,f.id,bob,'unmute'),bob);const original=f.store.database.prepare('SELECT data FROM task_notification_mute_operations WHERE id=?').get(receipt.operationId)!.data as string;
 f.store.database.exec('DROP TRIGGER task_notification_mute_operations_no_update');
 const corruptors:Array<(op:Record<string,any>)=>void>=[op=>{op.id=randomUUID();},op=>{op.taskId=f.other;},op=>{op.principalId='alice';},op=>{op.input.extra=true;},op=>{op.input.expectedMuteVersion=1;},op=>{op.inputSha256='b'.repeat(64);},op=>{op.retryKeySha256='bad';},op=>{op.attribution.principalId='alice';},op=>{op.before.version=1;},op=>{op.after.muted=false;},op=>{op.createdAt='2025-01-01T00:00:00Z';},op=>{op.transactionId=randomUUID();},op=>{op.receipt.changed=false;},op=>{op.extra=true;}];
 for(const corrupt of corruptors){const op=JSON.parse(original);corrupt(op);f.store.database.prepare('UPDATE task_notification_mute_operations SET data=? WHERE id=?').run(JSON.stringify(op),receipt.operationId);assert.throws(()=>f.engine.operation(receipt.operationId),{code:'TASK_MUTE_INVALID_RECEIPT'});}
 f.store.database.prepare('UPDATE task_notification_mute_operations SET data=? WHERE id=?').run(original,receipt.operationId);assert.deepEqual(f.engine.operation(receipt.operationId).receipt,receipt);assert.throws(()=>f.engine.operationPrincipalId(randomUUID()),{code:'TASK_MUTE_INVALID_RECEIPT'});
}finally{f.store.close();}});

test('private state and history corruption cannot be presented as an authentic current preference',()=>{
 for(const corrupt of ['state','identity','attribution','gap'] as const){const f=fixture();try{
  for(let n=0;n<3;n++)f.engine.mutate(f.id,'bob',input(f.store,f.id,bob,n%2?'unmute':'mute'),bob);
  if(corrupt==='state')f.store.database.exec("UPDATE task_notification_mutes SET muted=0 WHERE principal_id='bob'");
  else if(corrupt==='gap'){f.store.database.exec('DROP TRIGGER task_notification_mute_history_no_delete');f.store.database.prepare('DELETE FROM task_notification_mute_history WHERE task_id=? AND principal_id=? AND version=2').run(f.id,'bob');}
  else {f.store.database.exec('DROP TRIGGER task_notification_mute_history_no_update');const row=f.store.database.prepare('SELECT id,data FROM task_notification_mute_history WHERE task_id=? AND principal_id=? AND version=3').get(f.id,'bob')!;const data=JSON.parse(row.data as string);if(corrupt==='identity')data.taskId=f.other;else data.attribution.principalId='alice';f.store.database.prepare('UPDATE task_notification_mute_history SET data=? WHERE id=?').run(JSON.stringify(data),row.id!);}
  assert.throws(()=>f.engine.snapshot(f.id,'bob'),{code:'TASK_MUTE_INVALID_RECEIPT'});assert.throws(()=>f.engine.history(f.id,'bob'),{code:'TASK_MUTE_INVALID_RECEIPT'});assert.throws(()=>f.engine.mutedPeople(f.id),{code:'TASK_MUTE_INVALID_RECEIPT'});
 }finally{f.store.close();}}
});


test('mute routing counts all stored preferences before the complete-query limit, including unmuted rows',()=>{const f=fixture();try{
 const insert=f.store.database.prepare('INSERT INTO task_notification_mutes(task_id,principal_id,muted,version,updated_at) VALUES(?,?,0,1,?)');f.store.transaction(()=>{for(let n=0;n<10001;n++)insert.run(f.id,`person${n}`,'2026-01-01T00:00:00Z');});
 // No truncated answer may be returned, even if the cache claims everyone is
 // unmuted. Proof checks run only after the complete preference set is admitted.
 assert.throws(()=>f.engine.mutedPeople(f.id),{code:'NOTIFICATION_LIMIT'});
}finally{f.store.close();}});
