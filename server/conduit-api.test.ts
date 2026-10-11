import test from 'node:test';
import assert from 'node:assert/strict';
import { conduitFailure, conduitResult, members, startWikiApi, workspace, type ConduitEnvelope } from './wiki-api-test-support.ts';

interface LegacyDocument { phid:string; uri:string; slug:string; version:number; authorPHID:null; title:string; content:string; status:string; description:string; dateCreated:number }
interface ContentAttachment { title:string; path:string; authorPHID:null; content:{raw:string} }
interface SearchRow { id:number; type:'WIKI'|'WRDS'; phid:string; fields:Record<string,unknown>; attachments:{content?:ContentAttachment} }
interface SearchResult { data:SearchRow[]; maps:Record<string,unknown>; query:{queryKey:string|null}; cursor:{limit:number; after:string|null; before:string|null; order:string|null} }

test('Conduit supports standard form tokens, JSON extension and bearer reads at root and mounted paths', async () => {
  for (const mount of ['/', '/workspace/']) {
    const app = await startWikiApi(mount);
    try {
      await app.document('/'); await app.document('transport/', { content: '\ufeffExact source\r\n' });
      const ordinary = await app.conduit<LegacyDocument>('phriction.info', { slug: 'TRANSPORT' });
      const expected = conduitResult(ordinary); assert.equal(expected.content, '\ufeffExact source\r\n'); assert.equal(expected.slug, 'transport/');
      assert.match(ordinary.headers.get('Cache-Control') ?? '', /no-store/);
      const transports:RequestInit[] = [
        { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({'api.token':app.tokens.reader.token,slug:'transport/',output:'json'}) },
        { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({slug:'transport/',__conduit__:{token:app.tokens.reader.token}}) },
        { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${app.tokens.reader.token}`}, body:JSON.stringify({slug:'transport/'}) },
      ];
      for (const transport of transports) assert.deepEqual(conduitResult(await app.raw<ConduitEnvelope<LegacyDocument>>('/api/phriction.info',transport)),expected);
      assert.equal(expected.uri, `${app.origin}${mount}w/transport/`);
      const linked = await fetch(expected.uri, { redirect:'manual', signal:AbortSignal.timeout(15_000) });
      assert.ok([302,303,307,308].includes(linked.status)); assert.equal(linked.headers.get('Location'),`${mount}#wiki/transport/`); await linked.arrayBuffer();
      const bracketed = await app.raw<ConduitEnvelope<SearchResult>>('/api/phriction.document.search', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({'api.token':app.tokens.reader.token,'constraints[paths][0]':'transport/','attachments[content]':'true',limit:'1'})});
      const result=conduitResult(bracketed); assert.equal(result.data.length,1); assert.equal(result.data[0]!.attachments.content?.content.raw,expected.content);
    } finally { await app.close(); }
  }
});

test('Conduit verifies scoped credentials and rejects mixed authentication without echoing secrets', async () => {
  const app=await startWikiApi();
  try {
    await app.document('/'); await app.document('authenticated/');
    conduitFailure(await app.conduit('phriction.info',{slug:'authenticated/'},null),'ERR-INVALID-AUTH');
    conduitFailure(await app.conduit('phriction.info',{slug:'authenticated/'},'writer'),'ERR-INVALID-AUTH');
    const secret='invalid-private-api-secret-do-not-reflect';
    const invalidTransports:RequestInit[]=[
      {headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:'authenticated/',__conduit__:{token:secret}})},
      {headers:{'Content-Type':'application/json',Authorization:`Bearer ${app.tokens.reader.token}`},body:JSON.stringify({slug:'authenticated/',__conduit__:{token:app.tokens.reader.token}})},
    ];
    for(const init of invalidTransports) {
      const response=await app.raw<ConduitEnvelope<unknown>>('/api/phriction.info',{method:'POST',...init}); conduitFailure(response,'ERR-INVALID-AUTH'); assert.equal(JSON.stringify(response.body).includes(secret),false); assert.equal(JSON.stringify(response.body).includes(app.tokens.reader.token),false);
    }
    app.auth.revokeToken(app.alice.id,app.tokens.reader.record.id);
    conduitFailure(await app.conduit('phriction.info',{slug:'authenticated/'}),'ERR-INVALID-AUTH');
    const cookie=await app.login();
    const valid=await app.raw<ConduitEnvelope<LegacyDocument>>('/api/phriction.info',{method:'POST',headers:{...cookie,'Content-Type':'application/json'},body:JSON.stringify({slug:'authenticated/'})}); conduitResult(valid);
    for(const override of [{'X-CSRF-Token':''},{'X-Session-Context':'wrong-context'}]) conduitFailure(await app.raw<ConduitEnvelope<unknown>>('/api/phriction.info',{method:'POST',headers:{...cookie,...override,'Content-Type':'application/json'},body:JSON.stringify({slug:'authenticated/'})}),'ERR-INVALID-AUTH');
    conduitFailure(await app.raw<ConduitEnvelope<unknown>>('/api/phriction.info',{method:'POST',headers:{...cookie,'Content-Type':'application/json'},body:JSON.stringify({slug:'authenticated/',__conduit__:{token:app.tokens.alice.token}})}),'ERR-INVALID-AUTH');
    const outside=await app.raw<unknown>('/api/phriction.info',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example'},body:JSON.stringify({slug:'authenticated/'})}); assert.equal(outside.status,403,'shared origin guards remain native HTTP errors');
  } finally {await app.close();}
});

