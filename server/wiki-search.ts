import type { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { WikiVersion } from '../shared/types.ts';
import { canonicalWikiPath, wikiParentPath, type WikiStatus } from '../shared/wiki.ts';
import { WIKI_SEARCH_MAX_SCAN, WIKI_SEARCH_MAX_SOURCE_BYTES, WIKI_SEARCH_SNIPPET_LENGTH, WIKI_SEARCH_MAX_FILTER_VALUES, type WikiSearchOrder, type WikiDocumentSearchQuery, type WikiContentSearchQuery, type WikiDocumentIdentity, type WikiContentIdentity, type WikiContentSearchItem, type WikiDocumentSearchItem, type WikiDocumentSearchPage, type WikiContentSearchPage } from '../shared/wiki-search.ts';
import { object, string, integer, choice, HttpError } from './validation.ts';

type Paging={order:WikiSearchOrder;after?:string;before?:string;limit:number;includeContent:boolean;query:string};
type Documents=Paging&{queryKey:'active'|'all';statuses:WikiStatus[];paths:string[];parentPaths:string[];ancestorPaths:string[];ids:number[];phids:string[]};
type Contents=Paging&{documentPHIDs:string[];versions:number[];ids:number[];phids:string[]};
const pagingKeys=['order','after','before','limit','includeContent','query'];
function list<T>(value:unknown,label:string,parse:(input:unknown)=>T):T[] {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>WIKI_SEARCH_MAX_FILTER_VALUES)throw new HttpError(400,`${label} must be a list of at most ${WIKI_SEARCH_MAX_FILTER_VALUES} values.`);
  return [...new Set(value.map(parse))].sort((a,b)=>typeof a==='number'&&typeof b==='number'?a-b:String(a)<String(b)?-1:String(a)>String(b)?1:0);
}
function phid(value:unknown,type:'WIKI'|'WRDS'):string {if(typeof value!=='string'||!new RegExp(`^PHID-${type}-[a-zA-Z0-9]{20}$`).test(value))throw new HttpError(400,`Expected a ${type} PHID.`);return value;}
function path(value:unknown):string {try{return canonicalWikiPath(string(value,'Path',512,true));}catch{throw new HttpError(400,'Invalid wiki path.');}}
function paging(data:Record<string,unknown>):Paging {
  if(data.after!==undefined&&data.before!==undefined)throw new HttpError(400,'Use either after or before, not both.');
  const limit=data.limit===undefined?25:integer(data.limit,'limit');if(limit>100)throw new HttpError(400,'limit must be at most 100.');
  if(data.includeContent!==undefined&&typeof data.includeContent!=='boolean')throw new HttpError(400,'includeContent must be a boolean.');
  const query=data.query===undefined?'':string(data.query,'Search text',1000,true);if(/[\uD800-\uDFFF]/u.test(query))throw new HttpError(400,'Search text must contain complete characters.');
  return {order:data.order===undefined?'newest':choice(data.order,'order',['newest','oldest']),...(data.after===undefined?{}:{after:string(data.after,'after',100)}),...(data.before===undefined?{}:{before:string(data.before,'before',100)}),limit,includeContent:data.includeContent===true,query:query.toLowerCase()};
}
export function parseWikiDocumentSearchQuery(input:unknown={}):Documents {
  const data=object(input,[...pagingKeys,'queryKey','statuses','paths','parentPaths','ancestorPaths','ids','phids']);
  const queryKey=data.queryKey===undefined?'active':choice(data.queryKey,'queryKey',['active','all']);
  return {...paging(data),queryKey,statuses:data.statuses===undefined?(queryKey==='active'?['active']:[]):list(data.statuses,'statuses',item=>choice(item,'status',['active','moved','deleted','stub'])),paths:list(data.paths,'paths',path),parentPaths:list(data.parentPaths,'parentPaths',path),ancestorPaths:list(data.ancestorPaths,'ancestorPaths',path),ids:list(data.ids,'ids',item=>integer(item,'ID')),phids:list(data.phids,'phids',item=>phid(item,'WIKI'))};
}
export function parseWikiContentSearchQuery(input:unknown={}):Contents {
  const data=object(input,[...pagingKeys,'documentPHIDs','versions','ids','phids']);
  return {...paging(data),documentPHIDs:list(data.documentPHIDs,'documentPHIDs',item=>phid(item,'WIKI')),versions:list(data.versions,'versions',item=>integer(item,'Version')),ids:list(data.ids,'ids',item=>integer(item,'ID')),phids:list(data.phids,'phids',item=>phid(item,'WRDS'))};
}

