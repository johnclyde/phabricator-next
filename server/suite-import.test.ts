import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import type { SuiteImportRequest, SuiteImportReceipt } from '../shared/suite-import.ts';
import type { SuiteAccess } from '../shared/suite.ts';
import type { AuthContext } from '../shared/auth.ts';
import { legalpadActiveSignature, type LegalpadData } from '../shared/legalpad.ts';
import { Store } from './store.ts';
import { createAuth } from './auth.ts';
import { PolicyStore } from './policy.ts';
import { SuiteService } from './suite.ts';
import { initializeSuiteImport, SuiteImportService } from './suite-import.ts';
import { parseSuiteMysqlXml } from './suite-import-xml.ts';

const access:SuiteAccess={spaceId:'S1',visibility:'members',memberIds:[],editorIds:[]};
const P={device:'PHID-ADEV-device',network:'PHID-ANET-network',service:'PHID-ASRV-service',iface:'PHID-AINT-interface',binding:'PHID-ABND-binding',room:'PHID-CONP-room',event:'PHID-CEVT-event',poll:'PHID-POLL-poll',blog:'PHID-BLOG-blog',post:'PHID-POST-post',legal:'PHID-LEGD-document',body:'PHID-LEGB-body',user:'PHID-USER-original',tx:'PHID-XACT-history'};
const escape=(value:unknown)=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
type Rows=Record<string,Record<string,unknown>[]>;
/** Synthetic values in the actual mysqldump --xml table/row/field envelope. */
function xml(tables:Rows):string{return `<?xml version="1.0"?><mysqldump xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><database name="original">${Object.entries(tables).map(([name,rows])=>`<table_data name="${name}">${rows.map(row=>`<row>${Object.entries(row).map(([name,value])=>value===null?`<field name="${name}" xsi:nil="true"/>`:`<field name="${name}">${escape(typeof value==='object'?JSON.stringify(value):value)}</field>`).join('')}</row>`).join('')}</table_data>`).join('')}</database></mysqldump>`;}
function row(phid:string,fields:Record<string,unknown>={}){return{id:1,phid,dateCreated:1_620_000_000,dateModified:1_620_100_000,...fields};}
const datetime=(hour:number)=>({kind:'absolute',year:2021,month:5,day:3,hour,minute:30,second:0,timezone:'UTC',isAllDay:false});
function allApps():Rows{return{
 almanac_device:[row(P.device,{name:'worker.example',status:'active',mailKey:'MUST-NOT-PERSIST'})],almanac_network:[row(P.network,{name:'internal'})],almanac_service:[row(P.service,{name:'build.example',serviceType:'almanac.custom'})],almanac_interface:[row(P.iface,{devicePHID:P.device,networkPHID:P.network,address:'127.0.0.1',port:8080})],almanac_binding:[row(P.binding,{servicePHID:P.service,devicePHID:P.device,interfacePHID:P.iface,isDisabled:0})],almanac_property:[{id:1,objectPHID:P.device,fieldName:'region',fieldValue:'"local"'}],
 conpherence_thread:[row(P.room,{title:'Source conversation',topic:'Research',messageCount:1})],conpherence_participant:[{id:1,conpherencePHID:P.room,participantPHID:P.user}],conpherence_transaction:[row(P.tx,{objectPHID:P.room,authorPHID:P.user,transactionType:'core:comment',commentPHID:'PHID-XCMT-message'})],conpherence_transactioncomment:[row('PHID-XCMT-message',{transactionPHID:P.tx,authorPHID:P.user,content:'Original historical message',commentVersion:1,isDeleted:0})],
 calendar_event:[row(P.event,{name:'Original seminar',hostPHID:P.user,description:'Discuss work',isAllDay:0,isCancelled:0,isRecurring:0,isStub:0,parameters:{startDateTime:datetime(9),endDateTime:datetime(10)}})],calendar_eventinvitee:[{id:1,eventPHID:P.event,inviteePHID:P.user,status:'attending'}],
 slowvote_poll:[row(P.poll,{question:'Which draft?',description:'Choose carefully',authorPHID:P.user,method:0,responseVisibility:2,isClosed:0,shuffle:0,mailKey:'MAIL-SECRET'})],slowvote_option:[{id:1,pollID:1,name:'First'},{id:2,pollID:1,name:'Second'}],slowvote_choice:[{id:1,pollID:1,optionID:2,authorPHID:P.user}],
 phame_blog:[row(P.blog,{name:'Research updates',subtitle:'Notes',description:'Body',creatorPHID:P.user,status:'active',domain:'old.example'})],phame_post:[row(P.post,{title:'Published source post',subtitle:'A subtitle',body:'The actual source body',bloggerPHID:P.user,blogPHID:P.blog,visibility:1,datePublished:1_620_020_000})],
 legalpad_document:[row(P.legal,{title:'Terms',creatorPHID:P.user,documentBodyPHID:P.body,versions:3,signatureType:'user',preamble:'Read carefully',requireSignature:1})],legalpad_documentbody:[row(P.body,{documentPHID:P.legal,creatorPHID:P.user,version:3,title:'Terms',text:'Actual agreement text'})],legalpad_documentsignature:[{id:1,documentPHID:P.legal,documentVersion:3,signerPHID:P.user,signerName:'Original signer',signerEmail:'original@example.test',signatureType:'user',verified:0,isExemption:0,secretKey:'SIGNATURE-SECRET'}],
};}
function request(tables:Rows=allApps()):SuiteImportRequest{return{sourceKey:'original-2021',files:[{name:'export.xml',xml:xml(tables)}],destination:access};}
function fixture(mode:'local'|'password'='local') {
 const store=new Store({path:':memory:'});initializeSuiteImport(store.database);
 const auth=createAuth({database:store.database,mode,basePath:'/',provisioning:true}),policies=new PolicyStore(store.database,{principalExists:id=>auth.listAccounts().some(account=>account.id===id)||id===`local:${auth.workspaceId}`}),suite=new SuiteService(store,auth,policies);
 const service=new SuiteImportService(store,auth,{validateAccess:(a,c)=>suite.validateImportAccess(a,c),validatePerson:(id,space,c)=>suite.validateImportPerson(id,space,c),create:(app,input,c)=>suite.importCreate(app,input,c),command:(id,action,input,c)=>suite.importCommand(id,action,input,c),detail:(id,c)=>suite.importDetail(id,c)});
 const context=()=>auth.authenticate({headers:{}} as IncomingMessage,'write');
 const count=(table:string)=>Number(store.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
 const apply=(input:SuiteImportRequest,actor=context(),key=randomUUID())=>{const preview=service.preview(input,actor);assert.equal(preview.canApply,true,JSON.stringify(preview.errors));return service.apply({request:input,previewDigest:preview.digest},key,actor).body as SuiteImportReceipt;};
 return{store,auth,policies,suite,service,context,count,apply};
}

test('actual upstream XML imports all six apps with stable graph links, current access and separate historical assertions',()=>{
 const f=fixture();try{
  const actor=f.context(),input=request(),before=f.policies.epoch(),preview=f.service.preview(input,actor);
  assert.equal(preview.canApply,true,JSON.stringify(preview.errors));assert.equal(preview.items.length,11);assert.equal(f.count('suite_records'),0);assert.equal(f.count('suite_history'),0);assert.equal(f.policies.epoch(),before);
  let notifications=0;f.suite.connectNotifications(()=>{notifications++;});const receipt=f.service.apply({request:input,previewDigest:preview.digest},'all-apps',actor).body as SuiteImportReceipt;
  assert.equal(receipt.records.length,11);assert.equal(notifications,0);
  const id=(phid:string)=>receipt.records.find(item=>item.sourcePHID===phid)!.recordId,record=(phid:string)=>f.suite.rawRecord(id(phid));
  assert.equal(record(P.iface).data.deviceId,id(P.device));assert.equal(record(P.binding).data.interfaceId,id(P.iface));assert.deepEqual(record(P.device).data.properties,{region:'local'});
  assert.equal(record(P.post).data.blogId,id(P.blog));assert.equal(record(P.post).data.status,'published');assert.equal(record(P.post).data.body,'The actual source body');
  assert.equal(record(P.poll).data.closed,true);assert.deepEqual(record(P.poll).data.ballots,[]);
  const agreement=record(P.legal).data as LegalpadData;assert.equal(agreement.versions[0]!.text,'Actual agreement text');assert.equal(agreement.versions[0]!.version,1);assert.deepEqual(agreement.signatures,[]);assert.equal(legalpadActiveSignature(agreement,P.user),undefined);
  assert.deepEqual(record(P.room).data.participants,[{id:actor.principalId,displayName:'You'}]);assert.deepEqual(record(P.room).data.messages,[]);
  const provenance=f.service.provenance(id(P.room),actor);assert.equal(provenance.assertionStatus,'historical-unverified');assert.equal(provenance.rows.find(item=>item.table.endsWith('comment'))!.fields.content,'Original historical message');
  assert.equal(JSON.stringify(f.service.provenance(id(P.legal),actor)).includes('SIGNATURE-SECRET'),false);assert.equal(JSON.stringify(f.service.provenance(id(P.poll),actor)).includes('MAIL-SECRET'),false);
  assert.equal(record(P.event).data.start,'2021-05-03T09:30:00.000Z');assert.equal((record(P.event).data.invitees as {id:string}[]).some(person=>person.id===P.user),false);
  assert.equal(record(P.post).ownerId,actor.principalId);assert.equal(record(P.post).access.visibility,'members');
 }finally{f.store.close();}
});

test('identical retries and new batches reuse mappings without overwriting current native edits; changed source conflicts',()=>{
 const f=fixture();try{
  const input=request({phame_blog:allApps().phame_blog!}),actor=f.context(),preview=f.service.preview(input,actor),payload={request:input,previewDigest:preview.digest};
  const first=f.service.apply(payload,'stable',actor).body as SuiteImportReceipt,id=first.records[0]!.recordId;
  f.store.transaction(()=>f.suite.importCommand(id,'edit',{title:'Edited here',description:'Local'},actor));
  assert.equal((f.service.apply(payload,'stable',actor).body as SuiteImportReceipt).replayed,true);assert.equal(f.count('suite_records'),1);
  const repeated=f.service.preview(input,actor);assert.equal(repeated.items[0]!.disposition,'skip');assert.equal(repeated.canApply,true);
  f.service.apply({request:input,previewDigest:repeated.digest},'new-key',actor);assert.equal(f.suite.rawRecord(id).title,'Edited here');assert.equal(f.count('suite_import_sources'),1);
  const changed=structuredClone(input);changed.files[0]!.xml=changed.files[0]!.xml.replace('Research updates','Updated upstream');const conflict=f.service.preview(changed,actor);assert.equal(conflict.canApply,false);assert.equal(conflict.items[0]!.disposition,'conflict');
  assert.throws(()=>f.service.apply({request:changed,previewDigest:conflict.digest},'conflict',actor),/Resolve/);
  assert.throws(()=>f.service.apply({request:changed,previewDigest:conflict.digest},'stable',actor),/different request/);
 }finally{f.store.close();}
});

test('preview validates native errors and rolls back all records/history/epochs; stale previews fail atomically',()=>{
 const f=fixture();try{
  const input=request({almanac_device:[row(P.device,{name:'valid.example',status:'active'}),row('PHID-ADEV-invalid',{id:2,name:'not a hostname',status:'active'})]}),actor=f.context();
  const bad=f.service.preview(input,actor);assert.equal(bad.canApply,false);assert.match(bad.errors.join(' '),/Use a name/);assert.equal(f.count('suite_records'),0);assert.equal(f.count('suite_history'),0);
  const valid=request({phame_blog:allApps().phame_blog!}),preview=f.service.preview(valid,actor);f.store.database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
  assert.throws(()=>f.service.apply({request:valid,previewDigest:preview.digest},'stale',actor),/preview changed/);assert.equal(f.count('suite_import_sources'),0);assert.equal(f.count('suite_records'),0);
 }finally{f.store.close();}
});

test('missing dependencies and unsupported recurrence are preview errors, not partial imports',()=>{
 const f=fixture();try{
  const post=f.service.preview(request({phame_post:allApps().phame_post!}),f.context());assert.equal(post.canApply,false);assert.match(post.errors.join(' '),/requires blogId/);
  const event=allApps().calendar_event![0]!;event.isRecurring=1;(event.parameters as Record<string,unknown>).recurrenceRule={FREQ:'MONTHLY'};
  const calendar=f.service.preview(request({calendar_event:[event]}),f.context());assert.equal(calendar.canApply,false);assert.match(calendar.errors.join(' '),/bounded daily/);
  assert.equal(f.count('suite_records'),0);
 }finally{f.store.close();}
});

test('previous batches resolve stable dependencies and disabled Almanac graphs settle safely',()=>{
 const f=fixture();try{
  const actor=f.context(),blog=f.apply(request({phame_blog:allApps().phame_blog!}),actor);const post=f.apply(request({phame_post:allApps().phame_post!}),actor);assert.equal(f.suite.rawRecord(post.records[0]!.recordId).data.blogId,blog.records[0]!.recordId);
  const rows=allApps(),device=rows.almanac_device![0]!;device.status='disabled';const selected=Object.fromEntries(Object.entries(rows).filter(([table])=>table.startsWith('almanac_')));
  const imported=f.apply(request(selected),actor);for(const phid of [P.device,P.iface,P.binding])assert.equal(f.suite.rawRecord(imported.records.find(item=>item.sourcePHID===phid)!.recordId).data.status,'disabled');
 }finally{f.store.close();}
});

test('provenance requires current edit authority; revoked participant cannot replay an old successful import',async()=>{
 const f=fixture('password');try{
  const alice=await f.auth.createAccount({username:'importer',displayName:'Importer',password:'Import fixture secure password'}),bob=await f.auth.createAccount({username:'participant',displayName:'Participant',password:'Participant fixture password'});
  const actor=(id:string):AuthContext=>{const token=f.auth.createToken(id,{name:'Import',scopes:['read','write']});return f.auth.authenticate({headers:{authorization:`Bearer ${token.token}`}} as IncomingMessage,'write');},a=actor(alice.id),b=actor(bob.id);
  const input=request({conpherence_thread:allApps().conpherence_thread!});input.roles={[P.room]:{participantIds:[bob.id]}};
  const preview=f.service.preview(input,a),payload={request:input,previewDigest:preview.digest};assert.equal(preview.canApply,true,JSON.stringify(preview.errors));
  const result=f.service.apply(payload,'private',a).body as SuiteImportReceipt,id=result.records[0]!.recordId;
  assert.equal(f.service.provenance(id,b).recordId,id);
  f.store.transaction(()=>f.suite.importCommand(id,'participants',{participantIds:[bob.id]},b));
  assert.throws(()=>f.service.provenance(id,a),/not found/i);assert.throws(()=>f.service.apply(payload,'private',a),/not found/i);
  assert.equal(f.count('suite_import_sources'),1);
 }finally{f.store.close();}
});

test('XML rejects XXE, SQL/structure payloads, duplicate identities, encoded source and malformed nesting; omissions are explicit',()=>{
 const parsed=parseSuiteMysqlXml([{name:'source.xml',xml:xml({slowvote_poll:[row(P.poll,{question:'A & B < C',mailKey:'PRIVATE',futureField:'omitted'})],unsupported_table:[{id:1,password:'never imported'}]})}]);
 assert.equal(parsed.rows[0]!.fields.question,'A & B < C');assert.equal(parsed.rows[0]!.fields.mailKey,undefined);assert.equal(parsed.rows[0]!.fields.futureField,undefined);assert.equal(parsed.rows.length,1);assert.match(parsed.warnings.join(' '),/Unsupported column/);assert.match(parsed.warnings.join(' '),/Unsupported table/);
 for(const content of ['<!DOCTYPE mysqldump [<!ENTITY stolen SYSTEM "file:///etc/passwd">]><mysqldump/>','INSERT INTO suite_records VALUES (1);','<mysqldump><database name="a"><table_structure name="slowvote_poll"/></database></mysqldump>',xml({slowvote_poll:[row(P.poll),row(P.poll)]}),'<mysqldump><row/></mysqldump>'])assert.throws(()=>parseSuiteMysqlXml([{name:'bad.xml',xml:content}]));
 const encoded=xml({slowvote_poll:[row(P.poll,{question:'AB'})]}).replace('<field name="question">','<field name="question" xsi:type="xs:hexBinary">');assert.throws(()=>parseSuiteMysqlXml([{name:'bad.xml',xml:encoded}]),/binary content/);
});

test('import schema is immutable and refuses partially matching schema drift atomically',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE suite_records(id TEXT PRIMARY KEY)');initializeSuiteImport(db);initializeSuiteImport(db);db.exec("INSERT INTO suite_records VALUES('native')");db.prepare('INSERT INTO suite_import_sources VALUES(?,?,?,?,?,?,?,?)').run('source','phid','digest','config','native','now','actor','{}');assert.throws(()=>db.exec("UPDATE suite_import_sources SET source_key='other'"),/immutable/);assert.throws(()=>db.exec('DELETE FROM suite_import_sources'),/immutable/);}finally{db.close();}
 const drift=new DatabaseSync(':memory:');try{drift.exec('CREATE TABLE suite_import_sources(unexpected TEXT)');assert.throws(()=>initializeSuiteImport(drift),/Unexpected/);assert.equal(drift.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger'").get()!.n,0);}finally{drift.close();}
});

test('a final provenance write failure rolls back every native object, mapping, history, and retry receipt',()=>{
 const f=fixture();try{
  const input=request({phame_blog:allApps().phame_blog!,phame_post:allApps().phame_post!}),actor=f.context(),preview=f.service.preview(input,actor),epoch=f.policies.epoch();assert.equal(preview.canApply,true);
  f.store.database.exec(`CREATE TRIGGER import_test_failure BEFORE INSERT ON suite_import_sources WHEN NEW.source_phid='${P.post}' BEGIN SELECT RAISE(ABORT,'forced final write failure'); END`);
  const payload={request:input,previewDigest:preview.digest};assert.throws(()=>f.service.apply(payload,'atomic',actor),/forced final/);
  for(const table of ['suite_records','suite_history','suite_import_sources','idempotency'])assert.equal(f.count(table),0);assert.equal(f.policies.epoch(),epoch);
  f.store.database.exec('DROP TRIGGER import_test_failure');const receipt=f.service.apply(payload,'atomic',actor).body as SuiteImportReceipt;assert.equal(receipt.records.length,2);assert.equal(receipt.replayed,false);
 }finally{f.store.close();}
});


test('inherited JavaScript names are unsupported source tables and cannot become Legalpad signature types',()=>{
 const parsed=parseSuiteMysqlXml([{name:'constructor.xml',xml:xml({constructor:[{id:1,content:'must remain unsupported'}]})}]);
 assert.deepEqual(parsed.rows,[]);assert.match(parsed.warnings.join(' '),/Unsupported table constructor/);
 const f=fixture();try{const rows=allApps(),document=rows.legalpad_document![0]!;document.signatureType='constructor';const preview=f.service.preview(request({legalpad_document:[document],legalpad_documentbody:rows.legalpad_documentbody!}),f.context());assert.equal(preview.canApply,false);assert.match(preview.errors.join(' '),/Unsupported Legalpad signature type/);assert.equal(f.count('suite_records'),0);}finally{f.store.close();}
});

test('Calendar converts native inclusive all-day ends and preserves already-exclusive imported event ends',()=>{
 const f=fixture();try{
  const source=(id:number,endDay:number,imported=false)=>row(`PHID-CEVT-allday${id}`,{id,name:`All-day ${id}`,isAllDay:1,isRecurring:0,isStub:0,isCancelled:0,importSourcePHID:imported?'PHID-CIMP-original':null,parameters:{startDateTime:{...datetime(0),day:3,minute:0,isAllDay:true},endDateTime:{...datetime(0),day:endDay,minute:0,isAllDay:true}}});
  const input=request({calendar_event:[source(1,3),source(2,5),source(3,4,true),source(4,6,true)]}),actor=f.context(),receipt=f.apply(input,actor);
  const events=receipt.records.map(item=>f.suite.rawRecord(item.recordId));assert.deepEqual(events.map(event=>[event.data.start,event.data.end]),[['2021-05-03','2021-05-04'],['2021-05-03','2021-05-06'],['2021-05-03','2021-05-04'],['2021-05-03','2021-05-06']]);
  const provenance=f.service.provenance(events[0]!.id,actor);assert.equal(JSON.parse(provenance.rows[0]!.fields.parameters!).endDateTime.day,3);
 }finally{f.store.close();}
});