test('Conduit legacy info/history preserve published selection, immutable dates and current status',async()=>{
  const app=await startWikiApi();
  try {
    await app.document('/');const page=await app.document('article/',{title:'Published heading',content:'Published original',message:'Original description'}),original=app.store.documentVersion(page.id,1);
    await app.operation(page.id,'drafts',{title:'New shared draft heading',content:'Unpublished draft text',message:'Draft description'});
    const info=conduitResult(await app.conduit<LegacyDocument>('phriction.info',{slug:'article/'}));
    assert.deepEqual(Object.keys(info).sort(),['phid','uri','slug','version','authorPHID','title','content','status','description','dateCreated'].sort());
    assert.equal(info.version,1);assert.equal(info.title,page.title);assert.equal(info.content,page.content);assert.equal(info.authorPHID,null);assert.equal(info.description,original.message);assert.equal(info.dateCreated,Math.floor(Date.parse(original.createdAt)/1000));assert.equal(info.status,'exists');assert.match(info.phid,/^PHID-WIKI-/);
    const history=conduitResult(await app.conduit<LegacyDocument[]>('phriction.history',{slug:'article/'}));assert.deepEqual(history.map(item=>item.version),[2,1]);assert.equal(history[0]!.content,'Unpublished draft text');assert.equal(history[0]!.description,'Draft description');assert.ok(history.every(item=>item.phid===info.phid&&item.status==='exists'));
    await app.operation(page.id,'delete');
    const deleted=conduitResult(await app.conduit<LegacyDocument>('phriction.info',{slug:'article/'}));assert.equal(deleted.status,'deleted');assert.equal(deleted.content,'');assert.equal(deleted.version,3);
    const deletedHistory=conduitResult(await app.conduit<LegacyDocument[]>('phriction.history',{slug:'article/'}));assert.ok(deletedHistory.every(item=>item.status==='deleted'));assert.equal(deletedHistory.at(-1)!.dateCreated,info.dateCreated);assert.equal(deletedHistory.at(-1)!.content,page.content);
    await app.operation(page.id,'publish',{targetVersionId:original.id});const republished=conduitResult(await app.conduit<LegacyDocument>('phriction.info',{slug:'article/'}));assert.equal(republished.version,1);assert.equal(republished.content,page.content);assert.equal(republished.status,'deleted');assert.equal(republished.dateCreated,info.dateCreated);
    conduitFailure(await app.conduit('phriction.info',{slug:'missing/'}),'ERR-BAD-DOCUMENT');
    conduitFailure(await app.conduit('phriction.history',{slug:'missing/'}),'ERR-BAD-DOCUMENT');
  } finally {await app.close();}
});

