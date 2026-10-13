import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { createGitFixture, type GitFixture } from '../tests/git-fixture.ts';
import type { DrydockClaim, DrydockBlueprint } from '../shared/drydock.ts';
import { createGitObserver } from './git.ts';
import { LocalDrydockWorker, parseDrydockWorkerConfiguration, runDrydockWorkerCycle } from './drydock-worker.ts';
import { DrydockStore, initializeDrydock } from './drydock.ts';
import { resolveRevisionPatch, revisionPatchIdentity } from './revision-patch.ts';
import { sourceSnapshotCanonical } from '../shared/source-snapshot.ts';
import type { RevisionVersion, SourceFile } from '../shared/types.ts';

const exec=promisify(execFile);
async function claimFor(fixture:GitFixture,commitId=fixture.importCommit):Promise<DrydockClaim>{const source=await createGitObserver({R1:fixture.barePath}).commit('R1',commitId),createdAt=new Date().toISOString(),blueprint:DrydockBlueprint={id:'DDB-example',version:1,ownerId:'alice',type:'working-copy',name:'Local',description:'',enabled:true,repositoryId:'R1',binding:'main',worker:'local',limit:2,createdAt,updatedAt:createdAt},pins={repositoryId:'R1',commitId,treeId:source.commit.treeId,objectFormat:source.objectFormat},id=`DDR-${randomUUID()}`,leaseId=`DDL-${randomUUID()}`;return {operation:'provision',token:'fenced',claimUntil:new Date(Date.now()+300_000).toISOString(),lease:{id:leaseId,version:2,blueprintId:blueprint.id,blueprintVersion:1,blueprint,authorizationId:'DDA-example',source:pins,status:'acquired',holderId:'alice',buildId:null,targetId:null,resourceId:id,createdAt,updatedAt:createdAt,expiresAt:new Date(Date.now()+3_600_000).toISOString(),reason:''},resource:{id,version:1,blueprintId:blueprint.id,leaseId,status:'pending',binding:'main',worker:'local',workerPrincipalId:'worker',handle:id,source:pins,createdAt,updatedAt:createdAt}};}
async function configured(fixture:GitFixture,now?:()=>number){const root=await realpath(fixture.root),path=join(root,'worker');return new LocalDrydockWorker(parseDrydockWorkerConfiguration({server:'https://example.test/instance',worker:'local',bindings:{main:{repositoryId:'R1',repositoryPath:fixture.barePath,root:path}}}),now);}
async function commitFiles(fixture:GitFixture,files:Record<string,Buffer|string>):Promise<string>{const entries:string[]=[];for(const [path,bytes]of Object.entries(files)){const blob=(await fixture.git(['hash-object','-w','--stdin'],bytes)).trim();entries.push(`100644 blob ${blob}\t${path}\0`);}const tree=(await fixture.git(['mktree','-z'],entries.join(''))).trim();return (await fixture.git(['commit-tree',tree],'Worker fixture\n')).trim();}
for(const format of ['sha1','sha256'] as const)test(`local worker materializes verified ${format} objects and cleans only owned directories`,async()=>{const fixture=await createGitFixture(format);try{const worker=await configured(fixture),claim=await claimFor(fixture);const copy=await worker.provision(claim);assert.equal(await readFile(join(copy.path,'docs/paper.tex'),'utf8'),'\\section{Introduction}\nAn immutable paper snapshot.\n');assert.equal((await lstat(join(copy.path,'tools/check.sh'))).mode&0o100,0o100);assert.equal((await exec('git',['-C',copy.path,'rev-parse','HEAD'])).stdout.trim(),claim.lease.source.commitId);assert.equal((await exec('git',['-C',copy.path,'status','--porcelain'])).stdout,'');assert.equal((await exec('git',['-C',copy.path,'rev-list','--count','HEAD'])).stdout.trim(),'1');assert.deepEqual(await worker.provision(claim),copy);await worker.release(claim);await assert.rejects(lstat(copy.path),{code:'ENOENT'});await worker.release(claim);assert.equal((await lstat(fixture.barePath)).isDirectory(),true);}finally{await fixture.close();}});
test('worker preserves binary bytes and literal CRLF without executing source, attributes, templates or hooks',async()=>{const fixture=await createGitFixture();try{const binary=Buffer.from([1,0,2,255,128]),commit=await commitFiles(fixture,{'binary.dat':binary,'text.txt':'literal\r\n','danger.sh':'#!/bin/sh\ntouch /tmp/DO-NOT-RUN-DRYDOCK\n','.gitattributes':'* filter=evil\ntext.txt text eol=lf\n'}),worker=await configured(fixture),claim=await claimFor(fixture,commit),copy=await worker.provision(claim);assert.deepEqual(await readFile(join(copy.path,'binary.dat')),binary);assert.equal(await readFile(join(copy.path,'text.txt'),'utf8'),'literal\r\n');assert.equal((await readdir(join(copy.path,'.git'))).includes('hooks'),false);await worker.release(claim);}finally{await fixture.close();}});
test('worker rejects symlinks, colliding paths, .git injection and mismatched source pins and removes partial copies',async()=>{const fixture=await createGitFixture();try{const worker=await configured(fixture);for(const commit of [fixture.head,await commitFiles(fixture,{'Name':'one','name':'two'}),await commitFiles(fixture,{'.git':'injected'}),await commitFiles(fixture,{'.gi\u200ct':'injected'}),await commitFiles(fixture,{'git~1':'injected'}),await commitFiles(fixture,{'straße':'one','STRASSE':'two'})]){const claim=await claimFor(fixture,commit);await assert.rejects(worker.provision(claim));assert.equal((await readdir(worker.configuration.bindings.main!.root)).some(name=>name===claim.resource.id),false);}const mismatch=await claimFor(fixture);mismatch.lease.source.treeId='f'.repeat(40);mismatch.resource.source=mismatch.lease.source;await assert.rejects(worker.provision(mismatch));}finally{await fixture.close();}});
test('worker cleanup rejects substituted resource symlinks and unrelated nonempty storage roots',async()=>{const fixture=await createGitFixture();try{const worker=await configured(fixture),claim=await claimFor(fixture),copy=await worker.provision(claim),outside=join(await realpath(fixture.root),'outside');await mkdir(outside);await writeFile(join(outside,'keep'),'owned by someone else');await rm(join(worker.configuration.bindings.main!.root,claim.resource.id),{recursive:true});await symlink(outside,join(worker.configuration.bindings.main!.root,claim.resource.id));await assert.rejects(worker.release(claim));assert.equal(await readFile(join(outside,'keep'),'utf8'),'owned by someone else');const bad=new LocalDrydockWorker({...worker.configuration,bindings:{main:{...worker.configuration.bindings.main!,root:outside}}});await assert.rejects(bad.provision(await claimFor(fixture)));assert.ok(copy.path.endsWith('/work'));}finally{await fixture.close();}});
test('worker reconnects after cached expiry, preserves a server-renewed copy and still reaps after token revocation',async()=>{const fixture=await createGitFixture(),database=new DatabaseSync(':memory:');let now=Date.now();try{initializeDrydock(database);const alice={principalId:'alice',displayName:'Alice',workspaceId:'workspace'},actor={principalId:'worker',displayName:'Worker',workspaceId:'workspace'},drydock=new DrydockStore(database,{authorize(){},mayManage:()=>true,allowBinding(){},worker(){},subject(){}},()=>now),blueprint=drydock.createBlueprint({name:'Local',description:'',enabled:true,repositoryId:'R1',binding:'main',worker:'local',limit:1},alice),authorization=drydock.requestAuthorization(blueprint.id,{subjectKind:'principal',subjectId:'alice'},alice);drydock.authorizationCommand(authorization.id,{expectedVersion:authorization.version,status:'approved'},alice);const source=await createGitObserver({R1:fixture.barePath}).commit('R1',fixture.importCommit),detail=drydock.request(source,{blueprintId:blueprint.id,blueprintVersion:1},alice),worker=await configured(fixture,()=>now);let dropReceipt=true;const reportKeys:string[]=[];
 const fetcher:typeof fetch=async(input,init)=>{const url=new URL(String(input)),path=url.pathname.replace('/instance/api/drydock',''),body=init?.body?JSON.parse(String(init.body)):undefined;let result:unknown;if(path.startsWith('/worker/jobs'))result={jobs:drydock.jobs('local',actor)};else if(path.endsWith('/claim'))result=drydock.claim(path.split('/')[2]!,body,actor);else if(path.endsWith('/report')){reportKeys.push((init?.headers as Record<string,string>)['Idempotency-Key']!);result=drydock.report(path.split('/')[2]!,body,actor);if(dropReceipt){dropReceipt=false;throw new Error('Ambiguous connection loss');}}else result=drydock.detail(path.split('/')[2]!,actor);return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});};
 await runDrydockWorkerCycle(worker,'private-test-token',fetcher);const active=drydock.detail(detail.lease.id,alice);assert.equal(active.lease.status,'active');assert.equal(reportKeys.length,2);assert.equal(reportKeys[0],reportKeys[1]);const path=join(worker.configuration.bindings.main!.root,active.resource!.id,'work');assert.equal((await lstat(path)).isDirectory(),true);
 const cachedExpiry=Date.parse(active.lease.expiresAt);
 now+=3_000_000;
 const renewed=drydock.command(active.lease.id,{command:'renew',expectedVersion:active.lease.version,durationSeconds:3600},alice);
 // The renewal happens while the worker is disconnected. Its next poll begins
 // after the stale local deadline, but before the new authoritative deadline.
 now+=700_000;
 assert.ok(now>cachedExpiry&&now<Date.parse(renewed.lease.expiresAt));
 const sentinel=join(path,'worker-retained-copy');await writeFile(sentinel,'same checkout');
 await runDrydockWorkerCycle(worker,'private-test-token',fetcher);
 assert.equal(await readFile(sentinel,'utf8'),'same checkout');
 assert.equal(await worker.reapExpired(),0);
 now+=3_000_000;await assert.rejects(runDrydockWorkerCycle(worker,'disabled-token',async()=>new Response('{}',{status:401})));await assert.rejects(lstat(path),{code:'ENOENT'});
 }finally{database.close();await fixture.close();}});
