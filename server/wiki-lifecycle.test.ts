import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, wikiLifecycleInputHash } from './store.ts';
import type { ActorAttribution, WikiDocument, WikiLifecyclePins } from '../shared/types.ts';
const actor:ActorAttribution={principalId:'alice',displayName:'Alice',credentialId:null,requestId:'lifecycle-test'};
const make=(store:Store,path='/')=>store.createDocument({title:'Published title',slug:path,content:'Published source\r\n😀'},actor);
const epoch=(store:Store)=>store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;
const current=(store:Store,id:string)=>store.documentDetail(id).document;
function pins(store:Store,id:string):WikiLifecyclePins{const doc=current(store,id),pub=doc.publication!;return {expectedVersion:doc.version,expectedHeadVersionId:pub.headVersionId,expectedPublishedVersionId:pub.publishedVersionId,expectedPublicationRevision:pub.revision,expectedAccessEpoch:epoch(store)};}
const rows=(store:Store)=>['entities','wiki_locations','wiki_versions','wiki_publication','wiki_transactions','activity','sequences','object_policies','policy_meta'].map(table=>store.database.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());

test('draft advances immutable head while preserving the published page; subsequent ordinary edits stay drafts',()=>{
 const store=new Store({path:':memory:'});try{
  const doc=make(store),first=store.documentVersion(doc.id,1),input={...pins(store,doc.id),title:'Draft title',content:'Draft source\r\n😀',message:'Keep unpublished'};
  const receipt=store.draftDocument(doc.id,input,actor);assert.equal(receipt.document.title,doc.title);assert.equal(receipt.document.content,doc.content);assert.equal(receipt.document.version,2);assert.equal(receipt.document.publication?.publishedVersion,1);assert.equal(receipt.transaction.kind,'draft');assert.equal(receipt.transaction.inputSha256,wikiLifecycleInputHash('draft',input));
  assert.equal(store.documentDetail(doc.id).head?.content,input.content);assert.deepEqual(store.documentVersion(doc.id,1),first);
  assert.throws(()=>store.updateDocument(doc.id,{title:'Unpinned',slug:'/',content:'Should fail',expectedVersion:2}),/Expected head/);
  const edit={...pins(store,doc.id),title:'Another draft',slug:'/',content:'Next draft',message:'Continue'};const next=store.updateDocument(doc.id,edit,actor);
  assert.equal(next.version,3);assert.equal(next.content,doc.content);assert.equal(store.documentVersion(doc.id,3).kind,'draft');assert.equal(store.documentTransaction(doc.id,next.publication!.revision).inputSha256,wikiLifecycleInputHash('edit',edit));
  assert.deepEqual(store.wikiLifecycleReceipt(doc.id,receipt.transaction.id),receipt,'receipt retains original publication even after later draft');
 }finally{store.close();}
});

test('publishing older or newer exact content only changes publication state and never fabricates content history',()=>{
 const store=new Store({path:':memory:'});try{
  const doc=make(store);store.draftDocument(doc.id,{...pins(store,doc.id),title:'Draft title',content:'Draft source'},actor);
  const before=store.database.prepare('SELECT * FROM wiki_versions ORDER BY rowid').all(),draft=store.documentVersion(doc.id,2),original=store.documentVersion(doc.id,1);
  const published=store.publishDocument(doc.id,{...pins(store,doc.id),targetVersionId:draft.id},actor);assert.equal(published.document.content,draft.content);assert.equal(published.document.version,2);assert.equal(published.document.publication?.revision,3);assert.equal(published.transaction.newVersionId,null);
  assert.deepEqual(store.database.prepare('SELECT * FROM wiki_versions ORDER BY rowid').all(),before);
  assert.throws(()=>store.updateDocument(doc.id,{title:'Stale version-only client',slug:'/',content:'Bad',expectedVersion:2}),/Expected head/);
  const older=store.publishDocument(doc.id,{...pins(store,doc.id),targetVersionId:original.id},actor);assert.equal(older.document.version,2);assert.equal(older.document.content,original.content);assert.equal(older.document.publication?.publishedVersion,1);assert.equal(older.document.publication?.revision,4);
  assert.deepEqual(store.database.prepare('SELECT * FROM wiki_versions ORDER BY rowid').all(),before);const saved=rows(store);assert.throws(()=>store.publishDocument(doc.id,{...pins(store,doc.id),targetVersionId:original.id},actor),/already published/);assert.deepEqual(rows(store),saved);
  assert.deepEqual(store.wikiLifecycleReceipt(doc.id,published.transaction.id),published);
  const history=store.documentTransactions(doc.id,{limit:2});assert.deepEqual(history.transactions.map(tx=>tx.kind),['publish','publish']);assert.equal(history.nextBefore,3);assert.deepEqual(store.documentTransactions(doc.id,{before:history.nextBefore!,limit:2}).transactions.map(tx=>tx.kind),['draft','create']);
 }finally{store.close();}
});