test('Conduit search returns stable object and content identities with opt-in exact content attachments',async()=>{
  const app=await startWikiApi();
  try{
    await app.document('/');const page=await app.document('search/',{title:'Published searchable title',content:'Published searchable body'});
    const draft=await app.operation(page.id,'drafts',{title:'Draft-only-title',content:'Draft-only-body'});
    const result=conduitResult(await app.conduit<SearchResult>('phriction.document.search',{constraints:{paths:['search/']}}));
    assert.deepEqual(result.maps,{});assert.deepEqual(result.query,{queryKey:null});assert.deepEqual(result.cursor,{limit:100,after:null,before:null,order:null});assert.equal(result.data.length,1);
    const row=result.data[0]!;assert.equal(row.type,'WIKI');assert.ok(Number.isSafeInteger(row.id)&&row.id>0);assert.match(row.phid,/^PHID-WIKI-/);assert.deepEqual(row.fields,{path:'search/',status:{value:'active',name:'Active'}});assert.deepEqual(row.attachments,{});assert.equal(JSON.stringify(result).includes('Draft-only'),false);
    const withContent=conduitResult(await app.conduit<SearchResult>('phriction.document.search',{constraints:{phids:[row.phid]},attachments:{content:true}}));
    assert.deepEqual(withContent.data[0]!.attachments.content,{title:page.title,path:page.slug,authorPHID:null,content:{raw:page.content}});
    const contents=conduitResult(await app.conduit<SearchResult>('phriction.content.search',{constraints:{documentPHIDs:[row.phid]},attachments:{content:true},order:'oldest'}));
    assert.equal(contents.data.length,2);assert.deepEqual(contents.data.map(item=>item.fields.version),[1,2]);assert.ok(contents.data.every(item=>item.type==='WRDS'&&item.fields.documentPHID===row.phid&&/^PHID-WRDS-/.test(item.phid)));
    assert.notEqual(contents.data[0]!.id,contents.data[1]!.id);assert.notEqual(contents.data[0]!.phid,contents.data[1]!.phid);
    for(const item of contents.data){assert.equal(typeof item.fields.dateCreated,'number');assert.equal(item.fields.dateModified,item.fields.dateCreated);assert.equal('policy' in item.fields,false);assert.equal('spacePHID' in item.fields,false);}
    assert.equal(contents.data[1]!.attachments.content?.content.raw,'Draft-only-body');
    await app.operation(page.id,'publish',{targetVersionId:draft.document.publication!.headVersionId});
    const selected=conduitResult(await app.conduit<SearchResult>('phriction.content.search',{constraints:{ids:[contents.data[0]!.id],phids:[contents.data[0]!.phid],versions:[1]},attachments:{content:true}}));assert.deepEqual(selected.data,[contents.data[0]!]);
    for(const alias of ['document','documents','documentPHID']){
      const aliased=conduitResult(await app.conduit<SearchResult>('phriction.content.search',{constraints:{[alias]:[row.phid],version:[1]},attachments:{content:true}}));assert.deepEqual(aliased.data,selected.data);
    }
    conduitFailure(await app.conduit('phriction.content.search',{constraints:{documentPHIDs:[row.phid],document:[row.phid]}}),'ERR-INVALID-PARAMETER');
    const same=conduitResult(await app.conduit<SearchResult>('phriction.document.search',{constraints:{ids:[row.id]}}));assert.equal(same.data[0]!.phid,row.phid);
  }finally{await app.close();}
});

