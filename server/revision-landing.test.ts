import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGitFixture } from '../tests/git-fixture.ts';
import { sourceSnapshotCanonical } from '../shared/source-snapshot.ts';
import type { ActorAttribution, RevisionVersion } from '../shared/types.ts';
import { revisionLandingPrepareInput, type LandingGateProof, type RevisionLandingPrepareInput } from '../shared/revision-landing.ts';
import { createGitObserver } from './git.ts';
import { LocalGitLanding } from './git-landing.ts';
import { createRevisionPatchFromGitBase, revisionPatchIdentity } from './revision-patch.ts';
import { initializeRevisionLanding, RevisionLandingStore, type RevisionLandingHooks } from './revision-landing.ts';
import { HttpError } from './validation.ts';

const proof:LandingGateProof={receiptId:'receive-receipt',allowed:true,evidenceSha256:'d'.repeat(64)};
const actor:ActorAttribution={principalId:'alice',displayName:'Alice',credentialId:null,requestId:'landing-test'};
async function fixture(format:'sha1'|'sha256'='sha1') {
  const git=await createGitFixture(format),observer=createGitObserver({R1:git.barePath}),baseline=await observer.importSnapshot('R1',git.importCommit),target=await observer.importSnapshot('R1',git.importNextCommit);
  await git.git(['update-ref','refs/heads/main',baseline.provenance.commitId]);
  const version:RevisionVersion={id:'version-1',revisionId:'D1',number:1,files:target.files,gitSource:target.provenance,contentHash:createHash('sha256').update(sourceSnapshotCanonical(target.files)).digest('hex'),message:'Reviewed import',createdAt:new Date().toISOString()};
  const patch=createRevisionPatchFromGitBase('R1',version,baseline),transport=new LocalGitLanding([{key:'local',repositoryId:'R1',repositoryPath:git.barePath,branches:['refs/heads/main']}]);
  const input={operationId:`LAND-${randomUUID()}`,binding:'local',branch:'refs/heads/main',expectedTargetCommitId:baseline.provenance.commitId,patch,author:{name:'Alice',email:'alice@users.invalid',timestamp:'2026-10-14T00:00:00.000Z'},committer:{name:'Application',email:'app@users.invalid',timestamp:'2026-10-14T00:00:00.000Z'},message:'Reviewed title\n\nReviewed summary',pusherId:'alice'};
  const preparation=await transport.prepare(input);
  const request:RevisionLandingPrepareInput={binding:'local',branch:input.branch,baseCommitId:patch.baseCommitId,expectedTargetCommitId:patch.baseCommitId,expectedVersion:version.number,expectedVersionId:version.id,expectedContentHash:version.contentHash,expectedLifecycleVersion:2,expectedAuthorVersion:1,expectedReviewerVersion:1,expectedMetadataVersion:1,expectedEvidenceSha256:'e'.repeat(64),expectedConfigId:'f'.repeat(64),expectedAccessEpoch:1};
  return {git,observer,baseline,target,version,patch,transport,input,preparation,request,close:()=>git.close()};
}

