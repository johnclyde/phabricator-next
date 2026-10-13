import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { parseWikiConduitCreateInput, parseWikiConduitEditInput, wikiConduitInputHash } from './wiki-conduit.ts';
import type { ActorAttribution, WikiLifecyclePins } from '../shared/types.ts';
import type { WikiConduitReceipt } from '../shared/wiki-conduit.ts';

const actor:ActorAttribution={principalId:'alice',displayName:'Alice',credentialId:'credential-a',requestId:'request-a'};
const make=(store:Store,slug='/')=>store.createDocument({slug,title:'Published title',content:'Published source\r\n😀'},actor);
const doc=(store:Store,id:string)=>store.documentDetail(id).document;
const epoch=(store:Store)=>store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;
function pins(store:Store,id:string):WikiLifecyclePins {const current=doc(store,id),p=current.publication!;return {expectedVersion:current.version,expectedHeadVersionId:p.headVersionId,expectedPublishedVersionId:p.publishedVersionId,expectedPublicationRevision:p.revision,expectedAccessEpoch:epoch(store)};}
function snapshot(db:DatabaseSync,except:string[]=[]){
  const schema=db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as {name:string}[];
  return {schema,rows:new Map(names.filter(row=>!except.includes(row.name)).map(row=>[row.name,db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()]))};
}
function assertRows(db:DatabaseSync,previous:ReturnType<typeof snapshot>){for(const [name,rows]of previous.rows)assert.deepEqual(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),rows,name);}
function receiptRoundTrip(store:Store,receipt:WikiConduitReceipt){assert.deepEqual(store.wikiConduitReceipt(receipt.id),receipt);assert.equal(store.wikiConduitContent(receipt.id).id,receipt.selectedVersionId);}

test('Conduit create preserves exact text, attribution and source identities while keeping native validation unchanged',()=>{
  const store=new Store({path:':memory:'});try{
    const input={slug:'/',title:' \t ',content:'\ufeff \r\n😀',description:'0'},receipt=store.createConduitDocument(input,actor,'a'.repeat(64)),version=store.wikiConduitContent(receipt.id);
    assert.equal(version.title,input.title);assert.equal(version.content,input.content);assert.equal(version.message,'0');assert.equal(version.kind,'create');assert.equal(version.number,1);assert.deepEqual(version.attribution,actor);assert.equal(receipt.retryKeySha256,'a'.repeat(64));assert.equal(receipt.inputSha256,wikiConduitInputHash('phriction.create',input));receiptRoundTrip(store,receipt);
    assert.match(store.wikiDocumentIdentity(receipt.documentId).phid,/^PHID-WIKI-[a-f0-9]{20}$/);assert.match(store.wikiContentIdentity(version.id).phid,/^PHID-WRDS-[a-f0-9]{20}$/);
    const zero=store.createConduitDocument({slug:'zero',title:'0',content:'0'},actor);assert.equal(store.wikiConduitContent(zero.id).content,'0');
    assert.throws(()=>store.createDocument({slug:'native-empty-title',title:' ',content:'Body'},actor),/Title/);
    assert.throws(()=>store.createConduitDocument({slug:'/',title:'Other',content:'Body'},actor),/unavailable/);
    assert.throws(()=>store.createConduitDocument({slug:'missing/child',title:'Child',content:'Body'},actor),/parent/);
  }finally{store.close();}
});

