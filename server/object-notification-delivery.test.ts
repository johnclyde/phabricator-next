import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import { createAuth } from './auth.ts';
import type { ActorAttribution, WikiLifecyclePins } from '../shared/types.ts';
import { isNotificationEvent, isNotificationInbox } from '../shared/notifications.ts';

const actor = (id: string): ActorAttribution => ({ principalId: id, displayName: id, credentialId: null, requestId: `request-${id}` });
const alice = actor('alice'), bob = actor('bob'), carol = actor('carol');
const epoch = (s: Store) => Number(s.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value);
const rows = (s: Store) => Object.fromEntries((s.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as {name:string}[]).map(({name}) => [name,s.database.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()]));
function fixture() {
  const s = new Store({path:':memory:'}), hidden = new Set<string>(), disabled = new Set<string>();
  createAuth({ database: s.database, mode: 'local', basePath: '/' });
  for (const person of [alice,bob,carol]) s.database.prepare('INSERT INTO auth_accounts(id,username,display_name,disabled,salt,password_hash) VALUES(?,?,?,0,?,?)').run(person.principalId,person.principalId,person.displayName,'not-used','not-used');
  s.notifications.configure({eligible: id => ['alice','bob','carol'].includes(id) && !disabled.has(id), canView: (id, person) => !hidden.has(`${id}:${person}`)});
  const inbox = (person='bob') => s.notifications.list(person,{limit:100},epoch(s));
  const follow = (id:string, person=bob, action:'subscribe'|'unsubscribe'='subscribe', by=person) => s.objectSubscriptions.mutate(id,{action,principalId:person.principalId,expectedSubscriptionVersion:s.objectSubscriptions.status(id,person.principalId).version,expectedAccessEpoch:epoch(s)},by,{principalId:person.principalId,displayName:person.displayName});
  const mute = (id:string,person=bob,action:'mute'|'unmute'='mute') => s.objectSubscriptions.mutate(id,{action,principalId:person.principalId,expectedMuteVersion:s.objectSubscriptions.snapshot(id,person.principalId).mute.version,expectedAccessEpoch:epoch(s)},person,{principalId:person.principalId,displayName:person.displayName});
  const wiki = (path='/') => s.createDocument({title:'Published title',slug:path,content:'Published body\r\n😀'},alice);
  const pins = (id:string):WikiLifecyclePins => {const d=s.documentDetail(id).document,p=d.publication!;return {expectedVersion:d.version,expectedHeadVersionId:p.headVersionId,expectedPublishedVersionId:p.publishedVersionId,expectedPublicationRevision:p.revision,expectedAccessEpoch:epoch(s)};};
  const edit = (id:string, content:string, title='Published title') => s.updateDocument(id,{...pins(id),title,slug:s.documentDetail(id).document.slug,content},alice);
  const move = (id:string,path:string) => {const source=s.documentDetail(id).document,destination=s.documentAtPath(path);return s.moveDocument(id,{destinationPath:path,expectedVersion:source.version,expectedSourceVersionId:source.publication!.headVersionId,expectedPublicationRevision:source.publication!.revision,expectedPublishedVersionId:source.publication!.publishedVersionId,expectedDestinationId:destination?.id??null,expectedDestinationVersion:destination?.version??0,...(destination?{expectedDestinationPublicationRevision:destination.publication!.revision,expectedDestinationPublishedVersionId:destination.publication!.publishedVersionId}:{}),expectedAccessEpoch:epoch(s)},alice);};
  return {s,hidden,disabled,inbox,follow,mute,wiki,pins,edit,move};
}

