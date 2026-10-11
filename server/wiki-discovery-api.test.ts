import test from 'node:test';
import assert from 'node:assert/strict';
import { WIKI_SEARCH_SNIPPET_LENGTH, type WikiDocumentSearchPage } from '../shared/wiki-search.ts';
import { members, startWikiApi, workspace } from './wiki-api-test-support.ts';

test('native discovery defaults to active published documents with bounded snippets and opt-in source',async()=>{
  const app=await startWikiApi();
  try{
    await app.document('/');const page=await app.document('published/',{title:'Visible published heading',content:'Published content '+ 'x'.repeat(500)});
    await app.operation(page.id,'drafts',{title:'Unpublished draft heading',content:'Unpublished draft body'});
    const inactive=await app.document('deleted/');await app.operation(inactive.id,'delete');
    const result=await app.request<WikiDocumentSearchPage>('/api/documents');assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(typeof result.body.accessEpoch,'number');assert.match(result.headers.get('Cache-Control')??'',/no-store/);
    assert.equal(result.body.documents.some(item=>item.id===inactive.id),false);const found=result.body.documents.find(item=>item.id===page.id)!;assert.ok(found);assert.equal(found.title,page.title);assert.equal(found.version,2);assert.equal(found.published.version,1);assert.equal(found.published.content,undefined);assert.ok(found.published.snippet.length<=WIKI_SEARCH_SNIPPET_LENGTH+2);assert.equal(JSON.stringify(result.body).includes('Unpublished'),false);
    const exact=await app.request<WikiDocumentSearchPage>('/api/documents?paths=published%2F&includeContent=true');assert.equal(exact.status,200);assert.equal(exact.body.documents.length,1);assert.equal(exact.body.documents[0]!.published.content,page.content);
    const absent=await app.request<WikiDocumentSearchPage>('/api/documents?query=Unpublished');assert.equal(absent.status,200);assert.deepEqual(absent.body.documents,[]);
    const all=await app.request<WikiDocumentSearchPage>('/api/documents?queryKey=all');assert.equal(all.status,200);assert.ok(all.body.documents.some(item=>item.id===inactive.id));
  }finally{await app.close();}
});

test('native discovery supports repeated filters, parent/ancestor alternatives and literal published queries',async()=>{
  const app=await startWikiApi();
  try{
    await app.document('/');const branch=await app.document('branch/');const child=await app.document('branch/child/',{title:'100% literal _ wildcard',content:'Punctuation [x] is literal'});const deep=await app.document('branch/child/deep/');const other=await app.document('other/');const leaf=await app.document('other/leaf/');
    const get=async(query:string)=>{const response=await app.request<WikiDocumentSearchPage>(`/api/documents?${query}`);assert.equal(response.status,200,JSON.stringify(response.body));return response.body.documents.map(item=>item.id).sort();};
    assert.deepEqual(await get('parentPaths=branch%2F'),[child.id]);
    assert.deepEqual(await get('ancestorPaths=branch%2F'),[child.id,deep.id].sort());
    assert.deepEqual(await get('parentPaths=branch%2F&ancestorPaths=other%2F'),[child.id,leaf.id].sort());
    assert.deepEqual(await get('paths=branch%2F&paths=other%2F'),[branch.id,other.id].sort());
    assert.deepEqual(await get('parentPaths=branch%2F&ancestorPaths=other%2F&paths=other%2Fleaf%2F'),[leaf.id]);
    assert.deepEqual(await get('query=%25'),[child.id]);assert.deepEqual(await get('query=%5Bx%5D'),[child.id]);
    await app.operation(child.id,'delete');
    assert.deepEqual(await get('queryKey=active&statuses=deleted&statuses=active&paths=branch%2Fchild%2F&paths=other%2F'),[child.id,other.id].sort());
  }finally{await app.close();}
});

