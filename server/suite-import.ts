import type { DatabaseSync } from 'node:sqlite';
import type { AuthContext } from '../shared/auth.ts';
import type { SuiteAccess, SuiteApp, SuiteDetail, SuiteRecord } from '../shared/suite.ts';
import type { SuiteImportItemPreview, SuiteImportPreview, SuiteImportProvenance, SuiteImportReceipt, SuiteImportRequest } from '../shared/suite-import.ts';
import type { Auth } from './auth.ts';
import type { Store, MutationResponse } from './store.ts';
import { buildSuiteImportPlan, importDigest, type SuiteImportPlan } from './suite-import-plan.ts';
import { SUITE_IMPORT_LIMITS } from './suite-import-xml.ts';
import { HttpError, object, string } from './validation.ts';

const definitions = [
  ['table','suite_import_sources','CREATE TABLE suite_import_sources(source_key TEXT NOT NULL,source_phid TEXT NOT NULL,source_digest TEXT NOT NULL,configuration_digest TEXT NOT NULL,record_id TEXT NOT NULL UNIQUE REFERENCES suite_records(id),imported_at TEXT NOT NULL,imported_by TEXT NOT NULL,provenance TEXT NOT NULL CHECK(json_valid(provenance)),PRIMARY KEY(source_key,source_phid))'],
  ['trigger','suite_import_sources_no_update',"CREATE TRIGGER suite_import_sources_no_update BEFORE UPDATE ON suite_import_sources BEGIN SELECT RAISE(ABORT,'Import provenance is immutable'); END"],
  ['trigger','suite_import_sources_no_delete',"CREATE TRIGGER suite_import_sources_no_delete BEFORE DELETE ON suite_import_sources BEGIN SELECT RAISE(ABORT,'Import provenance is immutable'); END"],
] as const;
export function initializeSuiteImport(database: DatabaseSync): void {
  database.exec('SAVEPOINT suite_import_schema');
  try {
    for (const [type,name,sql] of definitions) {
      const existing=database.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').all(name) as {type:string;sql:string}[];
      const normalize=(value:string)=>value.replace(/\s+/g,' ').trim().replace(/;$/,'');
      if (existing.length && (existing.length!==1 || existing[0]!.type!==type || normalize(existing[0]!.sql)!==normalize(sql))) throw new Error(`Unexpected ${name} schema; import migration was not applied.`);
      if (!existing.length) database.exec(sql);
    }
    database.exec('RELEASE suite_import_schema');
  } catch(error) { database.exec('ROLLBACK TO suite_import_schema; RELEASE suite_import_schema'); throw error; }
}
export interface SuiteImportAdapter {
  validateAccess(access: unknown, actor: AuthContext): SuiteAccess;
  validatePerson(id: string, spaceId: string, actor: AuthContext): void;
  /** Synchronous module mutations under the import transaction; no notifications or external hooks. */
  create(app: SuiteApp, input: Record<string, unknown>, actor: AuthContext): SuiteRecord;
  command(id: string, action: string, input: Record<string, unknown>, actor: AuthContext): SuiteRecord;
  detail(id: string, actor: AuthContext): SuiteDetail;
}
interface Mapping {source_key:string;source_phid:string;source_digest:string;configuration_digest:string;record_id:string;imported_at:string;imported_by:string;provenance:string}
interface Prepared {request:SuiteImportRequest;plan:SuiteImportPlan;preview:SuiteImportPreview;existing:Map<string,Mapping>}
const notFound=()=>new HttpError(404,'Import provenance was not found.');