for(const format of ['sha1','sha256'] as const)test(`local ${format} landing preserves the exact reviewed tree and atomically records a squash commit plus audit proof`,async()=>{
  const f=await fixture(format);try{
    const hooks=join(f.git.barePath,'hooks');await mkdir(hooks,{recursive:true});const sentinel=join(f.git.root,'executed');await writeFile(join(hooks,'reference-transaction'),`#!/bin/sh\nprintf executed > '${sentinel}'\n`);await chmod(join(hooks,'reference-transaction'),0o700);
    assert.equal((await f.git.git(['rev-parse','refs/heads/main'])).trim(),f.patch.baseCommitId,'prepare never changes refs');assert.equal(f.transport.state(f.preparation.prepared),'ready');assert.equal(f.transport.proof(f.preparation.prepared),null);
    assert.equal(f.preparation.facts.updates[0]!.commits.length,1);assert.equal(f.preparation.facts.updates[0]!.commits[0]!.commit.treeId,f.patch.targetTreeId);
    assert.equal(f.transport.land(f.preparation.prepared,proof),'landed');assert.equal((await f.git.git(['rev-parse','refs/heads/main'])).trim(),f.preparation.prepared.commitId);assert.deepEqual(f.transport.proof(f.preparation.prepared),proof);
    const landed=await f.observer.importSnapshot('R1',f.preparation.prepared.commitId);assert.deepEqual(landed.files,f.target.files);assert.deepEqual(landed.provenance.manifest,f.target.provenance.manifest);
    const commit=await f.observer.commit('R1',f.preparation.prepared.commitId);assert.deepEqual(commit.commit.parentIds,[f.patch.baseCommitId]);assert.match(commit.commit.message,/Differential Revision: D1/);assert.equal(f.transport.land(f.preparation.prepared,proof),'landed','unchanged retry does not create another commit');
    await assert.rejects(access(sentinel),'neither preparation nor landing executes Git hooks or source');
    const proofId=(await f.git.git(['rev-parse',`refs/phabricator/land-proof/${f.input.operationId.slice(5)}`])).trim(),audit=await f.git.git(['cat-file','blob',proofId]);assert.ok(audit.includes(proof.evidenceSha256));assert.equal(audit.includes('Reviewed summary'),false,'proof carries no private rule or review text');
  }finally{await f.close();}
});

test('landing rejects a moved branch without overwriting it and refuses no-op or unconfigured targets',async()=>{
  const f=await fixture();try{
    await f.git.git(['update-ref','refs/heads/main',f.git.importNextCommit]);assert.equal(f.transport.land(f.preparation.prepared,proof),'conflict');assert.equal((await f.git.git(['rev-parse','refs/heads/main'])).trim(),f.git.importNextCommit);assert.equal(f.transport.proof(f.preparation.prepared),null);
    await assert.rejects(f.transport.prepare(f.input),/target branch changed/i);
    await assert.rejects(f.transport.prepare({...f.input,branch:'refs/heads/other'}),/not configured/i);
    await f.git.git(['update-ref','refs/heads/main',f.patch.baseCommitId]);const baseVersion={...f.version,files:f.baseline.files,gitSource:f.baseline.provenance,contentHash:createHash('sha256').update(sourceSnapshotCanonical(f.baseline.files)).digest('hex')};
    await assert.rejects(f.transport.prepare({...f.input,patch:createRevisionPatchFromGitBase('R1',baseVersion,f.baseline)}),/no changes/i);
    assert.throws(()=>revisionLandingPrepareInput({...f.request,baseCommitId:f.git.importNextCommit}),/target branch base/i);
  }finally{await f.close();}
});

test('landing fences repository retargeting, symbolic branch references and incomplete audit marker pairs',async()=>{
  const f=await fixture();try{
    await f.git.git(['symbolic-ref','refs/heads/main','refs/heads/feature']);assert.throws(()=>f.transport.land(f.preparation.prepared,proof),/unavailable/i);
    await f.git.git(['update-ref','--no-deref','refs/heads/main',f.patch.baseCommitId]);
    await f.git.git(['update-ref',f.preparation.prepared.markerRef,f.preparation.prepared.commitId]);assert.throws(()=>f.transport.state(f.preparation.prepared),/unavailable/i);
    await f.git.git(['update-ref','-d',f.preparation.prepared.markerRef]);await f.git.git(['config','core.filemode','false']);assert.throws(()=>f.transport.land(f.preparation.prepared,proof),/unavailable/i);
  }finally{await f.close();}
});

