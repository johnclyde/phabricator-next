import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { GIT_LIMITS } from '../shared/repositories.ts';
import type { GitComparisonFileQuery, GitComparisonQuery } from '../shared/repositories.ts';
import { createGitFixture, createGitComparisonFixture } from '../tests/git-fixture.ts';
import type { GitFixture } from '../tests/git-fixture.ts';
import { createGitObserver } from './git.ts';
import { HttpError } from './validation.ts';

const hasCode=(code:string)=>(error:unknown)=>error instanceof HttpError&&error.code===code;
async function fixtureTest(work:(fixture:GitFixture)=>Promise<void>,format:'sha1'|'sha256'='sha1') {
  const fixture=await createGitFixture(format);try{await work(fixture);}finally{await fixture.close();}
}
async function commitRecords(fixture:GitFixture,records:string[]):Promise<string>{
  const tree=(await fixture.git(['mktree','-z'],records.join(''))).trim();
  return (await fixture.git(['commit-tree',tree],'Exact comparison boundary\n')).trim();
}
const blob=async(fixture:GitFixture,content:string|Buffer)=>(await fixture.git(['hash-object','-w','--stdin'],content)).trim();

for(const format of ['sha1','sha256']as const)test(`exact ${format} comparisons preserve changed-content rename, copy, modes and type changes`,async()=>fixtureTest(async fixture=>{
  const pair=await createGitComparisonFixture(fixture),observer=createGitObserver({R1:fixture.barePath});
  const result=await observer.compare('R1',pair);
  assert.equal(result.baseCommit?.id,pair.base);assert.equal(result.targetCommit.id,pair.target);assert.equal(result.algorithm,'git-M50-C50');
  assert.equal(result.baseTreeId,result.baseCommit?.treeId);assert.equal(result.targetTreeId,result.targetCommit.treeId);
  const renamed=result.changes.find(change=>change.after?.path==='rename-after.txt')!;
  assert.equal(renamed.status,'renamed');assert.equal(renamed.before?.path,'rename-before.txt');assert.ok(renamed.similarity!>=50&&renamed.similarity!<100);
  const copied=result.changes.find(change=>change.after?.path==='copy-result.txt')!;
  assert.equal(copied.status,'copied');assert.equal(copied.similarity,100);assert.equal(copied.before?.path,'copy-source.txt');
  const mode=result.changes.find(change=>change.after?.path==='executable.sh')!;
  assert.equal(mode.status,'modified');assert.equal(mode.before?.objectId,mode.after?.objectId);assert.equal(mode.before?.mode,'100644');assert.equal(mode.after?.mode,'100755');
  const types=result.changes.filter(change=>change.status==='type_changed');assert.deepEqual(types.map(change=>change.after!.path),['to-directory','type-change']);
  assert.equal(types[0]?.before?.type,'file');assert.equal(types[0]?.after?.type,'tree');assert.equal(types[1]?.after?.type,'symlink');
  assert.ok(result.changes.some(change=>change.after?.path==='to-directory/child.txt'));
  assert.equal(result.changes.find(change=>change.before?.path==='deleted.txt')?.status,'deleted');
  assert.equal(new Set(result.changes.map(change=>change.id)).size,result.changes.length);
  assert.ok(result.changes.every(change=>/^[a-f0-9]{64}$/.test(change.id)));
  await fixture.advanceMain();assert.deepEqual(await observer.compare('R1',pair),result);
  const file=await observer.compareFile('R1',{...pair,beforePath:'rename-before.txt',afterPath:'rename-after.txt'});
  assert.deepEqual(file.change,renamed);assert.equal(file.before?.state,'text');assert.equal(file.after?.state,'text');
  assert.equal(file.before?.commitId,pair.base);assert.equal(file.after?.commitId,pair.target);
  if(file.before?.state==='text'&&file.after?.state==='text'){assert.match(file.before.content,/Line 20:/);assert.match(file.after.content,/Updated 20:/);}
},format));