/** Immutable API identities are sidecars; historical source and receipts stay byte-for-byte unchanged. */
export function initializeWikiSearch(database:DatabaseSync):void {
  database.exec(`CREATE TABLE wiki_document_identifiers(id INTEGER PRIMARY KEY,document_id TEXT NOT NULL UNIQUE REFERENCES entities(id),phid TEXT NOT NULL UNIQUE CHECK(length(phid)=30));
    CREATE TABLE wiki_content_identifiers(id INTEGER PRIMARY KEY,version_id TEXT NOT NULL UNIQUE REFERENCES wiki_versions(id),document_id TEXT NOT NULL REFERENCES entities(id),phid TEXT NOT NULL UNIQUE CHECK(length(phid)=30),byte_size INTEGER NOT NULL CHECK(byte_size>=0));
    CREATE INDEX wiki_content_identifiers_document ON wiki_content_identifiers(document_id,id);
    CREATE TRIGGER wiki_document_identifiers_no_update BEFORE UPDATE ON wiki_document_identifiers BEGIN SELECT RAISE(ABORT,'Wiki API identities are immutable'); END;
    CREATE TRIGGER wiki_document_identifiers_no_delete BEFORE DELETE ON wiki_document_identifiers BEGIN SELECT RAISE(ABORT,'Wiki API identities are immutable'); END;
    CREATE TRIGGER wiki_content_identifiers_no_update BEFORE UPDATE ON wiki_content_identifiers BEGIN SELECT RAISE(ABORT,'Wiki API identities are immutable'); END;
    CREATE TRIGGER wiki_content_identifiers_no_delete BEFORE DELETE ON wiki_content_identifiers BEGIN SELECT RAISE(ABORT,'Wiki API identities are immutable'); END;`);
  const search=new WikiSearchStore(database);
  for(const row of database.prepare("SELECT id FROM entities WHERE kind='document' ORDER BY rowid").all() as {id:string}[])search.ensureDocument(row.id);
  for(const row of database.prepare('SELECT id FROM wiki_versions ORDER BY rowid').all() as {id:string}[])search.ensureContent(row.id);
}

