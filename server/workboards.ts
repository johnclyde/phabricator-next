import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ActorAttribution, Project, Task } from '../shared/types.ts';
import type { ProjectReference } from '../shared/projects.ts';
import { WORKBOARD_BULK_MOVE_LIMIT, type TaskColumnMove, type Workboard, type WorkboardBulkMovePreview, type WorkboardBulkMoveQuery, type WorkboardBulkMoveReceipt, type WorkboardCardPage, type WorkboardCardsQuery, type WorkboardColumn, type WorkboardColumnPosition, type WorkboardColumnSnapshot, type WorkboardDetail, type WorkboardFilter, type WorkboardHistory, type WorkboardImportPreview, type WorkboardQuery, type WorkboardReceipt, type WorkboardTransaction } from '../shared/workboards.ts';
import { ancestorIds, children, descendantIds, hierarchy } from './project-graph.ts';
import { choice, HttpError, integer, object, string } from './validation.ts';

export interface WorkboardVisibility {
  canViewProject: (id: string) => boolean; canViewTask: (id: string) => boolean;
  canEditTask: (id: string) => boolean; canEditProject: (id: string) => boolean;
}
interface Options {
  project: (id: string) => Project; task: (id: string) => Task; nextColumnId: () => string;
  normalizeTags: (ids: string[]) => string[];
  moveTask: (task: Task, projectIds: string[], move: TaskColumnMove | undefined, attribution: ActorAttribution | undefined, now: string, operationId: string) => Task;
}
type ColumnRow = { id: string; project_id: string; kind: 'normal' | 'proxy'; proxy_project_id: string | null; is_default: number; name: string; hidden: number; point_limit: number | null; sequence: number };
type LayoutCard = { task: Task; sequence: number | null };
type BoardRow = { enabled: number; version: number };
const unrestricted: WorkboardVisibility = { canViewProject: () => true, canViewTask: () => true, canEditTask: () => true, canEditProject: () => true };
let savepoint = 0;
const unavailable = () => new HttpError(404, 'Workboard column was not found.', 'COLUMN_UNAVAILABLE');
function nonnegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${field} must be a nonnegative integer.`);
  return value;
}
function next(value: number): number { if (!Number.isSafeInteger(value + 1)) throw new HttpError(409, 'This workboard has reached its supported version or history limit.'); return value + 1; }
function limit(value: unknown): number { const count = value === undefined ? 50 : integer(value, 'limit'); if (count > 100) throw new HttpError(400, 'limit must be at most 100.'); return count; }
function pointLimit(value: unknown): number | null { return value === null ? null : nonnegative(value, 'pointLimit'); }
function columnName(value: unknown, isDefault = false): string {
  if (typeof value !== 'string' || value.length > 255 || /[\uD800-\uDFFF]/u.test(value) || value.includes('\0') || (!isDefault && !value.trim())) throw new HttpError(400, 'Column names must contain valid text of at most 255 characters.');
  return value.trim();
}
function reference(project: Project): ProjectReference {
  const { id, name, displayName, kind, parentId, milestoneNumber, status, icon, color, colorKey, version, hierarchyVersion, depth } = project;
  return { id, name, displayName, kind, parentId, milestoneNumber, status, icon, color, colorKey, version, hierarchyVersion, depth };
}
function snapshot(column: WorkboardColumn): WorkboardColumnSnapshot { return { id: column.id, name: column.name, proxyProjectId: column.proxyProjectId }; }
function configuration(column: WorkboardColumn): NonNullable<WorkboardTransaction['columnConfiguration']> { return { isDefault: column.isDefault, pointLimit: column.pointLimit }; }

/** No boards or historical actions are invented by this migration. */
export function initializeWorkboards(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE project_workboards (project_id TEXT PRIMARY KEY REFERENCES entities(id), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), version INTEGER NOT NULL CHECK(version >= 0));
    CREATE TABLE workboard_columns (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project_workboards(project_id), kind TEXT NOT NULL CHECK(kind IN ('normal','proxy')), proxy_project_id TEXT REFERENCES entities(id), is_default INTEGER NOT NULL CHECK(is_default IN (0,1)), name TEXT NOT NULL, hidden INTEGER NOT NULL CHECK(hidden IN (0,1)), point_limit INTEGER CHECK(point_limit >= 0), sequence INTEGER NOT NULL CHECK(sequence >= 0), UNIQUE(project_id,proxy_project_id), UNIQUE(project_id,id), CHECK((kind='normal' AND proxy_project_id IS NULL) OR (kind='proxy' AND proxy_project_id IS NOT NULL AND is_default=0)));
    CREATE UNIQUE INDEX workboard_default_column ON workboard_columns(project_id) WHERE is_default=1;
    CREATE INDEX workboard_column_order ON workboard_columns(project_id,sequence,id);
    CREATE TABLE workboard_positions (project_id TEXT NOT NULL, column_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES entities(id), sequence INTEGER NOT NULL CHECK(sequence >= 0), PRIMARY KEY(project_id,column_id,task_id), FOREIGN KEY(project_id,column_id) REFERENCES workboard_columns(project_id,id));
    CREATE INDEX workboard_positions_task ON workboard_positions(task_id,project_id);
    CREATE INDEX workboard_positions_order ON workboard_positions(project_id,column_id,sequence);
    CREATE TABLE workboard_transactions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project_workboards(project_id), sequence INTEGER NOT NULL CHECK(sequence > 0), board_version INTEGER NOT NULL CHECK(board_version > 0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(project_id,sequence));
    CREATE TRIGGER workboard_transactions_no_update BEFORE UPDATE ON workboard_transactions BEGIN SELECT RAISE(ABORT,'Workboard transactions are immutable'); END;
    CREATE TRIGGER workboard_transactions_no_delete BEFORE DELETE ON workboard_transactions BEGIN SELECT RAISE(ABORT,'Workboard transactions are immutable'); END;
  `);
}