test('selected comparison sides preserve absent, empty, binary, invalid encoding, oversized, tree, symlink and submodule states',async()=>fixtureTest(async fixture=>{
  const pair=await createGitComparisonFixture(fixture),observer=createGitObserver({R1:fixture.barePath});
  for(const [path,state]of [['binary.dat','binary'],['invalid.txt','unsupported_encoding'],['oversized.txt','oversized'],['module','submodule']]as const){
    const result=await observer.compareFile('R1',{...pair,beforePath:null,afterPath:path});assert.equal(result.before,null);assert.equal(result.after?.state,state);assert.equal(Object.hasOwn(result.after!,'content'),false);
  }
  const empty=await observer.compareFile('R1',{...pair,beforePath:'empty.txt',afterPath:'empty-added.txt'});
  assert.equal(empty.before?.state,'text');assert.equal(empty.after?.state,'text');if(empty.after?.state==='text')assert.equal(empty.after.content,'');
  const deleted=await observer.compareFile('R1',{...pair,beforePath:'deleted.txt',afterPath:null});assert.equal(deleted.after,null);assert.equal(deleted.before?.state,'text');
  const tree=await observer.compareFile('R1',{...pair,beforePath:'to-directory',afterPath:'to-directory'});assert.equal(tree.after?.state,'tree');
  const symlink=await observer.compareFile('R1',{...pair,beforePath:'type-change',afterPath:'type-change'});assert.equal(symlink.after?.state,'symlink');assert.equal(Object.hasOwn(symlink.after!,'content'),false);
  const path=':(literal) unicode 研究\tname.txt',literal=await observer.compareFile('R1',{...pair,beforePath:null,afterPath:path});
  assert.equal(literal.after?.path,path);if(literal.after?.state==='text')assert.equal(literal.after.content,'\ufeffLiteral exact source.\r\n');else assert.fail('literal UTF-8 source required');
}));

for(const format of ['sha1','sha256']as const)test(`empty, same, reverse, unrelated and explicit merge-parent ${format} pairs are immutable tree comparisons`,async()=>fixtureTest(async fixture=>{
  const observer=createGitObserver({R1:fixture.barePath});
  const objectsBefore=(await readdir(join(fixture.barePath,'objects'),{recursive:true})).sort();
  // No empty-tree object is required for a root comparison.
  const emptyHash=createHash(format).update('tree 0\0').digest('hex');await rm(join(fixture.barePath,'objects',emptyHash.slice(0,2),emptyHash.slice(2)),{force:true});
  const root=await observer.compare('R1',{base:null,target:fixture.base});assert.equal(root.baseCommit,null);assert.equal(root.baseTreeId,emptyHash);assert.equal(root.changes.length,1);assert.equal(root.changes[0]?.status,'added');
  const all=await observer.compare('R1',{base:null,target:fixture.head});assert.ok(all.changes.every(change=>change.before===null&&change.status==='added'));
  const objectsAfter=(await readdir(join(fixture.barePath,'objects'),{recursive:true})).sort();assert.deepEqual(objectsAfter,objectsBefore.filter(path=>path!==`${emptyHash.slice(0,2)}/${emptyHash.slice(2)}`));
  assert.deepEqual((await observer.compare('R1',{base:fixture.head,target:fixture.head})).changes,[]);
  assert.deepEqual((await observer.compare('R1',{base:fixture.importCommit,target:fixture.importEqualCommit})).changes,[]);
  const reverse=await observer.compare('R1',{base:fixture.head,target:fixture.base});assert.ok(reverse.changes.some(change=>change.status==='deleted'&&change.before?.path==='binary.dat'));
  const merge=(await observer.commit('R1',fixture.head)).commit;
  assert.deepEqual((await observer.compare('R1',{base:merge.parentIds[0]!,target:fixture.head})).changes,[]);
  assert.ok((await observer.compare('R1',{base:merge.parentIds[1]!,target:fixture.head})).changes.length>0);
  const pair=await createGitComparisonFixture(fixture);assert.ok((await observer.compare('R1',{base:fixture.base,target:pair.target})).changes.length>0);
},format));