test('Conduit input validation is strict, bounded and exact about ignored edit fields',()=>{
  assert.deepEqual(parseWikiConduitCreateInput({slug:'/GUIDE//',title:'0',content:'0',description:null}),{slug:'guide/',title:'0',content:'0',description:''});
  assert.deepEqual(parseWikiConduitEditInput({slug:'/',title:null,content:'0'}),{slug:'/',title:null,content:'0',description:''});
  assert.notEqual(wikiConduitInputHash('phriction.edit',{slug:'/'}),wikiConduitInputHash('phriction.edit',{slug:'/',content:'0'}));
  assert.notEqual(wikiConduitInputHash('phriction.edit',{slug:'/',title:''}),wikiConduitInputHash('phriction.edit',{slug:'/',title:null}));
  for(const parse of [parseWikiConduitCreateInput,parseWikiConduitEditInput])for(const slug of ['',null,3])assert.throws(()=>parse({slug,title:'Title',content:'Body'}));
  for(const [field,value]of [['title','x'.repeat(241)],['content','x'.repeat(500001)],['description','x'.repeat(10001)],['title','\ud800'],['content','\0'],['description',true]]as const)assert.throws(()=>parseWikiConduitCreateInput({slug:'/',title:'Title',content:'Body',[field]:value}));
  assert.throws(()=>parseWikiConduitEditInput({slug:'/',version:1}));
  const store=new Store({path:':memory:'});try{
    const before=snapshot(store.database);
    for(const input of [{slug:'/',title:'',content:'Body'},{slug:'/',title:'Title',content:''}])assert.throws(()=>store.createConduitDocument(input,actor),/must have/);
    assert.throws(()=>store.createConduitDocument({slug:'/',title:'Title',content:'Body'},undefined as unknown as ActorAttribution),/attribution/);
    assert.throws(()=>store.createConduitDocument({slug:'/',title:'Title',content:'Body'},actor,'bad'),/retry/);assertRows(store.database,before);
  }finally{store.close();}
});

test('effective legacy edits publish immediately over drafts without changing native automatic draft behavior',()=>{
  const store=new Store({path:':memory:'});try{
    const page=make(store),original=store.documentVersion(page.id,1);
    store.draftDocument(page.id,{...pins(store,page.id),title:'Unpublished title',content:'Unpublished body'},actor);
    const first=store.editConduitDocument(page.id,{slug:'/',title:'New published title',description:'Title only'},actor),selected=store.wikiConduitContent(first.id);
    assert.equal(selected.number,3);assert.equal(selected.title,'New published title');assert.equal(selected.content,original.content);assert.equal(doc(store,page.id).publication!.publishedVersion,3);assert.equal(selected.kind,'edit');receiptRoundTrip(store,first);
    store.draftDocument(page.id,{...pins(store,page.id),title:'Another draft',content:'Another draft body'},actor);
    const native=store.updateDocument(page.id,{...pins(store,page.id),slug:'/',title:'Native authored draft',content:'Native stays unpublished'},actor);assert.equal(native.version,5);assert.equal(native.publication!.publishedVersion,3);
    const body=store.editConduitDocument(page.id,{slug:'/',content:'Changed legacy body'},actor),published=store.wikiConduitContent(body.id);assert.equal(published.number,6);assert.equal(published.title,'New published title');assert.equal(published.content,'Changed legacy body');assert.equal(doc(store,page.id).publication!.publishedVersion,6);assert.deepEqual(store.documentVersion(page.id,1),original);
  }finally{store.close();}
});

test('description-only, ignored fields and content equal to draft head are immutable receipt-only no-ops',()=>{
  const store=new Store({path:':memory:'});try{
    const page=make(store);store.draftDocument(page.id,{...pins(store,page.id),title:'Draft title',content:'Draft body'},actor);
    for(const input of [{slug:'/',description:'Description alone'},{slug:'/',title:'',content:'0'},{slug:'/',title:null,content:null},{slug:'/',title:page.title,content:'Draft body'}]){
      const before=snapshot(store.database,['wiki_conduit_receipts']),receipt=store.editConduitDocument(page.id,input,{...actor,requestId:randomUUID()},'b'.repeat(64));
      assert.equal(receipt.transactionId,null);assertRows(store.database,before);assert.equal(store.wikiConduitContent(receipt.id).number,1);assert.equal(store.wikiConduitContent(receipt.id).message,'Initial version');assert.equal(receipt.inputSha256,wikiConduitInputHash('phriction.edit',input));receiptRoundTrip(store,receipt);
    }
    assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM wiki_conduit_receipts').get()!.count,4);
    const effective=store.editConduitDocument(page.id,{slug:'/',content:page.content,description:'Revert to published body'},actor);assert.equal(store.wikiConduitContent(effective.id).number,3,'published body differs from head and is an effective content transaction');assert.equal(doc(store,page.id).publication!.publishedVersion,3);
  }finally{store.close();}
});