test('a completed Git marker recovers rolled-back landing state even after the branch advances, without rerunning rules',async()=>{
  const f=await fixture(),db=new DatabaseSync(':memory:');initializeRevisionLanding(db);let gates=0,completed=0,canLand=true;
  const hooks:RevisionLandingHooks={authorize:(_op,_actor,phase)=>{if(phase==='land'&&!canLand)throw new HttpError(403,'No longer accepted.');},beforeLand:()=>{gates++;return {allowed:true,proof};},afterLand:op=>{completed++;assert.deepEqual(op.gateProof,proof);}};
  const store=new RevisionLandingStore(db,f.transport,hooks);
  try{
    const prepared=store.prepare(f.request,revisionPatchIdentity(f.patch),f.preparation,actor,['review-1']);assert.equal(prepared.operation.state,'prepared');assert.deepEqual(store.prepare(f.request,revisionPatchIdentity(f.patch),f.preparation,actor,['review-1']),prepared);
    db.exec('BEGIN IMMEDIATE');assert.equal(store.command(prepared.operation.id,{command:'land',expectedVersion:1},actor).operation.state,'landed');db.exec('ROLLBACK');
    assert.equal(store.detail(prepared.operation.id,actor).operation.state,'prepared');assert.equal(gates,1);
    await f.git.git(['update-ref','refs/heads/main',f.git.importNextCommit]);canLand=false;
    const recovered=store.command(prepared.operation.id,{command:'land',expectedVersion:1},actor);assert.equal(recovered.operation.state,'landed');assert.match(recovered.operation.message,/Recovered/);assert.deepEqual(recovered.operation.gateProof,proof);assert.equal(gates,1);assert.equal(completed,2);assert.equal((await f.git.git(['rev-parse','refs/heads/main'])).trim(),f.git.importNextCommit);
    assert.equal(store.command(prepared.operation.id,{command:'land',expectedVersion:1},actor).operation.version,2);assert.equal(gates,1);assert.equal(store.detail(prepared.operation.id,actor).events.length,2);
    assert.throws(()=>db.prepare('UPDATE revision_landing_preparations SET facts=facts').run(),/immutable/);assert.throws(()=>db.prepare('DELETE FROM revision_landing_events').run(),/immutable/);
  }finally{db.close();await f.close();}
});

test('current authorization and repository rules can prevent prepared landing; cancellation and immutable preparation are durable',async()=>{
  const f=await fixture(),db=new DatabaseSync(':memory:');initializeRevisionLanding(db);let allowed=false,gateAllowed=true,readable=true;
  const hooks:RevisionLandingHooks={authorize:(_op,_actor,phase)=>{if(!readable)throw new HttpError(404,'Unavailable.');if(phase==='land'&&!allowed)throw new HttpError(403,'Acceptance changed.');},beforeLand:()=>gateAllowed?{allowed:true,proof}:{allowed:false,message:'Repository rules rejected this landing.'},afterLand:()=>{throw new Error('Must not land');}};
  const store=new RevisionLandingStore(db,f.transport,hooks);
  try{
    const prepared=store.prepare(f.request,revisionPatchIdentity(f.patch),f.preparation,actor,[]);
    assert.throws(()=>store.command(prepared.operation.id,{command:'land',expectedVersion:1},actor),/Acceptance changed/);assert.equal(f.transport.state(f.preparation.prepared),'ready');
    allowed=true;gateAllowed=false;const rejected=store.command(prepared.operation.id,{command:'land',expectedVersion:1},actor);assert.equal(rejected.operation.state,'conflict');assert.equal(f.transport.state(f.preparation.prepared),'ready');
    const next=await f.transport.prepare({...f.input,operationId:`LAND-${randomUUID()}`}),again=store.prepare(f.request,revisionPatchIdentity(f.patch),next,actor,[]);
    assert.equal(store.command(again.operation.id,{command:'cancel',expectedVersion:1},actor).operation.state,'cancelled');assert.equal(store.command(again.operation.id,{command:'cancel',expectedVersion:1},actor).operation.version,2);assert.equal(f.transport.state(next.prepared),'ready');
    readable=false;assert.throws(()=>store.detail(prepared.operation.id,actor),/Unavailable/);assert.throws(()=>store.command(again.operation.id,{command:'cancel',expectedVersion:1},actor),/Unavailable/);
  }finally{db.close();await f.close();}
});

test('landing initialization rejects a colliding incompatible schema',()=>{const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE revision_landings(id TEXT PRIMARY KEY,data TEXT)');assert.throws(()=>initializeRevisionLanding(db),/schema/);}finally{db.close();}});