test('wiki publication effects notify with immutable publication pins; body drafts and no-effect saves stay quiet',()=>{
  const f=fixture(),s=f.s;try{
    const w=f.wiki();assert.equal(s.objectSubscriptions.effective(w.id,'alice'),false,'wiki creator is not automatically followed');assert.equal(f.inbox('alice').items.length,0);f.follow(w.id);
    f.edit(w.id,w.content);assert.equal(f.inbox().items.length,0,'identical authored version preserved without notification');assert.equal(s.documentDetail(w.id).document.version,2);
    f.edit(w.id,'Published update');const updated=f.inbox().items[0]!;assert.equal(updated.event.kind,'wiki_updated');assert.equal(updated.event.context.kind,'wiki');
    const beforeDraft=f.inbox().items.length;s.draftDocument(w.id,{...f.pins(w.id),title:w.title,content:'Secret draft body'},alice);assert.equal(f.inbox().items.length,beforeDraft);
    const titleDraft=s.draftDocument(w.id,{...f.pins(w.id),title:'Secret draft title',content:'Secret draft body'},alice);const alert=f.inbox().items[0]!;
    assert.equal(alert.event.kind,'wiki_title_changed');assert.equal(alert.object.title,w.title);assert.deepEqual(alert.event.context,{kind:'wiki',publicationRevision:titleDraft.document.publication!.revision,headVersionId:titleDraft.document.publication!.headVersionId,headVersion:titleDraft.document.version,publishedVersionId:titleDraft.document.publication!.publishedVersionId,publishedVersion:titleDraft.document.publication!.publishedVersion});
    assert.doesNotMatch(JSON.stringify(alert),/Secret draft|requestId|credentialId/);
    s.draftDocument(w.id,{...f.pins(w.id),title:'Secret draft title',content:'Secret draft body'},alice);assert.equal(f.inbox().items[0]!.event.kind,'wiki_title_changed','title comparison remains published title, not previous draft');
    const head=s.documentDetail(w.id).head!;s.publishDocument(w.id,{...f.pins(w.id),targetVersionId:head.id},alice);assert.equal(f.inbox().items[0]!.event.kind,'wiki_published');
    s.deleteDocument(w.id,f.pins(w.id),alice);assert.equal(f.inbox().items[0]!.event.kind,'wiki_deleted');
    s.restoreDocument(w.id,{...f.pins(w.id),version:1},alice);assert.equal(f.inbox().items[0]!.event.kind,'wiki_restored');
    assert.ok(isNotificationInbox(f.inbox(),'bob'));assert.ok(f.inbox().items.every(item=>isNotificationEvent(item.event)));assert.deepEqual(s.database.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{s.close();}
});

test('normal wiki moves stay silent, subscriptions remain identity-bound, and copied-policy effect targets only reused destination',()=>{
  const f=fixture(),s=f.s;try{
    f.wiki();const a=f.wiki('a'),b=f.wiki('b');f.follow(a.id);f.follow(b.id,bob);s.deleteDocument(b.id,f.pins(b.id),alice);const count=f.inbox().items.length;
    const moved=f.move(a.id,'b');assert.equal(f.inbox().items.length,count);assert.equal(s.objectSubscriptions.effective(moved.source.id,'bob'),true);assert.equal(s.objectSubscriptions.effective(moved.destination.id,'bob'),true);
    s.mutate('policy-move','policy-move',()=>{s.notifyWikiMovePolicy(moved,alice);return {status:200,body:{saved:true}};});
    assert.equal(f.inbox().items.length,count+1);assert.equal(f.inbox().items[0]!.object.id,b.id);assert.equal(f.inbox().items[0]!.event.kind,'wiki_policy_changed');assert.doesNotMatch(JSON.stringify(f.inbox().items[0]),/sourceId|destinationPath/);
    const newMove=f.move(b.id,'c');assert.equal(f.inbox().items.length,count+1);assert.equal(s.objectSubscriptions.effective(newMove.destination.id,'bob'),false);assert.throws(()=>s.notifyWikiMovePolicy(newMove,alice),/evidence/);
    assert.throws(()=>s.notifyWikiMovePolicy({...moved,operationId:'wrong'},alice),/evidence/);
  }finally{s.close();}
});

test('Paste authors follow automatically; grouped historical comments follow humans without overriding explicit optout',()=>{
  const f=fixture(),s=f.s;try{
    const p=s.pastes.create({title:'Paste',content:'Original\r\n😀'},alice);assert.equal(s.objectSubscriptions.effective(p.id,'alice'),true);assert.equal(f.inbox('alice').items.length,0,'actor does not receive own creation');
    assert.throws(()=>f.follow(p.id,alice),/automatically/);s.pastes.update(p.id,{expectedVersion:1,content:'Current'},alice);
    const tx=s.pastes.comment(p.id,{contentVersion:1,body:'About the original'},bob);assert.equal(s.objectSubscriptions.effective(p.id,'bob'),true);
    const comment=f.inbox('alice').items[0]!;assert.equal(comment.event.kind,'paste_commented');assert.deepEqual(comment.event.context,{kind:'paste',pasteVersion:2,contentVersion:1,contentHash:s.pastes.version(p.id,1).sha256});assert.equal(comment.event.cause.id,tx.id);assert.doesNotMatch(JSON.stringify(comment),/About the original|Original|Current/);
    assert.equal(f.inbox('alice').items.length,1,'implicit follow creates no separate alert');assert.equal(f.inbox().items.length,0,'comment actor is excluded');
    f.follow(p.id,bob,'unsubscribe');s.pastes.comment(p.id,{contentVersion:2,body:'Still opted out'},bob);assert.equal(s.objectSubscriptions.effective(p.id,'bob'),false);
    s.pastes.update(p.id,{expectedVersion:2,title:'Changed by editor'},carol);assert.equal(s.objectSubscriptions.effective(p.id,'carol'),false,'ordinary edits do not imply following');
    f.follow(p.id,bob);f.mute(p.id);const n=f.inbox().items.length;s.pastes.update(p.id,{expectedVersion:3,status:'archived'},alice);assert.equal(f.inbox().items.length,n);
    f.mute(p.id,bob,'unmute');s.pastes.update(p.id,{expectedVersion:4,status:'active'},alice);assert.equal(f.inbox().items[0]!.event.kind,'paste_reactivated');const stable=rows(s);s.pastes.update(p.id,{expectedVersion:5,status:'active'},alice);assert.deepEqual(rows(s),stable);
    assert.ok(isNotificationInbox(f.inbox('alice'),'alice'));
  }finally{s.close();}
});

test('explicit other-person changes notify post-change recipients; self follow and private mute are quiet',()=>{
  const f=fixture(),s=f.s;try{
    const w=f.wiki(),p=s.pastes.create({title:'Paste',content:'Source'},alice);
    for(const id of [w.id,p.id]){f.follow(id,bob,'subscribe',alice);assert.equal(f.inbox().items[0]!.event.kind,id.startsWith('W')?'wiki_subscribers_changed':'paste_subscribers_changed');const n=f.inbox().items.length;f.follow(id,carol,'subscribe',alice);assert.equal(f.inbox().items.length,n+1);const carolCount=f.inbox('carol').items.length;f.follow(id,carol,'unsubscribe',alice);assert.equal(f.inbox('carol').items.length,carolCount,'removed follower not included in old-recipient union');const stable=f.inbox().items.length;f.mute(id);f.mute(id,bob,'unmute');f.follow(id,bob,'unsubscribe');f.follow(id);assert.equal(f.inbox().items.length,stable);}
  }finally{s.close();}
});

test('delivery uses final writer-scope policy, current eligibility and mutes; later grants do not invent missed alerts',()=>{
  const f=fixture(),s=f.s;try{
    const w=f.wiki();f.follow(w.id);s.mutate('hide-before-flush','edit',()=>{f.edit(w.id,'Private edit');f.hidden.add(`${w.id}:bob`);return {status:200,body:{saved:true}};});f.hidden.delete(`${w.id}:bob`);assert.equal(f.inbox().items.length,0);
    f.disabled.add('bob');f.edit(w.id,'Disabled recipient');f.disabled.delete('bob');assert.equal(f.inbox().items.length,0);
    f.mute(w.id);f.edit(w.id,'Muted');f.mute(w.id,bob,'unmute');assert.equal(f.inbox().items.length,0);f.edit(w.id,'Visible');assert.equal(f.inbox().items.length,1);
    s.mutate('private-paste-create','create',()=>{const p=s.pastes.create({title:'Private',content:'Body'},alice);f.follow(p.id,bob,'subscribe',alice);f.hidden.add(`${p.id}:bob`);return {status:201,body:{id:p.id}};});f.hidden.clear();assert.equal(f.inbox().items.length,1,'creation and follow both filtered after final policy');
  }finally{s.close();}
});

test('failed Paste comments and wiki writes roll back source, implicit following, events, deliveries and saved responses atomically',()=>{
  const f=fixture(),s=f.s;try{
    const w=f.wiki();f.follow(w.id);const p=s.pastes.create({content:'Body'},alice);
    let before=rows(s);assert.throws(()=>s.mutate('failed-paste','comment',()=>({status:200,body:s.pastes.comment(p.id,{contentVersion:1,body:'New person'},bob)}),undefined,()=>{throw new Error('reject presenter');}),/reject presenter/);assert.deepEqual(rows(s),before);assert.equal(s.objectSubscriptions.effective(p.id,'bob'),false);
    before=rows(s);assert.throws(()=>s.mutate('failed-wiki','edit',()=>({status:200,body:f.edit(w.id,'Rollback text')}),undefined,()=>{throw new Error('reject presenter');}),/reject presenter/);assert.deepEqual(rows(s),before);
    s.database.exec("CREATE TRIGGER reject_inbox BEFORE INSERT ON notification_deliveries BEGIN SELECT RAISE(ABORT,'inbox fail'); END");before=rows(s);assert.throws(()=>f.edit(w.id,'Direct rollback'),/inbox fail/);assert.deepEqual(rows(s),before);assert.throws(()=>s.pastes.comment(p.id,{contentVersion:1,body:'Direct rollback'},bob),/inbox fail/);assert.deepEqual(rows(s),before);
  }finally{s.close();}
});

test('Conduit no-effect edits are quiet and direct effects share exact wiki context',()=>{
  const f=fixture(),s=f.s;try{
    const c=s.createConduitDocument({slug:'/',title:'Legacy title',content:'Body'},alice);f.follow(c.documentId);
    const noop=s.editConduitDocument(c.documentId,{slug:'/',description:'No source change'},alice);assert.equal(noop.transactionId,null);assert.equal(f.inbox().items.length,0);
    const edited=s.editConduitDocument(c.documentId,{slug:'/',content:'New body'},alice);assert.equal(f.inbox().items[0]!.event.kind,'wiki_updated');assert.equal(f.inbox().items[0]!.event.cause.id,edited.transactionId);const context=f.inbox().items[0]!.event.context;assert.ok(context.kind==='wiki');assert.equal(context.publishedVersionId,edited.selectedVersionId);
  }finally{s.close();}
});

for (const mount of ['/', '/mounted/']) test(`wiki move API sends only effective reused-destination policy changes after final authorization at ${mount}`,async()=>{
  const {startWikiApi,members,workspace}=await import('./wiki-api-test-support.ts');const app=await startWikiApi(mount);
  try{
    await app.document('/');const actor:ActorAttribution={principalId:app.alice.id,displayName:app.alice.displayName,credentialId:null,requestId:'move-follow'};
    const follow=async(id:string)=>{const response=await app.request(`/api/objects/${id}/subscriptions`,'POST',{action:'subscribe',principalId:app.bob.id,expectedSubscriptionVersion:0,expectedAccessEpoch:app.policies.epoch()},'bob',`follow-${id}`);assert.equal(response.status,200,JSON.stringify(response.body));};
    const deliveries=(id:string)=>Number(app.store.database.prepare('SELECT count(*) AS n FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE d.principal_id=? AND e.revision_id=?').get(app.bob.id,id)!.n);
    const move=async(id:string,path:string,key:string)=>{const preview=await app.request<import('../shared/wiki.ts').WikiMovePreview>(`/api/documents/${id}/move-preview?${new URLSearchParams({path})}`);assert.equal(preview.status,200,JSON.stringify(preview.body));const response=await app.request<import('../shared/wiki.ts').WikiMoveReceipt>(`/api/documents/${id}/move`,'POST',preview.body.defaultInput,'alice',key);assert.equal(response.status,200,JSON.stringify(response.body));return {input:preview.body.defaultInput,response};};
    for(const kind of ['different','same','hidden'] as const){
      const source=await app.document(`${kind}-source`),destination=await app.document(`${kind}-destination`);
      app.policy(source.id,{view:kind==='hidden'?members(app.alice.id):workspace,edit:members(app.alice.id),interact:workspace});
      app.policy(destination.id,{view:workspace,edit:kind==='different'?workspace:members(app.alice.id),interact:kind==='same'?members(app.alice.id):workspace});
      await follow(destination.id);if(kind!=='hidden')await follow(source.id);await app.operation(destination.id,'delete');
      const before=deliveries(destination.id),sourceBefore=deliveries(source.id),result=await move(source.id,`${kind}-destination/`,`move-${kind}`);
      assert.equal(deliveries(source.id),sourceBefore,'move-away stays silent');
      assert.equal(deliveries(destination.id),before+(kind==='different'?1:0),'view/edit effects only; interaction-only change is quiet and final View filters delivery');
      const replay=await app.request(`/api/documents/${source.id}/move`,'POST',result.input,'alice',`move-${kind}`);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.deepEqual(replay.body,result.response.body);assert.equal(deliveries(destination.id),before+(kind==='different'?1:0));
      if(kind==='different'){const event=app.store.database.prepare("SELECT data FROM notification_events WHERE revision_id=? AND cause_type='wiki_move_policy'").get(destination.id);assert.ok(event);assert.equal((JSON.parse(event.data as string) as {kind:string}).kind,'wiki_policy_changed');}
      if(kind==='hidden'){app.policy(destination.id,{view:workspace});assert.equal(deliveries(destination.id),before,'later access restoration does not create a missed policy alert');}
    }
    const newSource=await app.document('new-source');await follow(newSource.id);const n=deliveries(newSource.id);const moved=await move(newSource.id,'new-destination/','new-destination');assert.equal(deliveries(newSource.id),n);assert.equal(deliveries(moved.response.body.destination.id),0);assert.equal(app.store.objectSubscriptions.effective(moved.response.body.destination.id,app.bob.id),false);
    assert.equal(app.store.database.prepare("SELECT count(*) AS n FROM notification_events WHERE revision_id=?").get(moved.response.body.destination.id)!.n,0,'new move destination is not mistaken for creation');
    assert.equal(app.store.objectSubscriptions.effective(newSource.id,actor.principalId),false);
  }finally{await app.close();}
});