test('inactive published markers validate before effect filtering and successful effects reactivate',()=>{
  const store=new Store({path:':memory:'});try{
    const page=make(store),initial=store.documentVersion(page.id,1);store.deleteDocument(page.id,pins(store,page.id),actor);
    for(const input of [{slug:'/'},{slug:'/',title:'Different title'},{slug:'/',content:''},{slug:'/',content:'0'}]){const before=snapshot(store.database);assert.throws(()=>store.editConduitDocument(page.id,input,actor),/must have/);assertRows(store.database,before);}
    store.publishDocument(page.id,{...pins(store,page.id),targetVersionId:initial.id},actor);const before=epoch(store),noop=store.editConduitDocument(page.id,{slug:'/',description:'No effect'},actor);assert.equal(noop.snapshot.location.status,'deleted');assert.equal(epoch(store),before);receiptRoundTrip(store,noop);
    const changed=store.editConduitDocument(page.id,{slug:'/',title:'Reactivated'},actor);assert.equal(changed.snapshot.location.status,'active');assert.equal(store.wikiConduitContent(changed.id).content,initial.content);assert.equal(epoch(store),before+1);receiptRoundTrip(store,changed);
  }finally{store.close();}
});

test('legacy body-equal-head filtering preserves the documented blank publication edge',()=>{
  const store=new Store({path:':memory:'});try{
    const page=make(store);store.deleteDocument(page.id,pins(store,page.id),actor);store.draftDocument(page.id,{...pins(store,page.id),title:page.title,content:'Nonempty draft'},actor);
    const noop=store.editConduitDocument(page.id,{slug:'/',content:'Nonempty draft'},actor);assert.equal(noop.transactionId,null);assert.equal(noop.snapshot.location.status,'deleted');assert.equal(store.wikiConduitContent(noop.id).content,'');
    const changed=store.editConduitDocument(page.id,{slug:'/',title:'Legacy title',content:'Nonempty draft'},actor);assert.equal(changed.snapshot.location.status,'active');assert.equal(changed.snapshot.publication.headVersion,4);assert.equal(changed.snapshot.publication.publishedVersion,4);assert.equal(store.wikiConduitContent(changed.id).content,'');receiptRoundTrip(store,changed);
    assert.throws(()=>store.updateDocument(page.id,{...pins(store,page.id),slug:'/',title:'Native title',content:''},actor),/must have content/);
  }finally{store.close();}
});

test('legacy effects clear a moved marker without moving descendants or changing destination content',()=>{
  const store=new Store({path:':memory:'});try{
    make(store);const source=make(store,'source'),child=make(store,'source/child'),original=store.documentVersion(source.id,1);
    const {expectedHeadVersionId,...movePins}=pins(store,source.id);
    const moved=store.moveDocument(source.id,{...movePins,expectedSourceVersionId:expectedHeadVersionId,expectedDestinationId:null,expectedDestinationVersion:0,destinationPath:'destination/'},actor),destination=doc(store,moved.destination.id);
    assert.throws(()=>store.editConduitDocument(source.id,{slug:'source/',title:'Retitled marker'},actor),/must have/);
    store.publishDocument(source.id,{...pins(store,source.id),targetVersionId:original.id},actor);
    const noop=store.editConduitDocument(source.id,{slug:'source/'},actor);assert.equal(noop.snapshot.location.status,'moved');assert.equal(noop.snapshot.location.movedToId,destination.id);receiptRoundTrip(store,noop);
    const before=epoch(store),changed=store.editConduitDocument(source.id,{slug:'source/',content:'Restored source'},actor);assert.equal(changed.snapshot.location.status,'active');assert.equal(changed.snapshot.location.movedToId,null);assert.equal(epoch(store),before+1);receiptRoundTrip(store,changed);
    assert.deepEqual(doc(store,destination.id),destination);assert.equal(doc(store,child.id).location!.path,'source/child/');
  }finally{store.close();}
});

