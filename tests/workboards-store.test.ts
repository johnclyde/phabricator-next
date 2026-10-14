import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { Store } from '../server/store.ts';
import { initializeProjects } from '../server/projects.ts';
import { initializePolicies, upgradeProjectPolicies } from '../server/policy.ts';
import { initializeProjectHierarchy } from '../server/project-graph.ts';
import type { WorkboardVisibility } from '../server/workboards.ts';
import type { ActorAttribution, ProjectKind } from '../shared/types.ts';

const alice:ActorAttribution={principalId:'alice',displayName:'Alice',credentialId:'token-a',requestId:'request-a'};
const bob:ActorAttribution={principalId:'bob',displayName:'Bob',credentialId:'session-b',requestId:'request-b'};
const status=(code:number)=>(error:unknown)=>typeof error==='object'&&error!==null&&'status'in error&&error.status===code;
const raw=(store:Store,table:string)=>store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot=(store:Store)=>new Map((store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(({name})=>[name,raw(store,name)]));
const version=(store:Store,id:string)=>store.workboard(id).board.version;
const enable=(store:Store,id:string)=>store.configureWorkboard(id,{enabled:true,expectedBoardVersion:version(store,id)},alice);
const column=(store:Store,id:string,name='Working')=>store.createWorkboardColumn(id,{name,expectedBoardVersion:version(store,id)},alice).columnId!;
const move=(store:Store,id:string,taskId:string,columnId:string,position:unknown={edge:'start'})=>store.moveWorkboardCard(id,{taskId,columnId,position,expectedBoardVersion:version(store,id),expectedTaskVersion:store.taskDetail(taskId).task.version},bob);
const child=(store:Store,parentId:string,kind:ProjectKind,name:string)=>{const p=store.projectChildPreview(parentId,kind);return store.createProject({name,parentId,kind,expectedParentVersion:p.expectedParentVersion,expectedHierarchyVersion:p.expectedHierarchyVersion,expectedParentMembersVersion:p.expectedParentMembersVersion,...(p.conversionRequired?{confirmMembershipConversion:true}:{})},alice);};
const visibility=(hidden:string[]=[],uneditable:string[]=[]):WorkboardVisibility=>({canViewProject:id=>!hidden.includes(id),canViewTask:id=>!hidden.includes(id),canEditTask:id=>!uneditable.includes(id),canEditProject:id=>!uneditable.includes(id)});
const ids=(store:Store,id:string,columnId:string)=>store.workboard(id,{status:'all',showHidden:true}).columns.find(column=>column.id===columnId)!.cards.cards.map(card=>card.id);

test('boards are opt-in, reads do not initialize, disabled boards retain columns, and defaults/limits/reorder are explicit',()=>{
  const store=new Store({path:':memory:'});try{
    const project=store.createProject({name:'First board'});const before=snapshot(store);assert.deepEqual(store.workboard(project.id).board,{projectId:project.id,enabled:false,version:0});assert.deepEqual(snapshot(store),before);
    assert.deepEqual(enable(store,project.id),{projectId:project.id,saved:true,refreshRequired:true,boardVersion:1});const backlog=store.workboard(project.id).columns[0]!;assert.equal(backlog.name,'Backlog');assert.equal(backlog.isDefault,true);
    const a=column(store,project.id,'In progress');const b=column(store,project.id,'Done');const start=version(store,project.id);
    store.reorderWorkboardColumn(project.id,b,{expectedBoardVersion:start,position:{beforeColumnId:a}},bob);assert.deepEqual(store.workboard(project.id).columns.map(row=>row.id),[backlog.id,b,a]);
    const noOp=snapshot(store);store.reorderWorkboardColumn(project.id,b,{expectedBoardVersion:start+1,position:{beforeColumnId:a}},bob);assert.deepEqual(snapshot(store),noOp);
    assert.throws(()=>store.updateWorkboardColumn(project.id,backlog.id,{expectedBoardVersion:version(store,project.id),hidden:true}),status(400));
    store.updateWorkboardColumn(project.id,backlog.id,{expectedBoardVersion:version(store,project.id),name:'Incoming',pointLimit:0},alice);const task=store.createTask({title:'Zero limit warns',projectIds:[project.id]});const shown=store.workboard(project.id).columns[0]!;assert.equal(shown.name,'Incoming');assert.equal(shown.overLimit,true);assert.equal(shown.visibleCardCount,1);
    move(store,project.id,task.id,a);const positions=raw(store,'workboard_positions');const columns=raw(store,'workboard_columns');store.configureWorkboard(project.id,{enabled:false,expectedBoardVersion:version(store,project.id)},bob);assert.equal(store.workboard(project.id).columns.length,0);assert.deepEqual(raw(store,'workboard_positions'),positions);assert.deepEqual(raw(store,'workboard_columns'),columns);
    assert.throws(()=>move(store,project.id,task.id,b),status(409));enable(store,project.id);assert.deepEqual(ids(store,project.id,a),[task.id]);assert.deepEqual(raw(store,'workboard_positions'),positions);assert.deepEqual(raw(store,'workboard_columns'),columns);
    const evidence=raw(store,'workboard_transactions');assert.ok(evidence.length>=7);assert.throws(()=>store.database.exec('UPDATE workboard_transactions SET data=data'),/immutable/);assert.throws(()=>store.database.exec('DELETE FROM workboard_transactions'),/immutable/);
  }finally{store.close();}
});

test('card moves preserve other boards and create one attributed task version with tag and column evidence',()=>{
  const store=new Store({path:':memory:'});try{
    const a=store.createProject({name:'Board A'});const b=store.createProject({name:'Board B'});enable(store,a.id);enable(store,b.id);const ac=column(store,a.id);const bc=column(store,b.id);const task=store.createTask({title:'Two boards',projectIds:[b.id]},alice);move(store,b.id,task.id,bc);const original=store.taskDetail(task.id);const bv=version(store,b.id);const oldHistory=raw(store,'task_transactions');const foreign=raw(store,'workboard_positions');
    const receipt=move(store,a.id,task.id,ac);assert.equal(receipt.taskVersion,original.task.version+1);assert.equal(receipt.boardVersion,version(store,a.id));assert.equal(version(store,b.id),bv+1);assert.deepEqual(ids(store,b.id,bc),[task.id]);assert.deepEqual(raw(store,'workboard_positions').filter(row=>row.project_id===b.id),foreign);
    const detail=store.taskDetail(task.id);assert.deepEqual(detail.task.projectIds,[a.id,b.id]);assert.equal(detail.task.status,'open');const added=detail.history.transactions.filter(row=>row.taskVersion===receipt.taskVersion);assert.deepEqual(added.map(row=>row.kind),['column','project']);assert.ok(added.every(row=>row.actor==='Bob'&&JSON.stringify(row.attribution)===JSON.stringify(bob)));assert.equal(added[0]!.column!.operationId,added[1]!.project!.operationId);assert.deepEqual(added[0]!.column!.fromColumns,[]);assert.equal(added[0]!.column!.toColumn.name,'Working');assert.deepEqual(raw(store,'task_transactions').slice(0,oldHistory.length),oldHistory);
    const noOp=snapshot(store);move(store,a.id,task.id,ac);assert.deepEqual(snapshot(store),noOp);
    const event=store.workboardHistory(a.id).transactions[0]!;assert.equal(event.kind,'card_move');assert.equal(event.move?.operationId,added[0]!.column!.operationId);assert.equal(event.taskVersion,detail.task.version);assert.deepEqual(event.relatedTaskIds,[task.id]);
  }finally{store.close();}
});

test('manual order includes hidden neighbors, hidden normal columns keep cards, and paging is visibility/filter scoped',()=>{
  const store=new Store({path:':memory:'});try{
    const project=store.createProject({name:'Private ordering'});enable(store,project.id);const target=column(store,project.id);const backlog=store.workboard(project.id).columns[0]!.id;const tasks=Array.from({length:5},(_,index)=>store.createTask({title:`Card ${index}`,projectIds:[project.id],ownerId:index===0?'alice':null,status:index===4?'resolved':'open'}));
    for(const task of tasks)move(store,project.id,task.id,target,{edge:'end'});assert.deepEqual(ids(store,project.id,target),tasks.map(task=>task.id));
    move(store,project.id,tasks[4]!.id,target,{afterTaskId:tasks[1]!.id});assert.deepEqual(ids(store,project.id,target),[tasks[0]!.id,tasks[1]!.id,tasks[4]!.id,tasks[2]!.id,tasks[3]!.id]);
    const visible=visibility([tasks[1]!.id],[tasks[0]!.id]);let detail=store.workboard(project.id,{limit:2,status:'all'},visible);const c=detail.columns.find(row=>row.id===target)!;assert.equal(c.visibleCardCount,4);assert.deepEqual(c.cards.cards.map(row=>row.id),[tasks[0]!.id,tasks[4]!.id]);assert.equal(c.cards.cards[0]!.canMove,false);assert.equal(c.cards.nextAfter,tasks[4]!.id);
    const page=store.workboardCards(project.id,target,{expectedBoardVersion:detail.board.version,after:c.cards.nextAfter!,status:'all',limit:2},visible);assert.deepEqual(page.cards.map(row=>row.id),[tasks[2]!.id,tasks[3]!.id]);assert.equal(page.nextAfter,null);assert.deepEqual(page.filter,{status:'all',showHidden:false});
    detail=store.workboard(project.id,{ownerId:null},visible);assert.equal(detail.columns.find(row=>row.id===target)!.visibleCardCount,2);assert.equal(store.workboard(project.id,{ownerId:'alice'},visible).columns.find(row=>row.id===target)!.visibleCardCount,1);
    store.updateWorkboardColumn(project.id,target,{expectedBoardVersion:version(store,project.id),hidden:true},alice);assert.ok(!store.workboard(project.id).columns.some(row=>row.id===target));assert.deepEqual(ids(store,project.id,backlog),[]);assert.deepEqual(ids(store,project.id,target),[tasks[0]!.id,tasks[1]!.id,tasks[4]!.id,tasks[2]!.id,tasks[3]!.id]);assert.throws(()=>move(store,project.id,tasks[0]!.id,target),status(409));
    assert.throws(()=>store.workboardCards(project.id,target,{expectedBoardVersion:version(store,project.id)}),status(404));assert.throws(()=>store.workboardCards(project.id,target,{expectedBoardVersion:version(store,project.id)-1,showHidden:true}),status(409));
  }finally{store.close();}
});

test('hierarchy proxies are created without GET writes, ordinary descendants stay on their boards, and mixed proxy moves fail intact',()=>{
  const store=new Store({path:':memory:'});try{
    const root=store.createProject({name:'Hierarchy board'});const a=child(store,root.id,'project','Ordinary A');const leaf=child(store,a.id,'project','Leaf');enable(store,root.id);const normal=column(store,root.id);const milestone=child(store,root.id,'milestone','Milestone');const second=child(store,root.id,'milestone','Milestone 2');const proxy=store.workboard(root.id).columns.find(row=>row.proxyProjectId===milestone.id)!;const secondProxy=store.workboard(root.id).columns.find(row=>row.proxyProjectId===second.id)!;
    const ordinary=store.createTask({title:'Leaf task',projectIds:[leaf.id]});const mixed=store.createTask({title:'Mixed tags',projectIds:[leaf.id,milestone.id]});assert.ok(store.workboard(root.id).columns.every(row=>!row.cards.cards.some(card=>[ordinary.id,mixed.id].includes(card.id))));assert.equal(store.workboard(root.id).subprojects[0]!.id,a.id);assert.equal(raw(store,'workboard_columns').filter(row=>row.proxy_project_id===a.id).length,1);
    const stable=snapshot(store);store.workboard(root.id);assert.deepEqual(snapshot(store),stable);
    assert.throws(()=>move(store,root.id,mixed.id,secondProxy.id),{status:409,message:'This combination of project tags cannot occupy the selected milestone column. Review the task’s project tags first.'});assert.deepEqual(snapshot(store),stable);
    move(store,root.id,mixed.id,normal);assert.deepEqual(store.taskDetail(mixed.id).task.projectIds,[root.id]);assert.deepEqual(ids(store,root.id,normal),[mixed.id]);
    const beforeVersion=store.taskDetail(mixed.id).task.version;move(store,root.id,mixed.id,proxy.id);assert.deepEqual(store.taskDetail(mixed.id).task.projectIds,[milestone.id]);assert.equal(store.taskDetail(mixed.id).task.version,beforeVersion+1);assert.deepEqual(ids(store,root.id,proxy.id),[mixed.id]);
    const pv=version(store,root.id);store.updateProject(milestone.id,{expectedVersion:milestone.version,name:'Renamed',status:'archived'},alice);assert.equal(version(store,root.id),pv+1);assert.ok(!store.workboard(root.id).columns.some(row=>row.id===proxy.id));assert.equal(store.workboard(root.id,{showHidden:true}).columns.find(row=>row.id===proxy.id)!.name,'Hierarchy board (Renamed)');
    const positions=raw(store,'workboard_positions');store.configureWorkboard(root.id,{expectedBoardVersion:version(store,root.id),enabled:false});child(store,root.id,'milestone','Created while disabled');assert.equal(raw(store,'workboard_columns').filter(row=>row.kind==='proxy').length,4);assert.deepEqual(raw(store,'workboard_positions'),positions);
  }finally{store.close();}
});

test('tag cleanup, status, owner, merge and dependency updates invalidate affected boards once per operation',()=>{
  const store=new Store({path:':memory:'});try{
    const root=store.createProject({name:'External changes'});const milestone=child(store,root.id,'milestone','Release');enable(store,root.id);enable(store,milestone.id);const backlog=store.workboard(root.id).columns[0]!.id;const target=column(store,root.id);const proxy=store.workboard(root.id).columns.find(row=>row.proxyProjectId===milestone.id)!.id;let task=store.createTask({title:'External task',projectIds:[root.id]});move(store,root.id,task.id,target);
    task=store.taskDetail(task.id).task;store.updateTaskProjects(task.id,{action:'set',projectIds:[milestone.id],expectedVersion:task.version});assert.deepEqual(ids(store,root.id,proxy),[task.id]);assert.equal(raw(store,'workboard_positions').filter(row=>row.column_id===target).length,1,'normal position retained while proxy overrides');move(store,root.id,task.id,proxy,{edge:'start'});
    task=store.taskDetail(task.id).task;store.updateTaskProjects(task.id,{action:'set',projectIds:[root.id],expectedVersion:task.version});assert.deepEqual(ids(store,root.id,target),[task.id]);assert.deepEqual(ids(store,root.id,backlog),[]);
    const extra=store.createTask({title:'Other',projectIds:[root.id]});const before=version(store,root.id);task=store.taskDetail(task.id).task;store.updateTaskDependencies(task.id,{taskId:extra.id,action:'add',expectedVersion:task.version});assert.equal(version(store,root.id),before+1);
    let current=store.taskDetail(extra.id).task;const statusVersion=version(store,root.id);store.updateTask(extra.id,{expectedVersion:current.version,status:'resolved',ownerId:'alice'});assert.equal(version(store,root.id),statusVersion+1,'dependency parent and child share one board increment');
    const mergeVersion=version(store,root.id);const anchor=store.taskDetail(task.id).task;current=store.taskDetail(extra.id).task;store.mergeTask(extra.id,{taskId:task.id,expectedVersion:current.version,expectedTargetVersion:anchor.version},bob);assert.equal(version(store,root.id),mergeVersion+1);
    const unchanged=snapshot(store);current=store.taskDetail(extra.id).task;store.updateTask(extra.id,{expectedVersion:current.version,title:current.title});assert.deepEqual(snapshot(store),unchanged);
  }finally{store.close();}
});

test('bad pins, values, foreign columns and invalid relative anchors leave every row untouched',()=>{
  const store=new Store({path:':memory:'});try{
    const a=store.createProject({name:'Validate A'}),b=store.createProject({name:'Validate B'});enable(store,a.id);enable(store,b.id);const target=column(store,a.id);const foreign=column(store,b.id);const task=store.createTask({title:'Validated task',projectIds:[a.id]});const before=snapshot(store);const input={taskId:task.id,columnId:target,expectedBoardVersion:version(store,a.id),expectedTaskVersion:1,position:{edge:'start'}};
    for(const patch of [{expectedBoardVersion:0},{expectedTaskVersion:2},{position:{beforeTaskId:'T999'}},{columnId:foreign}])assert.throws(()=>store.moveWorkboardCard(a.id,{...input,...patch}),status(patch.columnId?404:409));
    for(const patch of [{expectedBoardVersion:-1},{expectedTaskVersion:Number.MAX_SAFE_INTEGER+1},{position:{}},{position:{beforeTaskId:task.id}},{position:{edge:'start',afterTaskId:task.id}}])assert.throws(()=>store.moveWorkboardCard(a.id,{...input,...patch}),status(400));
    for(const settings of [{pointLimit:-1},{pointLimit:1.5},{pointLimit:Number.MAX_SAFE_INTEGER+1},{name:''},{name:'\ud800'},{hidden:'true'}])assert.throws(()=>store.updateWorkboardColumn(a.id,target,{expectedBoardVersion:version(store,a.id),...settings}),status(400));
    assert.throws(()=>store.workboard(a.id,{limit:101}),status(400));assert.throws(()=>store.workboardHistory(a.id,undefined,0),status(400));assert.throws(()=>store.workboardColumn(a.id,foreign),{status:404,code:'COLUMN_UNAVAILABLE'});assert.deepEqual(snapshot(store),before);
  }finally{store.close();}
});

test('failed card history or version overflow rolls back tags, positions, task, board, activity and replay together',()=>{
  const store=new Store({path:':memory:'});try{
    const a=store.createProject({name:'Atomic board'});const b=store.createProject({name:'Source board'});enable(store,a.id);const target=column(store,a.id);const task=store.createTask({title:'Atomic task',projectIds:[b.id]});const input={taskId:task.id,columnId:target,expectedBoardVersion:version(store,a.id),expectedTaskVersion:1,position:{edge:'start'}};const before=snapshot(store);
    store.database.exec("CREATE TRIGGER fail_board_move BEFORE INSERT ON workboard_transactions WHEN json_extract(NEW.data,'$.kind')='card_move' BEGIN SELECT RAISE(ABORT,'forced board failure'); END");assert.throws(()=>store.mutate('move','request',()=>({status:200,body:store.moveWorkboardCard(a.id,input,bob)})),/forced board failure/);assert.deepEqual(snapshot(store),before);store.database.exec('DROP TRIGGER fail_board_move');
    const response=store.mutate('move','request',()=>({status:200,body:store.moveWorkboardCard(a.id,input,bob)}));const after=snapshot(store);assert.deepEqual(store.mutate('move','request',()=>{throw new Error('must not rerun');}),response);assert.deepEqual(snapshot(store),after);
    store.database.prepare('UPDATE project_workboards SET version=? WHERE project_id=?').run(Number.MAX_SAFE_INTEGER,a.id);const max=snapshot(store);assert.throws(()=>store.createTask({title:'Overflow must rollback',projectIds:[a.id]}),status(409));assert.deepEqual(snapshot(store),max);
  }finally{store.close();}
});

test('history filters all related task/project references before paging and retains immutable labels',()=>{
  const store=new Store({path:':memory:'});try{
    const project=store.createProject({name:'History board'});const milestone=child(store,project.id,'milestone','Private release');enable(store,project.id);const target=column(store,project.id,'Initial label');const a=store.createTask({title:'A',projectIds:[project.id]});const b=store.createTask({title:'B',projectIds:[project.id]});move(store,project.id,a.id,target);move(store,project.id,b.id,target,{afterTaskId:a.id});const evidence=raw(store,'workboard_transactions');
    const page=store.workboardHistory(project.id,undefined,1,id=>id!==a.id&&id!==milestone.id);assert.equal(page.transactions[0]?.kind,'column_create');assert.equal(page.transactions[0]?.column?.name,'Initial label');assert.ok(page.nextBefore);assert.ok(store.workboardHistory(project.id,page.nextBefore!,100,id=>id!==a.id&&id!==milestone.id).transactions.every(row=>!row.relatedProjectIds.includes(milestone.id)));assert.deepEqual(raw(store,'workboard_transactions'),evidence);
    const proxy=store.workboard(project.id).columns.find(row=>row.proxyProjectId===milestone.id)!;move(store,project.id,b.id,proxy.id);assert.ok(!store.taskHistory(b.id,undefined,100,id=>id!==milestone.id).transactions.some(row=>row.column?.toColumn.id===proxy.id));store.updateWorkboardColumn(project.id,target,{expectedBoardVersion:version(store,project.id),name:'Changed label'});assert.equal(store.taskHistory(a.id).transactions.find(row=>row.column)?.column?.toColumn.name,'Initial label');
  }finally{store.close();}
});

test('competing moves serialize under SQLite lock and stale dialogs cannot be rebased implicitly',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'phab-board-lock-'));const path=join(directory,'workspace.sqlite');const store=new Store({path});let worker:Worker|undefined;
  try{
    const project=store.createProject({name:'Concurrent board'});enable(store,project.id);const first=column(store,project.id,'First');const second=column(store,project.id,'Second');const task=store.createTask({title:'Contended card',projectIds:[project.id]});const input={taskId:task.id,columnId:first,expectedBoardVersion:version(store,project.id),expectedTaskVersion:1,position:{edge:'start'}};
    const moduleUrl=new URL('../server/store.ts',import.meta.url).href;
    worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');require('tsx/cjs');const {Store}=require(workerData.module);const s=new Store({path:workerData.path});parentPort.postMessage('ready');parentPort.once('message',()=>{parentPort.postMessage('attempting');try{s.moveWorkboardCard(workerData.project,workerData.input);parentPort.postMessage({ok:true});}catch(e){parentPort.postMessage({status:e.status,message:e.message});}finally{s.close();}});`,{eval:true,workerData:{module:new URL(moduleUrl).pathname,path,project:project.id,input}});
    await once(worker,'message');store.database.exec('BEGIN IMMEDIATE');worker.postMessage('go');await once(worker,'message');const completed=once(worker,'message');move(store,project.id,task.id,second);store.database.exec('COMMIT');const [result]=await completed;assert.equal(result.status,409);assert.deepEqual(ids(store,project.id,second),[task.id]);assert.deepEqual(ids(store,project.id,first),[]);assert.equal(store.taskDetail(task.id).task.version,2);
  }finally{if(worker)await worker.terminate();store.close();rmSync(directory,{recursive:true,force:true});}
});

