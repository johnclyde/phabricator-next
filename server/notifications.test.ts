import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { DatabaseSync } from 'node:sqlite';
import { initializeNotifications, NotificationStore } from './notifications.ts';
import { Auth } from './auth.ts';
import { isNotificationInbox, isNotificationSummary, NOTIFICATION_LIMITS } from '../shared/notifications.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionSubscriptionAction, RevisionSubscriptionInput } from '../shared/revision-subscriptions.ts';
import type { RevisionReviewerAction, RevisionReviewerInput } from '../shared/revision-reviewers.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'alice-key', requestId: 'alice-request' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: 'bob-key', requestId: 'bob-request' };
const carol: ActorAttribution = { principalId: 'carol', displayName: 'Carol', credentialId: null, requestId: 'carol-request' };
const ref = ({ principalId, displayName }: ActorAttribution) => ({ principalId, displayName });
const epoch = (store: Store) => store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;
function fixture() { const store = new Store({ path: ':memory:' }), hidden = new Set<string>(), disabled = new Set<string>(); store.notifications.configure({ eligible: id => [alice,bob,carol].some(p => p.principalId === id) && !disabled.has(id), canView: (id,p) => !hidden.has(`${id}:${p}`) }); return {store,hidden,disabled}; }
function create(store: Store, draft = false) { return store.createRevision({ title: 'Exact manuscript', testPlan: 'Read the manuscript.', kind: 'paper', draft, files: [{ path: 'paper.tex', content: 'original result\n' }] }, alice); }
function follow(store: Store, id: string, action: RevisionSubscriptionAction = 'subscribe', actor = bob, target = actor) { const s = store.revisionSubscriptions.snapshot(id,target.principalId), pins={principalId:target.principalId,expectedAuthorVersion:s.authorVersion,expectedReviewerVersion:s.reviewerVersion,expectedAccessEpoch:epoch(store)}; const input: RevisionSubscriptionInput = action==='subscribe'||action==='unsubscribe'?{action,...pins,expectedSubscriptionVersion:s.viewer.version}:{action,...pins,expectedMuteVersion:s.mute.version}; return store.revisionSubscriptions.mutate(id,input,actor,ref(target)); }
function review(store: Store,id:string,action:RevisionReviewerAction,actor=bob,target?:ActorAttribution) { const s=store.revisionReviewers.snapshot(id),pins={message:'',expectedReviewerVersion:s.reviewers.version,expectedLifecycleVersion:s.lifecycle.version,expectedAuthorVersion:s.authorship.version,expectedVersion:s.head.number,expectedVersionId:s.head.versionId,expectedContentHash:s.head.contentHash,expectedAccessEpoch:epoch(store),expectedConfigId:s.configId,expectedEvidenceSha256:s.evidence.sha256};const input:RevisionReviewerInput=target?{action:action as 'add',reviewerId:target.principalId,...pins}:{action:action as 'accept',...pins};return store.revisionReviewers.mutate(id,input,actor,target&&ref(target)); }
function source(store: Store,id:string) {const d=store.detail(id);return store.createVersion(id,{expectedVersion:d.revision.currentVersion,message:'Update source',files:[{path:'paper.tex',content:`version ${d.revision.currentVersion+1}\n`}]},alice);}
function inbox(store:Store,person=bob) {return store.notifications.list(person.principalId,{},epoch(store));}
const count = (store:Store, table:string) => Number(store.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);

test('post-change people recipients, object mute, active identities and current view drive complete durable delivery',()=>{const {store,hidden,disabled}=fixture();try{
 const id=create(store).revision.id;follow(store,id);follow(store,id,'subscribe',carol);assert.equal(inbox(store).items.length,0,'self subscription is silent');
 source(store,id);assert.deepEqual(inbox(store).items.map(i=>i.event.kind),['source_updated']);assert.equal(inbox(store,alice).items.length,0,'actor does not notify self');
 follow(store,id,'mute');source(store,id);assert.equal(inbox(store).items.length,1);assert.equal(inbox(store,carol).items.length,2);
 follow(store,id,'unmute');disabled.add('bob');hidden.add(`${id}:carol`);source(store,id);assert.equal(count(store,'notification_deliveries'),3);assert.throws(()=>inbox(store),{code:'NOTIFICATION_UNAVAILABLE'});
 disabled.delete('bob');assert.equal(inbox(store,carol).unreadCount,0);assert.equal(inbox(store,carol).items.length,0);hidden.clear();assert.equal(inbox(store,carol).unreadCount,2,'revocation hides existing rows, without deleting them');
 follow(store,id,'unsubscribe',alice,bob);assert.equal(inbox(store).items.length,1,'removed subscriber is absent from post-change feed recipients');assert.equal(inbox(store,carol).items[0]!.event.kind,'subscribers_changed');
 assert.ok(isNotificationInbox(inbox(store),'bob'));assert.ok(isNotificationSummary(store.notifications.summary('bob',epoch(store)),'bob'));
}finally{store.close();}});

