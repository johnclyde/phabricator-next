import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { SuiteImportRequest } from '../shared/suite-import.ts';
import { SUITE_IMPORT_LIMITS } from '../server/suite-import-xml.ts';

const help=`Import original Phabricator application data from MySQL XML exports.

  node --import tsx scripts/suite-import.ts preview manifest.json
  node --import tsx scripts/suite-import.ts apply manifest.json --digest SHA256 --key STABLE_KEY
  node --import tsx scripts/suite-import.ts provenance NATIVE_RECORD_ID

The manifest contains sourceKey, destination, optional roles, and files as paths
relative to the manifest. Preview never retains objects. Apply requires its exact
digest and an explicit stable retry key. Export instructions: docs/suite-import.md.
Set PHABRICATOR_URL and PHABRICATOR_TOKEN. Tokens require read/write for imports.
`;
async function main():Promise<void> {
  const{values,positionals}=parseArgs({allowPositionals:true,strict:true,options:{help:{type:'boolean',short:'h'},server:{type:'string'},digest:{type:'string'},key:{type:'string'}}});
  const[command,target,...extra]=positionals;
  if(values.help||!command){console.log(help);return;}
  if(!['preview','apply','provenance'].includes(command)||!target||extra.length)throw new Error('Use preview/apply MANIFEST or provenance RECORD_ID. See --help.');
  const server=new URL(values.server??process.env.PHABRICATOR_URL??'http://127.0.0.1:4310');
  if(!['http:','https:'].includes(server.protocol)||server.username||server.password||server.search||server.hash)throw new Error('Use an HTTP(S) server URL without credentials, query, or fragment.');
  if(server.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(server.hostname))throw new Error('Use HTTPS for remote imports.');
  server.pathname=server.pathname.replace(/\/$/,'')+'/';
  let body:unknown,route:string;
  if(command==='provenance'){if(!/^[A-Z][A-Z0-9]*-[a-f0-9-]{36}$/.test(target))throw new Error('Use a native suite record ID.');route=`api/suite-import/provenance/${target}`;}
  else {
    const manifestPath=resolve(target);if((await stat(manifestPath)).size>1_000_000)throw new Error('Manifest exceeds 1 MB.');
    const manifest=JSON.parse(await readFile(manifestPath,'utf8')) as Omit<SuiteImportRequest,'files'>&{files:string[]};
    if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>SUITE_IMPORT_LIMITS.files||manifest.files.some(path=>typeof path!=='string'))throw new Error('Manifest files must list 1–32 XML export paths.');
    let bytes=0;const files:SuiteImportRequest['files']=[];
    for(const name of manifest.files){const path=resolve(dirname(manifestPath),name),size=(await stat(path)).size;bytes+=size;if(bytes>SUITE_IMPORT_LIMITS.bytes)throw new Error('Export files exceed 12 MB. Split source objects into batches.');files.push({name,xml:await readFile(path,'utf8')});}
    const request={...manifest,files};route=`api/suite-import/${command}`;
    if(command==='apply') {if(!values.digest||!values.key)throw new Error('Apply requires --digest from the reviewed preview and --key for safe retry.');body={request,previewDigest:values.digest};}
    else body=request;
  }
  const token=process.env.PHABRICATOR_TOKEN;
  const response=await fetch(new URL(route,server),{method:body===undefined?'GET':'POST',redirect:'error',headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'}),...(command==='apply'?{'Idempotency-Key':values.key!}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(120_000)});
  const result:unknown=await response.json();
  if(!response.ok)throw new Error(`Import request failed (${response.status}): ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Import failed.');process.exitCode=1;});
