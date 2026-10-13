import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deflate } from 'node:zlib';
import { promisify } from 'node:util';
import type { DrydockClaim, DrydockLeaseDetail, DrydockSource } from '../shared/drydock.ts';
import { createGitObserver } from './git.ts';

export interface DrydockLocalBinding { repositoryId: string; repositoryPath: string; root: string }
export interface DrydockWorkerConfiguration { server: string; worker: string; bindings: Record<string, DrydockLocalBinding> }
interface Marker { format: 1; binding: string; worker: string; resourceId: string; leaseId: string; source: DrydockSource; expiresAt: string; ready: boolean }
const compress = promisify(deflate);
const failure = (): Error => new Error('The local working copy could not be safely provisioned or cleaned. Check the operator binding and worker storage.');
const absent = (error: unknown): boolean => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
const same = (a: unknown,b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const safeId = (id: string): boolean => /^DDR-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const env: NodeJS.ProcessEnv = { PATH:'/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME:'/nonexistent', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_SYSTEM:'/dev/null', GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_COUNT:'0', GIT_TERMINAL_PROMPT:'0', GIT_NO_REPLACE_OBJECTS:'1', GIT_ATTR_NOSYSTEM:'1', GIT_NO_LAZY_FETCH:'1', GIT_ALLOW_PROTOCOL:'file', GIT_OPTIONAL_LOCKS:'0', LC_ALL:'C', TZ:'UTC' };
const options = ['--no-replace-objects','--literal-pathspecs','--no-pager','-c','protocol.allow=never','-c','protocol.file.allow=always','-c','credential.helper=','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','core.autocrlf=false','-c','core.attributesFile=/dev/null'];
function git(args: string[],signal: AbortSignal,maximum=8*1024*1024):Promise<Buffer> { return new Promise((resolveResult,reject)=>{if(signal.aborted){reject(failure());return;}const child=spawn('git',[...options,...args],{cwd:'/',env,stdio:['ignore','pipe','pipe'],windowsHide:true});const chunks:Buffer[]=[];let size=0,errorSize=0,failed=false;const stop=()=>{failed=true;child.kill('SIGKILL');};signal.addEventListener('abort',stop,{once:true});child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maximum)stop();else if(!failed)chunks.push(chunk);});child.stderr.on('data',(chunk:Buffer)=>{errorSize+=chunk.length;if(errorSize>32_000)stop();});child.on('error',()=>{failed=true;});child.on('close',code=>{signal.removeEventListener('abort',stop);if(failed||code!==0)reject(failure());else resolveResult(Buffer.concat(chunks));});if(signal.aborted)stop();}); }
export function parseDrydockWorkerConfiguration(input: unknown):DrydockWorkerConfiguration {
  if(!input||typeof input!=='object'||Array.isArray(input))throw failure();const value=input as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['server','worker','bindings'].includes(key))||typeof value.server!=='string'||typeof value.worker!=='string'||!value.worker.trim()||!value.bindings||typeof value.bindings!=='object'||Array.isArray(value.bindings))throw failure();
  const url=new URL(value.server);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash||url.search||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('The worker server must use HTTPS, or HTTP on loopback.');
  const bindings:Record<string,DrydockLocalBinding>={};
  for(const [key,raw]of Object.entries(value.bindings)){if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(key)||!raw||typeof raw!=='object'||Array.isArray(raw))throw failure();const binding=raw as Record<string,unknown>;if(Object.keys(binding).some(name=>!['repositoryId','repositoryPath','root'].includes(name))||typeof binding.repositoryId!=='string'||!/^R[1-9]\d*$/.test(binding.repositoryId)||typeof binding.repositoryPath!=='string'||!isAbsolute(binding.repositoryPath)||typeof binding.root!=='string'||!isAbsolute(binding.root)||[binding.root,binding.repositoryPath].some(path=>path.includes('\0')))throw failure();bindings[key]={repositoryId:binding.repositoryId,repositoryPath:binding.repositoryPath,root:binding.root};}
  if(new Set(Object.values(bindings).map(binding=>resolve(binding.root))).size!==Object.keys(bindings).length)throw new Error('Each worker binding needs its own private storage root.');
  return {server:url.href.replace(/\/$/,''),worker:value.worker,bindings};
}