test('Conduit empty query keys remain unconstrained and the created order alias retains its original wire value',async()=>{
  const app=await startWikiApi();
  try{
    await app.document('/');const page=await app.document('alias/');await app.operation(page.id,'delete');
    for(const method of ['phriction.document.search','phriction.content.search']){
      const absent=conduitResult(await app.conduit<SearchResult>(method,{limit:2}));
      const empty=conduitResult(await app.conduit<SearchResult>(method,{queryKey:'',limit:2}));assert.deepEqual(empty.data,absent.data);assert.deepEqual(empty.query,{queryKey:null});assert.equal(empty.cursor.order,null);
      const newest=conduitResult(await app.conduit<SearchResult>(method,{order:'newest',limit:2}));
      const created=conduitResult(await app.conduit<SearchResult>(method,{queryKey:'',order:'created',limit:2}));assert.deepEqual(created.data,newest.data);assert.equal(created.cursor.order,'created');assert.deepEqual(created.query,{queryKey:null});
      const plain=conduitResult(await app.raw<ConduitEnvelope<SearchResult>>(`/api/${method}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({'api.token':app.tokens.reader.token,queryKey:'',order:'created',limit:'2'})}));assert.deepEqual(plain.data,newest.data);assert.equal(plain.cursor.order,'created');assert.deepEqual(plain.query,{queryKey:null});
      if(method==='phriction.document.search')assert.ok(empty.data.some(item=>(item.fields.status as {value:string}).value==='deleted'),'empty queryKey must not select the web Active default');
    }
  }finally{await app.close();}
});

test('Conduit query defaults, supported filters and both cursor directions exclude hidden rows',async()=>{
  const app=await startWikiApi();
  try{
    await app.document('/');const parent=await app.document('group/');const first=await app.document('group/a/');const hidden=await app.document('group/hidden/',{title:'Do not expose private search title'});const last=await app.document('group/z/');
    app.policy(hidden.id,{view:members(app.alice.id)});
    const all=conduitResult(await app.conduit<SearchResult>('phriction.document.search',{constraints:{parentPaths:['group/']},order:'oldest',limit:1},'bob'));assert.equal(all.data[0]!.fields.path,first.slug);assert.ok(all.cursor.after);assert.equal(JSON.stringify(all).includes('hidden'),false);
    const next=conduitResult(await app.conduit<SearchResult>('phriction.document.search',{constraints:{parentPaths:['group/']},order:'oldest',limit:1,after:all.cursor.after},'bob'));assert.equal(next.data[0]!.fields.path,last.slug);assert.ok(next.cursor.before);assert.equal(next.cursor.after,null);
    const previous=conduitResult(await app.conduit<SearchResult>('phriction.document.search',{constraints:{parentPaths:['group/']},order:'oldest',limit:1,before:next.cursor.before},'bob'));assert.deepEqual(previous.data,all.data);
    await app.operation(last.id,'delete');
    const unfiltered=conduitResult(await app.conduit<SearchResult>('phriction.document.search',{constraints:{parentPaths:['group/']}},'bob'));assert.equal(unfiltered.data.length,2);
    const active=conduitResult(await app.conduit<SearchResult>('phriction.document.search',{queryKey:'active',constraints:{parentPaths:['group/']}},'bob'));assert.equal(active.data.length,1);assert.equal(active.data[0]!.fields.path,first.slug);
    const override=conduitResult(await app.conduit<SearchResult>('phriction.document.search',{queryKey:'active',constraints:{parentPaths:['group/'],statuses:['deleted']}},'bob'));assert.equal(override.data.length,1);assert.equal(override.data[0]!.fields.path,last.slug);
    app.policy(parent.id,{view:members(app.alice.id)});
    const retired=await app.conduit('phriction.document.search',{constraints:{parentPaths:['group/']},order:'oldest',limit:1,after:all.cursor.after},'bob');conduitFailure(retired);assert.equal(JSON.stringify(retired.body).includes('private search title'),false);
    assert.deepEqual(conduitResult(await app.conduit<SearchResult>('phriction.document.search',{constraints:{ancestorPaths:['group/']}},'bob')).data,[]);
    assert.deepEqual(conduitResult(await app.conduit<SearchResult>('phriction.content.search',{attachments:{content:true}},'bob')).data.filter(item=>item.attachments.content?.path.startsWith('group/')),[]);
    conduitFailure(await app.conduit('phriction.info',{slug:first.slug},'bob'),'ERR-BAD-DOCUMENT');conduitFailure(await app.conduit('phriction.history',{slug:first.slug},'bob'),'ERR-BAD-DOCUMENT');
    app.policy(parent.id,{view:workspace});const current=conduitResult(await app.conduit<SearchResult>('phriction.document.search',{constraints:{paths:[first.slug]}},'bob'));assert.equal(current.data.length,1);
    const space=app.policies.getSpace('S1',app.alice.id);app.policies.updateSpace(space.id,{expectedVersion:space.version,view:members(app.alice.id)},app.alice.id);
    assert.deepEqual(conduitResult(await app.conduit<SearchResult>('phriction.document.search',{},'bob')).data,[]);conduitFailure(await app.conduit('phriction.info',{slug:first.slug},'bob'),'ERR-BAD-DOCUMENT');
  }finally{await app.close();}
});

test('Conduit rejects read-token writes, unsupported methods, constraints, malformed shapes and out-of-range limits explicitly',async()=>{
  const app=await startWikiApi();
  try{
    await app.document('/');
    for(const method of ['phriction.create','phriction.edit']) conduitFailure(await app.conduit(method,{slug:'/',title:'Do not mutate',content:'No write'}),'ERR-INVALID-AUTH');
    conduitFailure(await app.conduit('phriction.nonexistent',{slug:'/',title:'Do not mutate',content:'No write'}),'ERR-UNKNOWN-METHOD');
    for(const input of [{limit:0},{limit:101},{limit:1.5},{queryKey:'invented'},{order:'hierarchy'},{order:['id']},{constraints:{projects:['PHID-PROJ-unknown']}},{constraints:{subscribers:[]}},{constraints:{spaces:[]}},{constraints:{unknown:'do-not-reflect'}},{attachments:{projects:true}},{constraints:[]},{attachments:[]},{unrecognized:'secret-parameter-value'}]){
      const response=await app.conduit('phriction.document.search',input);conduitFailure(response,'ERR-INVALID-PARAMETER');assert.equal(JSON.stringify(response.body).includes('secret-parameter-value'),false);assert.equal(JSON.stringify(response.body).includes('do-not-reflect'),false);
    }
    const malformed=await app.raw<ConduitEnvelope<unknown>>('/api/phriction.info',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({params:'{"__conduit__":{"token":"secret-invalid-json"}'})});conduitFailure(malformed);assert.equal(JSON.stringify(malformed.body).includes('secret-invalid-json'),false);
    const unknownAuth=await app.raw<ConduitEnvelope<unknown>>('/api/phriction.info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:'/',__conduit__:{token:app.tokens.reader.token,authUser:'private-user-marker'}})});conduitFailure(unknownAuth);assert.equal(JSON.stringify(unknownAuth.body).includes('private-user-marker'),false);
    const ordinary=conduitResult(await app.conduit<LegacyDocument>('phriction.info',{slug:'/'}));assert.notEqual(ordinary.title,'Do not mutate');
  }finally{await app.close();}
});

test('Conduit rejects ambiguous encodings, secret-bearing URL parameters and oversized or malformed byte bodies',async()=>{
  const app=await startWikiApi();
  try{
    await app.document('/');const secret='never-reflect-private-parser-input';
    const forms=[
      new URLSearchParams([['api.token',app.tokens.reader.token],['api.token',secret],['slug','/']]),
      new URLSearchParams({params:JSON.stringify({slug:'/',__conduit__:{token:app.tokens.reader.token}}),slug:secret}),
      new URLSearchParams({'api.token':app.tokens.reader.token,'constraints[paths]':'/','constraints[paths][0]':secret}),
      new URLSearchParams([['api.token',app.tokens.reader.token],['constraints[paths][0]','/'],['constraints[paths][0]',secret]]),
      new URLSearchParams({'api.token':app.tokens.reader.token,'constraints[paths][]':'/','constraints[paths][1]':secret}),
      new URLSearchParams({'api.token':app.tokens.reader.token,output:'human',slug:'/'}),
    ];
    for(const body of forms){const response=await app.raw<ConduitEnvelope<unknown>>('/api/phriction.document.search',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});conduitFailure(response,'ERR-INVALID-PARAMETER');assert.equal(JSON.stringify(response.body).includes(secret),false);assert.equal(JSON.stringify(response.body).includes(app.tokens.reader.token),false);}
    const query=await app.raw<ConduitEnvelope<unknown>>(`/api/phriction.info?api.token=${secret}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:'/'})});conduitFailure(query,'ERR-INVALID-PARAMETER');assert.equal(JSON.stringify(query.body).includes(secret),false);
    const badUTF8=await app.raw<ConduitEnvelope<unknown>>('/api/phriction.info',{method:'POST',headers:{'Content-Type':'application/json'},body:new Uint8Array([0xff]).buffer});conduitFailure(badUTF8,'ERR-INVALID-PARAMETER');
    const tooLarge=await app.raw<ConduitEnvelope<unknown>>('/api/phriction.info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:secret+'x'.repeat(2_000_000)})});conduitFailure(tooLarge,'ERR-INVALID-PARAMETER');assert.equal(JSON.stringify(tooLarge.body).includes(secret),false);
    const get=await app.raw<ConduitEnvelope<unknown>>('/api/phriction.info',{headers:{Authorization:`Bearer ${app.tokens.reader.token}`}});conduitFailure(get,'ERR-INVALID-PARAMETER');
  }finally{await app.close();}
});

