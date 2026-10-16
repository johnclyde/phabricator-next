import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AuthContext } from '../shared/auth.ts';
import type { ActorAttribution, RevisionVersion } from '../shared/types.ts';
import type { RevisionLifecycleSnapshot } from '../shared/revision-lifecycle.ts';
import { sameHead } from '../shared/revision-lifecycle.ts';
import type { RevisionLandingDetail, RevisionLandingOperation, RevisionLandingPins, RevisionLandingPrepareInput, RevisionLandingSnapshot } from '../shared/revision-landing.ts';
import { isLandingBranch, revisionLandingPrepareInput } from '../shared/revision-landing.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import type { Store, MutationResponse } from './store.ts';
import type { Automation } from './automation.ts';
import { AccessLayer } from './access.ts';
import { createGitObserver } from './git.ts';
import { LocalGitLanding, type LocalLandingBinding } from './git-landing.ts';
import { RevisionLandingStore } from './revision-landing.ts';
import { createRevisionPatchFromGitBase, resolveRevisionPatch, revisionPatchIdentity, revisionPatchObjectId } from './revision-patch.ts';
import { HttpError } from './validation.ts';

export function landingBindingsFromEnvironment(env:Record<string,string|undefined>=process.env):LocalLandingBinding[] {
  const invalid=()=>new Error('APP_LANDING_BINDINGS must list distinct keys, repository IDs, absolute local bare paths and explicit branch refs.');
  const raw=env.APP_LANDING_BINDINGS??'[]';if(raw.length>100_000)throw invalid();let value:unknown;try{value=JSON.parse(raw);}catch{throw invalid();}
  if(!Array.isArray(value)||value.length>100)throw invalid();
  const result:LocalLandingBinding[]=value.map(entry=>{if(!entry||typeof entry!=='object'||Array.isArray(entry))throw invalid();const item=entry as Record<string,unknown>;
    if(Object.keys(item).length!==4||Object.keys(item).some(key=>!['key','repositoryId','repositoryPath','branches'].includes(key))||typeof item.key!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(item.key)||typeof item.repositoryId!=='string'||!/^R[1-9]\d*$/.test(item.repositoryId)||typeof item.repositoryPath!=='string'||!isAbsolute(item.repositoryPath)||item.repositoryPath.length>4096||item.repositoryPath.includes('\0')||!Array.isArray(item.branches)||!item.branches.length||item.branches.length>100||item.branches.some(branch=>!isLandingBranch(branch))||new Set(item.branches).size!==item.branches.length)throw invalid();return {key:item.key,repositoryId:item.repositoryId,repositoryPath:item.repositoryPath,branches:[...item.branches] as string[]};});
  if(new Set(result.map(item=>item.key)).size!==result.length)throw invalid();return result;
}
const changed=()=>new HttpError(409,'The source, review, metadata or access changed. Reload and prepare the current revision.','LANDING_REVIEW_CHANGED');
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pins=(snapshot:RevisionLifecycleSnapshot,metadataVersion:number):RevisionLandingPins=>({expectedVersion:snapshot.head.number,expectedVersionId:snapshot.head.versionId,expectedContentHash:snapshot.head.contentHash,expectedLifecycleVersion:snapshot.lifecycle.version,expectedAuthorVersion:snapshot.authorship.version,expectedReviewerVersion:snapshot.reviewers.version,expectedMetadataVersion:metadataVersion,expectedEvidenceSha256:snapshot.evidence.sha256,expectedConfigId:snapshot.configId,expectedAccessEpoch:snapshot.accessEpoch});
function requestPins(input:RevisionLandingPrepareInput):RevisionLandingPins {const {binding:_binding,branch:_branch,baseCommitId:_base,expectedTargetCommitId:_target,...value}=input;return value;}

/** Owns authenticated HTTP orchestration. Git preparation is asynchronous;
 * authorization, Herald gating and the final CAS share the SQLite writer lock. */
