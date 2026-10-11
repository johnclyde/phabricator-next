import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initializeNotifications, NotificationStore, notificationInputHash } from './notifications.ts';
import { isNotificationEvent, isNotificationInbox, notificationEvent, notificationInput, notificationItem, notificationReadObjectId, TASK_NOTIFICATION_KINDS } from '../shared/notifications.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { NotificationContext, NotificationKind } from '../shared/notifications.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'test' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: null, requestId: 'test' };
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE entities(id TEXT PRIMARY KEY); CREATE TABLE policy_meta(name TEXT PRIMARY KEY,value INTEGER); INSERT INTO policy_meta VALUES('epoch',1)");
  initializeNotifications(db);
  const objects = new Map(['T1','T2','D1','P1','L1'].map(id => [id,{title:`Title ${id}`,version:1}]));
  for (const id of objects.keys()) db.prepare('INSERT INTO entities(id) VALUES(?)').run(id);
  const hidden = new Set<string>(), disabled = new Set<string>(), muted = new Set<string>();
  const engine = new NotificationStore(db, {
    revision: id => ({ title: objects.get(id)!.title, kind: id.startsWith('D')?'code':id.startsWith('L')?'document':'paper', head: {versionId:`source-${id}`,number:objects.get(id)!.version,contentHash:'a'.repeat(64)}, broadcast:true }),
    task: id => ({ ...objects.get(id)! }), recipients: () => ({recipients:['alice','bob'],muted:[...muted]}),
  });
  engine.configure({eligible:id=>['alice','bob'].includes(id)&&!disabled.has(id),canView:(id,person)=>!hidden.has(id)&&!hidden.has(`${id}:${person}`)});
  const emit = (id:string,kind:NotificationKind=id.startsWith('T')?'task_updated':'source_updated') => engine.emit(id.startsWith('T')?{objectId:id,kind,cause:{type:'test',id:randomUUID()},attribution:alice}:{revisionId:id,kind,cause:{type:'test',id:randomUUID()},attribution:alice});
  return {db,engine,objects,hidden,disabled,muted,emit};
}

test('generic target guards preserve strict legacy projection and exact legacy request normalization',()=>{
  const legacy={id:randomUUID(),revisionId:'L1',kind:'commented',cause:{type:'comment',id:'original'},actor:null,createdAt:'2026-10-01T00:00:00Z',head:{versionId:'old-source',number:2,contentHash:'a'.repeat(64)}};
  const original=JSON.stringify(legacy),modern=notificationEvent(legacy)!;
  assert.ok(isNotificationEvent(modern));assert.equal(modern.objectId,'L1');assert.deepEqual(modern.context,{kind:'revision',head:legacy.head});assert.equal(JSON.stringify(legacy),original);
  const item=notificationItem({id:randomUUID(),event:legacy,revision:{id:'L1',title:'Word',kind:'document'},read:false,version:0});assert.equal(item?.object.kind,'document');
  assert.equal(notificationEvent({...legacy,revisionId:'T1'}),null);assert.equal(notificationEvent({...legacy,kind:'task_updated'}),null);assert.equal(notificationEvent({...legacy,extra:true}),null);
  assert.equal(notificationItem({...item,revision:{id:'L1',title:'Word',kind:'document'}}),null);
  const horizon='a'.repeat(720),old={action:'read_object' as const,revisionId:'L1',horizon,expectedAccessEpoch:1},next={action:'read_object' as const,objectId:'L1',horizon,expectedAccessEpoch:1};
  assert.equal(JSON.stringify(notificationInput(old)),JSON.stringify(old));assert.equal(notificationReadObjectId(old),'L1');assert.notEqual(notificationInputHash(old),notificationInputHash(next));
  assert.throws(()=>notificationInput({...old,objectId:'L1'}));assert.throws(()=>notificationInput({...old,revisionId:'T1'}));assert.throws(()=>notificationInput({...next,objectId:'W1'}));
});

