import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionPatchIdentity } from '../shared/revision-patch.ts';
import type { GitReceiveFacts } from '../shared/git-automation.ts';
import type { RevisionLandingOperation, RevisionLandingDetail, RevisionLandingEvent, LandingGateProof } from '../shared/revision-landing.ts';
import { revisionLandingCommand, revisionLandingPrepareInput } from '../shared/revision-landing.ts';
import type { GitLandingPreparation, GitLandingTransport } from './git-landing.ts';
import { parseGitReceiveFacts } from './git-automation.ts';
import { HttpError } from './validation.ts';

export interface RevisionLandingHooks {
  authorize(operation: RevisionLandingOperation, actor: ActorAttribution, phase: 'read' | 'prepare' | 'land' | 'cancel' | 'recover'): void;
  beforeLand(operation: RevisionLandingOperation, facts: GitReceiveFacts, actor: ActorAttribution): { allowed: true; proof: LandingGateProof } | { allowed: false; message?: string; receiptId?: string };
  afterLand(operation: RevisionLandingOperation, facts: GitReceiveFacts, actor: ActorAttribution): void;
}
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const changed = () => new HttpError(409,'The landing operation changed. Reload before continuing.','LANDING_CHANGED');
const invalid = () => new HttpError(400,'The landing preparation does not match its immutable source and target.','LANDING_INVALID_PREPARATION');
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
let sequence=0;
function parsed<T>(parser:(input:unknown)=>T,input:unknown):T { try{return parser(input);}catch(error){throw new HttpError(400,error instanceof Error?error.message:'Invalid landing request.');} }

