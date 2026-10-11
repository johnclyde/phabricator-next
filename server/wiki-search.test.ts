import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { PolicyStore } from './policy.ts';
import { parseWikiDocumentSearchQuery, parseWikiContentSearchQuery } from './wiki-search.ts';
import { WIKI_SEARCH_MAX_SCAN, WIKI_SEARCH_MAX_SOURCE_BYTES, type WikiDocumentSearchQuery, type WikiContentSearchQuery } from '../shared/wiki-search.ts';
import type { ActorAttribution, WikiLifecyclePins } from '../shared/types.ts';
const actor:ActorAttribution={principalId:'alice',displayName:'Alice',credentialId:null,requestId:'search-test'};
const visible=()=>true;
const make=(store:Store,slug:string,title=slug,content=`Published ${slug}`)=>store.createDocument({slug,title,content},actor);
const documents=(store:Store,query:WikiDocumentSearchQuery={},view:(id:string)=>boolean=visible,principal='alice')=>store.searchWikiDocuments(query,view,principal);
const contents=(store:Store,query:WikiContentSearchQuery={},view:(id:string)=>boolean=visible,principal='alice')=>store.searchWikiContent(query,view,principal);
function pins(store:Store,id:string):WikiLifecyclePins {const doc=store.documentDetail(id).document,p=doc.publication!;return {expectedVersion:doc.version,expectedHeadVersionId:p.headVersionId,expectedPublishedVersionId:p.publishedVersionId,expectedPublicationRevision:p.revision,expectedAccessEpoch:store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number};}
const names=(page:ReturnType<typeof documents>)=>page.documents.map(row=>row.path);

test('document discovery uses exact published title, body, author, date and version, while content search includes drafts',()=>{
 const store=new Store({path:':memory:'});try{
  const doc=make(store,'/','Published heading','Published body exact\r\n😀');const original=store.documentVersion(doc.id,1),identity=store.wikiDocumentIdentity(doc.id);
  const draft=store.draftDocument(doc.id,{...pins(store,doc.id),title:'Unpublished needle',content:'Secret draft needle'},actor);
  assert.deepEqual(documents(store,{query:'needle'}).documents,[]);
  const result=documents(store,{query:'PUBLISHED',includeContent:true}).documents[0]!;assert.equal(result.title,original.title);assert.equal(result.version,2);assert.equal(result.published.version,1);assert.equal(result.published.versionId,original.id);assert.equal(result.published.content,original.content);assert.equal(result.published.createdAt,original.createdAt);assert.equal(result.published.authorId,actor.principalId);assert.equal(result.phid,identity.phid);assert.doesNotMatch(JSON.stringify(result),/Unpublished|Secret draft/);
  const historical=contents(store,{documentPHIDs:[identity.phid],query:'needle',includeContent:true}).contents;assert.equal(historical.length,1);assert.equal(historical[0]!.versionId,draft.document.publication!.headVersionId);assert.equal(historical[0]!.content,'Secret draft needle');assert.match(historical[0]!.phid,/^PHID-WRDS-[a-f0-9]{20}$/);
  store.publishDocument(doc.id,{...pins(store,doc.id),targetVersionId:draft.document.publication!.headVersionId},actor);assert.equal(documents(store,{query:'needle'}).documents[0]!.published.version,2);
  store.publishDocument(doc.id,{...pins(store,doc.id),targetVersionId:original.id},actor);assert.deepEqual(documents(store,{query:'needle'}).documents,[]);assert.equal(documents(store).documents[0]!.published.createdAt,original.createdAt);
 }finally{store.close();}
});

test('active/all, explicit statuses and canonical path relations match Phriction union/intersection semantics',()=>{
 const store=new Store({path:':memory:'});try{
  make(store,'/');make(store,'a');make(store,'a/direct');make(store,'a/direct/deep');make(store,'b');const deleted=make(store,'b/deleted'),stub=make(store,'b/stub');
  store.deleteDocument(deleted.id,pins(store,deleted.id),actor);store.database.prepare("UPDATE wiki_locations SET status='stub' WHERE document_id=?").run(stub.id);
  assert.ok(!names(documents(store)).some(path=>path==='b/deleted/'||path==='b/stub/'));assert.equal(documents(store,{queryKey:'all'}).documents.length,7);
  assert.deepEqual(names(documents(store,{statuses:['deleted','stub']})),['b/stub/','b/deleted/']);assert.equal(documents(store,{statuses:[]}).documents.length,7,'explicit empty status list clears the active builtin constraint');
  assert.deepEqual(names(documents(store,{paths:['/A//DIRECT/']})),['a/direct/']);assert.deepEqual(names(documents(store,{parentPaths:['a/']})),['a/direct/']);assert.deepEqual(names(documents(store,{ancestorPaths:['a/']})),['a/direct/deep/','a/direct/']);
  assert.deepEqual(names(documents(store,{queryKey:'all',parentPaths:['b/'],ancestorPaths:['a/']})),['b/stub/','b/deleted/','a/direct/deep/','a/direct/']);assert.deepEqual(names(documents(store,{paths:['a/direct/deep/'],parentPaths:['b/'],ancestorPaths:['a/']})),['a/direct/deep/']);
  assert.deepEqual(names(documents(store,{parentPaths:['/']})),['b/','a/']);assert.ok(!names(documents(store,{ancestorPaths:['/']})).includes('/'));
 }finally{store.close();}
});