test('Conduit legacy history is complete within its row ceiling and never silently truncates excess history',async()=>{
  const app=await startWikiApi();
  try{
    await app.document('/');let page=await app.document('long-history/');
    for(let version=2;version<=1000;version++)page=app.store.updateDocument(page.id,{title:page.title,slug:page.slug,content:`Version ${version}`,expectedVersion:page.version});
    const full=conduitResult(await app.conduit<LegacyDocument[]>('phriction.history',{slug:page.slug}));assert.equal(full.length,1000);assert.equal(full[0]!.version,1000);assert.equal(full.at(-1)!.version,1);
    app.store.updateDocument(page.id,{title:page.title,slug:page.slug,content:'Version 1001',expectedVersion:page.version});
    const tooLarge=await app.conduit('phriction.history',{slug:page.slug});conduitFailure(tooLarge,'ERR-RESPONSE-TOO-LARGE');assert.match(tooLarge.body.error_info!,/phriction\.content\.search/);
    const search=conduitResult(await app.conduit<SearchResult>('phriction.content.search',{limit:10}));assert.equal(search.data.length,10);assert.ok(search.cursor.after);
  }finally{await app.close();}
});

test('Conduit legacy history also bounds serialized response bytes independently from the row ceiling',async()=>{
  const app=await startWikiApi();
  try{
    await app.document('/');let page=await app.document('large-history/');
    // JSON escapes these permitted control characters to six bytes apiece.
    // Eight snapshots exceed 16 MiB on the wire while source stays below 4 MiB.
    const content='\u0001'.repeat(450_000);
    for(let version=2;version<=9;version++)page=app.store.updateDocument(page.id,{title:page.title,slug:page.slug,content,expectedVersion:page.version});
    const response=await app.conduit('phriction.history',{slug:page.slug});conduitFailure(response,'ERR-RESPONSE-TOO-LARGE');assert.equal(response.body.result,null);
    const search=conduitResult(await app.conduit<SearchResult>('phriction.content.search',{limit:1}));assert.equal(search.data.length,1);assert.deepEqual(search.data[0]!.attachments,{});
  }finally{await app.close();}
});