test('worker rejects unconfigured roots and nonlocal plaintext endpoints',()=>{for(const server of ['http://example.test','https://user:password@example.test','https://example.test/?token=secret'])assert.throws(()=>parseDrydockWorkerConfiguration({server,worker:'local',bindings:{}}));assert.throws(()=>parseDrydockWorkerConfiguration({server:'https://example.test',worker:'local',bindings:{main:{repositoryId:'R1',repositoryPath:'relative',root:'/tmp/root'}}}));});

test('worker verifies raw object hashes instead of trusting object filenames',async()=>{const fixture=await createGitFixture();try{const claim=await claimFor(fixture),objectPath=join(fixture.barePath,'objects',fixture.readmeBlob.slice(0,2),fixture.readmeBlob.slice(2)),payload=Buffer.from('corrupted bytes\n');await chmod(objectPath,0o600);await writeFile(objectPath,deflateSync(Buffer.concat([Buffer.from(`blob ${payload.length}\0`),payload])));const worker=await configured(fixture);await assert.rejects(worker.provision(claim));assert.equal((await readdir(worker.configuration.bindings.main!.root)).includes(claim.resource.id),false);}finally{await fixture.close();}});

for (const failure of ['network', 'server', 'token'] as const) test(`failed ${failure} reconciliation still reaps cached-expired copies and retains unexpired copies`, async () => {
  const fixture = await createGitFixture();
  let now = Date.now();
  try {
    const worker = await configured(fixture, () => now);
    const expired = await claimFor(fixture), current = await claimFor(fixture);
    current.lease.expiresAt = new Date(Date.parse(expired.lease.expiresAt) + 3_600_000).toISOString();
    const expiredCopy = await worker.provision(expired), currentCopy = await worker.provision(current);
    now = Date.parse(expired.lease.expiresAt) + 1;
    const fetcher: typeof fetch = async () => {
      if (failure === 'network') throw new Error('Worker disconnected');
      return new Response('{}', { status: failure === 'server' ? 503 : 401 });
    };
    await assert.rejects(runDrydockWorkerCycle(worker, 'test-token', fetcher), /disconnected|503|401/);
    await assert.rejects(lstat(expiredCopy.path), { code: 'ENOENT' });
    assert.equal((await lstat(currentCopy.path)).isDirectory(), true);
  } finally {
    await fixture.close();
  }
});