type Candidate={id:number;document_id:string;phid:string;version_id:string;content_id:number;content_phid:string;document_phid:string;byte_size:number;path:string;status:WikiStatus;head_number:number;version_number:number};
type Position={upper:number;boundary:number;epoch:number};
function completeSlice(value:string,start:number,end:number):string {if(start>0&&/[\uDC00-\uDFFF]/.test(value[start]??''))start--;if(end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1]??''))end--;return value.slice(start,end);}
function snippet(content:string,term:string):string {const at=term?content.toLowerCase().indexOf(term):-1,start=Math.max(0,at-60),end=start+WIKI_SEARCH_SNIPPET_LENGTH;return `${start?'…':''}${completeSlice(content,start,end)}${end<content.length?'…':''}`;}
export class WikiSearchStore {
  constructor(private readonly database:DatabaseSync){}
  ensureDocument(documentId:string):WikiDocumentIdentity {
    this.database.prepare("INSERT INTO wiki_document_identifiers(document_id,phid) SELECT id,? FROM entities WHERE id=? AND kind='document' ON CONFLICT(document_id) DO NOTHING").run(`PHID-WIKI-${randomBytes(10).toString('hex')}`,documentId);
    return this.documentIdentity(documentId);
  }
  ensureContent(versionId:string):WikiContentIdentity {
    this.database.prepare('INSERT INTO wiki_content_identifiers(version_id,document_id,phid,byte_size) SELECT id,document_id,?,length(CAST(data AS BLOB)) FROM wiki_versions WHERE id=? ON CONFLICT(version_id) DO NOTHING').run(`PHID-WRDS-${randomBytes(10).toString('hex')}`,versionId);
    return this.contentIdentity(versionId);
  }
  documentIdentity(documentId:string):WikiDocumentIdentity {
    const row=this.database.prepare('SELECT id,phid,document_id AS documentId FROM wiki_document_identifiers WHERE document_id=?').get(documentId) as unknown as WikiDocumentIdentity|undefined;
    if(!row)throw new HttpError(404,'Wiki document identity is unavailable.','WIKI_DOCUMENT_UNAVAILABLE');return {...row};
  }
  contentIdentity(versionId:string):WikiContentIdentity {
    const row=this.database.prepare('SELECT id,phid,document_id AS documentId,version_id AS versionId FROM wiki_content_identifiers WHERE version_id=?').get(versionId) as unknown as WikiContentIdentity|undefined;
    if(!row)throw new HttpError(404,'Wiki content identity is unavailable.','WIKI_VERSION_UNAVAILABLE');return {...row};
  }
  resolveDocument(value:number|string):WikiDocumentIdentity|null {
    const field=typeof value==='number'?'id':'phid',key=typeof value==='number'?integer(value,'ID'):phid(value,'WIKI');
    const row=this.database.prepare(`SELECT id,phid,document_id AS documentId FROM wiki_document_identifiers WHERE ${field}=?`).get(key) as unknown as WikiDocumentIdentity|undefined;return row?{...row}:null;
  }
  resolveContent(value:number|string):WikiContentIdentity|null {
    const field=typeof value==='number'?'id':'phid',key=typeof value==='number'?integer(value,'ID'):phid(value,'WRDS');
    const row=this.database.prepare(`SELECT id,phid,document_id AS documentId,version_id AS versionId FROM wiki_content_identifiers WHERE ${field}=?`).get(key) as unknown as WikiContentIdentity|undefined;return row?{...row}:null;
  }
  private epoch():number{return this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;}
  private key():Uint8Array{return this.database.prepare('SELECT key FROM wiki_cursor_secret WHERE singleton=1').get()!.key as Uint8Array;}
  private aad(kind:'documents'|'contents',query:Documents|Contents,direction:'after'|'before',principalId:string):Buffer {
    const {after:_after,before:_before,limit:_limit,...constraints}=query;return Buffer.from(JSON.stringify(['wiki-search-v1',kind,direction,principalId,constraints]));
  }
  private encode(kind:'documents'|'contents',query:Documents|Contents,direction:'after'|'before',position:Position,principalId:string):string {
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key(),nonce);cipher.setAAD(this.aad(kind,query,direction,principalId));
    const payload=Buffer.alloc(24);payload.writeBigUInt64BE(BigInt(position.upper),0);payload.writeBigUInt64BE(BigInt(position.boundary),8);payload.writeBigUInt64BE(BigInt(position.epoch),16);
    const encrypted=Buffer.concat([cipher.update(payload),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
  }
  private decode(kind:'documents'|'contents',query:Documents|Contents,direction:'after'|'before',token:string,principalId:string):Position {
    let position:Position;
    try{
      if(!/^[A-Za-z0-9_-]{70}$/.test(token))throw new Error();const bytes=Buffer.from(token,'base64url');if(bytes.toString('base64url')!==token)throw new Error();
      const decipher=createDecipheriv('aes-256-gcm',this.key(),bytes.subarray(0,12));decipher.setAAD(this.aad(kind,query,direction,principalId));decipher.setAuthTag(bytes.subarray(12,28));
      const payload=Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]);if(payload.length!==24)throw new Error();
      position={upper:Number(payload.readBigUInt64BE(0)),boundary:Number(payload.readBigUInt64BE(8)),epoch:Number(payload.readBigUInt64BE(16))};
      if(Object.values(position).some(value=>!Number.isSafeInteger(value)||value<1)||position.boundary>position.upper)throw new Error();
    }catch{throw new HttpError(400,'Invalid or mismatched wiki search cursor.','WIKI_SEARCH_CURSOR_INVALID');}
    if(position.epoch!==this.epoch())throw new HttpError(409,'Access changed. Start the search again.','ACCESS_EPOCH_CHANGED');return position;
  }
  private metadataMatches(row:Candidate,query:Documents|Contents,kind:'documents'|'contents'):boolean {
    if(query.ids.length&&!query.ids.includes(row.id)||query.phids.length&&!query.phids.includes(row.phid))return false;
    if(kind==='contents'){const filters=query as Contents;return (!filters.documentPHIDs.length||filters.documentPHIDs.includes(row.document_phid))&&(!filters.versions.length||filters.versions.includes(row.version_number));}
    const filters=query as Documents;
    if(filters.statuses.length&&!filters.statuses.includes(row.status)||filters.paths.length&&!filters.paths.includes(row.path))return false;
    if(filters.parentPaths.length||filters.ancestorPaths.length){const parent=wikiParentPath(row.path);if(!filters.parentPaths.includes(parent??'')&&!filters.ancestorPaths.some(path=>row.path!==path&&(path==='/'||row.path.startsWith(path))))return false;}
    return true;
  }
  private contentItem(row:Candidate,version:WikiVersion,includeContent:boolean,term:string):WikiContentSearchItem {
    return {id:row.content_id,phid:row.content_phid,documentId:row.document_id,documentPHID:row.document_phid,versionId:version.id,version:version.number,path:version.slug,title:version.title,authorId:version.attribution?.principalId??null,author:version.author,createdAt:version.createdAt,message:version.message,kind:version.kind,snippet:snippet(version.content,term),...(includeContent?{content:version.content}:{})};
  }
  private search(kind:'documents'|'contents',query:Documents|Contents,canView:(id:string)=>boolean,principalId:string):{items:(WikiDocumentSearchItem|WikiContentSearchItem)[];nextAfter:string|null;nextBefore:string|null} {
    string(principalId,'Search principal',128);
    const table=kind==='documents'?'wiki_document_identifiers':'wiki_content_identifiers',direction=query.before===undefined?'after':'before',token=query.before??query.after;
    const cursor=token?this.decode(kind,query,direction,token,principalId):null;
    const upper=cursor?.upper??(this.database.prepare(`SELECT COALESCE(MAX(id),0) AS id FROM ${table}`).get()!.id as number),epoch=cursor?.epoch??this.epoch();
    if(!upper)return {items:[],nextAfter:null,nextBefore:null};
    const descending=(query.order==='newest')===(direction==='after'),comparator=descending?'<':'>',order=descending?'DESC':'ASC';
    const select=kind==='documents'
      ?'SELECT i.id,i.document_id,i.phid,p.published_version_id AS version_id,c.id AS content_id,c.phid AS content_phid,i.phid AS document_phid,c.byte_size,l.path,l.status,h.number AS head_number,v.number AS version_number FROM wiki_document_identifiers i JOIN wiki_locations l ON l.document_id=i.document_id JOIN wiki_publication p ON p.document_id=i.document_id JOIN wiki_versions h ON h.id=p.head_version_id JOIN wiki_versions v ON v.id=p.published_version_id JOIN wiki_content_identifiers c ON c.version_id=p.published_version_id'
      :'SELECT i.id,i.document_id,i.phid,i.version_id,i.id AS content_id,i.phid AS content_phid,d.phid AS document_phid,i.byte_size,l.path,l.status,h.number AS head_number,v.number AS version_number FROM wiki_content_identifiers i JOIN wiki_document_identifiers d ON d.document_id=i.document_id JOIN wiki_locations l ON l.document_id=i.document_id JOIN wiki_publication p ON p.document_id=i.document_id JOIN wiki_versions h ON h.id=p.head_version_id JOIN wiki_versions v ON v.id=i.version_id';
    let boundary=cursor?.boundary??null,first:number|null=null,last:number|null=null,scanned=0,sourceBytes=0,done=false;const items:(WikiDocumentSearchItem|WikiContentSearchItem)[]=[];
    while(!done&&scanned<WIKI_SEARCH_MAX_SCAN&&items.length<query.limit){
      const rows=this.database.prepare(`${select} WHERE i.id<=? ${boundary===null?'':`AND i.id${comparator}?`} ORDER BY i.id ${order} LIMIT ?`).all(...(boundary===null?[upper,Math.min(100,WIKI_SEARCH_MAX_SCAN-scanned)]:[upper,boundary,Math.min(100,WIKI_SEARCH_MAX_SCAN-scanned)])) as Candidate[];
      if(!rows.length)break;
      for(const row of rows){
        scanned++;
        if(this.metadataMatches(row,query,kind)&&canView(row.document_id)){
          if(row.byte_size>WIKI_SEARCH_MAX_SOURCE_BYTES)throw new HttpError(409,'An authorized wiki version exceeds the search source limit.','WIKI_SEARCH_SOURCE_LIMIT');
          // This candidate is not consumed until its bytes fit the page budget.
          if(sourceBytes+row.byte_size>WIKI_SEARCH_MAX_SOURCE_BYTES){done=true;break;}
          sourceBytes+=row.byte_size;
          const source=this.database.prepare('SELECT data FROM wiki_versions WHERE id=?').get(row.version_id) as {data:string}|undefined;
          if(!source)throw new HttpError(409,'Wiki search content is unavailable.','WIKI_VERSION_UNAVAILABLE');
          const version=JSON.parse(source.data) as WikiVersion;
          if(version.documentId!==row.document_id||version.id!==row.version_id||version.number!==row.version_number)throw new HttpError(409,'Wiki search content does not match its identity.','WIKI_VERSION_UNAVAILABLE');
          if(!query.query||version.title.toLowerCase().includes(query.query)||version.content.toLowerCase().includes(query.query)){
            const published=this.contentItem(row,version,query.includeContent,query.query);
            items.push(kind==='documents'?{id:row.document_id,title:version.title,path:row.path,status:row.status,version:row.head_number,conduitId:row.id,phid:row.phid,published}:published);
          }
        }
        first??=row.id;last=row.id;boundary=row.id;
        if(scanned>=WIKI_SEARCH_MAX_SCAN||items.length>=query.limit)break;
      }
    }
    if(first===null||last===null)return {items:[],nextAfter:null,nextBefore:null};
    const more=(anchor:number,forward:boolean)=>{const desc=(query.order==='newest')===forward;return !!this.database.prepare(`SELECT 1 FROM ${table} WHERE id<=? AND id${desc?'<':'>'}? LIMIT 1`).get(upper,anchor);};
    const afterAnchor=direction==='after'?last:first,beforeAnchor=direction==='after'?first:last;
    if(direction==='before')items.reverse();
    return {items,nextAfter:more(afterAnchor,true)?this.encode(kind,query,'after',{upper,boundary:afterAnchor,epoch},principalId):null,nextBefore:more(beforeAnchor,false)?this.encode(kind,query,'before',{upper,boundary:beforeAnchor,epoch},principalId):null};
  }
  documents(query:WikiDocumentSearchQuery={},canView:(id:string)=>boolean,principalId:string):WikiDocumentSearchPage {const page=this.search('documents',parseWikiDocumentSearchQuery(query),canView,principalId);return {documents:page.items as WikiDocumentSearchItem[],nextAfter:page.nextAfter,nextBefore:page.nextBefore};}
  contents(query:WikiContentSearchQuery={},canView:(id:string)=>boolean,principalId:string):WikiContentSearchPage {const page=this.search('contents',parseWikiContentSearchQuery(query),canView,principalId);return {contents:page.items as WikiContentSearchItem[],nextAfter:page.nextAfter,nextBefore:page.nextBefore};}
}
