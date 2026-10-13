import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { Store } from '../server/store.ts';
import { ancestorIds, effectiveMember, effectiveMembers, hierarchy, membershipSources } from '../server/project-graph.ts';
import { initializeProjects } from '../server/projects.ts';
import { initializePolicies, upgradeProjectPolicies } from '../server/policy.ts';
import type { ActorAttribution, Project, ProjectKind } from '../shared/types.ts';
import { PROJECT_COLOR_HEX } from '../shared/projects.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'session-a', requestId: 'request-a' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: 'session-b', requestId: 'request-b' };
const status = (value: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === value;
const raw = (store: Store, table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const tables = ['entities','project_profiles','project_aliases','project_hierarchy','project_relations','project_transactions','project_preference_events','object_policies','policy_meta','activity','sequences','idempotency','task_projects','task_transactions'];
const snapshot = (store: Store) => tables.map(table => raw(store, table));
const epoch = (store: Store) => (store.database.prepare("SELECT value FROM policy_meta WHERE name = 'epoch'").get() as {value:number}).value;
const childInput = (store: Store, parentId: string, kind: ProjectKind, extra: object = {}) => {
  const preview = store.projectChildPreview(parentId, kind);
  return { name: `${kind} ${preview.expectedHierarchyVersion}`, parentId, kind, expectedParentVersion: preview.expectedParentVersion, expectedHierarchyVersion: preview.expectedHierarchyVersion, expectedParentMembersVersion: preview.expectedParentMembersVersion, ...(preview.conversionRequired ? {confirmMembershipConversion:true} : {}), ...extra };
};
const child = (store: Store, parentId: string, kind: ProjectKind = 'project', extra: object = {}) => store.createProject(childInput(store,parentId,kind,extra),bob);
const members = (store: Store,id:string,action:'add'|'remove'|'set',principalIds:string[]) => store.updateProjectMembers(id,{action,principalIds,expectedCollectionVersion:store.projectMembers(id,'alice').collectionVersion},alice);
const edit = (store: Store,id:string,input:object) => store.updateProject(id,{...input,expectedVersion:store.getProject(id).version},alice);

test('first ordinary child converts all direct membership with explicit audit, no creator grants and byte-exact historical evidence', () => {
  const store = new Store({path:':memory:'});
  try {
    const parent=store.createProject({name:'Parent',memberIds:['alice','disabled-user']},alice);
    const prior=raw(store,'project_transactions');const priorEntity=raw(store,'entities');const startEpoch=epoch(store);
    const preview=store.projectChildPreview(parent.id,'project');assert.equal(preview.transferMemberCount,2);assert.equal(preview.conversionRequired,true);
    const before=snapshot(store);const input=childInput(store,parent.id,'project',{memberIds:['carol','alice']});
    assert.throws(()=>store.createProject({...input,confirmMembershipConversion:false},bob),status(409));assert.deepEqual(snapshot(store),before);
    const created=store.createProject(input,bob);
    assert.equal(created.kind,'project');assert.equal(created.parentId,parent.id);assert.equal(created.depth,1);assert.equal(created.membershipMode,'direct');assert.equal(created.displayName,created.name);
    assert.deepEqual(effectiveMembers(store.database,created.id),['alice','carol','disabled-user']);assert.equal(effectiveMember(store.database,created.id,'bob'),false);
    assert.deepEqual(effectiveMembers(store.database,parent.id),['alice','carol','disabled-user']);assert.equal(store.getProject(parent.id).membershipMode,'descendants');assert.equal(store.getProject(parent.id).version,1);assert.equal(store.getProject(parent.id).hierarchyVersion,2);
    assert.equal(store.projectMembers(parent.id,'alice').collectionVersion,2);assert.equal(store.projectMembers(created.id,'alice').collectionVersion,1);assert.equal(epoch(store),startEpoch+1);
    const parentRows=store.database.prepare("SELECT principal_id,active,version FROM project_relations WHERE project_id=? AND relation='member' ORDER BY principal_id").all(parent.id);
    assert.deepEqual(parentRows.map(row=>({...row})),[{principal_id:'alice',active:0,version:2},{principal_id:'disabled-user',active:0,version:2}]);
    assert.equal(store.projectPreferences(parent.id,'alice').membership.version,null);assert.equal(store.projectPreferences(parent.id,'alice').membership.source,'descendants');assert.deepEqual(store.projectPreferences(parent.id,'alice').membership.sourceProjectIds,[created.id]);
    assert.deepEqual(raw(store,'project_transactions').slice(0,prior.length),prior);assert.deepEqual(raw(store,'entities').slice(0,priorEntity.length),priorEntity);
    const history=store.projectHistory(parent.id).transactions.slice(0,2);assert.deepEqual(history.map(item=>item.hierarchy?.action),['created_child','converted_membership']);assert.equal(new Set(history.map(item=>item.hierarchy!.operationId)).size,1);assert.ok(history.every(item=>item.attribution?.principalId==='bob'&&item.hierarchy?.childId===created.id));
    assert.throws(()=>members(store,parent.id,'set',[]),status(409));assert.throws(()=>store.updateProjectMembership(parent.id,{action:'leave',expectedVersion:2},alice),status(409));
    assert.deepEqual(store.projectDetail(created.id,'alice').hierarchy.ancestors.map(item=>item.id),[parent.id]);
    assert.throws(()=>store.database.exec("UPDATE project_hierarchy SET parent_id = NULL"),/immutable/);assert.throws(()=>store.database.exec('DELETE FROM project_hierarchy'),/immutable/);
  } finally {store.close();}
});

test('member unions propagate effective collection CAS only when sets change, including milestones and nested first conversions',()=>{
  const store=new Store({path:':memory:'});try{
    const root=store.createProject({name:'Union root',memberIds:['alice']});const rootM=child(store,root.id,'milestone');const a=child(store,root.id,'project',{name:'Branch A'});const b=child(store,root.id,'project',{name:'Branch B',memberIds:['alice']});const am=child(store,a.id,'milestone');
    const rv=store.projectMembers(root.id,'alice').collectionVersion;const mv=store.projectMembers(rootM.id,'alice').collectionVersion;
    members(store,a.id,'remove',['alice']);assert.equal(store.projectMembers(root.id,'alice').collectionVersion,rv);assert.equal(store.projectMembers(rootM.id,'alice').collectionVersion,mv);assert.equal(store.projectPreferences(am.id,'alice').membership.active,false);
    members(store,b.id,'remove',['alice']);assert.equal(store.projectMembers(root.id,'alice').collectionVersion,rv+1);assert.equal(store.projectMembers(rootM.id,'alice').collectionVersion,mv+1);
    members(store,a.id,'add',['bob']);assert.equal(store.projectMembers(root.id,'alice').collectionVersion,rv+2);assert.equal(store.projectMembers(rootM.id,'alice').collectionVersion,mv+2);assert.equal(store.projectPreferences(am.id,'bob').membership.active,true);
    const av=store.projectMembers(a.id,'alice').collectionVersion;const beforeRoot=store.projectMembers(root.id,'alice').collectionVersion;const beforeMilestone=store.projectMembers(am.id,'alice').collectionVersion;
    const leaf=child(store,a.id,'project',{name:'Leaf'});assert.equal(store.projectMembers(a.id,'alice').collectionVersion,av+1);assert.equal(store.projectMembers(root.id,'alice').collectionVersion,beforeRoot);assert.equal(store.projectMembers(am.id,'alice').collectionVersion,beforeMilestone);
    assert.deepEqual(membershipSources(store.database,root.id),[b.id,leaf.id].sort());assert.deepEqual(ancestorIds(store.database,leaf.id),[a.id,root.id]);assert.deepEqual(store.projectDetail(leaf.id,'alice').hierarchy.ancestors.map(row=>row.id),[root.id,a.id]);
    members(store,leaf.id,'add',['carol']);assert.equal(store.projectPreferences(rootM.id,'carol').membership.active,true);assert.deepEqual(store.projectPreferences(rootM.id,'carol').membership.sourceProjectIds,[leaf.id]);
    const before=snapshot(store);members(store,leaf.id,'add',['carol']);assert.deepEqual(snapshot(store),before);
  }finally{store.close();}
});

test('milestones share parent membership and live appearance, keep independent metadata and global explicit aliases, and never convert members',()=>{
  const store=new Store({path:':memory:'});try{
    const parent=store.createProject({name:'Milestone parent',memberIds:['alice'],colorKey:'violet'});const before=raw(store,'project_relations');
    const first=child(store,parent.id,'milestone',{name:'Release',aliases:['release one']});const second=child(store,parent.id,'milestone',{name:'Release'});
    assert.deepEqual(raw(store,'project_relations'),before);assert.equal(store.getProject(parent.id).membershipMode,'direct');assert.equal(store.projectMembers(parent.id,'alice').collectionVersion,1);
    assert.equal(first.milestoneNumber,1);assert.equal(second.milestoneNumber,2);assert.equal(first.primarySlug,null);assert.equal(first.primarySlugSource,null);assert.equal(first.icon,'milestone');assert.equal(first.color,PROJECT_COLOR_HEX.violet);assert.equal(first.displayName,'Milestone parent (Release)');assert.equal(first.membershipMode,'inherited');assert.equal(store.projectPreferences(first.id,'alice').membership.version,null);
    assert.deepEqual(first.aliases,['release_one']);assert.throws(()=>store.createProject({name:'Release One'}),status(409));assert.doesNotThrow(()=>store.createProject({name:'Release'}));
    edit(store,parent.id,{name:'Renamed parent',colorKey:'orange',status:'archived'});assert.equal(store.getProject(first.id).displayName,'Renamed parent (Release)');assert.equal(store.getProject(first.id).color,PROJECT_COLOR_HEX.orange);assert.equal(store.getProject(first.id).version,1);
    edit(store,first.id,{name:'Renamed release',description:'Own description',status:'archived',aliases:[]});assert.deepEqual(store.getProject(first.id).aliases,[]);assert.equal(store.getProject(first.id).primarySlug,null);
    assert.equal(child(store,parent.id,'milestone',{name:'Release'}).milestoneNumber,3);
    for(const extra of [{memberIds:[]},{icon:'project'},{color:'#123456'},{colorKey:'red'}])assert.throws(()=>child(store,parent.id,'milestone',extra),status(400));
    for(const input of [{icon:'milestone'},{color:'#123456'},{colorKey:'blue'}])assert.throws(()=>edit(store,first.id,input),status(400));
    assert.throws(()=>members(store,first.id,'set',[]),status(409));assert.throws(()=>store.updateProjectMembership(first.id,{action:'join',expectedVersion:0},bob),status(409));assert.throws(()=>child(store,first.id),status(409));
    assert.throws(()=>store.createProject({name:'No parent',kind:'milestone'}),status(400));
    const after=store.projectDetail(first.id,'alice');assert.equal(after.hierarchy.subprojects.length,0);assert.equal(after.hierarchy.milestones.length,0);
  }finally{store.close();}
});

test('watch inheritance remains distinct from direct preferences and effective members can privately silence derived projects',()=>{
  const store=new Store({path:':memory:'});try{
    const root=store.createProject({name:'Watch root',memberIds:['alice']});const leaf=child(store,root.id);const milestone=child(store,root.id,'milestone');
    store.updateProjectWatcher(leaf.id,{principalId:'alice',action:'watch',expectedVersion:0},alice);
    store.updateProjectWatcher(root.id,{principalId:'alice',action:'watch',expectedVersion:0},alice);
    assert.equal(store.projectPreferences(leaf.id,'alice').effectiveWatching,true);assert.deepEqual(store.projectPreferences(leaf.id,'alice').watchingInheritedFrom,[root.id]);
    store.updateProjectWatcher(leaf.id,{principalId:'alice',action:'unwatch',expectedVersion:1},alice);assert.equal(store.projectPreferences(leaf.id,'alice').watching.active,false);assert.equal(store.projectPreferences(leaf.id,'alice').effectiveWatching,true);
    for(const action of ['watch','unwatch'])assert.throws(()=>store.updateProjectWatcher(leaf.id,{principalId:'alice',action,expectedVersion:2},alice),status(409));
    assert.equal(store.projectWatchers(leaf.id,'alice').watchers.length,0);assert.equal(store.projectPreferences(milestone.id,'alice').effectiveWatching,true);
    const before=raw(store,'project_transactions');store.updateProjectSilence(root.id,{silenced:true,expectedVersion:0},alice);store.updateProjectSilence(milestone.id,{silenced:true,expectedVersion:0},alice);
    assert.deepEqual(raw(store,'project_transactions'),before);assert.equal(store.projectPreferences(root.id,'bob').silence.active,false);assert.equal(store.projectPreferences(milestone.id,'alice').silence.active,true);
    members(store,leaf.id,'remove',['alice']);assert.throws(()=>store.updateProjectSilence(root.id,{silenced:false,expectedVersion:1},alice),status(409));members(store,leaf.id,'add',['alice']);assert.equal(store.projectPreferences(root.id,'alice').silence.active,true);
  }finally{store.close();}
});

test('three preview versions reject stale metadata, members and sibling creation; depth and integer bounds fail without changes',()=>{
  const store=new Store({path:':memory:'});try{
    const root=store.createProject({name:'CAS root'});let input=childInput(store,root.id,'project');edit(store,root.id,{description:'New'});assert.throws(()=>store.createProject(input),status(409));
    input=childInput(store,root.id,'project');members(store,root.id,'add',['alice']);assert.throws(()=>store.createProject(input),status(409));
    input=childInput(store,root.id,'project');child(store,root.id,'milestone');assert.throws(()=>store.createProject(input),status(409));
    const before=snapshot(store);for(const field of ['expectedParentVersion','expectedHierarchyVersion','expectedParentMembersVersion'])assert.throws(()=>store.createProject({...childInput(store,root.id,'project'),[field]:Number.MAX_SAFE_INTEGER+1}),status(400));assert.deepEqual(snapshot(store),before);
    let parent=root;for(let depth=1;depth<=15;depth++)parent=child(store,parent.id,'project',{name:`Depth ${depth}`});assert.equal(parent.depth,15);const deep=snapshot(store);assert.throws(()=>child(store,parent.id),status(409));assert.deepEqual(snapshot(store),deep);
    store.database.prepare('UPDATE project_hierarchy SET hierarchy_version = ? WHERE project_id = ?').run(Number.MAX_SAFE_INTEGER,root.id);const max=snapshot(store);assert.throws(()=>child(store,root.id,'milestone'),status(409));assert.deepEqual(snapshot(store),max);
  }finally{store.close();}
});

test('child creation and propagated collection overflow roll back every write, including conversion tombstones, policies and replay records',()=>{
  const store=new Store({path:':memory:'});try{
    const root=store.createProject({name:'Atomic root',memberIds:['alice','bob']});const input=childInput(store,root.id,'project');const before=snapshot(store);
    store.database.exec("CREATE TRIGGER fail_child_history BEFORE INSERT ON project_transactions WHEN json_extract(NEW.data,'$.hierarchy.action')='created_child' BEGIN SELECT RAISE(ABORT,'forced hierarchy failure'); END");
    assert.throws(()=>store.mutate('child-id','body',()=>({status:201,body:store.createProject(input,alice)})),/forced hierarchy failure/);assert.deepEqual(snapshot(store),before);store.database.exec('DROP TRIGGER fail_child_history');
    const leaf=store.createProject(input,alice);store.database.prepare('UPDATE project_profiles SET members_version = ? WHERE project_id = ?').run(Number.MAX_SAFE_INTEGER,root.id);const max=snapshot(store);
    assert.throws(()=>members(store,leaf.id,'add',['carol']),status(409));assert.deepEqual(snapshot(store),max);
  }finally{store.close();}
});

test('hierarchy history filters child references before paging and does not rewrite stored events',()=>{
  const store=new Store({path:':memory:'});try{
    const root=store.createProject({name:'History root'});const a=child(store,root.id,'project',{name:'Visible'});const b=child(store,root.id,'milestone',{name:'Hidden'});const evidence=raw(store,'project_transactions');
    const visible=(id:string)=>id!==b.id;const first=store.projectHistory(root.id,undefined,1,visible);assert.equal(first.transactions[0]?.hierarchy?.childId,a.id);assert.ok(first.nextBefore);
    const second=store.projectHistory(root.id,first.nextBefore!,1,visible);assert.equal(second.transactions[0]?.hierarchy?.action,'converted_membership');const last=store.projectHistory(root.id,second.nextBefore!,1,visible);assert.equal(last.transactions[0]?.kind,'create');assert.equal(last.nextBefore,null);assert.equal(last.firstAvailableSequence,1);
    assert.deepEqual(raw(store,'project_transactions'),evidence);
  }finally{store.close();}
});

test('task tags normalize ordered ancestor and milestone conflicts, record exact implicit removals, and leave existing tags alone on remove',()=>{
  const store=new Store({path:':memory:'});try{
    const root=store.createProject({name:'Tags root'});const a=child(store,root.id,'project',{name:'Tags A'});const b=child(store,root.id,'project',{name:'Tags B'});const ma=child(store,a.id,'milestone');const m1=child(store,root.id,'milestone');const m2=child(store,root.id,'milestone');
    let task=store.createTask({title:'Tag normalization',projectIds:[root.id,a.id,b.id,m1.id,m2.id,ma.id]},alice);assert.deepEqual(task.projectIds,[b.id,m2.id,ma.id].sort());
    const baseline=store.taskHistory(task.id).transactions[0]!;const snapshotBefore=JSON.stringify(baseline);
    let detail=store.updateTaskProjects(task.id,{action:'add',projectIds:[root.id],expectedVersion:task.version},alice);task=detail.task;assert.deepEqual(task.projectIds,[root.id]);
    const deltas=detail.history.transactions.filter(item=>item.kind==='project');assert.equal(deltas.length,4);assert.equal(new Set(deltas.map(row=>row.project!.operationId)).size,1);assert.deepEqual(deltas.filter(row=>row.project!.action==='removed').map(row=>row.project!.projectId).sort(),[b.id,m2.id,ma.id].sort());
    detail=store.updateTaskProjects(task.id,{action:'set',projectIds:[a.id,root.id,m1.id,m2.id],expectedVersion:task.version},bob);task=detail.task;assert.deepEqual(task.projectIds,[m2.id]);assert.equal(JSON.stringify(store.taskHistory(task.id).transactions.find(row=>row.id===baseline.id)),snapshotBefore);
    const before=snapshot(store);store.updateTaskProjects(task.id,{action:'add',projectIds:[m2.id],expectedVersion:task.version},alice);assert.deepEqual(snapshot(store),before);
    store.database.prepare('INSERT INTO task_projects(task_id,project_id) VALUES(?,?)').run(task.id,root.id);const odd=store.taskDetail(task.id).task;detail=store.updateTaskProjects(task.id,{action:'remove',projectIds:[a.id],expectedVersion:odd.version},alice);assert.deepEqual(detail.task.projectIds,[root.id,m2.id].sort());assert.equal(detail.task.version,odd.version);
    assert.deepEqual(store.createTask({title:'Opposite precedence',projectIds:[a.id,root.id]}).projectIds,[root.id]);
    store.database.exec("CREATE TRIGGER fail_tag_add BEFORE INSERT ON task_transactions WHEN json_extract(NEW.data,'$.project.action')='added' BEGIN SELECT RAISE(ABORT,'forced tag failure'); END");const fail=snapshot(store);assert.throws(()=>store.updateTaskProjects(task.id,{action:'set',projectIds:[a.id],expectedVersion:odd.version},alice),/forced tag failure/);assert.deepEqual(snapshot(store),fail);
  }finally{store.close();}
});

test('first-child retries and competing conversions preserve exact replay bytes across restart and never recopy stale direct tombstones',()=>{
  const directory=mkdtempSync(join(tmpdir(),'phab-hierarchy-retry-'));const path=join(directory,'workspace.sqlite');let first=new Store({path});let second=new Store({path});
  try{
    const parent=first.createProject({name:'Concurrent conversion',memberIds:['alice']});const originalInput=childInput(first,parent.id,'project',{name:'First child'});
    const saved=first.mutate('first-child','same-body',()=>({status:201,body:first.createProject(originalInput,bob)}));const childId=(saved.body as Project).id;const evidence=raw(first,'idempotency');
    assert.throws(()=>second.createProject({...originalInput,name:'Competing child'},alice),status(409));
    members(second,childId,'remove',['alice']);const sibling=child(second,parent.id,'project',{name:'Fresh sibling',memberIds:['bob']});assert.deepEqual(effectiveMembers(first.database,parent.id),['bob']);assert.equal(first.projectPreferences(sibling.id,'alice').membership.active,false);
    const before=snapshot(first);assert.deepEqual(first.mutate('first-child','same-body',()=>{throw new Error('Must not run');}),saved);assert.deepEqual(snapshot(first),before);assert.deepEqual(raw(first,'idempotency'),evidence);
    first.close();second.close();first=new Store({path});second=new Store({path});assert.deepEqual(snapshot(first),before);assert.deepEqual(first.replay('first-child','same-body'),saved);assert.equal(first.projectPreferences(childId,'alice').membership.active,false);assert.deepEqual(effectiveMembers(first.database,parent.id),['bob']);
  }finally{first.close();second.close();rmSync(directory,{recursive:true,force:true});}
});

test('hierarchy creation waits for writer authority before rechecking all parent versions', {timeout:15_000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'phab-hierarchy-lock-'));const path=join(directory,'workspace.sqlite');const store=new Store({path});let worker:Worker|undefined;
  try{
    const parent=store.createProject({name:'Writer hierarchy',memberIds:['alice']});const input=childInput(store,parent.id,'project');const original=raw(store,'project_transactions');
    worker=new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
      import { parentPort, workerData } from 'node:worker_threads'; import { DatabaseSync } from 'node:sqlite';
      const db=new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      db.prepare('UPDATE project_hierarchy SET hierarchy_version=hierarchy_version+1 WHERE project_id=?').run(workerData.id);
      parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});parentPort.postMessage('locked');
    `)}`),{workerData:{path,id:parent.id}});
    assert.deepEqual(await once(worker,'message'),['locked']);const prepare=store.database.prepare.bind(store.database);let waits=0;
    store.database.prepare=(sql:string)=>{if(sql==="UPDATE sequences SET value = value WHERE name = 'project'"){waits++;worker!.postMessage('commit');}return prepare(sql);};
    try{assert.throws(()=>store.createProject(input,alice),status(409));assert.equal(waits,1);}finally{store.database.prepare=prepare;}
    assert.equal(store.getProject(parent.id).hierarchyVersion,2);assert.equal(store.getProject(parent.id).membershipMode,'direct');assert.deepEqual(effectiveMembers(store.database,parent.id),['alice']);assert.deepEqual(raw(store,'project_transactions'),original);assert.equal(raw(store,'entities').length,1);
  }finally{if(worker)await worker.terminate();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('operator membership transfer affects only direct leaf grants and atomically updates all effective collections',()=>{
  const store=new Store({path:':memory:'});try{
    const local='local:workspace';const root=store.createProject({name:'Handoff root',memberIds:[local]});const milestone=child(store,root.id,'milestone');const leaf=child(store,root.id,'project');
    const beforeParent=store.projectMembers(root.id,'alice').collectionVersion;const beforeMilestone=store.projectMembers(milestone.id,'alice').collectionVersion;const prior=raw(store,'project_transactions');
    const count=store.transferLocalProjectMemberships(local,'alice',bob);assert.equal(count,1);assert.equal(effectiveMember(store.database,root.id,local),false);assert.equal(effectiveMember(store.database,milestone.id,'alice'),true);assert.equal(store.projectMembers(root.id,'alice').collectionVersion,beforeParent+1);assert.equal(store.projectMembers(milestone.id,'alice').collectionVersion,beforeMilestone+1);
    assert.equal(store.projectPreferences(leaf.id,'alice').membership.active,true);assert.deepEqual(raw(store,'project_transactions').slice(0,prior.length),prior);assert.ok(store.projectHistory(leaf.id).transactions.slice(0,2).every(row=>row.relation?.reason==='transferred'&&row.attribution?.principalId==='bob'));
    const parentRow=store.database.prepare("SELECT active,version FROM project_relations WHERE project_id=? AND principal_id=? AND relation='member'").get(root.id,local);assert.deepEqual({...parentRow},{active:0,version:2});const before=snapshot(store);assert.equal(store.transferLocalProjectMemberships(local,'alice',bob),0);assert.deepEqual(snapshot(store),before);
  }finally{store.close();}
});

function schemaEleven(path:string):Map<string,unknown[]> {
  const database=new DatabaseSync(path);try{
    // This historical schema is constructed directly; a current database is never relabeled.
    database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('project','repository','revision','task','document')),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX entities_kind ON entities(kind);
      CREATE UNIQUE INDEX documents_slug ON entities(json_extract(data,'$.slug')) WHERE kind='document';
      CREATE TABLE versions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),number INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,number));
      CREATE TABLE comments(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE reviews(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE activity(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,object_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX activity_object ON activity(object_id,sequence);
      CREATE TABLE sequences(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE idempotency(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL);
      CREATE TABLE wiki_versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES entities(id),number INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(document_id,number));
      CREATE TABLE review_threads(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),root_comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE thread_events(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),thread_id TEXT NOT NULL REFERENCES review_threads(id),version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE suggestion_applications(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id),thread_id TEXT NOT NULL REFERENCES review_threads(id),from_version_id TEXT NOT NULL REFERENCES versions(id),to_version_id TEXT NOT NULL REFERENCES versions(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE task_transactions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES entities(id),sequence INTEGER NOT NULL,task_version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(task_id,sequence));
      CREATE TABLE task_dependencies(task_id TEXT NOT NULL REFERENCES entities(id),dependency_id TEXT NOT NULL REFERENCES entities(id),PRIMARY KEY(task_id,dependency_id),CHECK(task_id<>dependency_id));
      CREATE TABLE task_subscriptions(task_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('subscribed','unsubscribed')),version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(task_id,principal_id));
      CREATE TABLE task_duplicates(source_id TEXT NOT NULL REFERENCES entities(id),target_id TEXT NOT NULL REFERENCES entities(id),operation_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,target_id),CHECK(source_id<>target_id));
      CREATE TABLE task_projects(task_id TEXT NOT NULL REFERENCES entities(id),project_id TEXT NOT NULL REFERENCES entities(id),PRIMARY KEY(task_id,project_id));
      CREATE INDEX task_projects_project ON task_projects(project_id,task_id);
      INSERT INTO sequences(name,value)VALUES('project',2),('task',1);
    `);
    for(const table of ['wiki_versions','comments','thread_events','suggestion_applications','task_transactions','task_duplicates'])for(const operation of ['update','delete'])database.exec(`CREATE TRIGGER ${table}_no_${operation} BEFORE ${operation.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT,'Immutable evidence'); END`);
    const oldProject={id:'PROJ1',name:'Legacy Root',description:'Exact legacy description',color:'#123456'};const other={...oldProject,id:'PROJ2',name:'Other root'};
    for(const project of [oldProject,other])database.prepare("INSERT INTO entities(id,kind,data)VALUES(?,'project',?)").run(project.id,JSON.stringify(project,null,2));
    const task={id:'T1',title:'Old task',description:'',status:'open',priority:'normal',projectIds:['PROJ1'],ownerId:null,authorId:null,version:2,createdAt:'2025-01-01T00:00:00Z',updatedAt:'2025-01-01T00:00:00Z'};
    database.prepare("INSERT INTO entities(id,kind,data)VALUES(?,'task',?)").run(task.id,JSON.stringify(task,null,2));database.prepare('INSERT INTO task_projects(task_id,project_id)VALUES(?,?)').run(task.id,'PROJ1');
    initializePolicies(database);initializeProjects(database);upgradeProjectPolicies(database);
    database.prepare('UPDATE project_profiles SET members_version=5 WHERE project_id=?').run('PROJ1');
    for(const [principalId,relation,active,version] of [['alice','member',1,3],['disabled-user','member',1,1],['bob','member',0,2],['alice','watcher',1,2],['alice','silenced',1,1]] as const)database.prepare('INSERT INTO project_relations(project_id,principal_id,relation,active,version,updated_at)VALUES(?,?,?,?,?,?)').run('PROJ1',principalId,relation,active,version,'2025-01-01T00:00:00Z');
    database.prepare('INSERT INTO project_preference_events(id,project_id,principal_id,version,data)VALUES(?,?,?,?,?)').run('private-old','PROJ1','alice',1,JSON.stringify({id:'private-old',projectId:'PROJ1',principalId:'alice',active:true,version:1,attribution:alice},null,2));
    const history={id:'old-task-history',taskId:'T1',sequence:1,taskVersion:2,kind:'legacy',actor:null,createdAt:task.createdAt,snapshot:task};database.prepare('INSERT INTO task_transactions(id,task_id,sequence,task_version,data)VALUES(?,?,?,?,?)').run(history.id,'T1',1,2,JSON.stringify(history,null,2));
    const profile=JSON.parse((database.prepare('SELECT data FROM project_profiles WHERE project_id=?').get('PROJ1') as {data:string}).data);database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at)VALUES(?,?,?,?,?)').run('legacy-project','old-input',201,JSON.stringify(profile,null,2),'2025-01-01T00:00:00Z');
    database.exec('PRAGMA user_version=11');
    return new Map((database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(({name})=>[name,database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  }finally{database.close();}
}

test('schema 12 migrates actual schema 11 into root hierarchy without changing any historical/profile/member/policy/replay bytes',()=>{
  const directory=mkdtempSync(join(tmpdir(),'phab-hierarchy-migrate-'));const path=join(directory,'workspace.sqlite');const old=schemaEleven(path);let store=new Store({path});
  try{
    assert.equal((store.database.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,40);for(const [table,rows]of old)assert.deepEqual(raw(store,table),rows,table);
    const project=store.getProject('PROJ1');assert.equal(project.kind,'project');assert.equal(project.parentId,null);assert.equal(project.milestoneNumber,null);assert.equal(project.depth,0);assert.equal(project.hierarchyVersion,1);assert.equal(project.membershipMode,'direct');assert.equal(project.displayName,project.name);
    assert.equal(store.projectPreferences('PROJ1','alice').membership.version,3);assert.equal(store.projectPreferences('PROJ1','bob').membership.version,2);assert.equal(store.projectPreferences('PROJ1','alice').watching.version,2);assert.equal(store.projectPreferences('PROJ1','alice').silence.version,1);assert.equal(store.projectMembers('PROJ1','alice').collectionVersion,5);
    const baseline=store.projectHistory('PROJ1').transactions[0]!.snapshot!;assert.equal(baseline.kind,undefined);assert.equal(baseline.parentId,undefined);assert.deepEqual(store.taskDetail('T1').task.projectIds,['PROJ1']);
    const before=snapshot(store);store.close();store=new Store({path});assert.deepEqual(snapshot(store),before);
    const created=child(store,'PROJ1');assert.deepEqual(effectiveMembers(store.database,created.id),['alice','disabled-user']);assert.equal(store.projectPreferences('PROJ1','bob').membership.active,false);assert.equal(store.projectPreferences(created.id,'alice').watching.active,false);assert.equal(store.projectPreferences(created.id,'alice').effectiveWatching,true);
    assert.deepEqual(raw(store,'idempotency'),old.get('idempotency'));
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('failed schema 12 migration rolls back the new graph and retries without changing old evidence',()=>{
  const directory=mkdtempSync(join(tmpdir(),'phab-hierarchy-migrate-failure-'));const path=join(directory,'workspace.sqlite');const old=schemaEleven(path);let database=new DatabaseSync(path);
  try{
    database.exec('PRAGMA foreign_keys=OFF');database.prepare('INSERT INTO project_profiles(project_id,data,members_version)VALUES(?,?,?)').run('PROJ999',JSON.stringify({id:'PROJ999'}),0);database.close();assert.throws(()=>new Store({path}),/FOREIGN KEY/);database=new DatabaseSync(path);
    assert.equal((database.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,11);assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='project_hierarchy'").get(),undefined);
    for(const [table,rows]of old)if(table!=='project_profiles')assert.deepEqual(database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),rows);
    database.prepare('DELETE FROM project_profiles WHERE project_id=?').run('PROJ999');database.close();const store=new Store({path});try{assert.equal(store.getProject('PROJ1').kind,'project');for(const[table,rows]of old)assert.deepEqual(raw(store,table),rows);}finally{store.close();}database=new DatabaseSync(path);
  }finally{database.close();rmSync(directory,{recursive:true,force:true});}
});