test('current author and nonresigned reviewers receive changes; draft first broadcast and cascades have one cause',()=>{const {store}=fixture();try{
 const id=create(store,true).revision.id;follow(store,id);review(store,id,'add',alice,carol);source(store,id);assert.equal(count(store,'notification_events'),0);
 lifecycleAction(store,id,'request_review',alice);assert.deepEqual(inbox(store).items.map(i=>i.event.kind),['lifecycle_changed']);assert.equal(inbox(store,carol).items.length,1);
 const before=count(store,'notification_events');review(store,id,'accept',carol);assert.equal(count(store,'notification_events'),before+1);assert.equal(inbox(store,alice).items[0]!.event.kind,'reviewers_changed');
 const s=store.revisionAuthorship.snapshot(id);store.revisionAuthorship.mutate(id,{action:'assign',authorId:carol.principalId,message:'',expectedAuthorVersion:s.authorship.version,expectedReviewerVersion:s.reviewerVersion,expectedLifecycleVersion:s.lifecycleVersion,expectedVersion:s.head.number,expectedVersionId:s.head.versionId,expectedContentHash:s.head.contentHash,expectedAccessEpoch:epoch(store)},alice,ref(carol));
 assert.equal(count(store,'notification_events'),before+2,'author reviewer/lifecycle effects are grouped');assert.equal(inbox(store,carol).items[0]!.event.kind,'author_changed');
 const event=inbox(store).items[0]!.event;assert.equal(event.cause.type,'authorship');assert.equal(event.head!.versionId,s.head.versionId);assert.ok(!JSON.stringify(event).includes('original result'));
}finally{store.close();}});

test('tagged ancestor watchers override project silence; ordinary members do not route and object mute still wins',()=>{const {store}=fixture();try{
 const parent=store.createProject({name:'Parent',memberIds:['bob']},alice);const pref=store.projectPreferences(parent.id,'bob');store.updateProjectWatcher(parent.id,{principalId:'bob',action:'watch',expectedVersion:pref.watching.version},bob);store.updateProjectSilence(parent.id,{silenced:true,expectedVersion:0},bob);const preview=store.projectChildPreview(parent.id,'project'),child=store.createProject({name:'Child',parentId:parent.id,expectedParentVersion:preview.expectedParentVersion,expectedHierarchyVersion:preview.expectedHierarchyVersion,expectedParentMembersVersion:preview.expectedParentMembersVersion,confirmMembershipConversion:true},alice);
 const detail=store.createRevision({title:'Tagged',kind:'code',testPlan:'Read.',projectIds:[child.id],files:[{path:'main.ts',content:'one'}]},alice),id=detail.revision.id;
 assert.equal(inbox(store).items[0]!.event.kind,'created');follow(store,id,'mute');source(store,id);assert.equal(inbox(store).items.length,1);
 follow(store,id,'unmute');source(store,id);assert.equal(inbox(store).items.length,2);assert.equal(inbox(store,carol).items.length,0);
}finally{store.close();}});

test('writer queue uses final creation policy and rolls notification causes back with domain work',()=>{const {store,hidden}=fixture();try{
 const project=store.createProject({name:'Watched'},alice);store.updateProjectWatcher(project.id,{principalId:'bob',action:'watch',expectedVersion:0},bob);
 let id='';store.mutate('private-create','private-create',()=>{const d=store.createRevision({title:'Private',kind:'code',testPlan:'Read.',projectIds:[project.id],files:[{path:'one',content:'one'}]},alice);id=d.revision.id;hidden.add(`${id}:bob`);assert.equal(count(store,'notification_events'),0,'delivery waits for final policy');return{status:201,body:d};});
 assert.equal(inbox(store).items.length,0);hidden.clear();follow(store,id);
 const before=count(store,'notification_events'),version=store.detail(id).revision.currentVersion;
 assert.throws(()=>store.mutate('rollback','rollback',()=>{source(store,id);throw new Error('force rollback');}),/force rollback/);assert.equal(count(store,'notification_events'),before);assert.equal(store.detail(id).revision.currentVersion,version);
 source(store,id);assert.equal(inbox(store).items.length,1);assert.equal(count(store,'notification_events'),before+1);
 assert.throws(()=>store.database.exec('DELETE FROM notification_events'),/immutable/);assert.throws(()=>store.database.exec('DELETE FROM notification_deliveries'),/durable/);
}finally{store.close();}});