test('empty subtrees remain explicit metadata and unchanged subtrees need not be traversed',async()=>fixtureTest(async fixture=>{
  const observer=createGitObserver({R1:fixture.barePath});
  const empty=(await fixture.git(['mktree','-z'],'')).trim();
  const target=await commitRecords(fixture,[`040000 tree ${empty}\tempty-directory\0`]);
  const result=await observer.compare('R1',{base:fixture.base,target});assert.equal(result.changes.find(change=>change.after?.path==='empty-directory')?.after?.type,'tree');
  const side=await observer.compareFile('R1',{base:fixture.base,target,beforePath:null,afterPath:'empty-directory'});assert.equal(side.after?.state,'tree');
  const largeTree=(await fixture.git(['mktree','-z'],Array.from({length:1001},(_,index)=>`100644 blob ${fixture.readmeBlob}\tf${index}\0`).join(''))).trim();
  const before=await commitRecords(fixture,[`040000 tree ${largeTree}\tunchanged\0`]);
  const after=await commitRecords(fixture,[`040000 tree ${largeTree}\tunchanged\0`,`100644 blob ${fixture.readmeBlob}\tadded\0`]);
  const skipped=await observer.compare('R1',{base:before,target:after});assert.deepEqual(skipped.changes.map(change=>change.after?.path),['added']);
}));

test('invalid selectors and invented before/after pairings cannot be presented as a comparison',async()=>fixtureTest(async fixture=>{
  const observer=createGitObserver({R1:fixture.barePath}),pair=await createGitComparisonFixture(fixture);
  for(const query of [null,{}, {base:'HEAD',target:pair.target},{base:null,target:'main'},{base:pair.base.slice(0,8),target:pair.target},{base:42,target:pair.target},{base:null,target:{toString:()=>pair.target}}])await assert.rejects(observer.compare('R1',query as GitComparisonQuery),hasCode('GIT_INVALID_QUERY'));
  for(const paths of [{beforePath:'../bad',afterPath:'rename-after.txt'},{beforePath:null,afterPath:null},{beforePath:42,afterPath:'rename-after.txt'},{afterPath:'rename-after.txt'}])await assert.rejects(observer.compareFile('R1',{...pair,...paths}as GitComparisonFileQuery),hasCode('GIT_INVALID_QUERY'));
  for(const paths of [{beforePath:'copy-source.txt',afterPath:'rename-after.txt'},{beforePath:null,afterPath:'rename-after.txt'},{beforePath:'rename-before.txt',afterPath:'copy-result.txt'}])await assert.rejects(observer.compareFile('R1',{...pair,...paths}),hasCode('GIT_OBJECT_UNAVAILABLE'));
  await assert.rejects(observer.compare('R1',{base:fixture.readmeBlob,target:pair.target}),hasCode('GIT_OBJECT_UNAVAILABLE'));
  const controller=new AbortController();controller.abort();await assert.rejects(observer.compare('R1',pair,controller.signal),hasCode('GIT_ABORTED'));
}));

test('comparison limits reject whole inventories for blob, aggregate source, entry and matching work bounds',async()=>fixtureTest(async fixture=>{
  const observer=createGitObserver({R1:fixture.barePath});
  const huge=await blob(fixture,Buffer.alloc(GIT_LIMITS.comparisonBlobBytes+1,65));
  let target=await commitRecords(fixture,[`100644 blob ${huge}\thuge\0`]);await assert.rejects(observer.compare('R1',{base:null,target}),hasCode('GIT_LIMIT_EXCEEDED'));
  const large=await blob(fixture,Buffer.alloc(GIT_LIMITS.comparisonBlobBytes,65));
  target=await commitRecords(fixture,[`100644 blob ${large}\tadmitted-large\0`]);assert.equal((await observer.compare('R1',{base:null,target})).changes[0]?.after?.size,GIT_LIMITS.comparisonBlobBytes);
  target=await commitRecords(fixture,Array.from({length:9},(_,index)=>`100644 blob ${large}\tf${index}\0`));await assert.rejects(observer.compare('R1',{base:null,target}),hasCode('GIT_LIMIT_EXCEEDED'));
  target=await commitRecords(fixture,Array.from({length:1001},(_,index)=>`100644 blob ${fixture.readmeBlob}\tf${index}\0`));await assert.rejects(observer.compare('R1',{base:null,target}),hasCode('GIT_LIMIT_EXCEEDED'));
  const old=await blob(fixture,'source\n'),next=await blob(fixture,'different\n');
  const base=await commitRecords(fixture,Array.from({length:501},(_,index)=>`100644 blob ${old}\tf${index}\0`));
  target=await commitRecords(fixture,Array.from({length:501},(_,index)=>`120000 blob ${next}\tf${index}\0`));
  // All other bounds admit these 501 paths, but the conservative candidate
  // preflight rejects the 501×501 source/destination matching work.
  await assert.rejects(observer.compare('R1',{base,target}),hasCode('GIT_LIMIT_EXCEEDED'));
}));