test('newest and oldest pages traverse both directions without duplicate results and bind cursors to exact authority and query',()=>{
 const store=new Store({path:':memory:'});try{
  make(store,'/');for(const path of ['a','b','c','d'])make(store,path);
  for(const order of ['newest','oldest'] as const){
   const first=documents(store,{order,limit:2});assert.equal(first.nextBefore,null);assert.ok(first.nextAfter);assert.match(first.nextAfter!,/^[A-Za-z0-9_-]{70}$/);
   const second=documents(store,{order,limit:2,after:first.nextAfter!});assert.ok(second.nextBefore);assert.deepEqual(names(documents(store,{order,limit:2,before:second.nextBefore!})),names(first));
   const final=documents(store,{order,limit:2,after:second.nextAfter!});assert.equal(final.nextAfter,null);assert.equal(new Set([...first.documents,...second.documents,...final.documents].map(row=>row.id)).size,5);
   assert.throws(()=>documents(store,{order,limit:2,after:first.nextAfter!},visible,'bob'),/cursor/);
   for(const query of [{order:order==='newest'?'oldest':'newest',after:first.nextAfter!},{queryKey:'all',after:first.nextAfter!},{query:'other',after:first.nextAfter!},{includeContent:true,after:first.nextAfter!},{before:first.nextAfter!}])assert.throws(()=>documents(store,query as WikiDocumentSearchQuery),/cursor/);
   const token=first.nextAfter!;assert.throws(()=>documents(store,{order,after:(token[0]==='A'?'B':'A')+token.slice(1)}),/cursor/);
  }
  const cursor=documents(store,{limit:1}).nextAfter!;store.database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();assert.throws(()=>documents(store,{limit:1,after:cursor}),/Access changed/);
 }finally{store.close();}
});

test('content numeric IDs are globally distinct from per-document versions, and high-watermark cursors omit later drafts',()=>{
 const store=new Store({path:':memory:'});try{
  const root=make(store,'/'),other=make(store,'other');const rootIdentity=store.wikiContentIdentity(store.documentVersion(root.id,1).id),otherIdentity=store.wikiContentIdentity(store.documentVersion(other.id,1).id);
  assert.notEqual(rootIdentity.id,otherIdentity.id);assert.equal(store.documentVersion(root.id,1).number,store.documentVersion(other.id,1).number);
  assert.deepEqual(store.resolveWikiContentIdentity(rootIdentity.id),rootIdentity);assert.deepEqual(store.resolveWikiContentIdentity(rootIdentity.phid),rootIdentity);assert.deepEqual(store.resolveWikiDocumentIdentity(store.wikiDocumentIdentity(other.id).phid),store.wikiDocumentIdentity(other.id));assert.equal(store.resolveWikiDocumentIdentity(99999),null);
  const first=contents(store,{order:'oldest',limit:1});store.draftDocument(other.id,{...pins(store,other.id),title:'Later draft',content:'Later source'},actor);
  const last=contents(store,{order:'oldest',limit:1,after:first.nextAfter!});assert.equal(last.contents[0]!.id,otherIdentity.id);assert.equal(last.nextAfter,null);assert.equal(contents(store).contents.length,3);
  assert.deepEqual(contents(store,{ids:[rootIdentity.id],phids:[rootIdentity.phid],versions:[1]}).contents.map(row=>row.id),[rootIdentity.id]);assert.equal(contents(store,{versions:[99]}).contents.length,0);
 }finally{store.close();}
});