test('all task event kinds carry captured task version while mixed inboxes expose current authorized object titles',()=>{const f=fixture();try{
  for(const id of ['D1','P1','L1'])f.emit(id);
  f.db.exec('BEGIN');f.engine.batch(()=>{for(const kind of TASK_NOTIFICATION_KINDS)f.emit('T1',kind);f.objects.get('T1')!.version=2;f.objects.get('T1')!.title='Current task title';});f.db.exec('COMMIT');
  const page=f.engine.list('bob',{},1);assert.equal(page.items.length,13);assert.ok(isNotificationInbox(page,'bob'));
  const tasks=page.items.filter(item=>item.object.kind==='task');assert.equal(tasks.length,TASK_NOTIFICATION_KINDS.length);for(const item of tasks){assert.equal(item.object.title,'Current task title');assert.deepEqual(item.event.context,{kind:'task',taskVersion:1});assert.equal(item.event.objectId,'T1');}
  assert.equal(f.engine.summary('alice',1).unreadCount,0,'acting person excluded');
  f.muted.add('bob');f.emit('T1');assert.equal(f.engine.summary('bob',1).unreadCount,13);f.muted.clear();f.hidden.add('T1');assert.equal(f.engine.summary('bob',1).unreadCount,3);assert.equal(f.engine.list('bob',{},1).items.length,3);f.hidden.clear();assert.equal(f.engine.summary('bob',1).unreadCount,13);
  assert.equal(f.engine.notificationObjectId('bob',tasks[0]!.id),'T1');assert.throws(()=>f.engine.notificationObjectId('alice',tasks[0]!.id),{code:'NOTIFICATION_UNAVAILABLE'});
}finally{f.db.close();}});

test('task view boundary marks only its earlier deliveries and mixed generic operations retain canonical proofs',()=>{const f=fixture();try{
  f.emit('T1');f.emit('T2');f.emit('P1');const boundary=f.engine.summary('bob',1);f.emit('T1');
  const request={action:'read_object' as const,objectId:'T1',horizon:boundary.horizon,expectedAccessEpoch:1};const receipt=f.engine.mutate('bob',request,bob,'a'.repeat(64));const op=f.engine.operation(receipt.operationId);
  assert.deepEqual(op.affectedObjectIds,['T1']);assert.equal(op.affected.length,1);assert.deepEqual(op.input,request);assert.equal(f.engine.summary('bob',1).unreadCount,3);
  const noop=f.engine.mutate('bob',request,bob,'b'.repeat(64));assert.equal(noop.changed,false);assert.deepEqual(f.engine.operation(noop.operationId).affectedObjectIds,['T1']);
  const oldRequest={action:'read_object' as const,revisionId:'P1',horizon:boundary.horizon,expectedAccessEpoch:1};const old=f.engine.mutate('bob',oldRequest,bob);assert.deepEqual(f.engine.operation(old.operationId).input,oldRequest);
  const all=f.engine.mutate('bob',{action:'read_through',horizon:f.engine.summary('bob',1).horizon,expectedAccessEpoch:1},bob);assert.deepEqual(f.engine.operation(all.operationId).affectedObjectIds,['T1','T2']);assert.equal(f.engine.summary('bob',1).unreadCount,0);
  const task=f.engine.list('bob',{},1).items.find(item=>item.event.objectId==='T1')!;const unread=f.engine.mutate('bob',{action:'unread',notificationId:task.id,expectedVersion:task.version,expectedAccessEpoch:1},bob);assert.equal(f.engine.operation(unread.operationId).affected[0]!.objectId,'T1');
  assert.deepEqual(f.engine.operation(receipt.operationId).receipt,receipt,'earlier proof survives later mixed operations');
  f.hidden.add('T1');assert.throws(()=>f.engine.mutate('bob',{...request,horizon:f.engine.summary('bob',1).horizon},bob),{code:'NOTIFICATION_UNAVAILABLE'});
}finally{f.db.close();}});