export function initializeRevisionLanding(database: DatabaseSync): void {
  const schema=`
    CREATE TABLE IF NOT EXISTS revision_landings(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,owner_id TEXT NOT NULL,input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE IF NOT EXISTS revision_landing_preparations(operation_id TEXT PRIMARY KEY REFERENCES revision_landings(id),data TEXT NOT NULL CHECK(json_valid(data)),facts TEXT NOT NULL CHECK(json_valid(facts)));
    CREATE TABLE IF NOT EXISTS revision_landing_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,operation_id TEXT NOT NULL REFERENCES revision_landings(id),version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(operation_id,version));
    ${['revision_landing_preparations','revision_landing_events'].map(table=>`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Landing evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Landing evidence is immutable'); END;`).join('\n')}
  `;
  const name=`landing_schema_${++sequence}`,model=new DatabaseSync(':memory:');database.exec(`SAVEPOINT ${name}`);
  try {
    model.exec(schema);
    type Definition={type:string;name:string;tbl_name:string;sql:string|null};
    const expected=model.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN('revision_landings','revision_landing_preparations','revision_landing_events')").all() as unknown as Definition[];
    const normalize=(sql:string|null)=>sql?.replace(/\bIF NOT EXISTS\s+/gi,'').replace(/\s+/g,' ').trim()??null;
    const existing=database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN('revision_landings','revision_landing_preparations','revision_landing_events') OR name IN ('revision_landing_preparations_no_update','revision_landing_preparations_no_delete','revision_landing_events_no_update','revision_landing_events_no_delete')").all() as unknown as Definition[];
    for(const value of existing){const match=expected.find(row=>row.name===value.name);if(!match||match.type!==value.type||match.tbl_name!==value.tbl_name||normalize(match.sql)!==normalize(value.sql))throw new Error(`Unexpected ${value.name} schema; landing migration was not applied.`);}
    database.exec(schema);database.exec(`RELEASE ${name}`);
  }catch(error){database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);throw error;}finally{model.close();}
}

/** Prepare must commit before command can touch Git. External effects are fenced
 * by an atomic Git marker, so a database rollback cannot repeat the ref update. */
export class RevisionLandingStore {
  constructor(private readonly database:DatabaseSync,private readonly transport:GitLandingTransport,private readonly hooks:RevisionLandingHooks){}
  private scope<T>(work:()=>T):T { const name=`landing_${++sequence}`;this.database.exec(`SAVEPOINT ${name}`);try{this.database.exec('UPDATE revision_landings SET data=data WHERE 0');const result=work();this.database.exec(`RELEASE ${name}`);return result;}catch(error){this.database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);throw error;} }
  private read(id:string):RevisionLandingOperation {const row=this.database.prepare('SELECT data FROM revision_landings WHERE id=?').get(id) as {data:string}|undefined;if(!row)throw new HttpError(404,'Landing operation was not found.');return decode(row.data);}
  private facts(id:string):GitReceiveFacts {const row=this.database.prepare('SELECT facts FROM revision_landing_preparations WHERE operation_id=?').get(id) as {facts:string}|undefined;if(!row)throw new HttpError(500,'Landing evidence is unavailable.');return parseGitReceiveFacts(decode(row.facts));}
  private event(value:RevisionLandingOperation,actor:ActorAttribution):void {const event:RevisionLandingEvent={id:randomUUID(),operationId:value.id,version:value.version,state:value.state,message:value.message,createdAt:value.updatedAt,actorId:actor.principalId};this.database.prepare('INSERT INTO revision_landing_events(id,operation_id,version,data) VALUES(?,?,?,?)').run(event.id,event.operationId,event.version,JSON.stringify({...event,snapshot:value}));}
  private save(value:RevisionLandingOperation,actor:ActorAttribution):void {value.version++;value.updatedAt=new Date().toISOString();this.database.prepare('UPDATE revision_landings SET data=? WHERE id=?').run(JSON.stringify(value),value.id);this.event(value,actor);}
  private events(id:string,version=Number.MAX_SAFE_INTEGER):RevisionLandingEvent[] {return (this.database.prepare('SELECT data FROM revision_landing_events WHERE operation_id=? AND version<=? ORDER BY version').all(id,version) as {data:string}[]).map(row=>{const {snapshot:_snapshot,...event}=decode<RevisionLandingEvent&{snapshot:RevisionLandingOperation}>(row.data);return event;});}
  detail(id:string,actor:ActorAttribution):RevisionLandingDetail {const operation=this.read(id);this.hooks.authorize(operation,actor,'read');return {operation,events:this.events(id)};}
  verifyDetail(detail:RevisionLandingDetail,actor:ActorAttribution):void {
    const fail=()=>new HttpError(409,'This saved landing receipt does not match immutable operation evidence.','LANDING_INVALID_RECEIPT');
    if(!detail||!detail.operation||typeof detail.operation.id!=='string'||!Number.isSafeInteger(detail.operation.version)||detail.operation.version<1)throw fail();
    this.detail(detail.operation.id,actor);
    const row=this.database.prepare('SELECT data FROM revision_landing_events WHERE operation_id=? AND version=?').get(detail.operation.id,detail.operation.version) as {data:string}|undefined;
    const snapshot=row?decode<{snapshot:RevisionLandingOperation}>(row.data).snapshot:null;
    if(!snapshot||!isDeepStrictEqual(detail.operation,snapshot)||!isDeepStrictEqual(detail.events,this.events(detail.operation.id,detail.operation.version))||Object.keys(detail).some(key=>!['operation','events','accessEpoch','canLand','canCancel','canRecover'].includes(key)))throw fail();
  }
  list(revisionId:string,actor:ActorAttribution):RevisionLandingOperation[] {const rows=this.database.prepare('SELECT id FROM revision_landings WHERE revision_id=? ORDER BY rowid DESC').all(revisionId) as {id:string}[];return rows.map(row=>this.detail(row.id,actor).operation);}
  prepare(input:unknown,patch:RevisionPatchIdentity,preparation:GitLandingPreparation,actor:ActorAttribution,reviewIds:readonly string[]):RevisionLandingDetail {
    const request=parsed(revisionLandingPrepareInput,input),{prepared}=preparation,facts=parseGitReceiveFacts(preparation.facts);
    const id=prepared.operationId;
    if(!/^LAND-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)||!actor.principalId||patch.versionId!==request.expectedVersionId||patch.versionNumber!==request.expectedVersion||patch.contentHash!==request.expectedContentHash||patch.baseCommitId!==request.baseCommitId||patch.targetTreeId!==prepared.treeId||patch.objectFormat!==prepared.objectFormat||prepared.binding!==request.binding||prepared.branch!==request.branch||prepared.expectedTargetCommitId!==request.expectedTargetCommitId||facts.repositoryId!==prepared.repositoryId||facts.objectFormat!==prepared.objectFormat||facts.phase!=='pre'||facts.requestId!==id||facts.pusherId!==actor.principalId||facts.updates.length!==1||!Array.isArray(reviewIds)||reviewIds.some(value=>typeof value!=='string'||!value)||new Set(reviewIds).size!==reviewIds.length)throw invalid();
    const update=facts.updates[0]!;
    if(update.refName!==prepared.branch||update.oldId!==prepared.expectedTargetCommitId||update.oldCommitId!==prepared.expectedTargetCommitId||update.newId!==prepared.commitId||update.newCommitId!==prepared.commitId||update.forced||update.commits.length!==1||update.commits[0]!.commit.id!==prepared.commitId||update.commits[0]!.commit.treeId!==prepared.treeId||update.commits[0]!.commit.parentIds.length!==1||update.commits[0]!.commit.parentIds[0]!==prepared.expectedTargetCommitId)throw invalid();
    const now=new Date().toISOString(),value:RevisionLandingOperation={id,revisionId:patch.revisionId,version:1,state:'prepared',input:request,patch,prepared,attribution:{...actor},reviewIds:[...reviewIds],gateProof:null,createdAt:now,updatedAt:now,landedAt:null,message:'Exact reviewed source prepared as a squash commit; the target branch has not changed.'};
    const inputHash=sha({request,patch,preparation,actorId:actor.principalId,reviewIds});
    return this.scope(()=>{
      this.hooks.authorize(value,actor,'prepare');
      const existing=this.database.prepare('SELECT input_sha256 FROM revision_landings WHERE id=?').get(id) as {input_sha256:string}|undefined;
      if(existing){if(existing.input_sha256!==inputHash)throw changed();return this.detail(id,actor);}
      const pending=this.database.prepare("SELECT id FROM revision_landings WHERE revision_id=? AND json_extract(data,'$.state')='prepared'").get(value.revisionId);
      if(pending)throw new HttpError(409,'This revision already has a prepared landing. Land or cancel it first.','LANDING_ALREADY_PREPARED');
      if(this.transport.state(prepared)!=='ready')throw new HttpError(409,'The target branch changed during preparation.','LANDING_TARGET_CHANGED');
      this.database.prepare('INSERT INTO revision_landings(id,revision_id,owner_id,input_sha256,data) VALUES(?,?,?,?,?)').run(id,value.revisionId,actor.principalId,inputHash,JSON.stringify(value));
      this.database.prepare('INSERT INTO revision_landing_preparations(operation_id,data,facts) VALUES(?,?,?)').run(id,JSON.stringify(value),JSON.stringify(facts));this.event(value,actor);return this.detail(id,actor);
    });
  }
  command(id:string,input:unknown,actor:ActorAttribution):RevisionLandingDetail {
    const request=parsed(revisionLandingCommand,input);
    return this.scope(()=>{
      const value=this.read(id);this.hooks.authorize(value,actor,'read');
      if(value.state==='landed'&&request.command==='land')return this.detail(id,actor);
      if(value.state==='cancelled'&&request.command==='cancel')return this.detail(id,actor);
      if(value.version!==request.expectedVersion||value.state!=='prepared')throw changed();
      const state=this.transport.state(value.prepared);
      if(state==='landed'){
        this.hooks.authorize(value,actor,'recover');value.gateProof=this.transport.proof(value.prepared);if(!value.gateProof)throw new HttpError(503,'The landing audit proof is unavailable.');this.hooks.afterLand(value,{...this.facts(id),phase:'post'},actor);
        value.state='landed';value.landedAt=new Date().toISOString();value.message='Recovered the completed atomic Git landing; the branch was not written again.';this.save(value,actor);return this.detail(id,actor);
      }
      if(request.command==='cancel'){
        this.hooks.authorize(value,actor,'cancel');value.state='cancelled';value.message='Prepared landing cancelled; the target branch was not changed.';this.save(value,actor);return this.detail(id,actor);
      }
      this.hooks.authorize(value,actor,'land');
      if(state==='conflict'){value.state='conflict';value.message='The target branch changed. Update and review the source, then prepare again.';this.save(value,actor);return this.detail(id,actor);}
      const facts=this.facts(id),decision=this.hooks.beforeLand(value,facts,actor);
      if(!decision.allowed){if(decision.receiptId!==undefined){if(!/^GREC-[a-f0-9]{64}$/.test(decision.receiptId))throw invalid();value.rejectedReceiveId=decision.receiptId;}value.state='conflict';value.message=decision.message??'Repository rules rejected this landing.';this.save(value,actor);return this.detail(id,actor);}
      // Root must perform authorization, gate evaluation and this bounded local
      // CAS under the same writer transaction, without asynchronous callbacks.
      value.gateProof=decision.proof;
      if(this.transport.land(value.prepared,decision.proof)==='conflict'){value.state='conflict';value.message='The target branch changed before its atomic update.';this.save(value,actor);return this.detail(id,actor);}
      this.hooks.afterLand(value,{...facts,phase:'post'},actor);value.state='landed';value.landedAt=new Date().toISOString();value.message='Landed the exact reviewed tree with an atomic squash commit.';this.save(value,actor);return this.detail(id,actor);
    });
  }
}
