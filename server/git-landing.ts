import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { GitPerson } from '../shared/repositories.ts';
import type { GitReceiveFacts } from '../shared/git-automation.ts';
import type { GitLandingPrepared, RevisionLandingBinding, LandingGateProof } from '../shared/revision-landing.ts';
import { isLandingBranch } from '../shared/revision-landing.ts';
import type { RevisionPatchPayload } from '../shared/revision-patch.ts';
import { createGitObserver } from './git.ts';
import { inspectReceive } from './git-receive-inspection.ts';
import { buildRevisionPatchTree, revisionPatchObjectId, verifyRevisionPatch } from './revision-patch.ts';
import { HttpError } from './validation.ts';

export interface LocalLandingBinding extends RevisionLandingBinding { repositoryPath: string }
export interface GitLandingPrepare {
  operationId: string; binding: string; branch: string; expectedTargetCommitId: string;
  patch: RevisionPatchPayload; author: GitPerson; committer: GitPerson; message: string; pusherId: string;
}
export interface GitLandingPreparation { prepared: GitLandingPrepared; facts: GitReceiveFacts }
export interface GitLandingTransport {
  prepare(input: GitLandingPrepare, signal?: AbortSignal): Promise<GitLandingPreparation>;
  state(prepared: GitLandingPrepared): 'ready' | 'landed' | 'conflict';
  proof(prepared: GitLandingPrepared): LandingGateProof | null;
  land(prepared: GitLandingPrepared, proof: LandingGateProof): 'landed' | 'conflict';
}

const unavailable = () => new HttpError(503, 'The configured landing repository is unavailable or has changed.', 'LANDING_REPOSITORY_UNAVAILABLE');
const conflict = () => new HttpError(409, 'The target branch changed. Prepare and review the current source before landing.', 'LANDING_TARGET_CHANGED');
const invalid = () => new HttpError(400, 'Provide a verified revision patch and configured landing target.', 'LANDING_INVALID_INPUT');
const operation = /^LAND-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const options = ['--no-replace-objects','--literal-pathspecs','--no-pager','-c','protocol.allow=never','-c','credential.helper=','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.attributesFile=/dev/null','-c','core.commitGraph=false','-c','core.multiPackIndex=false','-c','gc.auto=0','-c','maintenance.auto=false'];
const env: NodeJS.ProcessEnv = { PATH:'/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME:'/nonexistent', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_SYSTEM:'/dev/null', GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_COUNT:'0', GIT_TERMINAL_PROMPT:'0', GIT_NO_REPLACE_OBJECTS:'1', GIT_ATTR_NOSYSTEM:'1', GIT_NO_LAZY_FETCH:'1', GIT_ALLOW_PROTOCOL:'', LC_ALL:'C', TZ:'UTC' };
const oid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const absent = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
function fingerprint(path: string): string {
  try {
    const root = lstatSync(path); if (!root.isDirectory() || root.isSymbolicLink()) throw unavailable();
    const canonical = realpathSync(path), fd = openSync(join(canonical,'config'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 64_000) throw unavailable(); return digest(JSON.stringify({ path: canonical, dev: root.dev, ino: root.ino, config: digest(readFileSync(fd)) })); }
    finally { closeSync(fd); }
  } catch { throw unavailable(); }
}
function refPath(path: string, ref: string): void {
  let current = path;
  for (const part of ref.split('/')) { current=join(current,part); try { const stat=lstatSync(current); if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) throw unavailable(); } catch(error) { if(absent(error)) return; throw error; } }
}
function sync(path: string, args: string[], input?: string): { data: string; code: number | null } {
  const result=spawnSync('git',[...options,'--git-dir',path,...args],{cwd:'/',env,input,encoding:'utf8',timeout:15_000,maxBuffer:100_000,windowsHide:true});
  if(result.error||result.signal)throw unavailable(); return {data:result.stdout,code:result.status};
}
function run(path: string, args: string[], signal: AbortSignal, input?: Buffer): Promise<Buffer> {
  if(signal.aborted)return Promise.reject(unavailable());
  return new Promise((resolve,reject)=>{
    const child=spawn('git',[...options,'--git-dir',path,...args],{cwd:'/',env,stdio:[input?'pipe':'ignore','pipe','pipe'],windowsHide:true});
    let failed=false,size=0,errorSize=0;const chunks:Buffer[]=[];const stop=()=>{failed=true;child.kill('SIGKILL');};signal.addEventListener('abort',stop,{once:true});
    child.stdout!.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2_000_000)stop();else chunks.push(chunk);});child.stderr!.on('data',(chunk:Buffer)=>{errorSize+=chunk.length;if(errorSize>32_000)stop();});child.on('error',()=>{failed=true;});
    child.on('close',code=>{signal.removeEventListener('abort',stop);if(failed||code!==0)reject(unavailable());else resolve(Buffer.concat(chunks));});if(input){child.stdin!.on('error',()=>undefined);child.stdin!.end(input);}if(signal.aborted)stop();
  });
}
function person(value: GitPerson): string {
  if(!value || typeof value.name!=='string'||!value.name.trim()||value.name.length>200||/[\x00-\x1f\x7f<>]/.test(value.name)||typeof value.email!=='string'||!value.email||value.email.length>254||/[\x00-\x20\x7f<>]/.test(value.email)||!Number.isFinite(Date.parse(value.timestamp)))throw invalid();
  return `${value.name} <${value.email}> ${Math.floor(Date.parse(value.timestamp)/1000)} +0000`;
}

