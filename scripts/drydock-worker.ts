import { readFile } from 'node:fs/promises';
import { LocalDrydockWorker, parseDrydockWorkerConfiguration, runDrydockWorkerCycle } from '../server/drydock-worker.ts';

const configPath=process.env.APP_DRYDOCK_WORKER_CONFIG,token=process.env.APP_DRYDOCK_WORKER_TOKEN;
if(!configPath||!token)throw new Error('Configure APP_DRYDOCK_WORKER_CONFIG and APP_DRYDOCK_WORKER_TOKEN before starting the local Drydock worker.');
const worker=new LocalDrydockWorker(parseDrydockWorkerConfiguration(JSON.parse(await readFile(configPath,'utf8'))));
const once=process.argv.includes('--once');let stopping=false;let wake:()=>void=()=>undefined;
process.on('SIGTERM',()=>{stopping=true;wake();});process.on('SIGINT',()=>{stopping=true;wake();});
do{
  try{await runDrydockWorkerCycle(worker,token,fetch,()=>stopping);}catch{console.error('Drydock worker could not complete this poll. Owned expired resources will still be cleaned on the next poll.');if(once)process.exitCode=1;}
  if(once||stopping)break;
  await new Promise<void>(resolve=>{const timer=setTimeout(resolve,10_000);wake=()=>{clearTimeout(timer);resolve();};});
}while(!stopping);
