import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, parseWikiMoveInput, wikiMoveInputHash } from './store.ts';
import { canonicalWikiPath, wikiAncestors, wikiParentPath, type WikiMoveInput } from '../shared/wiki.ts';
import type { ActorAttribution, WikiDocument } from '../shared/types.ts';
const actor:ActorAttribution={principalId:'alice',displayName:'Alice',credentialId:null,requestId:'wiki-test'};
const make=(store:Store,slug:string,content='Exact body\r\n😀')=>store.createDocument({title:`Document ${slug}`,slug,content},actor);
const epoch=(store:Store)=>store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;
function pins(store:Store,id:string,path:string):WikiMoveInput {const source=store.documentDetail(id).document,destination=store.documentAtPath(path);return {destinationPath:path,expectedVersion:source.version,expectedSourceVersionId:store.documentVersion(id,source.version).id,expectedDestinationId:destination?.id??null,expectedDestinationVersion:destination?.version??0,expectedAccessEpoch:epoch(store),message:'Transfer published content'};}
const snapshot=(store:Store)=>['entities','wiki_locations','wiki_versions','activity','sequences','object_policies','policy_meta','idempotency'].map(table=>store.database.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());

test('Phriction canonical paths include root, Unicode, dot components, aliases and bounded ancestors',()=>{
  assert.equal(canonicalWikiPath('///'),'/');assert.equal(canonicalWikiPath('/Research//An Essay/'),'research/an_essay/');
  assert.equal(canonicalWikiPath('ÉTUDE/😀'),'étude/😀/');assert.equal(canonicalWikiPath('./../#Draft'),'dot/dotdot/draft/');
  assert.deepEqual(wikiAncestors('A/B/C'),['/','a/','a/b/']);assert.equal(wikiParentPath('/'),null);
  assert.throws(()=>canonicalWikiPath('\ud800'),/complete characters/);assert.throws(()=>canonicalWikiPath('a'.repeat(513)),/512/);
});

test('fresh writes require root and every ancestor, canonical paths are unique, same-path edits cannot rename',()=>{
  const store=new Store({path:':memory:'});try{
    assert.throws(()=>make(store,'parent/child'),/every parent/);assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind='document'").get()!.n,0);
    const root=make(store,'/');assert.throws(()=>make(store,'parent/child'),/every parent/);const parent=make(store,'Parent'),child=make(store,'Parent/Child');
    assert.equal(child.slug,'parent/child/');assert.deepEqual(store.documentAncestry(child.slug).map(row=>row.document?.id),[root.id,parent.id]);
    assert.throws(()=>make(store,'PARENT//CHILD/'),/unavailable/);assert.throws(()=>make(store,'a'.repeat(128)),/128/);
    const old=snapshot(store);assert.throws(()=>store.updateDocument(child.id,{title:child.title,slug:'other',content:'rename',expectedVersion:1}),/Use Move/);assert.deepEqual(snapshot(store),old);
    assert.equal(store.updateDocument(child.id,{title:'Updated',slug:'PARENT/CHILD',content:'Changed',expectedVersion:1}).slug,child.slug);
    assert.deepEqual(store.documentVersion(child.id,1).content,child.content);
  }finally{store.close();}
});

test('move copies one published document, leaves an immutable moved marker, and never relocates descendants',()=>{
  const store=new Store({path:':memory:'});try{
    make(store,'/');const source=make(store,'source'),child=make(store,'source/child'),before=store.documentVersion(source.id,1),input=pins(store,source.id,'Destination');
    const receipt=store.moveDocument(source.id,input,actor);
    assert.equal(receipt.source.id,source.id);assert.equal(receipt.source.slug,source.slug);assert.equal(receipt.source.content,'');assert.equal(receipt.source.location?.status,'moved');
    assert.equal(receipt.source.location?.movedToId,receipt.destination.id);assert.equal(receipt.destination.content,source.content);assert.equal(receipt.destination.title,source.title);assert.equal(receipt.destination.slug,'destination/');
    assert.deepEqual(store.documentDetail(child.id).document,child);assert.equal(store.documentAtPath('source/child')?.id,child.id);
    assert.deepEqual(store.documentVersion(source.id,1),before);const moved=store.documentVersion(source.id,2);assert.equal(moved.move?.inputSha256,wikiMoveInputHash(input));assert.equal(moved.attribution?.principalId,actor.principalId);
    assert.deepEqual(store.wikiMoveReceipt(source.id,receipt.sourceVersionId,receipt.destinationVersionId),receipt);
    assert.throws(()=>store.moveDocument(source.id,pins(store,source.id,'third'),actor),/active document/);
    store.updateDocument(receipt.destination.id,{title:'Later title',slug:receipt.destination.slug,content:'Later text',expectedVersion:1});
    assert.deepEqual(store.wikiMoveReceipt(source.id,receipt.sourceVersionId,receipt.destinationVersionId),receipt,'later changes do not rewrite receipt');
    assert.ok(store.activities(source.id).filter(item=>item.action==='moved_away').every(item=>!item.detail.includes('destination')));
    assert.throws(()=>store.database.exec("UPDATE wiki_versions SET data=data"),/immutable/);
  }finally{store.close();}
});