test('changed and no-op receipts retain exact publication and retry identities after subsequent edits and restart',()=>{
  const directory=mkdtempSync(join(tmpdir(),'wiki-conduit-receipt-')),path=join(directory,'db.sqlite');let store=new Store({path});try{
    const created=store.createConduitDocument({slug:'/',title:'First',content:'Body'},actor,'1'.repeat(64)),noopInput={slug:'/',description:'No effect'},noop=store.editConduitDocument(created.documentId,noopInput,actor,'2'.repeat(64));
    const edited=store.editConduitDocument(created.documentId,{slug:'/',title:'Later',content:'Later body'},actor,'3'.repeat(64)),laterNoop=store.editConduitDocument(created.documentId,noopInput,actor,'4'.repeat(64));
    assert.equal(noop.inputSha256,laterNoop.inputSha256);assert.notEqual(noop.retryKeySha256,laterNoop.retryKeySha256);assert.notEqual(noop.selectedVersionId,laterNoop.selectedVersionId);
    store.close();store=new Store({path});for(const receipt of [created,noop,edited,laterNoop])receiptRoundTrip(store,receipt);
    assert.equal(store.wikiConduitContent(noop.id).title,'First');assert.equal(store.wikiConduitContent(edited.id).title,'Later');
    for(const action of ['UPDATE wiki_conduit_receipts SET data=data','DELETE FROM wiki_conduit_receipts'])assert.throws(()=>store.database.exec(action),/immutable/);
    const insert=store.database.prepare('INSERT INTO wiki_conduit_receipts VALUES(?,?,?,?)');
    for(const change of [{selectedVersionId:edited.selectedVersionId},{snapshot:edited.snapshot},{transactionId:edited.transactionId},{inputSha256:'0'.repeat(64)},{attribution:{...actor,principalId:'bob'}}]){
      const forged={...created,...change,id:randomUUID()};insert.run(forged.id,forged.documentId,forged.selectedVersionId,JSON.stringify(forged));assert.throws(()=>store.wikiConduitReceipt(forged.id),/does not match/);
    }
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('receipt insertion failures roll back all content, publication, identity, activity and sequence writes',()=>{
  const store=new Store({path:':memory:'});try{
    const root=make(store);store.database.exec("CREATE TRIGGER fail_conduit_receipt BEFORE INSERT ON wiki_conduit_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END;");const before=snapshot(store.database);
    for(const write of [()=>store.createConduitDocument({slug:'child',title:'Child',content:'Body'},actor),()=>store.editConduitDocument(root.id,{slug:'/',content:'Changed'},actor),()=>store.editConduitDocument(root.id,{slug:'/'},actor)]){assert.throws(write,/receipt failure/);assertRows(store.database,before);}
  }finally{store.close();}
});

function schema22(path:string){const store=new Store({path});const page=make(store);store.draftDocument(page.id,{...pins(store,page.id),title:'Earlier draft',content:'Unpublished exact\r\n😀'},actor);store.database.exec("DROP TABLE wiki_conduit_receipts; CREATE VIEW legacy_conduit_versions AS SELECT id,data FROM wiki_versions; ALTER TABLE wiki_versions ADD COLUMN operator_note TEXT; PRAGMA user_version=22;");return store;}
test('schema23 preserves every schema22 row and schema object and starts with an empty receipt ledger',()=>{
  const directory=mkdtempSync(join(tmpdir(),'wiki-conduit-migration-')),path=join(directory,'db.sqlite');let store=schema22(path);const before=snapshot(store.database);store.close();try{
    store=new Store({path});assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version,38);assertRows(store.database,before);for(const schema of before.schema)assert.equal(store.database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(schema.name)!.sql,schema.sql,String(schema.name));assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM wiki_conduit_receipts').get()!.count,0);assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(),[]);
    const receipt=store.editConduitDocument('W1',{slug:'/',content:'Published legacy edit'},actor);receiptRoundTrip(store,receipt);store.close();store=new Store({path});receiptRoundTrip(store,receipt);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('failed schema23 migration leaves schema22 exactly intact and retryable',()=>{
  const directory=mkdtempSync(join(tmpdir(),'wiki-conduit-migration-failure-')),path=join(directory,'db.sqlite'),original=schema22(path),before=snapshot(original.database);original.close();const exec=DatabaseSync.prototype.exec;
  try{
    DatabaseSync.prototype.exec=function(sql:string){if(sql==='PRAGMA user_version = 23')throw new Error('injected schema23 failure');return exec.call(this,sql);};assert.throws(()=>new Store({path}),/injected schema23 failure/);
  }finally{DatabaseSync.prototype.exec=exec;}
  const db=new DatabaseSync(path);try{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,22);assert.deepEqual(snapshot(db),before);}finally{db.close();}
  const reopened=new Store({path});try{assert.equal(reopened.database.prepare('PRAGMA user_version').get()!.user_version,38);}finally{reopened.close();rmSync(directory,{recursive:true,force:true});}
});