test('paged horizons survive new arrivals; personal read generations invalidate cursors and preserve later arrivals',()=>{const {store}=fixture();try{
 const id=create(store).revision.id;follow(store,id);for(let i=0;i<4;i++)source(store,id);
 const page=store.notifications.list('bob',{limit:2},epoch(store));assert.equal(page.items.length,2);assert.ok(page.nextBefore);source(store,id);
 const next=store.notifications.list('bob',{limit:2,before:page.nextBefore!},epoch(store));assert.equal(next.items.length,2);assert.equal(next.unreadCount,5);assert.ok(!next.items.some(i=>page.items.some(p=>p.id===i.id)));
 const receipt=store.notifications.mutate('bob',{action:'read_through',horizon:page.horizon,expectedAccessEpoch:epoch(store)},bob,'a'.repeat(64));assert.equal(receipt.changed,true);assert.equal(inbox(store).unreadCount,1);assert.equal(store.notifications.operation(receipt.operationId).affected.length,4);
 assert.throws(()=>store.notifications.list('bob',{before:page.nextBefore!},epoch(store)),{code:'NOTIFICATION_CHANGED'});
 const item=inbox(store).items[0]!, request={action:'read' as const,notificationId:item.id,expectedVersion:item.version,expectedAccessEpoch:epoch(store)};
 const read=store.notifications.mutate('bob',request,bob);assert.equal(inbox(store).unreadCount,0);assert.throws(()=>store.notifications.mutate('bob',request,bob),{code:'NOTIFICATION_CHANGED'});
 const noOp=store.notifications.mutate('bob',{...request,expectedVersion:1},bob);assert.equal(noOp.changed,false);assert.equal(inbox(store).readVersion,2);
 store.notifications.mutate('bob',{action:'unread',notificationId:item.id,expectedVersion:1,expectedAccessEpoch:epoch(store)},bob);assert.equal(inbox(store).unreadCount,1);
 assert.deepEqual(store.notifications.operation(read.operationId).receipt,read);assert.deepEqual(store.notifications.operation(noOp.operationId).receipt,noOp);assert.deepEqual(store.notifications.operation(receipt.operationId).receipt,receipt);
}finally{store.close();}});

test('private cursors and read mutations enforce owner, query, epoch and current source visibility',()=>{const {store,hidden}=fixture();try{
 const id=create(store).revision.id;follow(store,id);follow(store,id,'subscribe',carol);source(store,id);source(store,id);
 const page=store.notifications.list('bob',{limit:1},epoch(store)),item=page.items[0]!;
 assert.throws(()=>store.notifications.list('carol',{before:page.nextBefore!},epoch(store)),{code:'NOTIFICATION_CURSOR_INVALID'});
 assert.throws(()=>store.notifications.list('bob',{filter:'read',before:page.nextBefore!},epoch(store)),{code:'NOTIFICATION_CHANGED'});
 assert.throws(()=>store.notifications.mutate('carol',{action:'read',notificationId:item.id,expectedVersion:0,expectedAccessEpoch:epoch(store)},carol),{code:'NOTIFICATION_UNAVAILABLE'});
 hidden.add(`${id}:bob`);assert.equal(inbox(store).unreadCount,0);assert.throws(()=>store.notifications.mutate('bob',{action:'read',notificationId:item.id,expectedVersion:0,expectedAccessEpoch:epoch(store)},bob),{code:'NOTIFICATION_UNAVAILABLE'});
 const empty=store.notifications.mutate('bob',{action:'read_through',horizon:page.horizon,expectedAccessEpoch:epoch(store)},bob);assert.equal(empty.changed,false);hidden.clear();assert.equal(inbox(store).unreadCount,2);
 store.database.exec("UPDATE policy_meta SET value=value+1 WHERE name='epoch'");assert.throws(()=>store.notifications.mutate('bob',{action:'read_through',horizon:page.horizon,expectedAccessEpoch:epoch(store)},bob),{code:'NOTIFICATION_CHANGED'});
}finally{store.close();}});