export class SuiteImportService {
  constructor(private readonly store: Pick<Store,'database'|'mutate'>, private readonly auth: Pick<Auth,'revalidate'>, private readonly adapter: SuiteImportAdapter, private readonly clock=Date.now) {}
  private request(input:unknown, actor:AuthContext):SuiteImportRequest {
    const value=object(input,['sourceKey','files','destination','roles']), sourceKey=string(value.sourceKey,'Source key',128);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(sourceKey)) throw new HttpError(400,'Use a stable source key with letters, numbers, dots, slashes, colons, underscores, or hyphens.');
    if (!Array.isArray(value.files) || !value.files.length || value.files.length>SUITE_IMPORT_LIMITS.files) throw new HttpError(400,'Provide 1–32 MySQL XML export files.');
    const names=new Set<string>(), files=value.files.map(entry=>{ const file=object(entry,['name','xml']), name=string(file.name,'Export name',240), xml=string(file.xml,'XML export',SUITE_IMPORT_LIMITS.bytes); if(names.has(name))throw new HttpError(400,'Export file names must be distinct.'); names.add(name); return{name,xml}; });
    if (value.destination===undefined) throw new HttpError(400,'Explicitly choose the destination Space and access policy.');
    const destination=this.adapter.validateAccess(value.destination,actor);
    const roles: NonNullable<SuiteImportRequest['roles']> = Object.create(null) as NonNullable<SuiteImportRequest['roles']>;
    if(value.roles!==undefined) {
      if(!value.roles || typeof value.roles!=='object' || Array.isArray(value.roles) || Object.keys(value.roles).length>SUITE_IMPORT_LIMITS.objects)throw new HttpError(400,'Choose destination roles keyed by upstream object PHID.');
      for(const [phid,inputRoles]of Object.entries(value.roles)) {
        if(!/^PHID-[A-Z0-9]{4}-[A-Za-z0-9]{1,80}$/.test(phid))throw new HttpError(400,'Destination roles must use upstream object PHIDs.');
        const selected=object(inputRoles,['participantIds','inviteeIds','authorIds','editorIds']), result: Record<string,string[]>={};
        for(const [key,ids]of Object.entries(selected)) {
          if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||!id||id.length>120))throw new HttpError(400,'Choose at most 100 current people per role.');
          result[key]=[...new Set(ids as string[])].sort(); for(const id of result[key]!)this.adapter.validatePerson(id,destination.spaceId,actor);
        }
        roles[phid]=result;
      }
    }
    return{sourceKey,files,destination,roles};
  }
  private mapping(sourceKey:string,phid:string):Mapping|undefined {return this.store.database.prepare('SELECT * FROM suite_import_sources WHERE source_key=? AND source_phid=?').get(sourceKey,phid) as Mapping|undefined;}
  private editable(id:string,actor:AuthContext):SuiteDetail { const detail=this.adapter.detail(id,actor); if(!detail.canEdit)throw notFound(); return detail; }
  private configuration(request:SuiteImportRequest,phid:string):string {return importDigest({destination:request.destination,roles:request.roles?.[phid]??{}});}
  private createItems(prepared:Prepared,actor:AuthContext):{ids:Map<string,string>;records:SuiteImportReceipt['records'];created:Set<string>} {
    const {request,plan,existing}=prepared,ids=new Map([...existing].map(([phid,mapping])=>[phid,mapping.record_id])),records:SuiteImportReceipt['records']=[],created=new Set<string>();
    for(const item of plan.items) {
      const mapped=existing.get(item.sourcePHID);
      if(mapped){records.push({sourcePHID:item.sourcePHID,recordId:mapped.record_id,created:false});continue;}
      const native={...item.input,access:request.destination};
      for(const [field,source]of Object.entries(item.references)){const id=ids.get(source);if(!id)throw new HttpError(409,'An imported dependency is unavailable.');Object.assign(native,{[field]:id});}
      const record=this.adapter.create(item.app,native,actor);ids.set(item.sourcePHID,record.id);created.add(item.sourcePHID);records.push({sourcePHID:item.sourcePHID,recordId:record.id,created:true});
    }
    for(const item of [...plan.items].reverse())if(created.has(item.sourcePHID))for(const action of item.after)this.adapter.command(ids.get(item.sourcePHID)!,action.action,action.input,actor);
    return{ids,records,created};
  }
  private prepare(input:unknown,actor:AuthContext):Prepared {
    const request=this.request(input,actor),plan=buildSuiteImportPlan(request),existing=new Map<string,Mapping>(),versions:unknown[]=[],errors=[...plan.errors];
    const items:SuiteImportItemPreview[]=plan.items.map(item=>{
      const mapped=this.mapping(request.sourceKey,item.sourcePHID); let disposition:SuiteImportItemPreview['disposition']='create';
      if(mapped){const current=this.editable(mapped.record_id,actor);existing.set(item.sourcePHID,mapped);versions.push([mapped.record_id,current.record.version,current.accessEpoch]);disposition=mapped.source_digest===item.sourceDigest&&mapped.configuration_digest===this.configuration(request,item.sourcePHID)?'skip':'conflict';if(disposition==='conflict')errors.push(`${item.sourcePHID} was already imported with different content or destination configuration. Existing native work is never overwritten.`);}
      return{sourcePHID:item.sourcePHID,app:item.app,kind:item.kind,title:item.title,disposition,recordId:mapped?.record_id??null,sourceDigest:item.sourceDigest,historyRows:item.history.rows.length,warnings:item.warnings};
    });
    const batch=new Map(plan.items.map(item=>[item.sourcePHID,item]));
    for(const item of plan.items)for(const [field,dependency]of Object.entries(item.references)) {
      if(batch.has(dependency))continue;
      const mapped=this.mapping(request.sourceKey,dependency);
      if(!mapped){errors.push(`${item.sourcePHID} requires ${field} ${dependency}; include it in this batch or import it from the same source first.`);continue;}
      const current=this.editable(mapped.record_id,actor);existing.set(dependency,mapped);versions.push([mapped.record_id,current.record.version,current.accessEpoch]);
    }
    const preview:SuiteImportPreview={sourceKey:request.sourceKey,digest:'',items,warnings:plan.warnings,errors,canApply:errors.length===0,destination:request.destination};
    const prepared={request,plan,preview,existing};
    if(preview.canApply) {
      // Run the exact native validators, including inter-object and global uniqueness
      // constraints, without retaining data, history, epochs, or notifications.
      this.store.database.exec('SAVEPOINT suite_import_preview');
      try { this.createItems(prepared,actor); }
      catch(error) { if(!(error instanceof HttpError) || ![400,409,413].includes(error.status))throw error; preview.errors.push(error.message); preview.canApply=false; }
      finally { this.store.database.exec('ROLLBACK TO suite_import_preview; RELEASE suite_import_preview'); }
    }
    for(const item of plan.items)if(Buffer.byteLength(JSON.stringify(item.history))>1_950_000){preview.errors.push(`${item.sourcePHID} exceeds the 2 MB per-object provenance limit.`);preview.canApply=false;}
    const epoch=this.store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()?.value;
    preview.digest=importDigest({preview,actor:actor.principalId,roles:request.roles,versions,epoch});
    return prepared;
  }
  preview(input:unknown,actor:AuthContext):SuiteImportPreview {this.auth.revalidate(actor,'write');return this.prepare(input,actor).preview;}
  apply(input:unknown,key:string|undefined,actor:AuthContext):MutationResponse {
    const value=object(input,['request','previewDigest']), digest=string(value.previewDigest,'Preview digest',64);
    if(!/^[a-f0-9]{64}$/.test(digest))throw new HttpError(400,'Use the digest returned by an import preview.');
    if(!key||key.length>200)throw new HttpError(400,'Imports require a bounded Idempotency-Key.');
    const fingerprint=importDigest(input);
    return this.store.mutate(`suite-import:${actor.workspaceId}:${actor.principalId}:${key}`,fingerprint,()=>{
      const prepared=this.prepare(value.request,actor),{request,plan,preview,existing}=prepared;
      if(preview.digest!==digest)throw new HttpError(409,'The import preview changed. Review a fresh preview before applying.');
      if(!preview.canApply)throw new HttpError(409,'Resolve the import preview errors before applying.');
      const {ids,records,created}=this.createItems(prepared,actor);
      for(const item of plan.items)if(created.has(item.sourcePHID)) {
        const recordId=ids.get(item.sourcePHID)!,importedAt=new Date(this.clock()).toISOString();
        const provenance:SuiteImportProvenance={...item.history,sourceKey:request.sourceKey,sourcePHID:item.sourcePHID,sourceDigest:item.sourceDigest,recordId,importedAt,importedBy:actor.principalId,warnings:[...plan.warnings,...item.warnings],assertionStatus:'historical-unverified'};
        const serialized=JSON.stringify(provenance);if(Buffer.byteLength(serialized)>2_000_000)throw new HttpError(413,'One source object exceeds the 2 MB provenance limit. Split its historical export before importing.');
        this.store.database.prepare('INSERT INTO suite_import_sources(source_key,source_phid,source_digest,configuration_digest,record_id,imported_at,imported_by,provenance)VALUES(?,?,?,?,?,?,?,?)').run(request.sourceKey,item.sourcePHID,item.sourceDigest,this.configuration(request,item.sourcePHID),recordId,importedAt,actor.principalId,serialized);
      }
      const receipt:Omit<SuiteImportReceipt,'replayed'>={sourceKey:request.sourceKey,digest,records};return{status:201,body:receipt};
    },()=>this.auth.revalidate(actor,'write'),(response,replayed)=>{
      const receipt=response.body as Omit<SuiteImportReceipt,'replayed'>;
      // The durable receipt contains IDs only; replays cannot recover former source access.
      for(const record of receipt.records)this.editable(record.recordId,actor);
      return{status:response.status,body:{...receipt,replayed}};
    });
  }
  provenance(recordId:string,actor:AuthContext):SuiteImportProvenance {
    this.auth.revalidate(actor,'read');this.editable(recordId,actor);
    const mapping=this.store.database.prepare('SELECT provenance FROM suite_import_sources WHERE record_id=?').get(recordId) as {provenance:string}|undefined;
    if(!mapping)throw notFound();return JSON.parse(mapping.provenance) as SuiteImportProvenance;
  }
}