test('native discovery cursors preserve both directions and reject changed filters, corruption or retired authority',async()=>{
  const app=await startWikiApi();
  try{
    await app.document('/');await app.document('paging/');const first=await app.document('paging/one/');const hidden=await app.document('paging/private/',{title:'Secret hidden cursor title'});const second=await app.document('paging/two/');const third=await app.document('paging/three/');app.policy(hidden.id,{view:members(app.alice.id)});
    const prefix='/api/documents?parentPaths=paging%2F&limit=1&order=oldest';
    const one=await app.request<WikiDocumentSearchPage>(prefix,'GET',undefined,'bob');assert.equal(one.status,200);assert.equal(one.body.documents[0]!.id,first.id);assert.ok(one.body.nextAfter);assert.equal(JSON.stringify(one.body).includes('Secret hidden'),false);
    const two=await app.request<WikiDocumentSearchPage>(`${prefix}&after=${encodeURIComponent(one.body.nextAfter!)}`,'GET',undefined,'bob');assert.equal(two.status,200);assert.equal(two.body.documents[0]!.id,second.id);assert.ok(two.body.nextBefore);assert.ok(two.body.nextAfter);
    const back=await app.request<WikiDocumentSearchPage>(`${prefix}&before=${encodeURIComponent(two.body.nextBefore!)}`,'GET',undefined,'bob');assert.equal(back.status,200);assert.deepEqual(back.body.documents,one.body.documents);
    const three=await app.request<WikiDocumentSearchPage>(`${prefix}&after=${encodeURIComponent(two.body.nextAfter!)}`,'GET',undefined,'bob');assert.equal(three.status,200);assert.equal(three.body.documents[0]!.id,third.id);assert.equal(three.body.nextAfter,null);
    for(const changed of [`${prefix}&query=different&after=${encodeURIComponent(one.body.nextAfter!)}`,`${prefix}&after=malformed-cursor`,`${prefix}&after=${encodeURIComponent(one.body.nextAfter!.slice(0,-1)+'!')}`]){const response=await app.request<{error:string}>(changed,'GET',undefined,'bob');assert.ok([400,409].includes(response.status),JSON.stringify(response.body));}
    app.policy(second.id,{view:members(app.alice.id)});
    const stale=await app.request<{error:string}>(`${prefix}&after=${encodeURIComponent(one.body.nextAfter!)}`,'GET',undefined,'bob');assert.ok([400,409].includes(stale.status));assert.equal(JSON.stringify(stale.body).includes('Secret hidden'),false);
    const refreshed=await app.request<WikiDocumentSearchPage>('/api/documents?parentPaths=paging%2F&order=oldest','GET',undefined,'bob');assert.equal(refreshed.status,200);assert.deepEqual(refreshed.body.documents.map(item=>item.id),[first.id,third.id]);assert.ok(refreshed.body.accessEpoch!>one.body.accessEpoch!);
  }finally{await app.close();}
});

test('native discovery hides every descendant of invisible active, moved or deleted ancestors and observes Space ceilings',async()=>{
  const app=await startWikiApi();
  try{
    const root=await app.document('/'),parent=await app.document('protected/'),child=await app.document('protected/child/',{title:'Protected child title',content:'Protected published source'});
    for(const status of ['active','deleted','moved'] as const){
      if(status==='deleted')await app.operation(parent.id,'delete');
      if(status==='moved'){
        const pins=await app.pins(parent.id);const restored=await app.request(`/api/documents/${parent.id}/restore`,'POST',{...pins,version:1},'alice','discovery-restore');assert.equal(restored.status,200);await app.move(parent.id,'destination/');
      }
      app.policy(parent.id,{view:members(app.alice.id)});
      const response=await app.request<WikiDocumentSearchPage>('/api/documents?queryKey=all&includeContent=true','GET',undefined,'bob');assert.equal(response.status,200);assert.equal(response.body.documents.some(item=>item.id===child.id),false);assert.equal(JSON.stringify(response.body).includes('Protected child title'),false);assert.equal(JSON.stringify(response.body).includes('Protected published source'),false);
      app.policy(parent.id,{view:workspace});
    }
    app.policy(root.id,{view:members(app.alice.id)});
    const hiddenRoot=await app.request<WikiDocumentSearchPage>('/api/documents?queryKey=all','GET',undefined,'bob');assert.deepEqual(hiddenRoot.body.documents,[]);
    app.policy(root.id,{view:workspace});const space=app.policies.getSpace('S1',app.alice.id);app.policies.updateSpace(space.id,{expectedVersion:space.version,view:members(app.alice.id)},app.alice.id);
    const hiddenSpace=await app.request<WikiDocumentSearchPage>('/api/documents?queryKey=all','GET',undefined,'bob');assert.deepEqual(hiddenSpace.body.documents,[]);
  }finally{await app.close();}
});

test('native discovery validates filters and requires current read scope',async()=>{
  const app=await startWikiApi();
  try{
    await app.document('/');assert.equal((await app.request('/api/documents','GET',undefined,null)).status,401);assert.equal((await app.request('/api/documents','GET',undefined,'writer')).status,403);assert.equal((await app.request('/api/documents','GET',undefined,'reader')).status,200);
    for(const query of ['limit=0','limit=101','limit=1.2','order=hierarchy','queryKey=unknown','statuses=missing','includeContent=maybe','unknown=private-parameter','after=one&before=two','ids=not-a-number'])assert.equal((await app.request(`/api/documents?${query}`)).status,400,query);
    const tooMany=new URLSearchParams();for(let i=0;i<101;i++)tooMany.append('paths',`path-${i}/`);assert.equal((await app.request(`/api/documents?${tooMany}`)).status,400);
    app.auth.revokeToken(app.alice.id,app.tokens.reader.record.id);assert.equal((await app.request('/api/documents','GET',undefined,'reader')).status,401);
  }finally{await app.close();}
});