test('source-independent metadata/tags, human comments/replies and review evidence produce typed causes; silent changes do not',()=>{const {store}=fixture();try{
 new Auth({database:store.database,mode:'local',basePath:'/',provisioning:true});for(const person of[alice,bob,carol])store.database.prepare("INSERT INTO auth_accounts(id,username,display_name,salt,password_hash) VALUES(?,?,?,'fixture','fixture')").run(person.principalId,person.principalId,person.displayName);
 const d=create(store),id=d.revision.id;follow(store,id);const comment=store.createComment(id,{versionId:d.versions[0]!.id,body:'Private passage quote'},alice);store.createReply(id,comment.threadId!,{viewedVersionId:d.versions[0]!.id,body:'Exact reply'},carol);
 let before=count(store,'notification_events');store.updateThread(id,comment.threadId!,{status:'resolved',expectedThreadVersion:2,versionId:d.versions[0]!.id},alice);assert.equal(count(store,'notification_events'),before);
 const metadata=store.revisionMetadata.snapshot(id);store.revisionMetadata.mutate(id,{title:'Renamed',summary:'',testPlan:'Read again.',message:'',expectedMetadataVersion:metadata.metadata.version,expectedVersion:metadata.head.number,expectedVersionId:metadata.head.versionId,expectedContentHash:metadata.head.contentHash,expectedConfigId:metadata.configId,expectedAccessEpoch:epoch(store)},alice);
 store.revisionProjects.mutate(id,{action:'set',projectIds:[],expectedProjectVersion:0,expectedAccessEpoch:epoch(store)},alice);assert.equal(count(store,'notification_events'),before+1,'tag noop silent');
 const project=store.createProject({name:'Topic'},alice);store.revisionProjects.mutate(id,{action:'add',projectIds:[project.id],expectedProjectVersion:0,expectedAccessEpoch:epoch(store)},alice);
 store.saveReview(id,1,{provider:'local',model:'checks',summary:'Exact local evidence',findings:[]},alice);
 assert.deepEqual(inbox(store).items.map(item=>item.event.kind),['review_completed','projects_changed','metadata_changed','replied','commented']);assert.ok(inbox(store).items.every(item=>item.revision.title==='Renamed'));assert.ok(!JSON.stringify(inbox(store)).includes('Private passage quote'));
}finally{store.close();}});

test('suggestion application has one immutable cause rather than duplicate source and cascade notifications',()=>{const {store}=fixture();try{
 const d=create(store),id=d.revision.id;follow(store,id);const v=d.versions[0]!,comment=store.createComment(id,{versionId:v.id,body:'Replace',filePath:'paper.tex',passage:{start:0,end:8,quote:'original'},suggestion:{replacement:'improved'}},bob);const thread=store.detail(id).threads.find(t=>t.id===comment.threadId)!;const before=count(store,'notification_events');
 store.applySuggestion(id,comment.id,{expectedVersion:1,expectedVersionId:v.id,expectedContentHash:v.contentHash,expectedThreadVersion:thread.version},alice);
 assert.equal(count(store,'notification_events'),before+1);assert.equal(inbox(store).items[0]!.event.kind,'suggestion_applied');assert.equal(inbox(store).items[0]!.event.head!.number,2);
}finally{store.close();}});

test('bounded hidden paging can advance without exposing hidden IDs, and corruption of read provenance is rejected',()=>{const {store,hidden}=fixture();try{
 const visible=create(store).revision.id,secret=create(store).revision.id;follow(store,visible);follow(store,secret);source(store,visible);
 store.transaction(()=>{for(let i=0;i<NOTIFICATION_LIMITS.scan+1;i++)store.notifications.emit({revisionId:secret,kind:'source_updated',cause:{type:'test',id:randomUUID()},attribution:alice});});hidden.add(`${secret}:bob`);
 const page=inbox(store);assert.equal(page.items.length,0);assert.ok(page.nextBefore);assert.equal(page.unreadCount,1);assert.ok(!JSON.stringify(page).includes(JSON.stringify(secret)));const next=store.notifications.list('bob',{before:page.nextBefore!},epoch(store));assert.equal(next.items[0]!.event.revisionId,visible);
 const item=next.items[0]!,receipt=store.notifications.mutate('bob',{action:'read',notificationId:item.id,expectedVersion:0,expectedAccessEpoch:epoch(store)},bob);store.database.exec('DROP TRIGGER notification_operations_no_update');const raw=JSON.parse(store.database.prepare('SELECT data FROM notification_operations WHERE id=?').get(receipt.operationId)!.data as string);raw.beforeReadVersion=100;raw.afterReadVersion=101;store.database.prepare('UPDATE notification_operations SET data=? WHERE id=?').run(JSON.stringify(raw),receipt.operationId);assert.throws(()=>store.notifications.operation(receipt.operationId),{code:'NOTIFICATION_INVALID_RECEIPT'});
}finally{store.close();}});


