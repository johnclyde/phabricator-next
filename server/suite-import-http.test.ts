import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from './app.ts';
import { Store } from './store.ts';
import { createAuth } from './auth.ts';
import type { SuiteImportPreview, SuiteImportProvenance, SuiteImportReceipt } from '../shared/suite-import.ts';

const xml='<?xml version="1.0"?><mysqldump><database name="phabricator_phame"><table_data name="phame_blog"><row><field name="id">1</field><field name="phid">PHID-BLOG-historical</field><field name="name">Imported private blog</field><field name="description">Original &amp; escaped content</field><field name="status">active</field></row></table_data></database></mysqldump>';
test('authenticated HTTP preview/apply/provenance and CLI preserve private evidence without anonymous access',async()=>{
 const store=new Store({path:':memory:'}),auth=createAuth({database:store.database,mode:'password',basePath:'/',provisioning:true});
 const account=await auth.createAccount({username:'importer',displayName:'Importer',password:'HTTP import fixture passphrase'}),other=await auth.createAccount({username:'reader',displayName:'Reader',password:'HTTP import other passphrase'});
 const app=createApp({store,seed:false,authMode:'password'}),token=app.auth.createToken(account.id,{name:'Import fixture',scopes:['read','write']}).token,reader=app.auth.createToken(other.id,{name:'Read fixture',scopes:['read']}).token;
 const directory=await mkdtemp(join(tmpdir(),'suite-import-http-'));
 try{
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const request={sourceKey:'original-http',files:[{name:'phame.xml',xml}],destination:{spaceId:'S1',visibility:'members',memberIds:[],editorIds:[]}};
  const send=(path:string,input?:unknown,credential=token,key:string=randomUUID())=>fetch(`${base}${path}`,{method:input===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential}`,...(input===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},...(input===undefined?{}:{body:JSON.stringify(input)})});
  assert.equal((await fetch(`${base}/api/suite-import/preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)})).status,401);
  assert.equal((await send('/api/suite-import/preview',request,reader)).status,403);
  const previewResponse=await send('/api/suite-import/preview',request);assert.equal(previewResponse.status,200);const preview=await previewResponse.json() as SuiteImportPreview;assert.equal(preview.canApply,true);
  const applied=await send('/api/suite-import/apply',{request,previewDigest:preview.digest},token,'http-stable');assert.equal(applied.status,201,await applied.clone().text());const receipt=await applied.json() as SuiteImportReceipt,id=receipt.records[0]!.recordId;
  const read=await send(`/api/suite-import/provenance/${id}`);assert.equal(read.status,200);const provenance=await read.json() as SuiteImportProvenance&{accessEpoch:number};assert.equal(typeof provenance.accessEpoch,'number');assert.equal(provenance.assertionStatus,'historical-unverified');assert.equal(provenance.rows[0]!.fields.description,'Original & escaped content');
  assert.equal((await send(`/api/suite-import/provenance/${id}`,undefined,reader)).status,404);
  const repeated=await send('/api/suite-import/apply',{request,previewDigest:preview.digest},token,'http-stable');assert.equal((await repeated.json() as SuiteImportReceipt).replayed,true);
  await writeFile(join(directory,'phame.xml'),xml);await writeFile(join(directory,'manifest.json'),JSON.stringify({...request,files:['phame.xml']}));
  const result=await promisify(execFile)(process.execPath,['--import','tsx','scripts/suite-import.ts','preview',join(directory,'manifest.json'),'--server',base],{cwd:process.cwd(),env:{...process.env,PHABRICATOR_TOKEN:token},timeout:30_000});
  const cli=JSON.parse(result.stdout) as SuiteImportPreview;assert.equal(cli.canApply,true);assert.equal(cli.items[0]!.disposition,'skip');
 }finally{await app.close();store.close();await rm(directory,{recursive:true,force:true});}
});