test('moves can reuse an inactive destination identity and restore the source marker without altering copied content',()=>{
  const store=new Store({path:':memory:'});try{
    make(store,'/');const a=make(store,'a'),b=make(store,'b');
    const moved=store.moveDocument(a.id,pins(store,a.id,'c'),actor);const historical=store.documentVersion(a.id,2);
    const reused=store.moveDocument(b.id,pins(store,b.id,'a'),actor);assert.equal(reused.destination.id,a.id);assert.equal(reused.destination.version,3);assert.equal(reused.destination.createdAt,a.createdAt);assert.equal(reused.destination.location?.status,'active');assert.equal(reused.destination.location?.movedToId,null);
    assert.deepEqual(store.documentVersion(a.id,2),historical);assert.equal(store.documentDetail(moved.destination.id).document.content,a.content);
    const restored=store.restoreDocument(b.id,{version:1,expectedVersion:2},actor);assert.equal(restored.location?.status,'active');assert.equal(restored.location?.movedToId,null);assert.equal(restored.content,b.content);
    assert.equal(store.documentDetail(a.id).document.version,3);
  }finally{store.close();}
});

test('all exact move pins, collisions, missing ancestors and injected partial writes fail atomically',()=>{
  const store=new Store({path:':memory:'});try{
    make(store,'/');const source=make(store,'source');make(store,'occupied');
    const input=pins(store,source.id,'next');const invalid=[{...input,expectedVersion:2},{...input,expectedSourceVersionId:'wrong'},{...input,expectedDestinationId:'W999',expectedDestinationVersion:1},{...input,expectedAccessEpoch:input.expectedAccessEpoch+1},pins(store,source.id,'occupied'),pins(store,source.id,'absent/child'),pins(store,source.id,'source')];
    for(const value of invalid){const before=snapshot(store);assert.throws(()=>store.moveDocument(source.id,value,actor));assert.deepEqual(snapshot(store),before);}
    assert.throws(()=>parseWikiMoveInput({...input,expectedDestinationVersion:1}),/zero/);assert.notEqual(wikiMoveInputHash(input),wikiMoveInputHash({...input,message:'Different request'}));
    store.database.exec("CREATE TRIGGER break_move BEFORE INSERT ON activity WHEN json_extract(NEW.data,'$.action')='moved_to' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    const before=snapshot(store);assert.throws(()=>store.moveDocument(source.id,input,actor),/injected failure/);assert.deepEqual(snapshot(store),before);store.database.exec('DROP TRIGGER break_move');
    const receipt=store.moveDocument(source.id,input,actor);assert.equal(receipt.destination.version,1);
  }finally{store.close();}
});

function insertLegacy(store:Store,id:string,path:string):void {
  const document:WikiDocument={id,title:`Legacy ${id}`,slug:path,content:'Preserved',version:7,createdAt:'2020-01-01',updatedAt:'2020-02-01'};
  store.database.prepare("INSERT INTO entities(id,kind,data) VALUES (?,'document',?)").run(id,JSON.stringify(document));
  store.database.prepare("INSERT INTO wiki_locations(document_id,path,status,moved_to_id) VALUES (?,?,'active',NULL)").run(id,canonicalWikiPath(path));
}
test('bounded child scans filter visibility, expose visible missing parents, and continue without hidden path cursors',()=>{
  const store=new Store({path:':memory:'});try{
    make(store,'/');const child=make(store,'child');insertLegacy(store,'W4000','legacy/middle/leaf');insertLegacy(store,'W4001','hidden-gap/leaf');
    const page=store.documentChildren('/',id=>id!=='W4001');assert.deepEqual(page.documents.map(doc=>doc.id),[child.id]);assert.deepEqual(page.missingPaths,['legacy/']);assert.equal(page.nextAfter,null);
    for(let i=0;i<1002;i++)insertLegacy(store,`W${5000+i}`,`hidden-${i}`);const final=make(store,'last-visible');let calls=0;
    const first=store.documentChildren('/',id=>{calls++;return id===final.id;});assert.equal(calls,1000);assert.deepEqual(first.documents,[]);assert.match(first.nextAfter!,/^[A-Za-z0-9_-]{48}$/);assert.throws(()=>store.documentChildren('child',()=>true,first.nextAfter!),/cursor/);const token=first.nextAfter!;assert.throws(()=>store.documentChildren('/',()=>true,(token[0]==='A'?'B':'A')+token.slice(1)),/cursor/);assert.doesNotMatch(JSON.stringify(first),/hidden-/);
    const last=store.documentChildren('/',id=>id===final.id,first.nextAfter!);assert.deepEqual(last.documents.map(doc=>doc.id),[final.id]);assert.equal(last.nextAfter,null);
    assert.throws(()=>store.documentChildren('/',()=>true,'hidden-name/'),/cursor/);
  }finally{store.close();}
});

test('schema20 adds canonical locations only, preserves every prior row/schema, and permits legacy orphan edits',()=>{
  const directory=mkdtempSync(join(tmpdir(),'wiki-schema20-')),path=join(directory,'workspace.sqlite');let store=new Store({path});
  try{
    make(store,'/');make(store,'old');store.database.exec('DROP TABLE wiki_conduit_receipts; DROP TABLE wiki_content_identifiers; DROP TABLE wiki_document_identifiers; DROP TABLE wiki_transactions; DROP TABLE wiki_publication; DROP TABLE wiki_cursor_secret; DROP TABLE wiki_locations; PRAGMA user_version=19;');
    const old:WikiDocument={id:'W300',title:'Legacy orphan',slug:'missing/'+ 'x'.repeat(150),content:'Exact old source',version:3,createdAt:'2020-01-01',updatedAt:'2020-02-01'};
    store.database.prepare("INSERT INTO entities(id,kind,data) VALUES (?,'document',?)").run(old.id,JSON.stringify(old,null,2));
    store.database.prepare('INSERT INTO wiki_versions(id,document_id,number,data) VALUES(?,?,?,?)').run('old-wiki-version',old.id,old.version,JSON.stringify({id:'old-wiki-version',documentId:old.id,number:old.version,title:old.title,slug:old.slug,content:old.content,createdAt:old.updatedAt,kind:'legacy',author:null,message:'Legacy',restoredFrom:null}));
    store.database.exec('CREATE VIEW old_document_view AS SELECT id,data FROM entities WHERE kind=\'document\'; ALTER TABLE wiki_versions ADD COLUMN operator_note TEXT;');
    const schemas=store.database.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];
    const rows=new Map((store.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(({name})=>[name,store.database.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()]));
    store.close();store=new Store({path});assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version,42);
    for(const schema of schemas)assert.equal(store.database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(schema.name)!.sql,schema.sql,schema.name);
    for(const [name,before] of rows)assert.deepEqual(store.database.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all(),before,name);
    assert.equal(store.documentAtPath('missing'),null);assert.equal(store.documentAtPath(old.slug)?.id,old.id);assert.deepEqual(store.documentAncestry(old.slug).map(ref=>ref.document?.id??null),['W1',null]);
    const edited=store.updateDocument(old.id,{title:old.title,slug:old.slug,content:'Edit legacy orphan',expectedVersion:3});assert.equal(edited.version,4);assert.equal(edited.slug,old.slug);
    assert.throws(()=>make(store,'missing/new'),/every parent/);assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(),[]);
    const cursor=store.documentChildren('/',()=>true,undefined,1).nextAfter!;assert.ok(cursor);
    store.close();store=new Store({path});assert.equal(store.documentDetail(old.id).document.content,'Edit legacy orphan');assert.deepEqual(store.documentChildren('/',()=>true,cursor).missingPaths,['missing/']);
    assert.throws(()=>store.database.exec("UPDATE wiki_cursor_secret SET key=key"),/immutable/);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('canonical collisions abort schema20 atomically without rewriting original entities',()=>{
  const directory=mkdtempSync(join(tmpdir(),'wiki-schema20-collision-')),path=join(directory,'workspace.sqlite');const store=new Store({path});
  store.database.exec('DROP TABLE wiki_conduit_receipts; DROP TABLE wiki_content_identifiers; DROP TABLE wiki_document_identifiers; DROP TABLE wiki_transactions; DROP TABLE wiki_publication; DROP TABLE wiki_cursor_secret; DROP TABLE wiki_locations; PRAGMA user_version=19;');
  for(const [id,slug]of [['W1','Name'],['W2','name/']])store.database.prepare("INSERT INTO entities(id,kind,data) VALUES (?,'document',?)").run(id,JSON.stringify({id,title:'Old',slug,content:'Keep',version:1,createdAt:'old',updatedAt:'old'}));
  const before=store.database.prepare('SELECT * FROM entities').all();store.close();
  try{assert.throws(()=>new Store({path}),/UNIQUE/);const db=new DatabaseSync(path);try{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,19);assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='wiki_locations'").get(),undefined);assert.deepEqual(db.prepare('SELECT * FROM entities').all(),before);}finally{db.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});