test('actual candidate work is capped before filtering and hidden source is never loaded, even when a page has no visible matches',()=>{
 const store=new Store({path:':memory:'});try{
  make(store,'/');const target=make(store,'visible-target');for(let i=0;i<1002;i++)make(store,`hidden-${i}`);
  const original=store.database.prepare.bind(store.database),reads:string[]=[];
  store.database.prepare=((sql:string)=>{const statement=original(sql);if(sql==='SELECT data FROM wiki_versions WHERE id=?')return new Proxy(statement,{get(object,key){if(key==='get')return (...args:Parameters<typeof statement.get>)=>{reads.push(String(args[0]));return object.get(...args);};const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});return statement;}) as typeof store.database.prepare;
  let calls=0;const canView=(id:string)=>{calls++;return id===target.id;};const first=documents(store,{},canView);assert.equal(calls,WIKI_SEARCH_MAX_SCAN);assert.deepEqual(reads,[]);assert.equal(first.documents.length,0);assert.ok(first.nextAfter);assert.doesNotMatch(first.nextAfter!,/hidden/);
  const next=documents(store,{after:first.nextAfter!},canView);assert.deepEqual(next.documents.map(row=>row.id),[target.id]);assert.equal(reads.length,1);assert.equal(next.nextAfter,null);
  const absent=documents(store,{paths:['does-not-exist/']});assert.deepEqual(absent.documents,[]);assert.ok(absent.nextAfter,'metadata filters do not silently perform an unbounded scan');
 }finally{store.close();}
});

test('visible source byte budget continues before an unconsumed candidate and snippets stay bounded',()=>{
 const store=new Store({path:':memory:'});try{
  make(store,'/');for(let i=0;i<7;i++)make(store,`large-${i}`,`Large ${i}`,'\u0001'.repeat(499_000));
  const first=documents(store,{includeContent:true,limit:100}),seen=new Set(first.documents.map(row=>row.id));assert.ok(first.nextAfter);assert.ok(first.documents.length<7);
  const bytes=first.documents.reduce((sum,row)=>sum+(store.database.prepare('SELECT byte_size FROM wiki_content_identifiers WHERE id=?').get(row.published.id)!.byte_size as number),0);assert.ok(bytes<=WIKI_SEARCH_MAX_SOURCE_BYTES);
  const second=documents(store,{includeContent:true,limit:100,after:first.nextAfter!});for(const row of second.documents){assert.ok(!seen.has(row.id));seen.add(row.id);}assert.equal(seen.size,8);assert.equal(second.nextAfter,null);assert.ok([...first.documents,...second.documents].every(row=>row.published.snippet.length<=242));
 }finally{store.close();}
});

test('real policy checks do not materialize denied wiki entity bodies outside the source budget',()=>{
 const store=new Store({path:':memory:'});try{
  const policies=new PolicyStore(store.database,{principalExists:id=>['alice','bob'].includes(id)});
  const root=make(store,'/'),sentinel='UNREAD_WIKI_SENTINEL_',secret=sentinel+'x'.repeat(300_000);
  const hidden=make(store,'hidden','Hidden document',secret),parent=make(store,'private','Private ancestor',secret);
  make(store,'private/child','Private descendant',secret);
  for(const id of [hidden.id,parent.id]){const current=policies.policy(id,'alice');policies.setPolicy(id,{expectedVersion:current.version,spaceId:current.spaceId,...current.rules,view:{kind:'principals',principalIds:['alice']}},'alice');}
  const prepare=store.database.prepare.bind(store.database),sourceReads:string[]=[];let policyReads=0;
  store.database.prepare=((sql:string)=>{
   const statement=prepare(sql);return new Proxy(statement,{get(object,key){
    if(key==='get'||key==='all')return (...args:Parameters<typeof statement.get>)=>{
     const result=key==='get'?object.get(...args):object.all(...args);
     if(sql.includes('AS entity_kind'))policyReads++;
     if(JSON.stringify(result)?.includes(sentinel))sourceReads.push(sql);
     return result;
    };
    const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;
   }});
  }) as typeof store.database.prepare;
  const canView=(id:string)=>policies.access(id,'bob').view;
  assert.deepEqual(documents(store,{includeContent:true},canView,'bob').documents.map(row=>row.id),[root.id]);
  assert.deepEqual(contents(store,{includeContent:true},canView,'bob').contents.map(row=>row.documentId),[root.id]);
  assert.ok(policyReads>=8,'the real permission resolver was exercised for each candidate');
  assert.deepEqual(sourceReads,[],'no denied source may cross the SQLite/JS boundary, including entity metadata reads');
 }finally{store.close();}
});

test('query validation rejects unsupported ordering, malformed IDs/cursors, oversized constraints and unknown fields',()=>{
 for(const input of [{order:'hierarchy'},{after:'a',before:'b'},{limit:101},{ids:[0]},{phids:['W1']},{statuses:['exists']},{paths:Array(101).fill('/')},{query:'x'.repeat(1001)},{query:'\ud800'},{surprise:true},{includeContent:'true'}])assert.throws(()=>parseWikiDocumentSearchQuery(input));
 assert.throws(()=>parseWikiContentSearchQuery({documentPHIDs:['PHID-WRDS-aaaaaaaaaaaaaaaaaaaa']}));assert.throws(()=>parseWikiContentSearchQuery({versions:[1.2]}));
 assert.deepEqual(parseWikiDocumentSearchQuery({paths:['A/','a','b/'],ids:[3,1,3]}).paths,['a/','b/']);assert.deepEqual(parseWikiDocumentSearchQuery({ids:[3,1,3]}).ids,[1,3]);
});

function schema21(path:string){const store=new Store({path});const doc=make(store,'/');store.draftDocument(doc.id,{...pins(store,doc.id),title:'Existing draft',content:'Exact existing draft\r\n😀'},actor);store.database.exec("DROP TABLE wiki_conduit_receipts; DROP TABLE wiki_content_identifiers; DROP TABLE wiki_document_identifiers; CREATE VIEW legacy_search_versions AS SELECT id,data FROM wiki_versions; ALTER TABLE wiki_versions ADD COLUMN operator_note TEXT; PRAGMA user_version=21;");return store;}
function snapshot(db:DatabaseSync){const schema=db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];const tables=(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {name:string}[]).map(row=>row.name);return {schema,rows:new Map(tables.map(name=>[name,db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()]))};}