test('delete creates a blank tombstone; publishing old content retains deleted status; restore appends and reactivates',()=>{
 const store=new Store({path:':memory:'});try{
  const doc=make(store);store.draftDocument(doc.id,{...pins(store,doc.id),title:'Unpublished new title',content:'Unpublished body'},actor);
  const removed=store.deleteDocument(doc.id,{...pins(store,doc.id),message:'Retire page'},actor);assert.equal(removed.document.title,doc.title);assert.equal(removed.document.content,'');assert.equal(removed.document.version,3);assert.equal(removed.document.location?.status,'deleted');assert.equal(store.documentVersion(doc.id,3).kind,'delete');
  const original=store.documentVersion(doc.id,1);const published=store.publishDocument(doc.id,{...pins(store,doc.id),targetVersionId:original.id},actor);assert.equal(published.document.location?.status,'deleted');assert.equal(published.document.content,original.content);assert.equal(published.document.version,3);
  assert.throws(()=>store.deleteDocument(doc.id,pins(store,doc.id),actor),/active document/);
  assert.throws(()=>store.restoreDocument(doc.id,{...pins(store,doc.id),version:3},actor),/must have content/);
  const restored=store.restoreDocument(doc.id,{...pins(store,doc.id),version:2,message:'Recover draft'},actor);assert.equal(restored.version,4);assert.equal(restored.content,'Unpublished body');assert.equal(restored.location?.status,'active');assert.equal(restored.publication?.publishedVersion,4);assert.equal(store.documentVersion(doc.id,4).restoredFrom,2);
  assert.deepEqual(store.wikiLifecycleReceipt(doc.id,removed.transaction.id),removed);
 }finally{store.close();}
});

test('moves copy published content and preserve draft history; publication changes invalidate source and destination pins',()=>{
 const store=new Store({path:':memory:'});try{
  make(store);const a=make(store,'a');store.draftDocument(a.id,{...pins(store,a.id),title:'Draft only',content:'Never implicitly publish'},actor);
  const head=current(store,a.id),base={destinationPath:'b',expectedVersion:head.version,expectedSourceVersionId:head.publication!.headVersionId,expectedDestinationId:null,expectedDestinationVersion:0,expectedAccessEpoch:epoch(store)};
  assert.throws(()=>store.moveDocument(a.id,base,actor),/Expected published/);
  const move=store.moveDocument(a.id,{...base,expectedPublicationRevision:head.publication!.revision,expectedPublishedVersionId:head.publication!.publishedVersionId},actor);
  assert.equal(move.destination.content,a.content);assert.equal(move.destination.title,a.title);assert.equal(store.documentVersion(a.id,2).content,'Never implicitly publish');assert.equal(move.source.publication?.publishedVersion,3);assert.deepEqual(store.wikiMoveReceipt(a.id,move.sourceVersionId,move.destinationVersionId),move);
  store.publishDocument(a.id,{...pins(store,a.id),targetVersionId:store.documentVersion(a.id,1).id},actor);assert.equal(current(store,a.id).location?.status,'moved');
  const b=current(store,move.destination.id),dest=current(store,a.id);const stale={destinationPath:'a',expectedVersion:b.version,expectedSourceVersionId:b.publication!.headVersionId,expectedDestinationId:a.id,expectedDestinationVersion:dest.version,expectedAccessEpoch:epoch(store)};
  assert.throws(()=>store.moveDocument(b.id,stale,actor),/destination publication/);
  const reused=store.moveDocument(b.id,{...stale,expectedDestinationPublicationRevision:dest.publication!.revision,expectedDestinationPublishedVersionId:dest.publication!.publishedVersionId},actor);assert.equal(reused.destination.id,a.id);assert.equal(reused.destination.location?.status,'active');
 }finally{store.close();}
});

test('draft title changes reactivate inactive documents, while every explicit draft keeps its publication pointer',()=>{
 const store=new Store({path:':memory:'});try{
  const doc=make(store);store.deleteDocument(doc.id,pins(store,doc.id),actor);const tombstone=current(store,doc.id).publication!.publishedVersionId;
  const same=store.draftDocument(doc.id,{...pins(store,doc.id),title:doc.title,content:'Draft recovery'},actor);assert.equal(same.document.location?.status,'deleted');assert.equal(same.document.publication?.publishedVersionId,tombstone);
  const beforeEpoch=epoch(store),changed=store.draftDocument(doc.id,{...pins(store,doc.id),title:'Recovered draft title',content:'Draft recovery'},actor);assert.equal(changed.document.location?.status,'active');assert.equal(changed.document.location?.movedToId,null);assert.ok(epoch(store)>beforeEpoch);assert.equal(changed.document.publication?.publishedVersionId,tombstone);assert.equal(changed.document.content,'');
  const unchanged=store.draftDocument(doc.id,{...pins(store,doc.id),title:'Recovered draft title',content:'Draft recovery'},actor);assert.equal(unchanged.document.version,changed.document.version+1);assert.equal(unchanged.document.publication?.publishedVersionId,tombstone,'identical explicit draft never silently publishes');
 }finally{store.close();}
});