test('historical comments and replies preserve their exact anchor version while event order follows delivery sequence',()=>{const {store}=fixture();try{
 const d=create(store),id=d.revision.id;follow(store,id);const current=source(store,id),original=d.versions[0]!;
 const comment=store.createComment(id,{versionId:original.id,body:'Earlier source discussion'},alice);store.createReply(id,comment.threadId!,{viewedVersionId:current.versions.at(-1)!.id,body:'Still the original anchor'},alice);
 const anchored=inbox(store).items.slice(0,2);assert.deepEqual(anchored.map(i=>i.event.kind),['replied','commented']);for(const item of anchored)assert.deepEqual(item.event.head,{versionId:original.id,number:1,contentHash:original.contentHash});
 store.transaction(()=>store.notifications.emit({revisionId:id,kind:'metadata_changed',cause:{type:'test',id:'backdated-event'},attribution:alice,createdAt:'2001-01-01T00:00:00.000Z'}));const page=store.notifications.list('bob',{limit:1},epoch(store));assert.equal(page.items[0]!.event.cause.id,'backdated-event');const next=store.notifications.list('bob',{limit:1,before:page.nextBefore!},epoch(store));assert.equal(next.items[0]!.event.kind,'replied');assert.equal(next.items[0]!.event.head!.number,1);
}finally{store.close();}});


test('complete unread counting and bulk read reject above explicit whole-query bounds without partial changes',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec("CREATE TABLE entities(id TEXT PRIMARY KEY); CREATE TABLE policy_meta(name TEXT PRIMARY KEY,value INTEGER); INSERT INTO policy_meta VALUES('epoch',1)");initializeNotifications(db);const notifications=new NotificationStore(db,{revision:()=>({title:'Bound fixture',kind:'paper',head:{versionId:'fixture',number:1,contentHash:'a'.repeat(64)},broadcast:true}),recipients:()=>({recipients:['bob'],muted:[]})});notifications.configure({eligible:id=>id==='bob',canView:()=>true});
 const entity=db.prepare('INSERT INTO entities(id) VALUES(?)'),event=db.prepare('INSERT INTO notification_events(id,revision_id,cause_type,cause_id,data) VALUES(?,?,?,?,?)'),delivery=db.prepare('INSERT INTO notification_deliveries(id,event_id,principal_id,read,version) VALUES(?,?,?,0,0)');
 const add=(n:number)=>{const id=`P${n}`,eventId=randomUUID();entity.run(id);event.run(eventId,id,'test',String(n),JSON.stringify({id:eventId,revisionId:id,kind:'created',cause:{type:'test',id:String(n)},actor:null,createdAt:'2026-01-01T00:00:00Z',head:null}));delivery.run(randomUUID(),eventId,'bob');};
 db.exec('BEGIN');for(let n=1;n<=NOTIFICATION_LIMITS.unreadRevisions;n++)add(n);db.exec('COMMIT');const atLimit=notifications.summary('bob',1);assert.equal(atLimit.unreadCount,10000);add(10001);assert.throws(()=>notifications.summary('bob',1),{code:'NOTIFICATION_LIMIT'});
 // A newly issued boundary covers the extra row. List/count is deliberately not
 // bypassed: use an individual read to make count admissible, get boundary, then
 // put that same row back to unread so bulk attempts the complete 10,001 rows.
 const last=db.prepare('SELECT id FROM notification_deliveries ORDER BY sequence DESC LIMIT 1').get()!.id as string;notifications.mutate('bob',{action:'read',notificationId:last,expectedVersion:0,expectedAccessEpoch:1},bob);const boundary=notifications.summary('bob',1);notifications.mutate('bob',{action:'unread',notificationId:last,expectedVersion:1,expectedAccessEpoch:1},bob);const operations=Number(db.prepare('SELECT count(*) AS count FROM notification_operations').get()!.count);
 assert.throws(()=>notifications.mutate('bob',{action:'read_through',horizon:boundary.horizon,expectedAccessEpoch:1},bob),{code:'NOTIFICATION_LIMIT'});assert.equal(db.prepare('SELECT count(*) AS count FROM notification_operations').get()!.count,operations);assert.equal(db.prepare('SELECT count(*) AS count FROM notification_deliveries WHERE read=0').get()!.count,10001);
 }finally{db.close();}
});