test('hash verification covers renamed and unpreviewable bodies, and repository filters cannot execute',async()=>fixtureTest(async fixture=>{
  const pair=await createGitComparisonFixture(fixture),observer=createGitObserver({R1:fixture.barePath});
  const inventory=await observer.compare('R1',pair),id=inventory.changes.find(change=>change.after?.path==='oversized.txt')!.after!.objectId;
  const path=join(fixture.barePath,'objects',id.slice(0,2),id.slice(2)),original=await readFile(path),data=Buffer.from('tampered');
  await chmod(path,0o600);await writeFile(path,deflateSync(Buffer.concat([Buffer.from(`blob ${data.length}\0`),data])));
  await assert.rejects(observer.compare('R1',pair),hasCode('GIT_INVALID_OBJECT'));await writeFile(path,original);
  const config=join(fixture.barePath,'config'),settings=await readFile(config),marker=join(fixture.root,'must-not-run');
  await writeFile(config,Buffer.concat([settings,Buffer.from(`\n[diff "custom"]\n textconv = touch ${marker}\n command = touch ${marker}\n`)]));
  await assert.rejects(observer.compare('R1',pair),hasCode('GIT_UNAVAILABLE'));await assert.rejects(readFile(marker),{code:'ENOENT'});
}));


test('combined traversal work is bounded even when each directory and changed inventory are individually small',async()=>fixtureTest(async fixture=>{
  const observer=createGitObserver({R1:fixture.barePath});
  const subtree=async(content:string)=>(await fixture.git(['mktree','-z'],`100644 blob ${await blob(fixture,content)}\tchild\0`)).trim();
  const common=Array.from({length:999},(_,index)=>`100644 blob ${fixture.readmeBlob}\tcommon${index}\0`);
  const base=await commitRecords(fixture,[...common,`040000 tree ${await subtree('before')}\tnested\0`]);
  const target=await commitRecords(fixture,[...common,`040000 tree ${await subtree('after')}\tnested\0`]);
  await assert.rejects(observer.compare('R1',{base,target}),hasCode('GIT_LIMIT_EXCEEDED'));
}));

test('exact binary, symlink and gitlink renames preserve their modes and never follow targets',async()=>fixtureTest(async fixture=>{
  const observer=createGitObserver({R1:fixture.barePath}),binary=await blob(fixture,Buffer.from([0,5,6])),link=await blob(fixture,'../../outside-secret');
  const records=[`100644 blob ${binary}\told-binary\0`,`120000 blob ${link}\told-link\0`,`160000 commit ${fixture.base}\told-module\0`];
  const base=await commitRecords(fixture,records),target=await commitRecords(fixture,records.map(record=>record.replace('\told-','\tnew-')));
  const result=await observer.compare('R1',{base,target});assert.equal(result.changes.length,3);assert.ok(result.changes.every(change=>change.status==='renamed'&&change.similarity===100));
  for(const [suffix,state]of [['binary','binary'],['link','symlink'],['module','submodule']]as const){
    const selected=await observer.compareFile('R1',{base,target,beforePath:`old-${suffix}`,afterPath:`new-${suffix}`});
    assert.equal(selected.before?.state,state);assert.equal(selected.after?.state,state);assert.equal(Object.hasOwn(selected.after!,'content'),false);
  }
}));

test('an equal-tree comparison still verifies its root tree instead of accepting a corrupt object',async()=>fixtureTest(async fixture=>{
  const observer=createGitObserver({R1:fixture.barePath}),tree=(await observer.commit('R1',fixture.base)).commit.treeId;
  const path=join(fixture.barePath,'objects',tree.slice(0,2),tree.slice(2));await chmod(path,0o600);await writeFile(path,deflateSync(Buffer.from('tree 0\0')));
  await assert.rejects(observer.compare('R1',{base:fixture.base,target:fixture.base}),hasCode('GIT_INVALID_OBJECT'));
}));