export class WorkboardStore {
  private touched = new Set<string>();
  private batchDepth = 0;
  constructor(private readonly database: DatabaseSync, private readonly options: Options) {}
  /** Called inside an existing write savepoint; nested task writes touch each board once. */
  batch<T>(work: () => T): T {
    const previous = new Set(this.touched); this.batchDepth++;
    try {
      const result = work();
      if (this.batchDepth === 1) {
        for (const id of this.touched) { const version = this.row(id)!.version; next(version); this.database.prepare('UPDATE project_workboards SET version=version+1 WHERE project_id=?').run(id); }
        this.touched.clear();
      }
      return result;
    } catch (error) { this.touched = previous; throw error; }
    finally { this.batchDepth--; }
  }
  private mutation<T>(work: () => T): T {
    const name = `workboard_write_${++savepoint}`; this.database.exec(`SAVEPOINT ${name}`);
    try { this.database.prepare("UPDATE sequences SET value=value WHERE name='task'").run(); const result = this.batch(work); this.database.exec(`RELEASE ${name}`); return result; }
    catch (error) { this.database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
  private row(id: string): BoardRow | undefined { return this.database.prepare('SELECT enabled,version FROM project_workboards WHERE project_id=?').get(id) as BoardRow | undefined; }
  board(id: string): Workboard { this.options.project(id); const row = this.row(id); return { projectId: id, enabled: !!row?.enabled, version: row ? row.version + Number(this.touched.has(id)) : 0 }; }
  private touch(id: string): void { if (this.row(id)) this.touched.add(id); }
  touchTask(task: Task): void { for (const projectId of task.projectIds) { this.touch(projectId); for (const ancestor of ancestorIds(this.database, projectId)) this.touch(ancestor); } }
  tagsChanged(task: Task, projectIds: string[]): void {
    this.touchTask(task); this.touchTask({ ...task, projectIds });
    // Normal placements survive tag removal. Invalid proxy placements do not.
    const rows = this.database.prepare("SELECT p.project_id,p.column_id,c.proxy_project_id FROM workboard_positions p JOIN workboard_columns c ON c.id=p.column_id WHERE p.task_id=? AND c.kind='proxy'").all(task.id) as { project_id: string; column_id: string; proxy_project_id: string }[];
    for (const row of rows) if (!projectIds.some(id => id === row.proxy_project_id || ancestorIds(this.database, id).includes(row.proxy_project_id))) { this.database.prepare('DELETE FROM workboard_positions WHERE project_id=? AND column_id=? AND task_id=?').run(row.project_id,row.column_id,task.id); this.touch(row.project_id); }
  }
  projectChanged(project: Project, created: boolean, attribution?: ActorAttribution): void {
    this.mutation(() => {
      this.touch(project.id); for (const ancestor of ancestorIds(this.database, project.id)) this.touch(ancestor);
      if (created && project.parentId && this.row(project.parentId)) this.createProxy(project.parentId, project, randomUUID(), attribution);
      // Parent name/color changes also change milestone-owned board headers.
      for (const node of children(this.database, project.id, 'milestone')) this.touch(node.projectId);
    });
  }
  private rows(id: string): ColumnRow[] { return this.database.prepare('SELECT * FROM workboard_columns WHERE project_id=? ORDER BY sequence,id').all(id) as ColumnRow[]; }
  private hydrate(row: ColumnRow): WorkboardColumn {
    const proxy = row.proxy_project_id ? this.options.project(row.proxy_project_id) : null;
    return { id: row.id, projectId: row.project_id, kind: row.kind, proxyProjectId: row.proxy_project_id, isDefault: !!row.is_default, name: proxy ? proxy.displayName : row.name || (row.is_default ? 'Backlog' : row.name), hidden: proxy ? proxy.status === 'archived' : !!row.hidden, pointLimit: row.point_limit };
  }
  column(id: string, columnId: string): WorkboardColumn { this.options.project(id); const row = this.database.prepare('SELECT * FROM workboard_columns WHERE project_id=? AND id=?').get(id,columnId) as ColumnRow | undefined; if (!row) throw unavailable(); return this.hydrate(row); }
  private columns(id: string): WorkboardColumn[] {
    return this.rows(id).map(row => this.hydrate(row)).sort((a,b) => {
      const an = a.proxyProjectId ? hierarchy(this.database,a.proxyProjectId) : null; const bn = b.proxyProjectId ? hierarchy(this.database,b.proxyProjectId) : null;
      if (an?.kind === 'milestone' && bn?.kind === 'milestone') return an.milestoneNumber! - bn.milestoneNumber!;
      return Number(an?.kind === 'milestone') - Number(bn?.kind === 'milestone');
    });
  }
  private allowedColumn(column: WorkboardColumn, visibility: WorkboardVisibility, showHidden: boolean): boolean {
    return (!column.proxyProjectId || (hierarchy(this.database,column.proxyProjectId)?.kind === 'milestone' && visibility.canViewProject(column.proxyProjectId))) && (showHidden || !column.hidden);
  }
  private query(query: WorkboardQuery): { filter: WorkboardFilter; limit: number } {
    const data = object(query, ['status','ownerId','showHidden','limit','after','expectedBoardVersion']);
    if (data.showHidden !== undefined && typeof data.showHidden !== 'boolean') throw new HttpError(400,'showHidden must be a boolean.');
    const ownerId = data.ownerId === undefined || data.ownerId === null ? data.ownerId : string(data.ownerId,'ownerId',128);
    return { filter: { status: data.status === undefined ? 'open' : choice(data.status,'status',['open','all']), ...(ownerId === undefined ? {} : {ownerId}), showHidden: data.showHidden === true }, limit: limit(data.limit) };
  }
  private layout(id: string): Map<string, LayoutCard[]> {
    const columns = this.columns(id); const result = new Map(columns.map(column => [column.id, [] as LayoutCard[]]));
    const proxies = new Map(columns.filter(column => column.proxyProjectId).map(column => [column.proxyProjectId!, column.id]));
    const defaultColumn = columns.find(column => column.isDefault);
    const candidates = [id,...descendantIds(this.database,id)];
    const ids = this.database.prepare(`SELECT DISTINCT task_id FROM task_projects WHERE project_id IN (${candidates.map(()=>'?').join(',')}) ORDER BY task_id`).all(...candidates) as {task_id:string}[];
    const positions = this.database.prepare('SELECT task_id,column_id,sequence FROM workboard_positions WHERE project_id=? ORDER BY sequence,column_id').all(id) as {task_id:string;column_id:string;sequence:number}[];
    const byTask = new Map<string,typeof positions>(); for (const position of positions) { const group = byTask.get(position.task_id) ?? []; group.push(position); byTask.set(position.task_id,group); }
    for (const row of ids) {
      const task = this.options.task(row.task_id); let proxy: string | undefined;
      // Use raw canonical tag order even when the winning proxy is hidden.
      for (const tag of task.projectIds) { for (const candidate of [tag,...ancestorIds(this.database,tag)]) { proxy=proxies.get(candidate); if(proxy)break; } if(proxy)break; }
      const stored = byTask.get(task.id) ?? [];
      const position = proxy ? stored.find(position=>position.column_id===proxy) : stored.find(position=>columns.some(column=>column.id===position.column_id && column.kind==='normal'));
      const columnId = proxy ?? position?.column_id ?? defaultColumn?.id;
      if(columnId)result.get(columnId)!.push({task,sequence:position?.sequence??null});
    }
    for(const cards of result.values()) cards.sort((a,b)=>(a.sequence??0)-(b.sequence??0) || Number(a.sequence!==null)-Number(b.sequence!==null) || Number(b.task.id.slice(1))-Number(a.task.id.slice(1)));
    return result;
  }
  private visibleCards(cards: LayoutCard[], filter: WorkboardFilter, visibility: WorkboardVisibility): LayoutCard[] {
    return cards.filter(({task})=>visibility.canViewTask(task.id) && (filter.status==='all'||task.status==='open'||task.status==='in_progress') && (filter.ownerId===undefined||task.ownerId===filter.ownerId));
  }
  private page(id:string,columnId:string,cards:LayoutCard[],filter:WorkboardFilter,size:number,visibility:WorkboardVisibility,after?:string):WorkboardCardPage {
    let start=0; if(after!==undefined){ const index=cards.findIndex(card=>card.task.id===after); if(index<0)throw new HttpError(409,'The card page changed. Reload the workboard.');start=index+1; }
    const selected=cards.slice(start,start+size);
    return {projectId:id,columnId,boardVersion:this.board(id).version,filter,cards:selected.map(({task})=>({id:task.id,title:task.title,status:task.status,priority:task.priority,ownerId:task.ownerId,projectIds:task.projectIds.filter(visibility.canViewProject),version:task.version,canMove:visibility.canEditTask(task.id)})),nextAfter:start+size<cards.length?selected.at(-1)!.task.id:null};
  }
  detail(id:string,query:WorkboardQuery={},visibility:WorkboardVisibility=unrestricted):WorkboardDetail {
    const project=this.options.project(id);const board=this.board(id);const {filter,limit:size}=this.query(query);const layout=board.enabled?this.layout(id):new Map<string,LayoutCard[]>();
    return {project:reference(project),board,filter,canEdit:visibility.canEditProject(id),subprojects:children(this.database,id,'project').filter(node=>visibility.canViewProject(node.projectId)).map(node=>reference(this.options.project(node.projectId))),columns:board.enabled?this.columns(id).filter(column=>this.allowedColumn(column,visibility,filter.showHidden)).map(column=>{const cards=this.visibleCards(layout.get(column.id)??[],filter,visibility);return {...column,...(column.proxyProjectId?{proxyProject:reference(this.options.project(column.proxyProjectId))}:{}),cards:this.page(id,column.id,cards,filter,size,visibility),visibleCardCount:cards.length,overLimit:column.pointLimit!==null&&cards.length>column.pointLimit};}):[]};
  }
  cards(id:string,columnId:string,query:WorkboardCardsQuery,visibility:WorkboardVisibility=unrestricted):WorkboardCardPage {
    const column=this.column(id,columnId);const board=this.board(id);const {filter,limit:size}=this.query(query);
    if(!this.allowedColumn(column,visibility,filter.showHidden))throw unavailable();
    if(nonnegative(query.expectedBoardVersion,'expectedBoardVersion')!==board.version)throw new HttpError(409,'The workboard changed. Reload before loading more cards.');
    if(!board.enabled)throw new HttpError(409,'Enable this workboard before loading cards.');
    const after=query.after===undefined?undefined:string(query.after,'after',50);
    return this.page(id,columnId,this.visibleCards(this.layout(id).get(columnId)??[],filter,visibility),filter,size,visibility,after);
  }
  private check(id:string,expected:unknown,enabled=true):Workboard {const board=this.board(id);if(nonnegative(expected,'expectedBoardVersion')!==board.version)throw new HttpError(409,'The workboard changed. Reload before saving.');if(enabled&&!board.enabled)throw new HttpError(409,'Enable this workboard before changing it.');return board;}
  private append(id:string,data:Omit<WorkboardTransaction,'id'|'projectId'|'sequence'|'boardVersion'|'actor'|'createdAt'|'attribution'>,attribution?:ActorAttribution):void {
    const row=this.database.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM workboard_transactions WHERE project_id=?').get(id) as {sequence:number};
    const transaction:WorkboardTransaction={id:randomUUID(),projectId:id,sequence:next(row.sequence),boardVersion:this.board(id).version,actor:attribution?.displayName??'You',createdAt:new Date().toISOString(),...(attribution?{attribution}:{}),...data};
    this.database.prepare('INSERT INTO workboard_transactions(id,project_id,sequence,board_version,data) VALUES(?,?,?,?,?)').run(transaction.id,id,transaction.sequence,transaction.boardVersion,JSON.stringify(transaction));
  }
  private receipt(id:string,extra:Partial<WorkboardReceipt>={}):WorkboardReceipt{return {projectId:id,saved:true,refreshRequired:true,boardVersion:this.board(id).version,...extra};}
  private insertColumn(id:string,name:string,isDefault=false,proxyProjectId:string|null=null,capacity:number|null=null):WorkboardColumn {
    const columnId=this.options.nextColumnId();const row=this.database.prepare('SELECT COALESCE(MAX(sequence),-1) AS sequence FROM workboard_columns WHERE project_id=?').get(id) as {sequence:number};
    this.database.prepare('INSERT INTO workboard_columns(id,project_id,kind,proxy_project_id,is_default,name,hidden,point_limit,sequence) VALUES(?,?,?,?,?,?,0,?,?)').run(columnId,id,proxyProjectId?'proxy':'normal',proxyProjectId,Number(isDefault),name,capacity,next(row.sequence));
    return this.column(id,columnId);
  }
  private createProxy(id:string,project:Project,operationId:string,attribution?:ActorAttribution):void {
    if(this.database.prepare('SELECT 1 FROM workboard_columns WHERE project_id=? AND proxy_project_id=?').get(id,project.id))return;
    this.touch(id);const column=this.insertColumn(id,'',false,project.id);this.append(id,{kind:'proxy_create',operationId,column:snapshot(column),columnConfiguration:configuration(column),relatedProjectIds:[id,project.id],relatedTaskIds:[]},attribution);
  }
  configure(id:string,input:unknown,attribution?:ActorAttribution):WorkboardReceipt {
    return this.mutation(()=>{const data=object(input,['enabled','expectedBoardVersion']);if(typeof data.enabled!=='boolean')throw new HttpError(400,'enabled must be a boolean.');const board=this.check(id,data.expectedBoardVersion,false);if(board.enabled===data.enabled)return this.receipt(id);const operationId=randomUUID();
      if(!this.row(id)){this.database.prepare('INSERT INTO project_workboards(project_id,enabled,version) VALUES(?,1,0)').run(id);this.touch(id);const column=this.insertColumn(id,'',true);this.append(id,{kind:'column_create',operationId,column:snapshot(column),columnConfiguration:configuration(column),relatedProjectIds:[id],relatedTaskIds:[]},attribution);for(const child of children(this.database,id))this.createProxy(id,this.options.project(child.projectId),operationId,attribution);}else{this.database.prepare('UPDATE project_workboards SET enabled=? WHERE project_id=?').run(Number(data.enabled),id);this.touch(id);}
      this.append(id,{kind:data.enabled?'enable':'disable',operationId,changes:[{field:'enabled',oldValue:board.enabled,newValue:data.enabled}],relatedProjectIds:[id],relatedTaskIds:[]},attribution);return this.receipt(id);
    });
  }
  private importSource(targetId: string, sourceId: string): { board: Workboard; project: Project; columns: ColumnRow[] } {
    this.options.project(targetId);
    if (sourceId === targetId) throw new HttpError(400, 'Choose a different project as the column source.');
    if (this.row(targetId)) throw new HttpError(409, 'Columns can only be imported before this workboard is initialized.');
    const project = this.options.project(sourceId); const board = this.board(sourceId);
    const columns = this.rows(sourceId).filter(column => column.kind === 'normal' && !column.hidden);
    if (!columns.length || columns.filter(column => column.is_default).length !== 1) throw new HttpError(409, 'The source must have exactly one importable default column.');
    return { board, project, columns };
  }
  importPreview(targetId: string, sourceId: string): WorkboardImportPreview {
    const source = this.importSource(targetId, sourceId);
    return {
      projectId: targetId, sourceProject: reference(source.project), expectedBoardVersion: 0,
      expectedSourceBoardVersion: source.board.version,
      columns: source.columns.map(row => { const column = this.hydrate(row); return { id: column.id, name: column.name, isDefault: column.isDefault, pointLimit: column.pointLimit }; }),
    };
  }
  importColumns(targetId: string, input: unknown, attribution?: ActorAttribution): WorkboardReceipt {
    return this.mutation(() => {
      const data = object(input, ['sourceProjectId', 'expectedBoardVersion', 'expectedSourceBoardVersion']);
      const sourceId = string(data.sourceProjectId, 'sourceProjectId', 50);
      if (!/^PROJ[1-9]\d*$/.test(sourceId)) throw new HttpError(400, 'Choose a valid source project.');
      this.check(targetId, data.expectedBoardVersion, false);
      const expectedSourceBoardVersion = integer(data.expectedSourceBoardVersion, 'expectedSourceBoardVersion');
      const source = this.importSource(targetId, sourceId);
      if (source.board.version !== expectedSourceBoardVersion) throw new HttpError(409, 'The source workboard changed. Reload the import preview.');
      const operationId = randomUUID();
      const importedFrom = { projectId: sourceId, boardVersion: source.board.version, columnCount: source.columns.length };
      const relatedProjectIds = [targetId, sourceId];
      this.database.prepare('INSERT INTO project_workboards(project_id,enabled,version) VALUES(?,1,0)').run(targetId);
      this.touch(targetId);
      for (const row of source.columns) {
        // Raw empty names preserve the default Backlog identity. Sequences are
        // compacted without copying gaps left by excluded hidden/proxy columns.
        const column = this.insertColumn(targetId, row.name, !!row.is_default, null, row.point_limit);
        this.append(targetId, {
          kind: 'column_create', operationId, column: snapshot(column), columnConfiguration: configuration(column),
          importedFrom: { ...importedFrom, columnId: row.id }, relatedProjectIds, relatedTaskIds: [],
        }, attribution);
      }
      for (const child of children(this.database, targetId)) this.createProxy(targetId, this.options.project(child.projectId), operationId, attribution);
      this.append(targetId, { kind: 'column_import', operationId, importedFrom, relatedProjectIds, relatedTaskIds: [] }, attribution);
      this.append(targetId, { kind: 'enable', operationId, changes: [{ field: 'enabled', oldValue: false, newValue: true }], importedFrom, relatedProjectIds, relatedTaskIds: [] }, attribution);
      return this.receipt(targetId);
    });
  }
  createColumn(id:string,input:unknown,attribution?:ActorAttribution):WorkboardReceipt {
    return this.mutation(()=>{const data=object(input,['name','pointLimit','expectedBoardVersion']);this.check(id,data.expectedBoardVersion);const name=columnName(data.name);const capacity=data.pointLimit===undefined?null:pointLimit(data.pointLimit);this.touch(id);const column=this.insertColumn(id,name,false,null,capacity);this.append(id,{kind:'column_create',operationId:randomUUID(),column:snapshot(column),columnConfiguration:configuration(column),relatedProjectIds:[id],relatedTaskIds:[]},attribution);return this.receipt(id,{columnId:column.id});});
  }
  updateColumn(id:string,columnId:string,input:unknown,attribution?:ActorAttribution):WorkboardReceipt {
    return this.mutation(()=>{const data=object(input,['name','hidden','pointLimit','expectedBoardVersion']);this.check(id,data.expectedBoardVersion);const column=this.column(id,columnId);if(!['name','hidden','pointLimit'].some(key=>key in data))throw new HttpError(400,'Provide a column setting to change.');
      if(column.kind==='proxy'&&(hierarchy(this.database,column.proxyProjectId!)?.kind!=='milestone'||'name'in data||'hidden'in data))throw new HttpError(400,'Change a proxy name or archive status on its project.');
      if(data.hidden!==undefined&&typeof data.hidden!=='boolean')throw new HttpError(400,'hidden must be a boolean.');if(column.isDefault&&data.hidden===true)throw new HttpError(400,'The Backlog column cannot be hidden.');
      const raw=this.rows(id).find(row=>row.id===columnId)!;const name=data.name===undefined?raw.name:columnName(data.name,column.isDefault);const hidden=data.hidden===undefined?!!raw.hidden:data.hidden;const capacity=data.pointLimit===undefined?column.pointLimit:pointLimit(data.pointLimit);
      const changes:WorkboardTransaction['changes']=[];if(name!==raw.name)changes.push({field:'name',oldValue:raw.name,newValue:name});if(hidden!==!!raw.hidden)changes.push({field:'hidden',oldValue:!!raw.hidden,newValue:hidden});if(capacity!==column.pointLimit)changes.push({field:'pointLimit',oldValue:column.pointLimit,newValue:capacity});if(!changes.length)return this.receipt(id,{columnId});
      this.database.prepare('UPDATE workboard_columns SET name=?,hidden=?,point_limit=? WHERE id=?').run(name,Number(hidden),capacity,columnId);this.touch(id);this.append(id,{kind:'column_edit',operationId:randomUUID(),column:snapshot(this.column(id,columnId)),changes,relatedProjectIds:[id,...(column.proxyProjectId?[column.proxyProjectId]:[])],relatedTaskIds:[]},attribution);return this.receipt(id,{columnId});});
  }
  private position(input:unknown,kind:'task'|'column'):{edge?:'start'|'end';before?:string;after?:string} {
    const before=kind==='task'?'beforeTaskId':'beforeColumnId';const after=kind==='task'?'afterTaskId':'afterColumnId';const data=object(input,[before,after,'edge']);if(Object.keys(data).length!==1)throw new HttpError(400,'Choose exactly one relative position.');if('edge'in data)return {edge:choice(data.edge,'edge',['start','end'] as const)};if(before in data)return {before:string(data[before],before,50)};if(after in data)return {after:string(data[after],after,50)};throw new HttpError(400,'Choose a relative position.');
  }
  private insertAt(ids:string[],id:string,position:{edge?:'start'|'end';before?:string;after?:string}):string[] {
    const result=ids.filter(value=>value!==id);if(position.before===id||position.after===id)throw new HttpError(400,'An item cannot be positioned relative to itself.');let index=position.edge==='end'?result.length:0;const anchor=position.before??position.after;if(anchor){index=result.indexOf(anchor);if(index<0)throw new HttpError(409,'The relative item is no longer in this column or workboard.');if(position.after)index++;}result.splice(index,0,id);return result;
  }
  reorderColumn(id:string,columnId:string,input:unknown,attribution?:ActorAttribution):WorkboardReceipt {
    return this.mutation(()=>{const data=object(input,['expectedBoardVersion','position']);this.check(id,data.expectedBoardVersion);const column=this.column(id,columnId);if(column.kind!=='normal')throw new HttpError(400,'Proxy columns have a fixed order.');const position=this.position(data.position,'column');const anchor=position.before??position.after;if(anchor&&this.column(id,anchor).kind!=='normal')throw new HttpError(400,'Choose a normal column as the relative position.');const columns=this.rows(id).filter(row=>row.kind==='normal').map(row=>row.id);const wanted=this.insertAt(columns,columnId,position);if(wanted.every((value,index)=>value===columns[index]))return this.receipt(id,{columnId});wanted.forEach((value,index)=>this.database.prepare('UPDATE workboard_columns SET sequence=? WHERE id=?').run(index,value));this.touch(id);this.append(id,{kind:'column_reorder',operationId:randomUUID(),column:snapshot(column),position:data.position as WorkboardColumnPosition,relatedProjectIds:[id],relatedTaskIds:[]},attribution);return this.receipt(id,{columnId});});
  }
  private bulkColumns(sourceId: string, sourceColumnId: string, destinationId: string, destinationColumnId: string): { source: WorkboardColumn; destination: WorkboardColumn } {
    const source = this.column(sourceId, sourceColumnId);
    const destination = this.column(destinationId, destinationColumnId);
    // The explicit source may be hidden or on a disabled board. Ordinary
    // subproject proxies remain outside the supported parent-board layout.
    if (source.proxyProjectId && hierarchy(this.database, source.proxyProjectId)?.kind !== 'milestone') throw new HttpError(400, 'Subproject tasks live on their own workboards.');
    if (!this.board(destinationId).enabled) throw new HttpError(409, 'Enable the destination workboard before moving tasks.');
    if (destination.kind !== 'normal') throw new HttpError(400, 'Choose a normal destination column.');
    if (destination.hidden) throw new HttpError(409, 'Show the destination column before moving tasks.');
    if (source.id === destination.id) throw new HttpError(400, 'Choose a different destination column.');
    return { source, destination };
  }
  bulkMovePreview(sourceId: string, query: WorkboardBulkMoveQuery, visibility: WorkboardVisibility = unrestricted): WorkboardBulkMovePreview {
    const data = object(query, ['sourceColumnId', 'destinationProjectId', 'destinationColumnId', 'status', 'ownerId', 'showHidden']);
    const sourceColumnId = string(data.sourceColumnId, 'sourceColumnId', 50);
    const destinationId = string(data.destinationProjectId, 'destinationProjectId', 50);
    const destinationColumnId = string(data.destinationColumnId, 'destinationColumnId', 50);
    const { source, destination } = this.bulkColumns(sourceId, sourceColumnId, destinationId, destinationColumnId);
    const { filter } = this.query({ status: data.status, ownerId: data.ownerId, showHidden: data.showHidden } as WorkboardQuery);
    const sourceLayout = this.layout(sourceId);
    const destinationLayout = sourceId === destinationId ? sourceLayout : this.layout(destinationId);
    const alreadyThere = new Set((destinationLayout.get(destinationColumnId) ?? []).map(card => card.task.id));
    const selected = this.visibleCards(sourceLayout.get(sourceColumnId) ?? [], filter, visibility).filter(({ task }) => visibility.canEditTask(task.id));
    if (selected.length > WORKBOARD_BULK_MOVE_LIMIT) throw new HttpError(409, `This selection exceeds ${WORKBOARD_BULK_MOVE_LIMIT} movable tasks. Narrow the task filter before previewing a bulk move.`);
    return {
      projectId: sourceId, sourceProject: reference(this.options.project(sourceId)), sourceColumn: source,
      destinationProject: reference(this.options.project(destinationId)), destinationColumn: destination,
      expectedBoardVersion: this.board(sourceId).version, expectedDestinationBoardVersion: this.board(destinationId).version,
      filter, tasks: selected.map(({ task }) => ({ id: task.id, title: task.title, version: task.version, alreadyInDestination: alreadyThere.has(task.id) })),
    };
  }
  bulkMoveCards(sourceId: string, input: unknown, attribution?: ActorAttribution): WorkboardBulkMoveReceipt {
    return this.mutation(() => {
      const data = object(input, ['sourceColumnId', 'destinationProjectId', 'destinationColumnId', 'expectedBoardVersion', 'expectedDestinationBoardVersion', 'tasks']);
      const sourceColumnId = string(data.sourceColumnId, 'sourceColumnId', 50);
      const destinationId = string(data.destinationProjectId, 'destinationProjectId', 50);
      const destinationColumnId = string(data.destinationColumnId, 'destinationColumnId', 50);
      this.check(sourceId, data.expectedBoardVersion, false);
      this.check(destinationId, data.expectedDestinationBoardVersion);
      const { source, destination } = this.bulkColumns(sourceId, sourceColumnId, destinationId, destinationColumnId);
      if (!Array.isArray(data.tasks) || !data.tasks.length || data.tasks.length > WORKBOARD_BULK_MOVE_LIMIT) throw new HttpError(400, `Provide between 1 and ${WORKBOARD_BULK_MOVE_LIMIT} reviewed tasks.`);
      const seen = new Set<string>();
      const pins = data.tasks.map(value => {
        const pin = object(value, ['taskId', 'expectedTaskVersion']);
        const taskId = string(pin.taskId, 'taskId', 50);
        if (!/^T[1-9]\d*$/.test(taskId)) throw new HttpError(400, 'Choose a valid task.');
        if (seen.has(taskId)) throw new HttpError(400, 'Choose each task only once.');
        seen.add(taskId);
        return { taskId, version: integer(pin.expectedTaskVersion, 'expectedTaskVersion') };
      });
      const sourceLayout = this.layout(sourceId);
      const destinationLayout = sourceId === destinationId ? sourceLayout : this.layout(destinationId);
      const sourceTasks = new Set((sourceLayout.get(sourceColumnId) ?? []).map(card => card.task.id));
      const destinationCards = destinationLayout.get(destinationColumnId) ?? [];
      const destinationTasks = new Set(destinationCards.map(card => card.task.id));
      const destinationColumns = this.columns(destinationId);
      // Read and validate the complete selection before any task or position
      // changes. Never silently skip, add, or refresh a submitted task pin.
      const plans = pins.map(pin => {
        const current = this.options.task(pin.taskId);
        if (pin.version !== current.version) throw new HttpError(409, 'A selected task changed. Reload before moving these tasks.');
        if (!sourceTasks.has(current.id)) throw new HttpError(409, 'A selected task is no longer in the source column. Load a new preview.');
        const remaining = current.projectIds.filter(id => id !== destinationId && (sourceId === destinationId || id !== sourceId));
        const tags = this.options.normalizeTags([...remaining, destinationId]);
        const placementChanged = !destinationTasks.has(current.id);
        const tagsChanged = tags.length !== current.projectIds.length || tags.some((id, index) => id !== current.projectIds[index]);
        const from = destinationColumns.filter(column => (destinationLayout.get(column.id) ?? []).some(card => card.task.id === current.id));
        return { current, tags, placementChanged, tagsChanged, from };
      });
      const operationId = randomUUID(); const now = new Date().toISOString();
      let order = destinationCards.map(card => card.task.id);
      let changedPositions = false;
      for (const plan of plans) {
        if (!plan.placementChanged && !plan.tagsChanged) continue;
        const move: TaskColumnMove | undefined = plan.placementChanged ? {
          projectId: destinationId, fromColumns: plan.from.map(snapshot), toColumn: snapshot(destination), operationId,
          bulkSource: { projectId: sourceId, column: snapshot(source) },
        } : undefined;
        const task = this.options.moveTask(plan.current, plan.tags, move, attribution, now, operationId);
        if (plan.placementChanged) {
          // Upstream bulk moves prepend each newly moved card in the reviewed
          // source order. Cards already at the destination retain their order.
          order = [task.id, ...order.filter(id => id !== task.id)];
          this.database.prepare('DELETE FROM workboard_positions WHERE project_id=? AND task_id=?').run(destinationId, task.id);
          changedPositions = true;
        }
        this.touch(sourceId); this.touch(destinationId);
        const relatedProjectIds = [...new Set([sourceId, destinationId, ...(source.proxyProjectId ? [source.proxyProjectId] : []), ...plan.from.flatMap(column => column.proxyProjectId ? [column.proxyProjectId] : [])])];
        const event: Omit<WorkboardTransaction, 'id' | 'projectId' | 'sequence' | 'boardVersion' | 'actor' | 'createdAt' | 'attribution'> = {
          kind: 'bulk_move', operationId, taskId: task.id, taskVersion: task.version,
          bulkMove: { sourceProjectId: sourceId, sourceColumn: snapshot(source), destinationProjectId: destinationId, destinationColumn: snapshot(destination), placementChanged: plan.placementChanged },
          ...(move ? { move } : {}), relatedProjectIds, relatedTaskIds: [task.id],
        };
        this.append(sourceId, event, attribution);
        if (sourceId !== destinationId) this.append(destinationId, event, attribution);
      }
      if (changedPositions) order.forEach((taskId, index) => this.database.prepare('INSERT INTO workboard_positions(project_id,column_id,task_id,sequence) VALUES(?,?,?,?) ON CONFLICT(project_id,column_id,task_id) DO UPDATE SET sequence=excluded.sequence').run(destinationId, destinationColumnId, taskId, index));
      return { ...this.receipt(sourceId), destinationProjectId: destinationId, destinationBoardVersion: this.board(destinationId).version };
    });
  }
  moveCard(id:string,input:unknown,attribution?:ActorAttribution):WorkboardReceipt {
    return this.mutation(()=>{const data=object(input,['taskId','columnId','expectedBoardVersion','expectedTaskVersion','position']);this.check(id,data.expectedBoardVersion);const taskId=string(data.taskId,'taskId',50);const columnId=string(data.columnId,'columnId',50);const current=this.options.task(taskId);if(integer(data.expectedTaskVersion,'expectedTaskVersion')!==current.version)throw new HttpError(409,'This task changed. Reload before moving it.');const column=this.column(id,columnId);if(column.hidden)throw new HttpError(409,'Show this column before moving a card into it.');if(column.proxyProjectId&&hierarchy(this.database,column.proxyProjectId)?.kind!=='milestone')throw new HttpError(400,'Subproject tasks live on their own workboards.');const position=this.position(data.position,'task');const layout=this.layout(id);const from=this.columns(id).filter(candidate=>(layout.get(candidate.id)??[]).some(card=>card.task.id===taskId));const cards=layout.get(columnId)??[];const wanted=this.insertAt(cards.map(card=>card.task.id),taskId,position);
      const tag=column.proxyProjectId??id;const inherited=column.proxyProjectId&&current.projectIds.some(projectId=>projectId===tag||ancestorIds(this.database,projectId).includes(tag));const tags=inherited?current.projectIds:this.options.normalizeTags([...current.projectIds.filter(projectId=>projectId!==tag),tag]);
      const proxies=new Map(this.columns(id).filter(candidate=>candidate.proxyProjectId).map(candidate=>[candidate.proxyProjectId!,candidate.id]));let effectiveProxy:string|undefined;for(const projectId of tags){for(const candidate of [projectId,...ancestorIds(this.database,projectId)]){effectiveProxy=proxies.get(candidate);if(effectiveProxy)break;}if(effectiveProxy)break;}if(effectiveProxy&&effectiveProxy!==columnId)throw new HttpError(409,'This combination of project tags cannot occupy the selected milestone column. Review the task’s project tags first.');
      const unchangedTags=tags.length===current.projectIds.length&&tags.every((tag,index)=>tag===current.projectIds[index]);const sameOrder=wanted.length===cards.length&&wanted.every((value,index)=>value===cards[index]?.task.id);if(from.length===1&&from[0]!.id===columnId&&sameOrder&&unchangedTags)return this.receipt(id,{columnId,taskId,taskVersion:current.version});
      const operationId=randomUUID();const move:TaskColumnMove={projectId:id,fromColumns:from.map(snapshot),toColumn:snapshot(column),operationId};const task=this.options.moveTask(current,tags,move,attribution,new Date().toISOString(),operationId);
      this.database.prepare('DELETE FROM workboard_positions WHERE project_id=? AND task_id=?').run(id,taskId);
      // Persist the complete raw order, including invisible neighbors, atomically.
      wanted.forEach((value,index)=>this.database.prepare('INSERT INTO workboard_positions(project_id,column_id,task_id,sequence) VALUES(?,?,?,?) ON CONFLICT(project_id,column_id,task_id) DO UPDATE SET sequence=excluded.sequence').run(id,columnId,value,index));
      this.touch(id);const anchor=position.before??position.after;this.append(id,{kind:'card_move',operationId,column:snapshot(column),position:data.position as WorkboardTransaction['position'],taskId,taskVersion:task.version,move,relatedProjectIds:[...new Set([id,...from.flatMap(source=>source.proxyProjectId?[source.proxyProjectId]:[]),...(column.proxyProjectId?[column.proxyProjectId]:[])])],relatedTaskIds:[taskId,...(anchor?[anchor]:[])]},attribution);return this.receipt(id,{columnId,taskId,taskVersion:task.version});});
  }
  history(id:string,before?:number,size=50,visible?:(id:string)=>boolean):WorkboardHistory {
    this.options.project(id);const cursor=before===undefined?null:integer(before,'before');const count=limit(size);const allowed=(item:WorkboardTransaction)=>!visible||[...item.relatedProjectIds,...item.relatedTaskIds].every(visible);
    const statement=this.database.prepare(`SELECT data FROM workboard_transactions WHERE project_id=?${cursor===null?'':' AND sequence<?'} ORDER BY sequence DESC`);const rows=cursor===null?statement.iterate(id):statement.iterate(id,cursor);const selected:WorkboardTransaction[]=[];
    for(const row of rows){const item=JSON.parse(row.data as string) as WorkboardTransaction;if(allowed(item))selected.push(item);if(selected.length>count)break;}
    const firstStatement=this.database.prepare('SELECT data FROM workboard_transactions WHERE project_id=? ORDER BY sequence');let first:number|null=null;for(const row of firstStatement.iterate(id)){const item=JSON.parse(row.data as string) as WorkboardTransaction;if(allowed(item)){first=item.sequence;break;}}
    const page=selected.slice(0,count);return {transactions:page,nextBefore:selected.length>count?page.at(-1)!.sequence:null,firstAvailableSequence:first};
  }
}
