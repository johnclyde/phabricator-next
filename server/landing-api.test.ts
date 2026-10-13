import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import { createGitObserver } from './git.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionLandingDetail, RevisionLandingPrepareInput, RevisionLandingSnapshot } from '../shared/revision-landing.ts';
import type { HeraldRule, HeraldRuleInput } from '../shared/herald.ts';
import { resolveRevisionPatch } from './revision-patch.ts';
import { HttpError } from './validation.ts';

const members=(...principalIds:string[])=>({kind:'principals' as const,principalIds});
const rule:HeraldRuleInput={name:'Reject landing source',contentType:'push-content',ruleType:'global',objectId:null,enabled:true,match:'all',repetition:'every',conditions:[{field:'always',operator:'true',value:null}],actions:[{type:'block-push',value:'A private rule explanation.'}]};
async function start(basePath='/') {
  const git=await createGitFixture(),store=new Store({path:':memory:'}),provision=createAuth({database:store.database,mode:'local',basePath:'/',provisioning:true});
  const alice=await provision.createAccount({username:'alice',displayName:'Alice Author',password:'Alice landing API fixture password'}),bob=await provision.createAccount({username:'bob',displayName:'Bob Editor',password:'Bob landing API fixture password'});
  const app=createApp({store,seed:false,authMode:'password',basePath,gitRepositories:{R1:git.barePath},landingBindings:[{key:'local',repositoryId:'R1',repositoryPath:git.barePath,branches:['refs/heads/main']}],automation:{managers:['alice']}});await app.automation.close();
  const actor:ActorAttribution={principalId:alice.id,displayName:alice.displayName,credentialId:null,requestId:'landing-source'};
  store.createRepository({name:'Landing source',remoteUrl:'https://example.invalid/never-fetched.git'});
  const tokens={alice:app.auth.createToken(alice.id,{name:'Author',scopes:['read','write']}).token,bob:app.auth.createToken(bob.id,{name:'Editor',scopes:['read','write']}).token,reader:app.auth.createToken(alice.id,{name:'Read only',scopes:['read']}).token};
  const observer=createGitObserver({R1:git.barePath}),snapshot=await observer.importSnapshot('R1',git.importNextCommit);
  await git.git(['update-ref','refs/heads/main',git.importCommit]);
  const revision=store.createRevisionFromGit('R1',{commitId:git.importNextCommit,kind:'code',title:'Accepted source',summary:'Frozen commit message',testPlan:'Inspect this exact version.'},snapshot,actor),id=revision.revision.id;
  function accept(){const current=store.detail(id).revision.currentVersion;store.saveReview(id,current,{provider:'local',model:'fixture-check',summary:'Exact local evidence',findings:[]},actor);const s=store.revisionLifecycle.snapshot(id,alice.id);store.revisionLifecycle.mutate(id,{action:'accept_reviewed',message:'Accept exact tested source.',expectedLifecycleVersion:s.lifecycle.version,expectedAuthorVersion:s.authorship.version,expectedReviewerVersion:s.reviewers.version,expectedVersion:s.head.number,expectedVersionId:s.head.versionId,expectedContentHash:s.head.contentHash,expectedAccessEpoch:app.policies.epoch(),expectedConfigId:s.configId,expectedEvidenceSha256:s.evidence.sha256},actor);}
  accept();await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath.replace(/\/$/,'')}`;
  async function request<T={error:string;code?:string}>(path:string,method='GET',body?:unknown,who:keyof typeof tokens='alice',key=randomUUID()) {const response=await fetch(origin+path,{method,signal:AbortSignal.timeout(30_000),headers:{Authorization:`Bearer ${tokens[who]}`,...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as T};}
  const path=`/api/revisions/${id}/landings`;
  const input=async(baseCommitId=git.importCommit):Promise<RevisionLandingPrepareInput>=>{const read=await request<RevisionLandingSnapshot>(path);assert.equal(read.status,200,JSON.stringify(read.body));return {...read.body.pins,binding:'local',branch:'refs/heads/main',baseCommitId,expectedTargetCommitId:baseCommitId};};
  const prepare=async()=>{const data=await input(),key=randomUUID(),result=await request<RevisionLandingDetail>(path,'POST',data,'alice',key);assert.equal(result.status,201,JSON.stringify(result.body));return {data,key,detail:result.body,commands:`/api/landings/${result.body.operation.id}/commands`};};
  const policy=(subject:string,changes:Record<string,unknown>,principalId=alice.id)=>{const current=app.policies.policy(subject,principalId);app.policies.setPolicy(subject,{expectedVersion:current.version,spaceId:current.spaceId,...current.rules,...changes},principalId);};
  return {...app,git,observer,alice,bob,actor,id,path,request,input,prepare,accept,policy,close:async()=>{await app.close();store.close();await git.close();}};
}

test('mounted landing API prepares an imported revision against its parent and lands, closes and replays exact evidence',async()=>{
  const app=await start('/mounted/');try{
    const snapshot=await app.request<RevisionLandingSnapshot>(app.path);assert.equal(snapshot.body.canPrepare,true);assert.equal(snapshot.body.suggestedBaseCommitId,app.git.importCommit);assert.equal(JSON.stringify(snapshot.body).includes(app.git.barePath),false);
    assert.equal((await app.request(app.path,'POST',await app.input(),'reader')).status,403);assert.equal((await app.request(app.path,'POST',await app.input(),'bob')).status,403);
    const prepared=await app.prepare();assert.equal(prepared.detail.canLand,true);assert.equal(prepared.detail.canRecover,false);assert.equal((await app.git.git(['rev-parse','refs/heads/main'])).trim(),app.git.importCommit);
    const command={command:'land',expectedVersion:1},key=randomUUID(),landed=await app.request<RevisionLandingDetail>(prepared.commands,'POST',command,'alice',key);assert.equal(landed.status,200,JSON.stringify(landed.body));assert.equal(landed.body.operation.state,'landed');assert.equal(app.store.detail(app.id).revision.status,'closed');assert.ok(landed.body.operation.gateProof);
    const commit=await app.observer.commit('R1',landed.body.operation.prepared.commitId);assert.deepEqual(commit.commit.parentIds,[app.git.importCommit]);assert.equal(commit.commit.treeId,app.store.detail(app.id).versions[0]!.gitSource!.treeId);assert.match(commit.commit.message,/Frozen commit message/);
    const replay=await app.request<RevisionLandingDetail>(prepared.commands,'POST',command,'alice',key);assert.deepEqual(replay,landed);
    const old=await app.request<RevisionLandingDetail>(app.path,'POST',prepared.data,'alice',prepared.key);assert.equal(old.status,201);assert.deepEqual(old.body.operation,prepared.detail.operation);assert.equal(old.body.canLand,false,'historical prepared receipt never grants another execution');assert.equal(old.body.canCancel,false);
    assert.equal(app.store.database.prepare('SELECT count(*) AS n FROM git_receive_records').get()!.n,2);assert.equal(app.store.database.prepare('SELECT count(*) AS n FROM revision_landing_events').get()!.n,2);
    const stored=app.store.database.prepare('SELECT key,body FROM idempotency WHERE key LIKE ?').get(`%:${prepared.key}`) as {key:string;body:string};
    const forged=JSON.parse(stored.body) as RevisionLandingDetail;forged.operation.prepared.message='FORGED message';app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(forged),stored.key);assert.equal((await app.request(app.path,'POST',prepared.data,'alice',prepared.key)).status,409);
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(stored.body,stored.key);assert.equal((await app.request(app.path,'POST',prepared.data,'alice',prepared.key)).status,201);
  }finally{await app.close();}
});

test('landing pins reject stale lifecycle, evidence, source, access and metadata before changing Git',async()=>{
  const app=await start();try{
    const data=await app.input();for(const change of [{expectedLifecycleVersion:99},{expectedAuthorVersion:99},{expectedReviewerVersion:99},{expectedMetadataVersion:99},{expectedVersion:99},{expectedVersionId:'other-version'},{expectedContentHash:'a'.repeat(64)},{expectedEvidenceSha256:'b'.repeat(64)},{expectedConfigId:'c'.repeat(64)},{expectedAccessEpoch:99}])assert.equal((await app.request(app.path,'POST',{...data,...change})).status,409,JSON.stringify(change));
    const prepared=await app.prepare();app.store.saveReview(app.id,1,{provider:'local',model:'later-check',summary:'Additional evidence must be inspected',findings:[]},app.actor);
    assert.equal((await app.request(prepared.commands,'POST',{command:'land',expectedVersion:1})).status,409);assert.equal((await app.request(prepared.commands,'POST',{command:'cancel',expectedVersion:1})).status,200);
    const second=await app.prepare();const head=app.store.detail(app.id).versions[0]!;app.store.createVersion(app.id,{expectedVersion:1,expectedVersionId:head.id,expectedContentHash:head.contentHash,files:head.files.map((file,index)=>({...file,content:file.content+(index===0?'\nNew unaccepted content':'')})),message:'A new source invalidates acceptance.'},app.actor);
    assert.equal((await app.request(second.commands,'POST',{command:'land',expectedVersion:1})).status,409);assert.equal((await app.git.git(['rev-parse','refs/heads/main'])).trim(),app.git.importCommit);assert.equal((await app.request<RevisionLandingSnapshot>(app.path)).body.canPrepare,false);
  }finally{await app.close();}
});

test('edited revision landing retains reviewed executable modes when the explicit target base differs',async()=>{
  const app=await start();try{
    const old=await app.observer.importSnapshot('R1',app.git.importCommit),current=app.store.detail(app.id).versions[0]!;
    app.store.createVersionFromGit(app.id,{commitId:app.git.importCommit,expectedVersion:1,expectedVersionId:current.id,expectedContentHash:current.contentHash,message:'Import executable baseline.'},old,app.actor);
    const imported=app.store.detail(app.id).versions.find(version=>version.number===2)!;app.store.createVersion(app.id,{expectedVersion:2,expectedVersionId:imported.id,expectedContentHash:imported.contentHash,files:imported.files.map((file,index)=>({...file,content:file.content+(index===0?'\nReviewed edit':'')})),message:'Edited source retains baseline modes.'},app.actor);app.accept();
    await app.git.git(['update-ref','refs/heads/main',app.git.importNextCommit]);const detail=app.store.detail(app.id),head=detail.versions.find(version=>version.number===3)!,reviewed=resolveRevisionPatch('R1',detail.versions,head.id,head.contentHash);
    const prepared=await app.request<RevisionLandingDetail>(app.path,'POST',await app.input(app.git.importNextCommit));assert.equal(prepared.status,201,JSON.stringify(prepared.body));assert.equal(prepared.body.operation.prepared.treeId,reviewed.targetTreeId);
    const result=await app.request<RevisionLandingDetail>(`/api/landings/${prepared.body.operation.id}/commands`,'POST',{command:'land',expectedVersion:1});assert.equal(result.status,200,JSON.stringify(result.body));const landed=await app.observer.importSnapshot('R1',result.body.operation.prepared.commitId);assert.equal(landed.provenance.manifest.find(file=>file.path==='tools/check.sh')!.mode,'100755');
  }finally{await app.close();}
});

test('Herald receives the exact prepared source and can reject landing without writing branch or markers',async()=>{
  const app=await start();try{
    const ruleResult=await app.request<{rule:HeraldRule}>('/api/herald/rules','POST',rule);assert.equal(ruleResult.status,201);const prepared=await app.prepare();
    const rejected=await app.request<RevisionLandingDetail>(prepared.commands,'POST',{command:'land',expectedVersion:1});assert.equal(rejected.status,200,JSON.stringify(rejected.body));assert.equal(rejected.body.operation.state,'conflict');assert.match(rejected.body.operation.message,/Herald/);assert.equal(JSON.stringify(rejected.body).includes('private rule explanation'),false);assert.equal(app.landing.transport.state(prepared.detail.operation.prepared),'ready');assert.equal(app.store.detail(app.id).revision.status,'accepted');
    const rows=app.store.database.prepare('SELECT data FROM git_receive_records').all() as {data:string}[];assert.equal(rows.length,1);const receipt=JSON.parse(rows[0]!.data) as {facts:{updates:{newId:string}[]};receipt:{allowed:boolean}};assert.equal(receipt.receipt.allowed,false);assert.equal(receipt.facts.updates[0]!.newId,prepared.detail.operation.prepared.commitId);
  }finally{await app.close();}
});

test('landing API exposes explicit recovery after Git success and SQLite failure, preserving newer source and moved branch',async()=>{
  const app=await start();try{
    const prepared=await app.prepare(),command={command:'land',expectedVersion:1},key=randomUUID(),original=app.store.revisionLifecycle.mutate.bind(app.store.revisionLifecycle);
    app.store.revisionLifecycle.mutate=()=>{throw new HttpError(503,'Simulated finalization interruption.');};
    assert.equal((await app.request(prepared.commands,'POST',command,'alice',key)).status,503);app.store.revisionLifecycle.mutate=original;
    assert.equal((await app.git.git(['rev-parse','refs/heads/main'])).trim(),prepared.detail.operation.prepared.commitId);assert.equal(app.landing.records.detail(prepared.detail.operation.id,app.actor).operation.state,'prepared');assert.equal(app.store.database.prepare('SELECT count(*) AS n FROM git_receive_records').get()!.n,0,'rolled-back pre/post receipts are not invented');
    const head=app.store.detail(app.id).versions[0]!;app.store.createVersion(app.id,{expectedVersion:1,expectedVersionId:head.id,expectedContentHash:head.contentHash,files:head.files.map((file,index)=>({...file,content:file.content+(index===0?'\nLater work':'')})),message:'Work after the successful external landing.'},app.actor);await app.git.git(['update-ref','refs/heads/main',app.git.feature]);
    assert.equal((await app.request('/api/herald/rules','POST',rule)).status,201);
    const status=await app.request<RevisionLandingDetail>(`/api/landings/${prepared.detail.operation.id}`);assert.equal(status.body.canRecover,true);assert.equal(status.body.canLand,false);assert.equal(status.body.canCancel,false);
    const recovered=await app.request<RevisionLandingDetail>(prepared.commands,'POST',command,'alice',key);assert.equal(recovered.status,200,JSON.stringify(recovered.body));assert.equal(recovered.body.operation.state,'landed');assert.match(recovered.body.operation.message,/Recovered/);assert.ok(recovered.body.operation.gateProof);assert.equal(app.store.detail(app.id).revision.status,'needs_review');assert.equal((await app.git.git(['rev-parse','refs/heads/main'])).trim(),app.git.feature);
    const rows=app.store.database.prepare('SELECT phase FROM git_receive_records').all();assert.deepEqual(rows.map(row=>row.phase),['post'],'recovery does not fabricate or rerun pre-push decisions');
  }finally{await app.close();}
});

test('landing reads, operations and saved receipts obey current repository and Space authority',async()=>{
  const app=await start();try{
    const prepared=await app.prepare();assert.equal((await app.request(prepared.commands,'POST',{command:'land',expectedVersion:1},'bob')).status,403);
    app.policy('R1',{edit:members(app.bob.id)},app.bob.id);assert.equal((await app.request(prepared.commands,'POST',{command:'land',expectedVersion:1})).status,403);assert.equal((await app.request<RevisionLandingDetail>(`/api/landings/${prepared.detail.operation.id}`)).body.canLand,false);
    const space=app.policies.createSpace({name:'Restricted repository',view:members(app.bob.id),edit:members(app.bob.id)},app.bob.id);app.policy('R1',{spaceId:space.id},app.bob.id);
    for(const path of [app.path,`/api/landings/${prepared.detail.operation.id}`])assert.equal((await app.request(path)).status,404);
    assert.equal((await app.request(app.path,'POST',prepared.data,'alice',prepared.key)).status,404);assert.equal((await app.request(prepared.commands,'POST',{command:'land',expectedVersion:1})).status,404);assert.equal((await app.git.git(['rev-parse','refs/heads/main'])).trim(),app.git.importCommit);
  }finally{await app.close();}
});

test('landing preserves a complete valid long Unicode revision summary in the commit and receive evidence',async()=>{
  const app=await start();try{
    const snapshot=app.store.revisionMetadata.snapshot(app.id),summary='界'.repeat(90_000);
    app.store.revisionMetadata.mutate(app.id,{title:snapshot.metadata.title,summary,testPlan:snapshot.metadata.testPlan??'',message:'Complete metadata.',expectedMetadataVersion:snapshot.metadata.version,expectedVersion:snapshot.head.number,expectedVersionId:snapshot.head.versionId,expectedContentHash:snapshot.head.contentHash,expectedAccessEpoch:app.policies.epoch(),expectedConfigId:snapshot.configId},app.actor);
    const prepared=await app.prepare();assert.ok(prepared.detail.operation.prepared.message.includes(summary));
    const landed=await app.request<RevisionLandingDetail>(prepared.commands,'POST',{command:'land',expectedVersion:1});assert.equal(landed.status,200,JSON.stringify(landed.body).slice(0,300));assert.equal(landed.body.operation.state,'landed');
    const raw=await app.git.git(['cat-file','commit',landed.body.operation.prepared.commitId]);assert.ok(raw.includes(summary));
    const saved=app.store.database.prepare("SELECT data FROM git_receive_records WHERE phase='pre'").get() as {data:string};assert.ok(saved.data.includes(summary));
  }finally{await app.close();}
});