test('schema22 identities are durable and immutable while migration preserves every old row/schema including SQLite sequences',()=>{
 const directory=mkdtempSync(join(tmpdir(),'wiki-schema22-')),path=join(directory,'workspace.sqlite');let store=schema21(path);const before=snapshot(store.database);store.close();
 try{store=new Store({path});assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version,25);for(const item of before.schema)assert.equal(store.database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(item.name)!.sql,item.sql,item.name);for(const [table,rows]of before.rows)assert.deepEqual(store.database.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all(),rows,table);
  const ids=[store.wikiDocumentIdentity('W1'),...store.documentHistory('W1').versions.map(version=>store.wikiContentIdentity(version.id))];assert.match(ids[0]!.phid,/^PHID-WIKI-[a-f0-9]{20}$/);assert.equal(new Set(ids.map(item=>item.phid)).size,3);
  const cursor=contents(store,{limit:1}).nextAfter!;store.close();store=new Store({path});assert.deepEqual([store.wikiDocumentIdentity('W1'),...store.documentHistory('W1').versions.map(version=>store.wikiContentIdentity(version.id))],ids);assert.equal(contents(store,{limit:1,after:cursor}).contents.length,1);
  assert.throws(()=>store.database.exec('UPDATE wiki_document_identifiers SET phid=phid'),/immutable/);assert.throws(()=>store.database.exec('DELETE FROM wiki_content_identifiers'),/immutable/);assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(),[]);
  const initial=snapshot(store.database);store.database.exec("CREATE TRIGGER fail_identity_write BEFORE INSERT ON activity WHEN json_extract(NEW.data,'$.action')='draft_saved' BEGIN SELECT RAISE(ABORT,'identity rollback'); END");assert.throws(()=>store.draftDocument('W1',{...pins(store,'W1'),title:'Failed draft',content:'Failed source'},actor),/identity rollback/);store.database.exec('DROP TRIGGER fail_identity_write');assert.deepEqual(snapshot(store.database),initial);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('failed schema22 migration rolls back all identifiers without changing schema21 evidence',()=>{
 const directory=mkdtempSync(join(tmpdir(),'wiki-schema22-failure-')),path=join(directory,'workspace.sqlite');const store=schema21(path),before=snapshot(store.database);store.close();const exec=DatabaseSync.prototype.exec;
 try{DatabaseSync.prototype.exec=function(sql:string){if(sql==='PRAGMA user_version = 22')throw new Error('injected schema22 failure');return exec.call(this,sql);};assert.throws(()=>new Store({path}),/injected schema22/);}finally{DatabaseSync.prototype.exec=exec;}
 try{const db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,21);assert.deepEqual(snapshot(db),before);db.close();const recovered=new Store({path});assert.equal(recovered.wikiDocumentIdentity('W1').documentId,'W1');recovered.close();}finally{rmSync(directory,{recursive:true,force:true});}
});