test('generic cursor boundaries retain owner, epoch, read generation and mixed-object chronology',()=>{const f=fixture();try{
  f.emit('T1');f.emit('P1');f.emit('T2');const first=f.engine.list('bob',{limit:1},1);assert.equal(first.items[0]!.event.objectId,'T2');f.emit('L1');
  f.hidden.add('P1');const next=f.engine.list('bob',{limit:1,before:first.nextBefore!},1);assert.equal(next.items[0]!.event.objectId,'T1');assert.equal(next.unreadCount,3);assert.throws(()=>f.engine.list('alice',{before:first.nextBefore!},1),{code:'NOTIFICATION_CURSOR_INVALID'});
  assert.throws(()=>f.engine.list('bob',{filter:'read',before:first.nextBefore!},1),{code:'NOTIFICATION_CHANGED'});
  f.engine.mutate('bob',{action:'read',notificationId:first.items[0]!.id,expectedVersion:0,expectedAccessEpoch:1},bob);assert.throws(()=>f.engine.list('bob',{before:first.nextBefore!},1),{code:'NOTIFICATION_CHANGED'});
  f.db.exec("UPDATE policy_meta SET value=2 WHERE name='epoch'");assert.throws(()=>f.engine.mutate('bob',{action:'read_through',horizon:first.horizon,expectedAccessEpoch:2},bob),{code:'NOTIFICATION_CHANGED'});
}finally{f.db.close();}});

test('invalid task contexts and mixed legacy-modern evidence fail closed without identity repair',()=>{const f=fixture();try{
  const contexts:NotificationContext[]=[{kind:'task',taskVersion:0},{kind:'revision',head:null}];
  for(const context of contexts)assert.equal(isNotificationEvent({format:'phabricator.notification-event.v2',id:randomUUID(),objectId:'T1',kind:'task_updated',cause:{type:'test',id:'invalid'},actor:null,createdAt:'2026-01-01Z',context}),false);
  assert.throws(()=>f.emit('T1','source_updated'),{code:'NOTIFICATION_INVALID_RECEIPT'});assert.throws(()=>f.emit('P1','task_updated'),{code:'NOTIFICATION_INVALID_RECEIPT'});
  f.emit('T1');const item=f.engine.list('bob',{},1).items[0]!,receipt=f.engine.mutate('bob',{action:'read',notificationId:item.id,expectedVersion:0,expectedAccessEpoch:1},bob);
  f.db.exec('DROP TRIGGER notification_operations_no_update');const raw=JSON.parse(f.db.prepare('SELECT data FROM notification_operations WHERE id=?').get(receipt.operationId)!.data as string);raw.affected[0].revisionId='T1';f.db.prepare('UPDATE notification_operations SET data=? WHERE id=?').run(JSON.stringify(raw),receipt.operationId);assert.throws(()=>f.engine.operation(receipt.operationId),{code:'NOTIFICATION_INVALID_RECEIPT'});
  f.db.exec('DROP TRIGGER notification_events_no_update');const event=JSON.parse(f.db.prepare('SELECT data FROM notification_events WHERE id=?').get(item.event.id)!.data as string);event.context.taskVersion=0;f.db.prepare('UPDATE notification_events SET data=? WHERE id=?').run(JSON.stringify(event),item.event.id);assert.throws(()=>f.engine.list('bob',{},1),{code:'NOTIFICATION_INVALID_RECEIPT'});
}finally{f.db.close();}});


test('derived task causes require current actor view only when explicitly requested',()=>{const f=fixture();try{
 f.hidden.add('T2:alice');
 const cause={objectId:'T2',kind:'task_subtask_status_changed' as const,cause:{type:'task_status',id:'hidden-parent'},attribution:alice,requireActorView:true};
 f.engine.emit(cause);assert.equal(f.engine.summary('bob',1).unreadCount,0);assert.equal(f.db.prepare('SELECT count(*) AS count FROM notification_events').get()!.count,0);
 f.emit('T2');assert.equal(f.engine.summary('bob',1).unreadCount,1,'ordinary semantic changes retain existing recipient rules');
 f.hidden.clear();f.engine.emit(cause);const event=f.engine.list('bob',{},1).items[0]!.event;assert.equal(event.kind,'task_subtask_status_changed');assert.equal('requireActorView' in event,false);assert.equal(f.engine.summary('bob',1).unreadCount,2);
}finally{f.db.close();}});