/** This adapter only materializes exact Git objects. It never executes source,
 * hooks, checkout filters, submodules, SSH, tests, or arbitrary plan commands. */
export class LocalDrydockWorker {
  constructor(readonly configuration:DrydockWorkerConfiguration,private readonly now:()=>number=Date.now){}
  private binding(key:string,source:DrydockSource):DrydockLocalBinding {const binding=this.configuration.bindings[key];if(!binding||binding.repositoryId!==source.repositoryId)throw failure();return binding;}
  private async root(key:string,binding:DrydockLocalBinding):Promise<string>{const root=resolve(binding.root);if(root==='/'||root===resolve(binding.repositoryPath)||root.startsWith(`${resolve(binding.repositoryPath)}/`)||resolve(binding.repositoryPath).startsWith(`${root}/`))throw failure();try{await mkdir(root,{mode:0o700});}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='EEXIST'))throw error;}const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid()||await realpath(root)!==root)throw failure();const markerPath=join(root,'.drydock-root.json'),expected={format:1,binding:key,worker:this.configuration.worker,repositoryId:binding.repositoryId};try{const markerStat=await lstat(markerPath);if(!markerStat.isFile()||markerStat.isSymbolicLink()||!same(JSON.parse(await readFile(markerPath,'utf8')),expected))throw failure();}catch(error){if(!absent(error))throw error;if((await readdir(root)).length)throw failure();await writeFile(markerPath,JSON.stringify(expected),{flag:'wx',mode:0o600});}return root;}
  private async readMarker(root:string,resourceId:string):Promise<Marker|null>{if(!safeId(resourceId))throw failure();const directory=join(root,resourceId);let stat;try{stat=await lstat(directory);}catch(error){if(absent(error))return null;throw error;}if(!stat.isDirectory()||stat.isSymbolicLink())throw failure();const markerPath=join(directory,'ownership.json'),file=await lstat(markerPath);if(!file.isFile()||file.isSymbolicLink()||file.size>16_000)throw failure();const marker=JSON.parse(await readFile(markerPath,'utf8')) as Marker;if(marker.format!==1||marker.resourceId!==resourceId||marker.worker!==this.configuration.worker||!Number.isFinite(Date.parse(marker.expiresAt)))throw failure();return marker;}
  private async mark(root:string,marker:Marker):Promise<void>{const path=join(root,marker.resourceId,'ownership.json'),handle=await open(path,constants.O_WRONLY|constants.O_TRUNC|constants.O_NOFOLLOW);try{await handle.writeFile(JSON.stringify(marker));}finally{await handle.close();}}
  async provision(claim:DrydockClaim):Promise<{handle:string;path:string}>{
    if(claim.operation!=='provision'||claim.resource.worker!==this.configuration.worker||!safeId(claim.resource.handle)||claim.resource.id!==claim.resource.handle||claim.resource.leaseId!==claim.lease.id||!same(claim.resource.source,claim.lease.source))throw failure();
    const binding=this.binding(claim.resource.binding,claim.resource.source),root=await this.root(claim.resource.binding,binding),directory=join(root,claim.resource.id),work=join(directory,'work');
    const prior=await this.readMarker(root,claim.resource.id);if(prior){if(prior.leaseId!==claim.lease.id||!same(prior.source,claim.lease.source)||prior.binding!==claim.resource.binding||!prior.ready)throw failure();return {handle:claim.resource.handle,path:work};}
    const marker:Marker={format:1,binding:claim.resource.binding,worker:this.configuration.worker,resourceId:claim.resource.id,leaseId:claim.lease.id,source:claim.lease.source,expiresAt:claim.lease.expiresAt,ready:false};
    await mkdir(directory,{mode:0o700});await writeFile(join(directory,'ownership.json'),JSON.stringify(marker),{flag:'wx',mode:0o600});
    try{
      const remaining=Math.min(Date.parse(claim.claimUntil),Date.parse(claim.lease.expiresAt))-this.now();if(remaining<=0)throw failure();const signal=AbortSignal.timeout(Math.min(remaining,240_000));
      const source=await createGitObserver({[binding.repositoryId]:binding.repositoryPath}).commit(binding.repositoryId,claim.lease.source.commitId,signal);
      if(source.objectFormat!==claim.lease.source.objectFormat||source.commit.treeId!==claim.lease.source.treeId)throw failure();
      const template=join(directory,'empty-template');await mkdir(template,{mode:0o700});
      await git(['init','--initial-branch=main',`--object-format=${claim.lease.source.objectFormat}`,`--template=${template}`,work],signal);
      const gitDir=join(work,'.git'),sourceGit=`--git-dir=${binding.repositoryPath}`,stored=new Set<string>();
      const storeObject=async(type:'commit'|'tree'|'blob',id:string,maximum:number):Promise<Buffer>=>{
        const bytes=await git([sourceGit,'cat-file',type,id],signal,maximum),header=Buffer.from(`${type} ${bytes.length}\0`);
        if(createHash(claim.lease.source.objectFormat).update(header).update(bytes).digest('hex')!==id)throw failure();
        if(!stored.has(id)){const directory=join(gitDir,'objects',id.slice(0,2));await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,id.slice(2)),await compress(Buffer.concat([header,bytes])),{flag:'wx',mode:0o400});stored.add(id);}
        return bytes;
      };
      await storeObject('commit',claim.lease.source.commitId,1_000_000);
      let metadataBytes=(await storeObject('tree',claim.lease.source.treeId,8*1024*1024)).length;
      const inventory=await git([sourceGit,'ls-tree','-r','-t','-z','--full-tree',claim.lease.source.commitId],signal);
      const entries=inventory.toString('utf8').split('\0').filter(Boolean);if(!Buffer.from(inventory.toString('utf8')).equals(inventory)||entries.length>20_000)throw failure();
      const paths=new Map<string,string>();let totalBytes=0;
      for(const entry of entries){if(signal.aborted)throw failure();const match=/^(100644|100755|040000) (blob|tree) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(entry);if(!match||(match[1]==='040000')!==(match[2]==='tree'))throw failure();const path=match[4]!,parts=path.split('/');if(path.length>4096||parts.some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git'||/[\\\x00-\x1f:]/.test(part)||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw failure();
        for(let index=0;index<parts.length;index++){const prefix=parts.slice(0,index+1).join('/'),normalized=prefix.normalize('NFC').toLowerCase(),priorPath=paths.get(normalized);if(priorPath&&priorPath!==prefix)throw failure();paths.set(normalized,prefix);}
        if(match[2]==='tree'){metadataBytes+=(await storeObject('tree',match[3]!,8*1024*1024)).length;if(metadataBytes>8*1024*1024)throw failure();await mkdir(join(work,...parts),{recursive:true,mode:0o700});continue;}
        const bytes=await storeObject('blob',match[3]!,64*1024*1024);totalBytes+=bytes.length;if(totalBytes>256*1024*1024)throw failure();
        const parent=join(work,...parts.slice(0,-1));await mkdir(parent,{recursive:true,mode:0o700});const handle=await open(join(work,...parts),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,match[1]==='100755'?0o700:0o600);try{await handle.writeFile(bytes);}finally{await handle.close();}
      }
      // A shallow boundary makes the exact checkout usable without copying an
      // unbounded amount of unrelated history into the worker's storage pool.
      await writeFile(join(gitDir,'shallow'),`${claim.lease.source.commitId}\n`,{mode:0o600});
      await git([`--git-dir=${gitDir}`,`--work-tree=${work}`,'read-tree',claim.lease.source.commitId],signal);
      await writeFile(join(gitDir,'HEAD'),`${claim.lease.source.commitId}\n`,{mode:0o600});await chmod(work,0o700);marker.ready=true;await this.mark(root,marker);return {handle:claim.resource.handle,path:work};
    }catch(error){await this.release(claim).catch(()=>undefined);throw error;}
  }
  async release(claim:Pick<DrydockClaim,'lease'|'resource'>):Promise<void>{const binding=this.binding(claim.resource.binding,claim.resource.source),root=await this.root(claim.resource.binding,binding),marker=await this.readMarker(root,claim.resource.id);if(!marker)return;if(marker.binding!==claim.resource.binding||marker.leaseId!==claim.lease.id||!same(marker.source,claim.resource.source))throw failure();await rm(join(root,claim.resource.id),{recursive:true,force:false});}
  async reapExpired():Promise<number>{let count=0;for(const [key,binding]of Object.entries(this.configuration.bindings)){const root=await this.root(key,binding);for(const id of await readdir(root)){if(!safeId(id))continue;const marker=await this.readMarker(root,id);if(marker&&marker.binding!==key)throw failure();if(marker&&Date.parse(marker.expiresAt)<=this.now()){await rm(join(root,id),{recursive:true,force:false});count++;}}}return count;}
  async reconcile(fetchLease:(id:string)=>Promise<DrydockLeaseDetail|null>):Promise<void>{for(const [key,binding]of Object.entries(this.configuration.bindings)){const root=await this.root(key,binding);for(const id of await readdir(root)){if(!safeId(id))continue;const marker=await this.readMarker(root,id);if(!marker)continue;if(marker.binding!==key)throw failure();const detail=await fetchLease(marker.leaseId);if(!detail||detail.resource?.id!==id||!same(detail.lease.source,marker.source)||!['active','acquired'].includes(detail.lease.status)){await rm(join(root,id),{recursive:true,force:false});continue;}marker.expiresAt=detail.lease.expiresAt;await this.mark(root,marker);}}}
}

