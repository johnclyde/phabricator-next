import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DrydockBlueprint, DrydockAuthorization, DrydockLeaseDetail } from '../shared/drydock.ts';
import { createApp } from './app.ts';
import { LocalDrydockWorker, parseDrydockWorkerConfiguration, runDrydockWorkerCycle } from './drydock-worker.ts';
import { createGitFixture } from '../tests/git-fixture.ts';

test('a real API and local worker provision and clean an authorized exact Git working copy', async () => {
 const fixture=await createGitFixture(),app=createApp({databasePath:':memory:',seed:false,gitRepositories:{R1:fixture.barePath},automation:{drydockBindings:[{key:'fixture-copy',worker:'fixture-worker',repositoryIds:['R1']}],drydockWorkers:{'fixture-worker':['local']}}});
 try {
  app.store.createRepository({name:'Local working source',description:'',remoteUrl:'https://example.invalid/source.git',defaultBranch:'main'});
  await new Promise<void>(accept=>app.server.listen(0,'127.0.0.1',accept));const address=app.server.address();assert.ok(address&&typeof address!=='string');const server=`http://127.0.0.1:${address.port}`;
  const api=async<T>(path:string,input?:unknown):Promise<T>=>{const response=await fetch(`${server}/api/drydock${path}`,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},...(input===undefined?{}:{body:JSON.stringify(input)})});const body=await response.json() as T;assert.ok(response.ok,JSON.stringify(body));return body;};
  const {blueprint}=await api<{blueprint:DrydockBlueprint}>('/blueprints',{name:'Fixture copy',description:'',enabled:true,repositoryId:'R1',binding:'fixture-copy',worker:'fixture-worker',limit:1});
  const {authorization}=await api<{authorization:DrydockAuthorization}>(`/blueprints/${blueprint.id}/authorizations`,{subjectKind:'principal',subjectId:`local:${app.auth.workspaceId}`});
  await api(`/authorizations/${authorization.id}/commands`,{expectedVersion:authorization.version,status:'approved'});
  const allocated=await api<DrydockLeaseDetail>('/leases',{repositoryId:'R1',commitId:fixture.importCommit,blueprintId:blueprint.id,blueprintVersion:blueprint.version});
  const root=join(await realpath(fixture.root),'worker-root');const worker=new LocalDrydockWorker(parseDrydockWorkerConfiguration({server,worker:'fixture-worker',bindings:{'fixture-copy':{repositoryId:'R1',repositoryPath:fixture.barePath,root}}}));
  await runDrydockWorkerCycle(worker,`phab_${'a'.repeat(43)}`);
  const ready=await api<DrydockLeaseDetail>(`/leases/${allocated.lease.id}`);assert.equal(ready.lease.status,'active');assert.ok(ready.resource);
  const work=join(root,ready.resource!.handle,'work');assert.equal((await readFile(join(work,'.git','HEAD'),'utf8')).trim(),fixture.importCommit);assert.match(await readFile(join(work,'README.md'),'utf8'),/After the change/);
  await api(`/leases/${ready.lease.id}/commands`,{command:'release',expectedVersion:ready.lease.version});await runDrydockWorkerCycle(worker,`phab_${'a'.repeat(43)}`);
  const released=await api<DrydockLeaseDetail>(`/leases/${ready.lease.id}`);assert.equal(released.lease.status,'released');assert.equal(released.resource!.status,'released');await assert.rejects(stat(work));
 }finally{await app.close();await fixture.close();}
});
