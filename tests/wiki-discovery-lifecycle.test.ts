import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import type { WikiDocumentSearchPage } from '../shared/wiki-search.ts';

const access=(id:string):ObjectAccess=>({policy:{objectId:id,version:1,spaceId:'S1',rules:{view:{kind:'workspace'},edit:{kind:'workspace'},interact:{kind:'workspace'}}},capabilities:{view:true,edit:true,interact:true,managePolicy:true},viewLabel:'Workspace',editLabel:'Workspace',interactLabel:'Workspace'});
const allAccess=()=>Object.fromEntries(['W1','W2','W3'].map(id=>[id,access(id)]));
const cache='wiki-search:queryKey=active&parentPaths=parent%2F';
const draftKey='wiki-edit:W3:content-three:3',draft={title:'Unsaved title',content:'Retain exact draft 😀\r\n',message:'Unsubmitted summary',authorityIds:['W1','W2','W3']};
function page(epoch=1):WikiDocumentSearchPage{return{documents:[{id:'W3',conduitId:3,phid:`PHID-WIKI-${'a'.repeat(20)}`,title:'Private search heading',path:'parent/child/',status:'active',version:3,published:{id:4,phid:`PHID-WRDS-${'b'.repeat(20)}`,documentId:'W3',documentPHID:`PHID-WIKI-${'a'.repeat(20)}`,versionId:'content-three',version:3,path:'parent/child/',title:'Private search heading',authorId:null,author:'Author',createdAt:'2026-01-01T00:00:00Z',message:'Published',kind:'edit',snippet:'Private published excerpt'}}],nextAfter:'opaque-cursor',nextBefore:null,accessEpoch:epoch};}
function fixture(mode:'local'|'password'='local'){
  const storageDescriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),windowDescriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),entries=new Map<string,string>(),events=new EventTarget();let quota=false;
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{get length(){return entries.size;},key:(index:number)=>[...entries.keys()][index]??null,getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>{if(quota)throw new Error('Quota');entries.set(key,value);},removeItem:(key:string)=>entries.delete(key)}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:events});
  const client=createWorkspaceClient(activateSession({mode,workspaceId:'wiki-discovery-lifecycle',account:mode==='password'?{id:'U1',username:'alice',displayName:'Alice',disabled:false}:null,sessionContext:mode==='password'?'session-one':null,csrfToken:mode==='password'?'csrf-one':null,expiresAt:null}));client.reconcileAccess(allAccess(),1,['S1']);
  return{client,entries,failWrites:()=>{quota=true;},storageRemoved:(key:string)=>{const storageKey=client.storageKey(key),oldValue=entries.get(storageKey)??null;entries.delete(storageKey);const event=new Event('storage');Object.assign(event,{key:storageKey,oldValue,newValue:null});events.dispatchEvent(event);},close:()=>{lockSession();if(storageDescriptor)Object.defineProperty(globalThis,'localStorage',storageDescriptor);else Reflect.deleteProperty(globalThis,'localStorage');if(windowDescriptor)Object.defineProperty(globalThis,'window',windowDescriptor);else Reflect.deleteProperty(globalThis,'window');}};
}

test('wiki search cache requires an authorized epoch and every filter cache retires when access advances',()=>{
  const current=fixture();
  try{
    const {client,entries}=current;for(const value of [{documents:[]},{documents:[],accessEpoch:-1},{documents:[],accessEpoch:1.5},{accessEpoch:1}]){assert.equal(client.writeStored(cache,value),false);entries.set(client.storageKey(cache),JSON.stringify(value));assert.equal(client.readStored(cache,null),null);}
    const second='wiki-search:queryKey=all';client.writeStored(cache,page());client.writeStored(second,page());client.writeStored(draftKey,draft);
    client.reconcileAccess(allAccess(),2,['S1']);
    for(const key of [cache,second]){assert.equal(client.readStored(key,null),null);assert.equal(entries.has(client.storageKey(key)),false);assert.equal(client.writeStored(key,page()),false);}
    assert.deepEqual(client.readStored(draftKey,null),draft,'unrelated epoch changes preserve authored work');assert.equal(client.writeStored(cache,page(2)),true);
  }finally{current.close();}
});

