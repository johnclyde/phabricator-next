import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { IncomingMessage } from 'node:http';
import type { PaperBuild, PaperBuildDetail, PaperBuildInput, PaperBuildPage } from '../shared/paper-builds.ts';
import type { FileRecord, RevisionAsset } from '../shared/files.ts';
import type { RevisionDetail } from '../shared/types.ts';
import { sourceSnapshotCanonical } from '../shared/source-snapshot.ts';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { PaperBuildService, type PaperRunner } from './paper-builds.ts';
import { PolicyStore } from './policy.ts';

const toolchain = { engine:'lifecycle-test-double',image:'sha256:'+'1'.repeat(64),bundle:'sha256:'+'2'.repeat(64) };
const workspace={kind:'workspace' as const}; const members=(...principalIds:string[])=>({kind:'principals' as const,principalIds});
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
function success(): Awaited<ReturnType<PaperRunner['run']>> {
  const artifacts = [
    {kind:'pdf' as const,name:'paper.pdf',mediaType:'application/pdf',data:Buffer.from('%PDF-1.7\nLifecycle fixture, not a typeset PDF.\n%%EOF\n')},
    {kind:'log' as const,name:'paper.log',mediaType:'text/plain',data:Buffer.from('Lifecycle fixture compiler log\n')},
    {kind:'manifest' as const,name:'manifest.json',mediaType:'application/json',data:Buffer.from(JSON.stringify({testDouble:true}))},
    {kind:'synctex' as const,name:'paper.synctex.gz',mediaType:'application/gzip',data:Buffer.from('Lifecycle fixture map bytes')},
    {kind:'mapping' as const,name:'mapping.json',mediaType:'application/json',data:Buffer.from(JSON.stringify({origin:'top-left',units:'pt',pages:[{page:1,width:612,height:792}],points:[{path:'main.tex',line:1,page:1,x:10,y:20,width:30,height:12}]}))},
  ];return{success:true,artifacts,diagnostics:[],error:null};
}
function controlled(abortable=true) {
  const calls: {input:Parameters<PaperRunner['run']>[0];signal:AbortSignal;finish:(value:Awaited<ReturnType<PaperRunner['run']>>)=>void}[]=[];
  const runner:PaperRunner={toolchain,run(input,signal){const result=deferred<Awaited<ReturnType<PaperRunner['run']>>>();calls.push({input,signal,finish:value=>{const manifest=value.artifacts.find(item=>item.kind==='manifest');if(manifest && Buffer.from(manifest.data).toString('utf8')===JSON.stringify({testDouble:true}))manifest.data=Buffer.from(JSON.stringify(compilerManifest(input,value)));result.resolve(value);}});if(abortable)signal.addEventListener('abort',()=>result.resolve({success:false,artifacts:[],diagnostics:[],error:'Test runner aborted.'}),{once:true});return result.promise;}};
  return{runner,calls};
}
function compilerManifest(input:Parameters<PaperRunner['run']>[0],result:Awaited<ReturnType<PaperRunner['run']>>) {
  return {schema:input.assets?.length?2:1,revisionId:input.revisionId,versionId:input.versionId,contentHash:input.contentHash,entrypoint:input.entrypoint,toolchain,
    files:[...input.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(file=>({path:file.path,sha256:createHash('sha256').update(file.content).digest('hex'),bytes:Buffer.byteLength(file.content)})),
    ...(input.assets?.length?{assets:[...input.assets].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(({path,fileId,sha256,bytes,mediaType})=>({path,fileId,sha256,bytes,mediaType}))}:{}),
    artifacts:result.artifacts.filter(item=>item.kind!=='manifest').map(item=>({kind:item.kind,sha256:createHash('sha256').update(item.data).digest('hex'),bytes:item.data.byteLength})).sort((a,b)=>a.kind<b.kind?-1:a.kind>b.kind?1:0)};
}
async function until(predicate:()=>boolean) {for(let i=0;i<200;i++){if(predicate())return;await delay(10);}assert.fail('Timed out waiting for paper build state.');}
async function start(runner:PaperRunner|null=controlled().runner) {
  const store=new Store({path:':memory:'});const provision=createAuth({database:store.database,mode:'local',basePath:'/',provisioning:true});
  const alice=await provision.createAccount({username:'alice',displayName:'Alice',password:'Alice durable paper build password'});const bob=await provision.createAccount({username:'bob',displayName:'Bob',password:'Bob durable paper build password'});
  const app=createApp({store,seed:false,authMode:'password',paperRunner:runner});const tokens={alice:app.auth.createToken(alice.id,{name:'Alice',scopes:['read','write']}),bob:app.auth.createToken(bob.id,{name:'Bob',scopes:['read','write']}),reader:app.auth.createToken(alice.id,{name:'Reader',scopes:['read']})};
  store.createRepository({name:'Paper repository',remoteUrl:'https://example.invalid/paper.git'});
  const detail=store.createRevision({kind:'paper',title:'Paper compiler lifecycle',repositoryId:'R1',files:[{path:'main.tex',content:'\\documentclass{article}\n\\begin{document}Old source.\\end{document}'},{path:'refs.bib',content:'@article{a,title={Title}}'}]});
  const version=detail.versions[0]!;const id=detail.revision.id;const route=`/api/revisions/${id}/paper-builds`;
  const input:PaperBuildInput={versionId:version.id,contentHash:version.contentHash,entrypoint:'main.tex',toolchainId:app.paperBuilds.configuration.toolchainId??'a'.repeat(64)};
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T=Record<string,unknown>>(path:string,method='GET',body?:unknown,actor:keyof typeof tokens='alice',key?:string){const response=await fetch(origin+path,{method,signal:AbortSignal.timeout(10_000),headers:{Authorization:`Bearer ${tokens[actor].token}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,headers:response.headers,body:await response.json() as T};}
  const policy=(id:string,changes:Record<string,unknown>,principal=bob.id)=>{const old=app.policies.policy(id,principal);return app.policies.setPolicy(id,{expectedVersion:old.version,spaceId:old.spaceId,...old.rules,...changes},principal);};
  const get=(job:string)=>JSON.parse((store.database.prepare('SELECT data FROM paper_builds WHERE id=?').get(job) as {data:string}).data) as PaperBuild;
  return{...app,alice,bob,tokens,origin,id,route,input,version,request,policy,get,close:async()=>{await app.close();store.close();}};
}

test('durable build submissions pin historical source and toolchain; exact replay survives completion and artifacts publish atomically',async()=>{
  const fake=controlled();const app=await start(fake.runner);
  try{
    const before=app.store.detail(app.id);const created=await app.request<PaperBuild>(app.route,'POST',app.input,'alice','first');assert.equal(created.status,201);assert.equal(created.body.status,'queued');const id=created.body.id;
    await until(()=>fake.calls.length===1);assert.deepEqual(fake.calls[0]!.input.files,app.version.files);
    app.store.createVersion(app.id,{expectedVersion:1,message:'Later source',files:[{path:'main.tex',content:'Changed'}]});
    const replay=await app.request<PaperBuild>(app.route,'POST',app.input,'alice','first');assert.deepEqual(replay.body,created.body);assert.equal(fake.calls.length,1);
    assert.equal((await app.request(app.route,'POST',{...app.input,entrypoint:'other.tex'},'alice','first')).status,409);
    fake.calls[0]!.finish(success());await until(()=>app.get(id).status==='succeeded');const completed=app.get(id);assert.equal(completed.versionNumber,1);assert.equal(completed.versionId,app.version.id);assert.equal(completed.attempt,1);assert.equal(completed.artifacts.length,5);assert.equal(completed.attempts[0]!.status,'succeeded');
    assert.deepEqual((await app.request<PaperBuild>(app.route,'POST',app.input,'alice','first')).body,created.body,'saved receipt remains historical, fetch returns current job');
    const detail=await app.request<PaperBuildDetail>(`${app.route}/${id}`);assert.equal(detail.body.build.status,'succeeded');
    const pdf=await fetch(`${app.origin}${app.route}/${id}/artifacts/pdf`,{headers:{Authorization:`Bearer ${app.tokens.alice.token}`}});assert.equal(pdf.status,200);assert.equal(pdf.headers.get('cache-control'),'private, no-store');assert.ok(pdf.headers.get('x-access-epoch'));const bytes=new Uint8Array(await pdf.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),completed.artifacts.find(a=>a.kind==='pdf')!.sha256);
    const map=await app.request(`${app.route}/${id}/synctex`);assert.equal(map.body.versionId,app.version.id);assert.equal(map.body.origin,'top-left');assert.equal(map.body.units,'pt');
    assert.throws(()=>app.store.database.prepare("UPDATE paper_build_artifacts SET data=x'00' WHERE build_id=?").run(id),/immutable/);
    assert.deepEqual(app.store.detail(app.id).versions.find(v=>v.number===1),before.versions[0]);assert.deepEqual(app.store.detail(app.id).reviews,before.reviews);
    const retried=await app.request<PaperBuild>(`${app.route}/${id}/retry`,'POST',{},'alice','retry');assert.equal(retried.status,201);assert.notEqual(retried.body.id,id);assert.equal(retried.body.versionId,app.version.id);assert.equal(retried.body.artifacts.length,0);
    assert.deepEqual((await app.request<PaperBuild>(`${app.route}/${id}/retry`,'POST',{},'alice','retry')).body,retried.body);
    const first=await app.request<PaperBuildPage>(app.route+'?limit=1');assert.equal(first.body.builds.length,1);assert.ok(first.body.nextBefore);const second=await app.request<PaperBuildPage>(app.route+`?before=${first.body.nextBefore}&limit=1`);assert.equal(second.body.builds[0]!.id,id);assert.equal(second.body.nextBefore,null);
  }finally{await app.close();}
});

test('cancel fencing wins against late successful runner output and explicit retry never inherits earlier artifacts',async()=>{
  const fake=controlled(false);const app=await start(fake.runner);
  try{
    const made=await app.request<PaperBuild>(app.route,'POST',app.input,'alice','create');const id=made.body.id;await until(()=>fake.calls.length===1);
    const canceled=await app.request<PaperBuild>(`${app.route}/${id}/cancel`,'POST',{},'alice','cancel');assert.equal(canceled.body.status,'canceled');assert.equal(fake.calls[0]!.signal.aborted,true);
    fake.calls[0]!.finish(success());await delay(20);assert.equal(app.get(id).status,'canceled');assert.deepEqual(app.get(id).artifacts,[]);assert.equal((await app.request(`${app.route}/${id}/artifacts/pdf`)).status,404);
    const retried=await app.request<PaperBuild>(`${app.route}/${id}/retry`,'POST',{},'alice','retry');await until(()=>fake.calls.length===2);fake.calls[1]!.finish({success:false,artifacts:[success().artifacts[1]!],diagnostics:[{severity:'error',message:'Bad command',path:'main.tex',line:1}],error:'Compilation failed.'});await until(()=>app.get(retried.body.id).status==='failed');assert.deepEqual(app.get(retried.body.id).artifacts.map(a=>a.kind),['log']);assert.equal(app.get(retried.body.id).diagnostics[0]!.path,'main.tex');
  }finally{for(const call of fake.calls)call.finish({success:false,artifacts:[],diagnostics:[],error:'test cleanup'});await app.close();}
});

test('current edit/read scopes, inherited repository and Space policy, and submitting credential revocation govern queue and publication',async()=>{
  const fake=controlled(false);const app=await start(fake.runner);
  try{
    assert.equal((await app.request(app.route,'POST',app.input,'reader','reader')).status,403);
    app.policy(app.id,{edit:members(app.bob.id)});assert.equal((await app.request(app.route,'POST',app.input,'alice','denied')).status,403);app.policy(app.id,{edit:workspace});
    const made=await app.request<PaperBuild>(app.route,'POST',app.input,'alice','pending');await until(()=>fake.calls.length===1);
    app.store.database.prepare('UPDATE auth_tokens SET revoked=1 WHERE id=?').run(app.tokens.alice.record.id);
    fake.calls[0]!.finish(success());await until(()=>app.get(made.body.id).status==='failed');assert.deepEqual(app.get(made.body.id).artifacts,[]);assert.equal((await app.request(`${app.route}/${made.body.id}`)).status,401);
    const next=await app.request<PaperBuild>(app.route,'POST',app.input,'bob','bob-pending');await until(()=>fake.calls.length===2);app.policy('R1',{view:members(app.alice.id)},app.alice.id);
    fake.calls[1]!.finish(success());await until(()=>app.get(next.body.id).status==='failed');assert.deepEqual(app.get(next.body.id).artifacts,[]);assert.equal((await app.request(`${app.route}/${next.body.id}`,'GET',undefined,'bob')).status,404);
    app.policy('R1',{view:workspace},app.alice.id);const space=app.policies.createSpace({name:'Restricted compiler source',view:workspace,edit:members(app.alice.id)},app.alice.id);app.policy(app.id,{spaceId:space.id});
    const third=await app.request<PaperBuild>(app.route,'POST',app.input,'bob','space-pending');await until(()=>fake.calls.length===3);app.policies.updateSpace(space.id,{expectedVersion:space.version,name:space.name,view:members(app.alice.id),edit:members(app.alice.id)},app.alice.id);
    fake.calls[2]!.finish(success());await until(()=>app.get(third.body.id).status==='failed');assert.deepEqual(app.get(third.body.id).artifacts,[]);
  }finally{for(const call of fake.calls)call.finish({success:false,artifacts:[],diagnostics:[],error:'test cleanup'});await app.close();}
});

test('compiler unavailable, changed pins, malformed queries and child identity fail without jobs or receipts',async()=>{
  const app=await start(null);
  try{
    const list=await app.request<PaperBuildPage>(app.route);assert.equal(list.body.configuration.available,false);
    assert.equal((await app.request(app.route,'POST',app.input,'alice','unavailable')).status,503);
    assert.equal((await app.request(app.route,'POST',app.input)).status,400);
    for(const query of ['?limit=0','?limit=101','?before=x','?limit=1&limit=2','?token=secret'])assert.equal((await app.request(app.route+query)).status,400);
    assert.equal((await app.request(`${app.route}/PBmissing/cancel`,'POST',{},'alice','unknown')).status,404);
    assert.equal(app.store.database.prepare('SELECT count(*) AS count FROM paper_builds').get()!.count,0);assert.equal(app.store.database.prepare('SELECT count(*) AS count FROM idempotency').get()!.count,0);
  }finally{await app.close();}
  const fake=controlled();const configured=await start(fake.runner);try{
    for(const input of [{...configured.input,toolchainId:'b'.repeat(64)},{...configured.input,contentHash:'c'.repeat(64)},{...configured.input,versionId:'missing'}])assert.equal((await configured.request(configured.route,'POST',input,'alice','bad-'+input.contentHash+input.versionId+input.toolchainId)).status,409);
    for(const input of [{...configured.input,entrypoint:'../main.tex'},{...configured.input,entrypoint:'not-found.tex'},{...configured.input,toolchainId:undefined},{...configured.input,command:'sh'}])assert.equal((await configured.request(configured.route,'POST',input,'alice','invalid')).status,400);
  }finally{await configured.close();}
});

test('restart recovery fences stale attempts and bounds global concurrency across two scheduler instances',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'paper-restart-'));const path=join(directory,'workspace.sqlite');const store=new Store({path});const auth=createAuth({database:store.database,mode:'local',basePath:'/'});const policies=new PolicyStore(store.database,{principalExists:()=>true});let now=1_800_000_000_000;
  const context=auth.authenticate({headers:{}} as IncomingMessage);const detail=store.createRevision({kind:'paper',title:'Restart fixture',files:[{path:'main.tex',content:'Exact source'}]});const version=detail.versions[0]!;
  const old=controlled(false),fresh=controlled();const first=new PaperBuildService(store,auth,policies,old.runner,()=>now);const secondStore=new Store({path});const secondAuth=createAuth({database:secondStore.database,mode:'local',basePath:'/'});const second=new PaperBuildService(secondStore,secondAuth,new PolicyStore(secondStore.database,{principalExists:()=>true}),fresh.runner,()=>now);
  try{
    const input={versionId:version.id,contentHash:version.contentHash,entrypoint:'main.tex',toolchainId:first.configuration.toolchainId!};const jobs=[1,2,3].map(()=>store.transaction(()=>first.submit(detail.revision.id,input,context)));first.tick();second.tick();assert.equal(old.calls.length,2);assert.equal(fresh.calls.length,0,'global limit applies across services');
    now+=31_000;second.tick();assert.equal(fresh.calls.length,2);old.calls[0]!.finish(success());old.calls[1]!.finish(success());await delay(20);
    for(const job of jobs.slice(0,2)) {const state=second.get(detail.revision.id,job.id,context);assert.equal(state.attempt,2);assert.equal(state.status,'running');assert.deepEqual(state.artifacts,[]);assert.equal(state.attempts[0]!.status,'failed');}
    fresh.calls[0]!.finish(success());fresh.calls[1]!.finish(success());await until(()=>fresh.calls.length===3);fresh.calls[2]!.finish(success());await until(()=>jobs.every(job=>second.get(detail.revision.id,job.id,context).status==='succeeded'));
    assert.equal(store.database.prepare('SELECT count(*) AS total FROM paper_build_artifacts').get()!.total,15,'only current fences publish');
  }finally{for(const call of old.calls)call.finish(success());for(const call of fresh.calls)call.finish(success());await first.close();await second.close();secondStore.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('invalid compiler artifacts roll back publication as one transaction, and graceful stop leaves a durable recoverable job',async()=>{
  const fake=controlled();const app=await start(fake.runner);try{
    const made=await app.request<PaperBuild>(app.route,'POST',app.input,'alice','invalid-artifact');await until(()=>fake.calls.length===1);const result=success();result.artifacts[4]!.data=Buffer.from(JSON.stringify({origin:'top-left',units:'pt',pages:[{page:1,width:612,height:792}],points:[{path:'secret.tex',line:1,page:1,x:1,y:1,width:1,height:1}]}));fake.calls[0]!.finish(result);await until(()=>app.get(made.body.id).status==='failed');assert.deepEqual(app.get(made.body.id).artifacts,[]);assert.equal(app.store.database.prepare('SELECT count(*) AS total FROM paper_build_artifacts').get()!.total,0);
    const next=await app.request<PaperBuild>(app.route,'POST',app.input,'alice','shutdown');await until(()=>fake.calls.length===2);await app.paperBuilds.close();assert.equal(app.get(next.body.id).status,'queued');assert.equal(app.get(next.body.id).attempts[0]!.status,'failed');assert.equal(fake.calls[1]!.signal.aborted,true);
  }finally{await app.close();}
});

/** Historical fixture uses only the schema14 table definitions, never relabels a current Store. */
function oldSchema(path:string) {
  const db=new DatabaseSync(path);db.exec(`CREATE TABLE sequences(name TEXT PRIMARY KEY,value INTEGER NOT NULL);CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL);CREATE TABLE versions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),number INTEGER NOT NULL,data TEXT NOT NULL);CREATE TABLE thread_preferences(thread_id TEXT NOT NULL,principal_id TEXT NOT NULL,collapsed INTEGER NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(thread_id,principal_id));PRAGMA user_version=14;`);
  db.prepare('INSERT INTO entities VALUES(?,?,?)').run('P1','revision','{ "old" : "preserve raw bytes" }');db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run('v1','P1',1,'{ "immutable" : true }');db.prepare('INSERT INTO thread_preferences VALUES(?,?,?,?,?)').run('thread','alice',1,2,'2024-01-01');const rows=['entities','versions','thread_preferences'].map(table=>db.prepare(`SELECT * FROM ${table}`).all());db.close();return rows;
}
test('schema15 adds empty job/artifact storage without rewriting schema14 evidence and rolls failed migrations back',()=>{
  const directory=mkdtempSync(join(tmpdir(),'paper-migration-'));const path=join(directory,'workspace.sqlite');const old=oldSchema(path);let store:Store|undefined;
  try{
    const exec=DatabaseSync.prototype.exec;try{DatabaseSync.prototype.exec=function(sql:string){if(sql==='PRAGMA user_version = 15')throw new Error('Injected migration failure');return exec.call(this,sql);};assert.throws(()=>new Store({path}),/Injected migration failure/);}finally{DatabaseSync.prototype.exec=exec;}
    const db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,14);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='paper_builds'").get(),undefined);db.close();
    store=new Store({path});assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version,16);assert.deepEqual(['entities','versions','thread_preferences'].map(table=>store!.database.prepare(`SELECT * FROM ${table}`).all()),old);assert.deepEqual(store.database.prepare('SELECT * FROM paper_builds').all(),[]);assert.deepEqual(store.database.prepare('SELECT * FROM paper_build_artifacts').all(),[]);
  }finally{store?.close();rmSync(directory,{recursive:true,force:true});}
});

test('a locally active expired attempt cannot overwrite its own replacement bookkeeping; closing still aborts the replacement',async()=>{
  const store=new Store({path:':memory:'});const auth=createAuth({database:store.database,mode:'local',basePath:'/'});const policies=new PolicyStore(store.database,{principalExists:()=>true});const context=auth.authenticate({headers:{}} as IncomingMessage);let now=1_800_000_000_000;const fake=controlled(false);const service=new PaperBuildService(store,auth,policies,fake.runner,()=>now);
  try {
    const detail=store.createRevision({kind:'paper',title:'Local lease recovery',files:[{path:'main.tex',content:'Exact source'}]});const version=detail.versions[0]!;const build=store.transaction(()=>service.submit(detail.revision.id,{versionId:version.id,contentHash:version.contentHash,entrypoint:'main.tex',toolchainId:service.configuration.toolchainId!},context));service.tick();assert.equal(fake.calls.length,1);
    now+=31_000;service.tick();assert.equal(fake.calls[0]!.signal.aborted,true);assert.equal(fake.calls.length,1,'wait for the old local runner to settle before reclaiming its job');
    fake.calls[0]!.finish(success());await until(()=>fake.calls.length===2);assert.equal(service.get(detail.revision.id,build.id,context).attempt,2);
    const closing=service.close();assert.equal(fake.calls[1]!.signal.aborted,true,'replacement remains tracked for close');fake.calls[1]!.finish(success());await closing;assert.equal(service.get(detail.revision.id,build.id,context).status,'queued');assert.equal(service.get(detail.revision.id,build.id,context).artifacts.length,0);
  }finally{for(const call of fake.calls)call.finish(success());await service.close();store.close();}
});

test('queued jobs reauthorize before runner dispatch, and published bytes remain hidden after repository or Space revocation',async()=>{
  const fake=controlled();const app=await start(fake.runner);
  try {
    const first=await app.request<PaperBuild>(app.route,'POST',app.input,'bob','first-bob');const second=await app.request<PaperBuild>(app.route,'POST',app.input,'bob','second-bob');await until(()=>fake.calls.length===2);
    const queued=await app.request<PaperBuild>(app.route,'POST',app.input,'alice','queued-alice');assert.equal(app.get(queued.body.id).status,'queued');app.auth.revokeToken(app.alice.id,app.tokens.alice.record.id);
    fake.calls[0]!.finish(success());fake.calls[1]!.finish(success());await until(()=>app.get(queued.body.id).status==='failed');assert.equal(fake.calls.length,2,'revoked queued credential never reaches the runner');assert.equal(app.get(queued.body.id).attempt,0);
    assert.equal(app.get(first.body.id).status,'succeeded');assert.equal(app.get(second.body.id).status,'succeeded');app.policy('R1',{view:members(app.alice.id)},app.alice.id);
    for(const suffix of ['',`/${first.body.id}`,`/${first.body.id}/synctex`,`/${first.body.id}/artifacts/pdf`,`/${first.body.id}/artifacts/log`,`/${first.body.id}/artifacts/manifest`])assert.equal((await app.request(app.route+suffix,'GET',undefined,'bob')).status,404,suffix);
    assert.equal((await app.request(app.route,'POST',app.input,'bob','first-bob')).status,404,'saved idempotent receipt still requires current source access');
    app.policy('R1',{view:workspace},app.alice.id);const restricted=app.policies.createSpace({name:'Published source',view:workspace,edit:members(app.alice.id)},app.alice.id);app.policy(app.id,{spaceId:restricted.id});app.policies.updateSpace(restricted.id,{expectedVersion:restricted.version,name:restricted.name,view:members(app.alice.id),edit:members(app.alice.id)},app.alice.id);
    assert.equal((await app.request(`${app.route}/${first.body.id}/artifacts/pdf`,'GET',undefined,'bob')).status,404);
  }finally{await app.close();}
});

test('a manifest for another source or altered artifact digest cannot publish, and old toolchain retries are never upgraded implicitly',async()=>{
  const fake=controlled();const app=await start(fake.runner);
  try {
    const made=await app.request<PaperBuild>(app.route,'POST',app.input,'alice','bad-manifest');await until(()=>fake.calls.length===1);const result=success();result.artifacts.find(item=>item.kind==='manifest')!.data=Buffer.from(JSON.stringify({schema:1,revisionId:app.id,versionId:'another-version',contentHash:app.input.contentHash}));fake.calls[0]!.finish(result);await until(()=>app.get(made.body.id).status==='failed');assert.deepEqual(app.get(made.body.id).artifacts,[]);
    const other=new PaperBuildService(app.store,app.auth,app.policies,{...fake.runner,toolchain:{...toolchain,image:'sha256:'+'3'.repeat(64)}});
    try {const context=app.auth.authenticate({headers:{authorization:`Bearer ${app.tokens.alice.token}`}} as IncomingMessage);assert.throws(()=>app.store.transaction(()=>other.retry(app.id,made.body.id,{},context)),error=>error instanceof Error && 'code' in error && error.code==='PAPER_TOOLCHAIN_CHANGED');assert.equal(app.store.database.prepare('SELECT count(*) AS total FROM paper_builds').get()!.total,1);}finally{await other.close();}
  }finally{await app.close();}
});

test('large bounded source maps validate against a precomputed source-line index and reject an out-of-range final point atomically',async()=>{
  const store=new Store({path:':memory:'});const auth=createAuth({database:store.database,mode:'local',basePath:'/'});const policies=new PolicyStore(store.database,{principalExists:()=>true});const context=auth.authenticate({headers:{}} as IncomingMessage);const fake=controlled();const service=new PaperBuildService(store,auth,policies,fake.runner);
  try {
    const detail=store.createRevision({kind:'paper',title:'Large source map',files:[{path:'main.tex',content:Array.from({length:10_000},(_,index)=>`Line ${index+1}`).join('\n')}]});const version=detail.versions[0]!;const input={versionId:version.id,contentHash:version.contentHash,entrypoint:'main.tex',toolchainId:service.configuration.toolchainId!};
    const points=Array.from({length:100_000},(_,index)=>({path:'main.tex',line:index%10_000+1,page:1,x:1,y:1,width:1,height:1}));
    for(const valid of [true,false]) {
      const build=store.transaction(()=>service.submit(detail.revision.id,input,context));service.tick();const result=success();if(!valid)points[points.length-1]!.line=10_001;result.artifacts.find(item=>item.kind==='mapping')!.data=Buffer.from(JSON.stringify({origin:'top-left',units:'pt',pages:[{page:1,width:612,height:792}],points}));fake.calls.at(-1)!.finish(result);await until(()=>service.get(detail.revision.id,build.id,context).finishedAt!==null);const saved=service.get(detail.revision.id,build.id,context);assert.equal(saved.status,valid?'succeeded':'failed');assert.equal(saved.artifacts.length,valid?5:0);
    }
  }finally{await service.close();store.close();}
});

async function addFigure(app:Awaited<ReturnType<typeof start>>, marker:string) {
  const bytes=Buffer.from(`%PDF-1.4\n${marker}\n`); // A storage fixture, never passed to a real compiler.
  const uploaded=await app.request<FileRecord>('/api/files','POST',{name:'figure.pdf',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),dataBase64:bytes.toString('base64')},'alice',`upload-${marker}`);
  assert.equal(uploaded.status,201,JSON.stringify(uploaded.body));const file=uploaded.body;
  const before=app.store.detail(app.id),current=before.versions.at(-1)!;
  const asset:RevisionAsset={path:'figures/figure.pdf',fileId:file.id,sha256:file.sha256,bytes:file.bytes,mediaType:'application/pdf'};
  const updated=await app.request<RevisionDetail>(`/api/revisions/${app.id}/versions`,'POST',{files:current.files,assets:[asset],expectedVersion:current.number,expectedVersionId:current.id,expectedContentHash:current.contentHash,expectedAccessEpoch:app.policies.epoch(),shareAssets:true,message:'Pin the exact figure'},'alice',`attach-${marker}`);
  assert.equal(updated.status,201,JSON.stringify(updated.body));const version=updated.body.versions.at(-1)!;
  return {file,asset,bytes,version,input:{...app.input,versionId:version.id,contentHash:version.contentHash}};
}

test('binary build snapshots resolve exact historical bytes and publish schema2 manifests after later figure replacement',async()=>{
  const fake=controlled();const app=await start(fake.runner);
  try {
    const first=await addFigure(app,'original');
    assert.equal(first.version.contentHash,createHash('sha256').update(sourceSnapshotCanonical(first.version.files,[first.asset])).digest('hex'));
    const made=await app.request<PaperBuild>(app.route,'POST',first.input,'bob','first-figure-build');assert.equal(made.status,201);await until(()=>fake.calls.length===1);
    assert.deepEqual(fake.calls[0]!.input.assets?.map(({data,...asset})=>asset),[first.asset]);assert.deepEqual(Buffer.from(fake.calls[0]!.input.assets![0]!.data),first.bytes);
    const second=await addFigure(app,'replacement');assert.notEqual(second.version.contentHash,first.version.contentHash);
    fake.calls[0]!.finish(success());await until(()=>app.get(made.body.id).status==='succeeded');
    const manifest=await app.request<{schema:number;assets:RevisionAsset[]}>(`${app.route}/${made.body.id}/artifacts/manifest`);assert.equal(manifest.body.schema,2);assert.deepEqual(manifest.body.assets,[first.asset]);
    const retry=await app.request<PaperBuild>(`${app.route}/${made.body.id}/retry`,'POST',{},'bob','old-figure-retry');assert.equal(retry.status,201);await until(()=>fake.calls.length===2);assert.deepEqual(Buffer.from(fake.calls[1]!.input.assets![0]!.data),first.bytes);fake.calls[1]!.finish(success());await until(()=>app.get(retry.body.id).status==='succeeded');
    const forged=await app.request<PaperBuild>(app.route,'POST',second.input,'bob','forged-figure-manifest');await until(()=>fake.calls.length===3);const result=success();const wrong=compilerManifest(fake.calls[2]!.input,result);wrong.assets![0]!.sha256=first.asset.sha256;result.artifacts.find(item=>item.kind==='manifest')!.data=Buffer.from(JSON.stringify(wrong));fake.calls[2]!.finish(result);await until(()=>app.get(forged.body.id).status==='failed');assert.deepEqual(app.get(forged.body.id).artifacts,[]);
  } finally {await app.close();}
});

test('figure Space revocation fences running and queued builds and hides already published historical artifacts',async()=>{
  const fake=controlled(false);const app=await start(fake.runner);
  try {
    const figure=await addFigure(app,'permission-figure');
    const done=await app.request<PaperBuild>(app.route,'POST',figure.input,'bob','published-figure');await until(()=>fake.calls.length===1);fake.calls[0]!.finish(success());await until(()=>app.get(done.body.id).status==='succeeded');
    const running=await app.request<PaperBuild>(app.route,'POST',figure.input,'bob','running-figure');const other=await app.request<PaperBuild>(app.route,'POST',figure.input,'bob','other-figure');await until(()=>fake.calls.length===3);
    const queued=await app.request<PaperBuild>(app.route,'POST',figure.input,'bob','queued-figure');assert.equal(app.get(queued.body.id).status,'queued');
    const space=app.policies.createSpace({name:'Private figure source',view:members(app.alice.id),edit:members(app.alice.id)},app.alice.id);app.policy(figure.file.id,{spaceId:space.id},app.alice.id);
    fake.calls[1]!.finish(success());fake.calls[2]!.finish(success());await until(()=>[running,other,queued].every(item=>app.get(item.body.id).status==='failed'));assert.equal(fake.calls.length,3,'Hidden queued figures never reach the worker');
    for(const item of [running,other,queued])assert.deepEqual(app.get(item.body.id).artifacts,[]);
    for(const suffix of ['',`/${done.body.id}`,`/${done.body.id}/synctex`,...['pdf','manifest','log','mapping','synctex'].map(kind=>`/${done.body.id}/artifacts/${kind}`)])assert.equal((await app.request(app.route+suffix,'GET',undefined,'bob')).status,404,suffix);
    assert.equal((await app.request(app.route,'POST',figure.input,'bob','published-figure')).status,404,'Replay must still reauthorize all historical figures');
  } finally {for(const call of fake.calls)call.finish({success:false,artifacts:[],diagnostics:[],error:'test cleanup'});await app.close();}
});