function schemaTwelve(path:string):Map<string,unknown[]> {
  const db=new DatabaseSync(path);try{
    // Construct the prior format directly: no current database is relabeled.
    db.exec(`
      CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE sequences(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE activity(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,object_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE idempotency(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL);
      CREATE TABLE versions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),number INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,number));
      CREATE TABLE comments(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE reviews(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE wiki_versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES entities(id),number INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(document_id,number));
      CREATE TABLE review_threads(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),root_comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE thread_events(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),thread_id TEXT NOT NULL REFERENCES review_threads(id),version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE suggestion_applications(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id),thread_id TEXT NOT NULL REFERENCES review_threads(id),from_version_id TEXT NOT NULL REFERENCES versions(id),to_version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE task_transactions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES entities(id),sequence INTEGER NOT NULL,task_version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(task_id,sequence));
      CREATE TABLE task_dependencies(task_id TEXT NOT NULL REFERENCES entities(id),dependency_id TEXT NOT NULL REFERENCES entities(id),PRIMARY KEY(task_id,dependency_id));
      CREATE TABLE task_subscriptions(task_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(task_id,principal_id));
      CREATE TABLE task_duplicates(source_id TEXT NOT NULL REFERENCES entities(id),target_id TEXT NOT NULL REFERENCES entities(id),operation_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,target_id));
      CREATE TABLE task_projects(task_id TEXT NOT NULL REFERENCES entities(id),project_id TEXT NOT NULL REFERENCES entities(id),PRIMARY KEY(task_id,project_id));
      CREATE INDEX task_projects_project ON task_projects(project_id,task_id);
      INSERT INTO sequences VALUES('project',1),('task',1);
    `);
    for(const table of ['wiki_versions','comments','thread_events','suggestion_applications','task_transactions','task_duplicates'])for(const operation of ['update','delete'])db.exec(`CREATE TRIGGER ${table}_no_${operation} BEFORE ${operation.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT,'Immutable evidence'); END`);
    const project={id:'PROJ1',name:'Prior boardless project',description:'Keep metadata',color:'#123456'};db.prepare("INSERT INTO entities VALUES(?,'project',?)").run(project.id,JSON.stringify(project,null,2));initializePolicies(db);initializeProjects(db);upgradeProjectPolicies(db);initializeProjectHierarchy(db);
    const task={id:'T1',title:'Prior task',description:'Keep body',status:'open',priority:'normal',ownerId:null,authorId:null,version:3,createdAt:'2024-01-01T00:00:00Z',updatedAt:'2024-01-02T00:00:00Z'};db.prepare("INSERT INTO entities VALUES(?,'task',?)").run(task.id,JSON.stringify(task,null,2));db.prepare('INSERT INTO task_projects VALUES(?,?)').run(task.id,project.id);const event={id:'old-event',taskId:task.id,sequence:1,taskVersion:3,kind:'legacy',actor:null,createdAt:task.updatedAt,snapshot:task};db.prepare('INSERT INTO task_transactions VALUES(?,?,?,?,?)').run(event.id,task.id,1,3,JSON.stringify(event,null,2));db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run('old-key','old-body',201,JSON.stringify(task,null,2),task.createdAt);db.exec('PRAGMA user_version=12');
    return new Map((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(({name})=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  }finally{db.close();}
}

test('schema13 preserves actual schema12 records and saved bytes, stays boardless, and persists initialized state across restart',()=>{
  const directory=mkdtempSync(join(tmpdir(),'phab-board-migrate-'));const path=join(directory,'workspace.sqlite');const before=schemaTwelve(path);let store=new Store({path});try{
    assert.equal((store.database.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,45);for(const [name,rows]of before)assert.deepEqual(raw(store,name),rows,name);assert.deepEqual(raw(store,'project_workboards'),[]);assert.deepEqual(raw(store,'workboard_transactions'),[]);assert.equal(store.workboard('PROJ1').board.version,0);enable(store,'PROJ1');const target=column(store,'PROJ1');move(store,'PROJ1','T1',target);const saved=snapshot(store);store.close();store=new Store({path});assert.deepEqual(snapshot(store),saved);assert.deepEqual(ids(store,'PROJ1',target),['T1']);assert.deepEqual(raw(store,'idempotency'),before.get('idempotency'));
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('failed schema13 creation rolls back all new tables and leaves schema12 ready for repair/retry',()=>{
  const directory=mkdtempSync(join(tmpdir(),'phab-board-migrate-fail-'));const path=join(directory,'workspace.sqlite');const before=schemaTwelve(path);let db=new DatabaseSync(path);db.exec('CREATE TABLE workboard_columns(collision TEXT)');db.close();try{
    assert.throws(()=>new Store({path}),/already exists/);db=new DatabaseSync(path);assert.equal((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,12);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='project_workboards'").get(),undefined);for(const [name,rows]of before)assert.deepEqual(db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),rows);db.exec('DROP TABLE workboard_columns');db.close();const store=new Store({path});store.close();
  }finally{rmSync(directory,{recursive:true,force:true});}
});