async function patchedClaim(fixture: GitFixture, edit: (files: SourceFile[]) => SourceFile[] = files => files): Promise<DrydockClaim> {
  const snapshot = await createGitObserver({ R1: fixture.barePath }).importSnapshot('R1', fixture.importCommit);
  const makeVersion = (files: SourceFile[], number: number): RevisionVersion => ({ id: `version-${number}`, revisionId: 'D1', number, files, message: 'Reviewed source', contentHash: createHash('sha256').update(sourceSnapshotCanonical(files)).digest('hex'), createdAt: new Date().toISOString() });
  const base = { ...makeVersion(snapshot.files, 1), gitSource: snapshot.provenance }, target = makeVersion(edit(snapshot.files.map(file => ({ ...file }))), 2);
  const patch = resolveRevisionPatch('R1', [base, target], target.id, target.contentHash), claim = await claimFor(fixture);
  claim.patch = patch; claim.lease.source.revisionPatch = revisionPatchIdentity(patch); claim.resource.source = structuredClone(claim.lease.source); return claim;
}

for (const format of ['sha1', 'sha256'] as const) test(`worker stages the exact reviewed ${format} revision tree on its verified baseline`, async () => {
  const fixture = await createGitFixture(format);
  try {
    const claim = await patchedClaim(fixture, files => [
      ...files.filter(file => file.path !== 'name with spaces.md' && !file.path.startsWith('docs/')).map(file => ({ ...file, content: file.path === 'README.md' ? 'Reviewed change\r\nNo final newline' : file.content })),
      { path: 'docs', content: 'A directory replaced by a file.\n' },
      { path: 'new/entry.tex', content: '\\section{Reviewed}\r\n' },
      { path: '.gitattributes', content: '* filter=evil\n* text eol=lf\n' },
    ]), worker = await configured(fixture), copy = await worker.provision(claim);
    assert.equal(await readFile(join(copy.path, 'README.md'), 'utf8'), 'Reviewed change\r\nNo final newline');
    assert.equal(await readFile(join(copy.path, 'docs'), 'utf8'), 'A directory replaced by a file.\n');
    assert.equal(await readFile(join(copy.path, 'new/entry.tex'), 'utf8'), '\\section{Reviewed}\r\n');
    await assert.rejects(lstat(join(copy.path, 'name with spaces.md')), { code: 'ENOENT' });
    assert.equal((await lstat(join(copy.path, 'tools/check.sh'))).mode & 0o100, 0o100);
    assert.equal((await exec('git', ['-C', copy.path, 'rev-parse', 'HEAD'])).stdout.trim(), claim.lease.source.commitId);
    assert.equal((await exec('git', ['-C', copy.path, 'write-tree'])).stdout.trim(), claim.patch!.targetTreeId);
    const staged = (await exec('git', ['-C', copy.path, 'diff', '--cached', '--name-status'])).stdout;
    assert.match(staged, /M\s+README\.md/); assert.match(staged, /D\s+name with spaces\.md/); assert.match(staged, /A\s+new\/entry\.tex/);
    assert.deepEqual(await worker.provision(claim), copy);
    await worker.release(claim); await assert.rejects(lstat(copy.path), { code: 'ENOENT' });
  } finally { await fixture.close(); }
});