test('wiki search snapshots disappear for source, ancestor or Space revocation while exact drafts remain exportable',()=>{
  for(const loss of ['W3','W2','S1']){
    const current=fixture();
    try{
      const {client}=current;client.writeStored(cache,page());client.writeStored(draftKey,draft);const changed=allAccess();delete changed[loss];
      client.reconcileAccess(loss==='S1'?{}:changed,2,loss==='S1'?[]:['S1']);
      assert.equal(client.readStored(cache,null),null,loss);assert.equal(client.draftIsHeld(draftKey),true,loss);assert.deepEqual(client.quarantinedDrafts().find(item=>item.key===draftKey)?.value,draft);
      client.reconcileAccess(allAccess(),3,['S1']);assert.equal(client.readStored(cache,null),null);assert.equal(client.draftIsHeld(draftKey),true,'returning authority does not revive saved work automatically');
    }finally{current.close();}
  }
});

test('a wiki discovery response already decoding cannot reintroduce snippets after epoch retirement',async()=>{
  const current=fixture(),previous=globalThis.fetch;let release!:(value:unknown)=>void;
  try{
    const response=Response.json({});Object.defineProperty(response,'json',{value:()=>new Promise(resolve=>{release=resolve;})});globalThis.fetch=async()=>response;
    const pending=current.client.request<WikiDocumentSearchPage>('/api/documents?queryKey=active');await new Promise<void>(resolve=>setImmediate(resolve));
    current.client.reconcileAccess({W1:access('W1')},2,['S1']);release(page());await assert.rejects(pending,/visibility changed|Access changed/i);assert.equal(current.client.readStored(cache,null),null);assert.equal(current.client.writeStored(cache,page()),false);
  }finally{globalThis.fetch=previous;current.close();}
});

test('removing a discovery cache in another tab retires in-flight reads and notifies the rendered snapshot listener',async()=>{
  const current=fixture(),previous=globalThis.fetch;let release!:(response:Response)=>void,retirements=0;
  try{
    const {client}=current;client.writeStored(cache,page());client.onTaskSnapshotChange(()=>retirements++);globalThis.fetch=async()=>new Promise<Response>(resolve=>{release=resolve;});
    const pending=client.request('/api/documents?queryKey=active');current.storageRemoved(cache);assert.equal(retirements,1);assert.equal(client.readStored(cache,null),null);
    release(Response.json(page()));await assert.rejects(pending,/visibility changed|Access changed/i);
  }finally{globalThis.fetch=previous;current.close();}
});

test('password-session discovery remains memory-only and old responses cannot cross an account change',async()=>{
  const current=fixture('password'),previous=globalThis.fetch;let release!:(response:Response)=>void;
  try{
    const {client,entries}=current;assert.equal(client.writeStored(cache,page()),true);assert.equal(entries.size,0);globalThis.fetch=async()=>new Promise<Response>(resolve=>{release=resolve;});const pending=client.request('/api/documents?queryKey=active');
    const next=createWorkspaceClient(activateSession({mode:'password',workspaceId:'wiki-discovery-lifecycle',account:{id:'U2',username:'bob',displayName:'Bob',disabled:false},sessionContext:'session-two',csrfToken:'csrf-two',expiresAt:null}));
    release(Response.json(page()));await assert.rejects(pending,SessionChangedError);assert.equal(next.readStored(cache,null),null);assert.equal(client.writeStored(cache,page()),false);assert.equal(entries.size,0);
  }finally{globalThis.fetch=previous;current.close();}
});

test('quota failure cannot retain retired discovery source or lose competing authored drafts',()=>{
  const current=fixture();
  try{
    const {client,entries}=current,other={...draft,message:'Another tab draft'};client.writeStored(cache,page());client.writeStored(draftKey,other);current.failWrites();assert.equal(client.writeStored(cache,{...page(),documents:[]}),false);assert.equal(client.writeStored(draftKey,draft),false);
    client.reconcileAccess({W1:access('W1')},2,['S1']);assert.equal(client.readStored(cache,null),null);assert.equal(entries.has(client.storageKey(cache)),false);assert.equal(client.writeStored(cache,page()),false);
    const preserved=client.quarantinedDrafts().filter(item=>item.key===draftKey||item.key===`${draftKey}:unsaved-memory`).map(item=>item.value);assert.equal(preserved.length,2);assert.ok(preserved.some(value=>JSON.stringify(value)===JSON.stringify(draft)));assert.ok(preserved.some(value=>JSON.stringify(value)===JSON.stringify(other)));
  }finally{current.close();}
});