/** One poll is useful both for service loops and operator cron. Idempotency keys
 * belong to exact writes; ambiguous network outcomes are retried with the same key. */
export async function runDrydockWorkerCycle(worker:LocalDrydockWorker,token:string,fetcher:typeof fetch=fetch,shouldStop:()=>boolean=()=>false):Promise<void>{
  if(shouldStop())return;
  const request=async(path:string,input?:unknown):Promise<Record<string,unknown>|null>=>{const key=input===undefined?undefined:randomUUID();for(let attempt=0;attempt<2;attempt++){try{const response=await fetcher(`${worker.configuration.server}/api/drydock${path}`,{method:input===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{Authorization:`Bearer ${token}`,...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key!})},...(input===undefined?{}:{body:JSON.stringify(input)})});if([403,404].includes(response.status)&&path.startsWith('/leases/')&&input===undefined)return null;if(!response.ok)throw new Error(`Drydock API returned ${response.status}.`);return await response.json() as Record<string,unknown>;}catch(error){if(attempt===1)throw error;}}throw failure();};
  // Refresh renewals before applying a cached deadline. Cleanup must still run
  // when the server is unreachable or the worker credential no longer works.
  try {
    await worker.reconcile(async id=>await request(`/leases/${encodeURIComponent(id)}`) as unknown as DrydockLeaseDetail|null);
  } finally {
    await worker.reapExpired();
  }
  if(shouldStop())return;
  const response=await request(`/worker/jobs?worker=${encodeURIComponent(worker.configuration.worker)}`),jobs=response?.jobs as DrydockLeaseDetail[]|undefined;if(!Array.isArray(jobs))throw failure();
  for(const job of jobs){if(shouldStop())return;let claim:DrydockClaim;try{const response=await request(`/leases/${encodeURIComponent(job.lease.id)}/claim`,{expectedVersion:job.lease.version,worker:worker.configuration.worker});claim=response as unknown as DrydockClaim;if(!claim?.lease||!claim.resource||!claim.token)throw failure();}catch{continue;}
    if(shouldStop())return;
    let type:'active'|'released'|'broken'='broken';try{if(claim.operation==='provision'){await worker.provision(claim);type='active';}else{await worker.release(claim);type='released';}}catch{type='broken';}
    try{await request(`/leases/${encodeURIComponent(claim.lease.id)}/report`,{token:claim.token,reportId:randomUUID(),type,log:type==='active'?'Exact Git working copy is ready; no source code was executed.':type==='released'?'The worker removed its owned working-copy directory.':'The local worker could not complete the requested operation.'});}catch(error){/* The ready receipt may have committed. Keep owned files until authoritative reconciliation or local expiry. */throw error;}
  }
}