test('worker rejects missing, substituted and corrupt revision patch payloads before readiness', async () => {
  const fixture = await createGitFixture();
  try {
    const worker = await configured(fixture), original = await patchedClaim(fixture, files => files.map(file => ({ ...file, content: file.path === 'README.md' ? 'Reviewed\n' : file.content })));
    for (const mutate of [
      (claim: DrydockClaim) => { delete claim.patch; },
      (claim: DrydockClaim) => { delete claim.lease.source.revisionPatch; delete claim.resource.source.revisionPatch; },
      (claim: DrydockClaim) => { claim.patch!.files[0]!.content = 'Unreviewed'; },
      (claim: DrydockClaim) => { claim.lease.source.revisionPatch!.versionId = 'another-version'; claim.resource.source = structuredClone(claim.lease.source); },
      (claim: DrydockClaim) => { claim.lease.source.treeId = 'f'.repeat(40); claim.resource.source = structuredClone(claim.lease.source); },
    ]) { const claim = structuredClone(original); mutate(claim); await assert.rejects(worker.provision(claim)); }
    const copy = await worker.provision(original); assert.equal((await exec('git', ['-C', copy.path, 'write-tree'])).stdout.trim(), original.patch!.targetTreeId); await worker.release(original);
  } finally { await fixture.close(); }
});

test('unchanged revision patch keeps exact imported content and a clean staged index', async () => {
  const fixture = await createGitFixture();
  try {
    const claim = await patchedClaim(fixture), worker = await configured(fixture), copy = await worker.provision(claim);
    assert.equal(claim.patch!.targetTreeId, claim.patch!.baseTreeId);
    assert.equal((await exec('git', ['-C', copy.path, 'status', '--porcelain'])).stdout, '');
    await worker.release(claim);
  } finally { await fixture.close(); }
});

test('worker independently checks baseline content identity and removes a failed partial revision copy', async () => {
  const fixture = await createGitFixture();
  try {
    const claim = await patchedClaim(fixture), worker = await configured(fixture);
    // Even a structurally self-consistent descriptor cannot substitute the
    // baseline content hash for the actual independently read Git objects.
    const { patchSha256: _oldDigest, ...payload } = claim.patch!;
    payload.baseContentHash = 'f'.repeat(64);
    claim.patch = { ...payload, patchSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
    claim.lease.source.revisionPatch = revisionPatchIdentity(claim.patch); claim.resource.source = structuredClone(claim.lease.source);
    await assert.rejects(worker.provision(claim));
    assert.equal((await readdir(worker.configuration.bindings.main!.root)).includes(claim.resource.id), false);
  } finally { await fixture.close(); }
});