test('exact lifecycle pins, foreign versions, empty source and partial failures never commit',()=>{
 const store=new Store({path:':memory:'});try{
  assert.throws(()=>store.createDocument({title:'Empty',slug:'/',content:''}),/must have content/);const doc=make(store),other=make(store,'other');
  const input={...pins(store,doc.id),title:'Draft',content:'Content'};
  for(const bad of [{...input,expectedVersion:99},{...input,expectedHeadVersionId:'wrong'},{...input,expectedPublishedVersionId:'wrong'},{...input,expectedPublicationRevision:99},{...input,expectedAccessEpoch:epoch(store)+1},{...input,content:''}]){const before=rows(store);assert.throws(()=>store.draftDocument(doc.id,bad,actor));assert.deepEqual(rows(store),before);}
  assert.throws(()=>store.publishDocument(doc.id,{...pins(store,doc.id),targetVersionId:store.documentVersion(other.id,1).id},actor),/unavailable/);
  store.database.exec("CREATE TRIGGER reject_lifecycle_event BEFORE INSERT ON activity WHEN json_extract(NEW.data,'$.action')='draft_saved' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  const before=rows(store);assert.throws(()=>store.draftDocument(doc.id,input,actor),/injected failure/);assert.deepEqual(rows(store),before);store.database.exec('DROP TRIGGER reject_lifecycle_event');
  const receipt=store.draftDocument(doc.id,{...input,content:' \r\n '},actor);assert.equal(store.documentDetail(doc.id).head?.content,' \r\n ');assert.notEqual(wikiLifecycleInputHash('draft',input),wikiLifecycleInputHash('draft',{...input,content:'Different'}));
  assert.throws(()=>store.database.exec('UPDATE wiki_transactions SET data=data'),/immutable/);assert.throws(()=>store.database.exec('DELETE FROM wiki_transactions'),/immutable/);assert.equal(receipt.transaction.sequence,2);
 }finally{store.close();}
});

function schema20(path:string){const store=new Store({path});make(store);store.database.exec("DROP TABLE wiki_conduit_receipts; DROP TABLE wiki_content_identifiers; DROP TABLE wiki_document_identifiers; DROP TABLE wiki_transactions; DROP TABLE wiki_publication; CREATE VIEW legacy_wiki AS SELECT id,data FROM wiki_versions; ALTER TABLE wiki_versions ADD COLUMN operator_note TEXT; PRAGMA user_version=20;");return store;}
function oldSnapshot(db:DatabaseSync){const schema=db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];const tables=(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(row=>row.name);return {schema,rows:new Map(tables.map(name=>[name,db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()]))};}

test('schema21 preserves all schema20 bytes and boundaries, seeds one honest baseline, and survives restart',()=>{
 const directory=mkdtempSync(join(tmpdir(),'wiki-schema21-')),path=join(directory,'workspace.sqlite');let store=schema20(path);const before=oldSnapshot(store.database);store.close();
 try{store=new Store({path});assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version,39);for(const schema of before.schema)assert.equal(store.database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(schema.name)!.sql,schema.sql,schema.name);for(const [name,rows]of before.rows)assert.deepEqual(store.database.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all(),rows,name);
  const baseline=store.documentTransactions('W1').transactions[0]!;assert.equal(baseline.kind,'legacy');assert.equal(baseline.newVersionId,null);assert.equal(baseline.inputSha256,null);assert.equal(baseline.actor,null);assert.equal(baseline.before,null);assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(),[]);
  const input={...pins(store,'W1'),title:'New draft',content:'New body'};const receipt=store.draftDocument('W1',input,actor);store.close();store=new Store({path});assert.deepEqual(store.wikiLifecycleReceipt('W1',receipt.transaction.id),receipt);assert.equal(store.documentDetail('W1').head?.content,'New body');
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('schema21 failure rolls back new sidecars and leaves schema20 evidence untouched',()=>{
 const directory=mkdtempSync(join(tmpdir(),'wiki-schema21-failure-')),path=join(directory,'workspace.sqlite');const first=schema20(path),before=oldSnapshot(first.database);first.close();const exec=DatabaseSync.prototype.exec;
 try{DatabaseSync.prototype.exec=function(sql:string){if(sql==='PRAGMA user_version = 21')throw new Error('injected schema21 failure');return exec.call(this,sql);};assert.throws(()=>new Store({path}),/injected schema21/);}finally{DatabaseSync.prototype.exec=exec;}
 try{const db=new DatabaseSync(path);try{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,20);assert.deepEqual(oldSnapshot(db),before);}finally{db.close();}const recovered=new Store({path});assert.equal(recovered.documentPublication('W1').publishedVersion,1);recovered.close();}finally{rmSync(directory,{recursive:true,force:true});}
});