export class LandingService {
  readonly records:RevisionLandingStore;
  readonly transport:LocalGitLanding;
  constructor(private readonly store:Store,private readonly auth:Auth,private readonly policies:PolicyStore,private readonly automation:Automation,private readonly bindings:readonly LocalLandingBinding[]=[],private readonly repositoryChanged:(id:string)=>void=()=>{}) {
    this.transport=new LocalGitLanding(bindings);
    this.records=new RevisionLandingStore(store.database,this.transport,{
      authorize:(operation,actor,phase)=>{
        this.authorizeActor(actor,operation.revisionId,phase!=='read');this.policies.require(operation.prepared.repositoryId,actor.principalId,phase==='read'?'view':'edit');
        if(phase!=='read'&&operation.attribution.principalId!==actor.principalId)throw new HttpError(403,'Only the account which prepared this landing may execute or cancel it.');
        if(phase==='prepare'||phase==='land')this.assertCurrent(operation.revisionId,operation.input,actor);
      },
      beforeLand:(operation,facts,actor)=>{
        const receipt=this.automation.landingReceive(facts,{...actor,workspaceId:this.auth.workspaceId});
        if(!receipt.allowed)return {allowed:false,receiptId:receipt.id,message:'Herald repository rules rejected this landing. Inspect the receive decision.'};
        const transcripts=receipt.transcriptIds.map(id=>this.automation.herald.transcript(id,()=>true));
        return {allowed:true,proof:{receiptId:receipt.id,allowed:true,evidenceSha256:hash({operationId:operation.id,receipt,transcripts})}};
      },
      afterLand:(operation,facts,actor)=>{
        this.automation.landingReceive(facts,{...actor,workspaceId:this.auth.workspaceId});
        this.repositoryChanged(facts.repositoryId);
        const current=this.store.revisionLifecycle.snapshot(operation.revisionId,actor.principalId);
        // Recovery records the historical landing, but never closes newer work.
        if(current.head.versionId!==operation.patch.versionId||current.head.contentHash!==operation.patch.contentHash||current.lifecycle.status!=='accepted'||!current.actions.some(action=>action.action==='close'&&action.available))return;
        const {expectedMetadataVersion:_metadata,...lifecyclePins}=pins({...current,access:this.policies.describe(operation.revisionId,actor.principalId),accessEpoch:this.policies.epoch()},this.store.revisionMetadata.state(operation.revisionId).version);
        this.store.revisionLifecycle.mutate(operation.revisionId,{action:'close',message:`Landed ${operation.prepared.commitId} on ${operation.prepared.branch}.`,...lifecyclePins},actor);
      },
    });
  }
  private actor(context:AuthContext,key='landing-read'):ActorAttribution {return {principalId:context.principalId,displayName:context.displayName,credentialId:context.credentialId??null,requestId:key};}
  private authorizeActor(actor:ActorAttribution,id:string,write:boolean):void {
    const active=this.auth.mode==='local'&&actor.principalId===`local:${this.auth.workspaceId}`||Boolean(this.store.database.prepare('SELECT 1 FROM auth_accounts WHERE id=? AND disabled=0').get(actor.principalId));
    if(!active)throw new HttpError(403,'This landing account is no longer active.');this.policies.require(id,actor.principalId,write?'edit':'view');
  }
  private snapshot(id:string,context:AuthContext):RevisionLandingSnapshot {
    this.auth.revalidate(context,'read');const access=new AccessLayer(this.store,this.auth,this.policies,context),lifecycle=access.revisionLifecycle(id),detail=this.store.detail(id),repositoryId=detail.revision.repositoryId;
    const selected=detail.versions.find(version=>version.id===lifecycle.head.versionId)!;
    const bindings=this.bindings.filter(binding=>binding.repositoryId===repositoryId).map(({repositoryPath:_path,...binding})=>({...binding,branches:[...binding.branches]}));
    let reason:string|null=null,suggestedBaseCommitId:string|null=null;
    try {this.assertEligible(id,this.actor(context));if(!context.scopes.includes('write'))throw new HttpError(403,'A write credential is required.');if(!bindings.length)throw new HttpError(409,'The operator has not configured a landing target for this repository.');const patch=resolveRevisionPatch(repositoryId!,detail.versions,selected.id,selected.contentHash);suggestedBaseCommitId=patch.baseCommitId;}catch(error){if(!(error instanceof HttpError))throw error;reason=error.message;}
    return {revisionId:id,repositoryId,pins:pins(lifecycle,detail.revision.metadataVersion??0),canPrepare:reason===null,reason,suggestedBaseCommitId,bindings,operations:this.records.list(id,this.actor(context)),accessEpoch:this.policies.epoch()};
  }
  private assertEligible(id:string,actor:ActorAttribution):void {
    this.authorizeActor(actor,id,true);const detail=this.store.detail(id),snapshot=this.store.revisionLifecycle.snapshot(id,actor.principalId),repositoryId=detail.revision.repositoryId;
    if(!repositoryId)throw new HttpError(409,'Import this revision from a Git repository before landing.');this.policies.require(repositoryId,actor.principalId,'edit');
    const accepted=snapshot.lifecycle.status==='accepted'||snapshot.lifecycle.status==='closed'&&snapshot.lifecycle.closedFromAccepted;
    const basis=snapshot.reviewers.acceptance;
    if(!accepted||!basis?.head||!sameHead(basis.head,snapshot.head)||snapshot.evidence.errorCount||snapshot.reviewers.rejecting||snapshot.reviewers.olderRejecting||snapshot.reviewers.blocking)throw new HttpError(409,'Accept the current revision version and resolve all blocking review findings before landing.');
    if(snapshot.authorship.author?.principalId!==actor.principalId&&!snapshot.config.alwaysAllowClose)throw new HttpError(403,'Only the current author can land this revision.');
    const parents=this.store.database.prepare('SELECT parent_id FROM revision_dependency_edges WHERE child_id=?').all(id) as {parent_id:string}[];
    if(parents.some(parent=>{const state=this.store.revisionLifecycle.state(parent.parent_id);return state.status!=='closed'&&!(snapshot.config.closeOnAccept&&state.status==='accepted');}))throw new HttpError(409,'Close or land the prerequisite revisions before landing this revision.');
    resolveRevisionPatch(repositoryId,detail.versions,snapshot.head.versionId,snapshot.head.contentHash);
  }
  private assertCurrent(id:string,input:RevisionLandingPrepareInput,actor:ActorAttribution):void {
    this.assertEligible(id,actor);const detail=this.store.detail(id),snapshot=this.store.revisionLifecycle.snapshot(id,actor.principalId);
    const current=pins({...snapshot,access:this.policies.describe(id,actor.principalId),accessEpoch:this.policies.epoch()},detail.revision.metadataVersion??0);
    if(!isDeepStrictEqual(current,requestPins(input)))throw changed();
    if(!this.bindings.some(binding=>binding.key===input.binding&&binding.repositoryId===detail.revision.repositoryId&&binding.branches.includes(input.branch)))throw new HttpError(403,'This repository branch is not configured for landing.');
  }
  async snapshotForReader(id:string,context:AuthContext,signal?:AbortSignal):Promise<RevisionLandingSnapshot> {
    const initial=this.store.read(()=>this.snapshot(id,context));if(!initial.canPrepare||!initial.repositoryId||!initial.bindings.length)return initial;
    const source=this.store.read(()=>this.store.detail(id).versions.find(version=>version.id===initial.pins.expectedVersionId)!);
    if(!source.gitSource)return initial;
    const binding=this.bindings.find(item=>item.key===initial.bindings[0]!.key)!;
    try {const commit=await createGitObserver({[binding.repositoryId]:binding.repositoryPath}).commit(binding.repositoryId,source.gitSource.commitId,signal);const result=this.store.read(()=>this.snapshot(id,context));if(isDeepStrictEqual(result.pins,initial.pins))result.suggestedBaseCommitId=commit.commit.parentIds[0]??null;return result;}
    catch(error){this.store.read(()=>{this.auth.revalidate(context,'read');this.policies.require(id,context.principalId,'view');});if(signal?.aborted)throw error;return {...this.store.read(()=>this.snapshot(id,context)),canPrepare:false,reason:'The configured Git source is unavailable. Check the repository binding.'};}
  }
  private present(detail:RevisionLandingDetail,context:AuthContext):RevisionLandingDetail {
    this.auth.revalidate(context,'read');this.records.verifyDetail(detail,this.actor(context));const current=this.records.detail(detail.operation.id,this.actor(context));let canLand=false,canCancel=false,canRecover=false;
    if(current.operation.state==='prepared'&&context.scopes.includes('write')&&current.operation.attribution.principalId===context.principalId){try{this.authorizeActor(this.actor(context),current.operation.revisionId,true);this.policies.require(current.operation.prepared.repositoryId,context.principalId,'edit');const state=this.transport.state(current.operation.prepared);canRecover=state==='landed';canCancel=!canRecover;if(state==='ready'){this.assertCurrent(current.operation.revisionId,current.operation.input,this.actor(context));canLand=true;}}catch{/* Current authority controls capabilities. */}}
    return {...detail,accessEpoch:this.policies.epoch(),canLand,canCancel,canRecover};
  }
  detail(id:string,context:AuthContext):RevisionLandingDetail {return this.store.read(()=>this.present(this.records.detail(id,this.actor(context)),context));}
  async prepare(id:string,input:unknown,rawKey:string|undefined,context:AuthContext,signal?:AbortSignal):Promise<MutationResponse> {
    if(!rawKey)throw new HttpError(400,'Landing requires an Idempotency-Key.');let data:RevisionLandingPrepareInput;try{data=revisionLandingPrepareInput(input);}catch(error){throw new HttpError(400,error instanceof Error?error.message:'Invalid landing request.');}
    const key=context.kind==='local'?rawKey:`${context.workspaceId}:${context.principalId}:${rawKey}`,fingerprint=hash(['POST',`/api/revisions/${id}/landings`,data]),actor=this.actor(context,rawKey);
    const authorize=()=>{this.auth.revalidate(context,'write');this.authorizeActor(actor,id,false);};
    const project=(response:MutationResponse)=>{const value=response.body as RevisionLandingDetail;if(response.status!==201||value?.operation?.revisionId!==id||value.operation.attribution?.principalId!==context.principalId||value.operation.attribution.requestId!==rawKey||!isDeepStrictEqual(value.operation.input,data))throw new HttpError(409,'The saved preparation receipt does not match this request.','LANDING_INVALID_RECEIPT');return {...response,body:this.present(value,context)};};
    const previous=this.store.read(()=>{authorize();return this.store.replay(key,fingerprint);});if(previous)return this.store.read(()=>project(previous));
    const detail=this.store.read(()=>{authorize();this.assertCurrent(id,data,actor);return this.store.detail(id);}),version=detail.versions.find(version=>version.id===data.expectedVersionId)!;
    const binding=this.bindings.find(item=>item.key===data.binding&&item.repositoryId===detail.revision.repositoryId)!;
    try {
      const baseline=await createGitObserver({[binding.repositoryId]:binding.repositoryPath}).importSnapshot(binding.repositoryId,data.baseCommitId,signal);
      this.store.read(()=>{authorize();this.assertCurrent(id,data,actor);});
      const reviewed=resolveRevisionPatch(binding.repositoryId,detail.versions,version.id,version.contentHash);
      const targetModes=reviewed.files.map(file=>({path:file.path,mode:file.mode,objectId:revisionPatchObjectId(reviewed.objectFormat,'blob',Buffer.from(file.content))}));
      const patch=createRevisionPatchFromGitBase(binding.repositoryId,version,baseline,targetModes),timestamp=new Date().toISOString();
      if(patch.targetTreeId!==reviewed.targetTreeId)throw changed();
      const person={name:actor.displayName.replace(/[\x00-\x1f\x7f<>]/g,' ').trim().slice(0,200)||'Workspace account',email:`${createHash('sha256').update(`${context.workspaceId}:${actor.principalId}`).digest('hex').slice(0,32)}@users.invalid`,timestamp};
      const preparation=await this.transport.prepare({operationId:`LAND-${randomUUID()}`,binding:data.binding,branch:data.branch,expectedTargetCommitId:data.expectedTargetCommitId,patch,author:person,committer:person,message:[detail.revision.title,detail.revision.summary].filter(Boolean).join('\n\n'),pusherId:actor.principalId},signal);
      if(signal?.aborted)throw new HttpError(499,'Landing preparation was cancelled.');
      return this.store.mutate(key,fingerprint,()=>{this.assertCurrent(id,data,actor);return {status:201,body:this.records.prepare(data,revisionPatchIdentity(patch),preparation,actor,this.store.revisionLifecycle.snapshot(id).evidence.reviewIds)};},authorize,project);
    }catch(error){this.store.read(authorize);throw error;}
  }
  command(id:string,input:unknown,rawKey:string|undefined,context:AuthContext):MutationResponse {
    if(!rawKey)throw new HttpError(400,'Landing requires an Idempotency-Key.');const actor=this.actor(context,rawKey),key=context.kind==='local'?rawKey:`${context.workspaceId}:${context.principalId}:${rawKey}`,fingerprint=hash(['POST',`/api/landings/${id}/commands`,input]);
    return this.store.mutate(key,fingerprint,()=>({status:200,body:this.records.command(id,input,actor)}),()=>{this.auth.revalidate(context,'write');this.records.detail(id,actor);},response=>{const value=response.body as RevisionLandingDetail;if(response.status!==200||value?.operation?.id!==id)throw new HttpError(409,'The saved landing receipt does not match this request.','LANDING_INVALID_RECEIPT');return {...response,body:this.present(value,context)};});
  }
}