/** Local squash landing only. Git plumbing never checks out or executes source,
 * never invokes repository hooks, and never contacts a remote. */
export class LocalGitLanding implements GitLandingTransport {
  constructor(private readonly bindings: readonly LocalLandingBinding[]) {
    if(new Set(bindings.map(binding=>binding.key)).size!==bindings.length||bindings.some(binding=>!binding||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(binding.key)||!/^R[1-9]\d*$/.test(binding.repositoryId)||!isAbsolute(binding.repositoryPath)||binding.repositoryPath.includes('\0')||!binding.branches.length||binding.branches.some(branch=>!isLandingBranch(branch))||new Set(binding.branches).size!==binding.branches.length))throw new Error('Landing requires distinct bindings to local bare repositories and explicit branch references.');
  }
  private binding(key: string, repositoryId: string, branch: string): LocalLandingBinding { const value=this.bindings.find(item=>item.key===key&&item.repositoryId===repositoryId&&item.branches.includes(branch));if(!value)throw new HttpError(403,'This repository branch is not configured for landing.','LANDING_UNCONFIGURED');return value; }
  private current(path: string, ref: string): string | null {
    refPath(path,ref);const symbolic=sync(path,['symbolic-ref','--quiet',ref]);if(symbolic.code!==1)throw unavailable();
    const result=sync(path,['rev-parse','--verify','--quiet',ref]);if(result.code===1)return null;if(result.code!==0||!oid(result.data.trim()))throw unavailable();return result.data.trim();
  }
  async prepare(input: GitLandingPrepare, signal?: AbortSignal): Promise<GitLandingPreparation> {
    const patch=verifyRevisionPatch(input.patch),match=operation.exec(input.operationId);
    if(!match||!isLandingBranch(input.branch)||input.expectedTargetCommitId!==patch.baseCommitId||typeof input.message!=='string'||!input.message.trim()||Buffer.byteLength(input.message)>500_000||input.message.includes('\0')||!input.pusherId)throw invalid();
    const binding=this.binding(input.binding,patch.repositoryId,input.branch),deadline=AbortSignal.any([AbortSignal.timeout(60_000),...(signal?[signal]:[])]),before=fingerprint(binding.repositoryPath);
    const base=await createGitObserver({[binding.repositoryId]:binding.repositoryPath}).commit(binding.repositoryId,patch.baseCommitId,deadline);
    if(base.objectFormat!==patch.objectFormat||base.commit.treeId!==patch.baseTreeId)throw invalid();
    if(this.current(binding.repositoryPath,input.branch)!==input.expectedTargetCommitId)throw conflict();
    if(patch.targetTreeId===patch.baseTreeId)throw new HttpError(409,'This exact revision has no changes against the selected base.','LANDING_EMPTY_PATCH');
    const author=person(input.author),committer=person(input.committer),manifest=patch.files.map(file=>({path:file.path,mode:file.mode,objectId:revisionPatchObjectId(patch.objectFormat,'blob',Buffer.from(file.content))}));
    const tree=buildRevisionPatchTree(manifest,patch.objectFormat);if(tree.treeId!==patch.targetTreeId)throw invalid();
    const write=async(type:'blob'|'tree'|'commit',bytes:Buffer,id:string)=>{const actual=(await run(binding.repositoryPath,['hash-object','-w','-t',type,'--stdin'],deadline,bytes)).toString('ascii').trim();if(actual!==id)throw unavailable();};
    for(const file of patch.files){const bytes=Buffer.from(file.content);await write('blob',bytes,revisionPatchObjectId(patch.objectFormat,'blob',bytes));}
    for(const object of tree.objects)await write('tree',object.bytes,object.objectId);
    const message=`${input.message.trim()}\n\nDifferential Revision: ${patch.revisionId}\nRevision Version: ${patch.versionId}\nRevision Content: ${patch.contentHash}\nLanding Operation: ${input.operationId}\n`;
    const bytes=Buffer.from(`tree ${tree.treeId}\nparent ${patch.baseCommitId}\nauthor ${author}\ncommitter ${committer}\n\n${message}`),commitId=createHash(patch.objectFormat).update(`commit ${bytes.length}\0`).update(bytes).digest('hex');
    await write('commit',bytes,commitId);
    const observed=await inspectReceive(binding.repositoryPath,`${patch.baseCommitId} ${commitId} ${input.branch}\n`,'pre',{},{maximumCommitBytes:512_000,signal:deadline});
    if(observed.objectFormat!==patch.objectFormat||observed.commits.length!==1||observed.commits[0]!.commit.id!==commitId||observed.updates.length!==1||fingerprint(binding.repositoryPath)!==before)throw unavailable();
    const {branches:_branches,...commit}=observed.commits[0]!;
    const facts:GitReceiveFacts={repositoryId:patch.repositoryId,objectFormat:patch.objectFormat,phase:'pre',requestId:input.operationId,pusherId:input.pusherId,inspectionComplete:true,updates:[{refName:input.branch,oldId:patch.baseCommitId,newId:commitId,oldCommitId:patch.baseCommitId,newCommitId:commitId,forced:false,commits:[commit]}]};
    const prepared:GitLandingPrepared={operationId:input.operationId,binding:binding.key,repositoryId:binding.repositoryId,branch:input.branch,expectedTargetCommitId:patch.baseCommitId,commitId,treeId:tree.treeId,objectFormat:patch.objectFormat,markerRef:`refs/phabricator/land/${match[1]}`,repositoryFingerprint:before,createdAt:new Date().toISOString(),message,author:{...input.author},committer:{...input.committer}};
    return {prepared,facts};
  }
  state(prepared: GitLandingPrepared): 'ready' | 'landed' | 'conflict' {
    const binding=this.binding(prepared.binding,prepared.repositoryId,prepared.branch),match=operation.exec(prepared.operationId);
    if(!match||prepared.markerRef!==`refs/phabricator/land/${match[1]}`||fingerprint(binding.repositoryPath)!==prepared.repositoryFingerprint)throw unavailable();
    const marker=this.current(binding.repositoryPath,prepared.markerRef);
    if(marker!==null){if(marker!==prepared.commitId||!this.proof(prepared))throw unavailable();return 'landed';}
    if(this.current(binding.repositoryPath,`refs/phabricator/land-proof/${match[1]}`)!==null)throw unavailable();
    return this.current(binding.repositoryPath,prepared.branch)===prepared.expectedTargetCommitId?'ready':'conflict';
  }
  private audit(prepared:GitLandingPrepared,proof:LandingGateProof):string {
    if(!proof||proof.allowed!==true||typeof proof.receiptId!=='string'||!proof.receiptId||proof.receiptId.length>240||/[\x00-\x1f\x7f]/.test(proof.receiptId)||!/^[a-f0-9]{64}$/.test(proof.evidenceSha256)||Object.keys(proof).sort().join(',')!=='allowed,evidenceSha256,receiptId')throw invalid();
    return JSON.stringify({format:'phabricator-land-proof-v1',operationId:prepared.operationId,repositoryId:prepared.repositoryId,branch:prepared.branch,baseCommitId:prepared.expectedTargetCommitId,commitId:prepared.commitId,treeId:prepared.treeId,proof});
  }
  proof(prepared:GitLandingPrepared):LandingGateProof|null {
    const binding=this.binding(prepared.binding,prepared.repositoryId,prepared.branch),match=operation.exec(prepared.operationId);
    if(!match||fingerprint(binding.repositoryPath)!==prepared.repositoryFingerprint)throw unavailable();
    const marker=this.current(binding.repositoryPath,prepared.markerRef),id=this.current(binding.repositoryPath,`refs/phabricator/land-proof/${match[1]}`);
    if(marker===null&&id===null)return null;if(marker!==prepared.commitId||id===null)throw unavailable();
    const result=sync(binding.repositoryPath,['cat-file','blob',id]);if(result.code!==0||Buffer.byteLength(result.data)>2_000||createHash(prepared.objectFormat).update(`blob ${Buffer.byteLength(result.data)}\0`).update(result.data).digest('hex')!==id)throw unavailable();
    try {const value=JSON.parse(result.data) as {proof:LandingGateProof};if(this.audit(prepared,value.proof)!==result.data)throw unavailable();return value.proof;}catch{throw unavailable();}
  }
  land(prepared: GitLandingPrepared, proof:LandingGateProof): 'landed' | 'conflict' {
    const state=this.state(prepared);if(state!=='ready')return state;
    const binding=this.binding(prepared.binding,prepared.repositoryId,prepared.branch),data=this.audit(prepared,proof),proofId=createHash(prepared.objectFormat).update(`blob ${Buffer.byteLength(data)}\0`).update(data).digest('hex');
    const written=sync(binding.repositoryPath,['hash-object','-w','-t','blob','--stdin'],data);if(written.code!==0||written.data.trim()!==proofId)throw unavailable();
    const proofRef=`refs/phabricator/land-proof/${operation.exec(prepared.operationId)![1]}`;
    const result=sync(binding.repositoryPath,['update-ref','--stdin'],`start\noption no-deref\nupdate ${prepared.branch} ${prepared.commitId} ${prepared.expectedTargetCommitId}\ncreate ${prepared.markerRef} ${prepared.commitId}\ncreate ${proofRef} ${proofId}\nprepare\ncommit\n`);
    // A timeout or lost Git receipt can never justify repeating an unchecked
    // write: the atomic operation marker is the authority for recovery.
    if(result.code!==0){const after=this.state(prepared);if(after==='ready')throw unavailable();return after;}
    if(this.state(prepared)!=='landed')throw unavailable();return 'landed';
  }
}
