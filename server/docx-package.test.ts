import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fromBufferPromise } from 'yauzl';
import { ZipFile } from 'yazl';
import { inspectDocx, replaceDocx } from './docx-package.ts';
import type { DocxProjection, DocxReplacement } from '../shared/docx.ts';
import { DOCX_LIMITS } from '../shared/docx.ts';

const fixture = () => readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url));
const who = { author: 'Workspace Reviewer', date: '2026-01-02T03:04:05.000Z' };
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function entries(bytes: Uint8Array): Promise<Map<string,Buffer>> {
  const zip=await fromBufferPromise(Buffer.from(bytes));const result=new Map<string,Buffer>();
  for await(const entry of zip.eachEntry()){const chunks:Buffer[]=[];for await(const chunk of await zip.openReadStreamPromise(entry))chunks.push(Buffer.from(chunk));result.set(entry.fileName,Buffer.concat(chunks));}return result;
}
async function archive(parts: Map<string,Buffer>, compress=true): Promise<Buffer> {
  const zip=new ZipFile(),chunks:Buffer[]=[];const done=new Promise<Buffer>((resolve,reject)=>{zip.outputStream.on('data',chunk=>chunks.push(Buffer.from(chunk)));zip.outputStream.once('end',()=>resolve(Buffer.concat(chunks)));zip.outputStream.once('error',reject);});
  for(const [name,bytes]of parts)zip.addBuffer(bytes,name,{compress});zip.end();return done;
}
async function modify(transform:(parts:Map<string,Buffer>)=>void):Promise<Buffer>{const parts=await entries(await fixture());transform(parts);return archive(parts);}
function replacement(projection:DocxProjection, text='The original result is clear.'):DocxReplacement {
  const range=projection.editableRanges.find(r=>r.text===text);assert.ok(range,`expected editable range ${text}`);
  return {rangeId:range.id,start:4,end:12,quote:'original',replacement:'revised'};
}

test('DOCX inventories inherited headings, linked notes, imported comments and revisions deterministically',async()=>{
  const bytes=await fixture(),p=await inspectDocx(bytes);assert.deepEqual(await inspectDocx(bytes),p);
  assert.equal(p.blocks.find(b=>b.text==='Findings and evidence')?.headingLevel,1);
  assert.ok(p.notes.find(n=>n.id==='footnote:2')?.blocks.some(b=>b.text.includes('Source note with exact wording.')));
  assert.equal(p.blocks.flatMap(b=>b.runs).find(r=>r.noteId)?.noteId,'footnote:2');
  assert.equal(p.comments[0]?.author,'Imported Reviewer');assert.equal(p.comments[0]?.blocks[0]?.text,'Please preserve this comment.');
  assert.deepEqual(p.blocks.find(b=>b.text==='This passage has a reviewer comment.')?.runs[0]?.commentIds,['7']);
  assert.deepEqual(p.changes.map(c=>[c.kind,c.text,c.author]),[['del','old wording','Imported Reviewer'],['ins','new wording','Imported Reviewer']]);
  assert.equal(p.editableRanges.some(r=>r.text==='old wording'||r.text==='new wording'),false);
  assert.equal(new Set([...p.blocks,...p.notes.flatMap(n=>n.blocks),...p.comments.flatMap(c=>c.blocks)].map(b=>b.id)).size,p.blocks.length+p.notes.flatMap(n=>n.blocks).length+p.comments.flatMap(c=>c.blocks).length);
});

test('tracked replacement preserves every other part and lexical bytes outside its source run',async()=>{
  const bytes=await fixture(),p=await inspectDocx(bytes),change=replacement(p),result=await replaceDocx(bytes,change,who);
  const before=await entries(bytes),after=await entries(result.bytes);assert.deepEqual([...after.keys()],[...before.keys()]);
  for(const [name,data]of before)if(name!==p.mainPart)assert.deepEqual(after.get(name),data,`unchanged ${name}`);
  const span=JSON.parse(change.rangeId) as [string,string,number,number];const oldXml=before.get(p.mainPart)!.toString(),newXml=after.get(p.mainPart)!.toString();
  assert.ok(newXml.startsWith(oldXml.slice(0,span[2])));assert.ok(newXml.endsWith(oldXml.slice(span[3])));
  assert.ok(newXml.includes('<!-- lexical sentinel remains exactly here -->'));
  assert.equal(result.projection.changes.filter(c=>c.author===who.author).length,2);
  assert.deepEqual(result.projection.changes.filter(c=>c.author===who.author).map(c=>[c.kind,c.text]),[['del','original'],['ins','revised']]);
  assert.deepEqual(result.projection.notes,p.notes);assert.deepEqual(result.projection.comments,p.comments);
  assert.equal(result.projection.blocks.find(b=>b.headingLevel)?.headingLevel,1);
  assert.equal(result.projection.blocks.find(b=>b.text.includes('originalrevised'))?.runs.filter(r=>r.change!=='deleted').map(r=>r.text).join(''),'The revised result is clear.');
  assert.deepEqual(await inspectDocx(result.bytes),result.projection);
});

test('no-op and bounded deletion preserve original identities; quote, offsets, attribution and markup are checked',async()=>{
  const bytes=await fixture(),p=await inspectDocx(bytes),change=replacement(p);
  const noop=await replaceDocx(bytes,{...change,replacement:'original'},who);assert.deepEqual(Buffer.from(noop.bytes),bytes);assert.deepEqual(noop.projection,p);
  const deleted=await replaceDocx(bytes,{...change,replacement:''},who);assert.deepEqual(deleted.projection.changes.filter(c=>c.author===who.author).map(c=>c.kind),['del']);
  for(const invalid of [{...change,quote:'different'},{...change,start:-1},{...change,end:1000},{...change,replacement:'line\nbreak'},{...change,replacement:'\ud800'},{...change,rangeId:'forged'}])await assert.rejects(replaceDocx(bytes,invalid,who),{status:422});
  await assert.rejects(replaceDocx(bytes,change,{author:'',date:who.date}),{status:422});
});

test('namespace prefixes, Strict namespaces, UTF-16 and XML character escaping survive edited roundtrips',async()=>{
  for(const encoding of ['utf16le','utf16be'] as const){
    const bytes=await modify(parts=>{for(const [name,data]of parts)if(name.endsWith('.xml')||name.endsWith('.rels'))parts.set(name,Buffer.from(data.toString().replaceAll(word,'http://purl.oclc.org/ooxml/wordprocessingml/main').replaceAll('http://schemas.openxmlformats.org/officeDocument/2006/relationships/','http://purl.oclc.org/ooxml/officeDocument/relationships/')));const xml=parts.get('word/document.xml')!.toString().replace(/encoding=['"]UTF-8['"]/,'encoding="UTF-16"').replaceAll('w:','different:').replace('xmlns:w=','xmlns:different=');let data=Buffer.from(xml,'utf16le');if(encoding==='utf16be')data=data.swap16();parts.set('word/document.xml',Buffer.concat([Buffer.from(encoding==='utf16le'?[0xff,0xfe]:[0xfe,0xff]),data]));});
    const p=await inspectDocx(bytes),change=replacement(p),result=await replaceDocx(bytes,{...change,replacement:'A & B < C "quoted"'},who);
    const xml=(await entries(result.bytes)).get(p.mainPart)!;assert.deepEqual(xml.subarray(0,2),Buffer.from(encoding==='utf16le'?[0xff,0xfe]:[0xfe,0xff]));
    assert.equal(result.projection.changes.find(c=>c.author===who.author&&c.kind==='ins')?.text,'A & B < C "quoted"');
    assert.equal(result.projection.comments[0]?.blocks[0]?.text,'Please preserve this comment.');
  }
});

test('footnote text can be edited while main document and imported comment parts remain untouched',async()=>{
  const bytes=await fixture(),p=await inspectDocx(bytes),range=p.editableRanges.find(r=>r.text===' Source note with exact wording.');assert.ok(range);
  const result=await replaceDocx(bytes,{rangeId:range.id,start:1,end:7,quote:'Source',replacement:'Original source'},who);const before=await entries(bytes),after=await entries(result.bytes);
  for(const [name,data]of before)if(name!=='word/footnotes.xml')assert.deepEqual(after.get(name),data);
  assert.ok(result.projection.notes.find(n=>n.id==='footnote:2')?.blocks.some(b=>b.runs.some(r=>r.change==='inserted'&&r.text==='Original source')));
});

test('fields, unknown XML, property revisions and split-run structures have no editable ranges',async()=>{
  const snippets=[
    '<w:fldSimple w:instr="DATE"><w:r><w:t>Unsafe target</w:t></w:r></w:fldSimple>',
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:t>Unsafe target</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>',
    '<custom:box xmlns:custom="urn:unsupported"><w:r><w:t>Unsafe target</w:t></w:r></custom:box>',
    '<w:r><w:rPr><w:rPrChange w:id="22"/></w:rPr><w:t>Unsafe target</w:t></w:r>',
    '<w:r><w:t>Unsafe target</w:t><w:t>another text</w:t></w:r>',
    '<w:r><!-- keep this unsupported inner token --><w:t>Unsafe target</w:t></w:r>',
    '<w:r><w:rPr/><w:rPr/><w:t>Unsafe target</w:t></w:r>',
    '<w:r><w:t>Unsafe<!-- retain inner XML comment --> target</w:t></w:r>',
    '<w:pPr><w:rPr><w:del w:id="30"/></w:rPr></w:pPr><w:r><w:t>Unsafe target</w:t></w:r>',
    '<w:pPr><w:rPr><w:ins w:id="31"/></w:rPr></w:pPr><w:r><w:t>Unsafe target</w:t></w:r>',
  ];
  for(const snippet of snippets){const bytes=await modify(parts=>parts.set('word/document.xml',Buffer.from(parts.get('word/document.xml')!.toString().replace('</w:body>',`<w:p>${snippet}</w:p></w:body>`))));const p=await inspectDocx(bytes);assert.equal(p.editableRanges.some(r=>r.text==='Unsafe target'),false,snippet);}
});

test('table property revisions prevent overlapping edits while ordinary table cells remain editable',async()=>{
  for(const [container,property]of [['tbl','tblPr'],['tr','trPr'],['tc','tcPr']] as const){const bytes=await modify(parts=>{const properties=`<w:${property}><w:${property}Change w:id="44"/></w:${property}>`;const table=`<w:tbl>${container==='tbl'?properties:''}<w:tr>${container==='tr'?properties:''}<w:tc>${container==='tc'?properties:''}<w:p><w:r><w:t>Table revision target</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;parts.set('word/document.xml',Buffer.from(parts.get('word/document.xml')!.toString().replace('</w:body>',`${table}</w:body>`)));});const p=await inspectDocx(bytes);assert.equal(p.editableRanges.some(r=>r.text==='Table revision target'),false);assert.equal(p.blocks.find(b=>b.text==='Table revision target')?.kind,'table-cell');}
});

test('default paragraph styles and document defaults contribute heading levels; byte-order declarations must match',async()=>{
  for(const source of ['style','defaults']){const bytes=await modify(parts=>{let xml=parts.get('word/styles.xml')!.toString();if(source==='style')xml=xml.replace(/(<w:style[^>]*w:styleId="Normal"[^>]*>)/,'$1<w:pPr><w:outlineLvl w:val="2"/></w:pPr>');else xml=xml.replace('<w:pPrDefault><w:pPr>','<w:pPrDefault><w:pPr><w:outlineLvl w:val="3"/>');parts.set('word/styles.xml',Buffer.from(xml));});const p=await inspectDocx(bytes);assert.equal(p.blocks.find(b=>b.text==='The original result is clear.')?.headingLevel,source==='style'?3:4);}
  const mismatch=await modify(parts=>{const xml=parts.get('word/document.xml')!.toString().replace(/encoding=['"]UTF-8['"]/,'encoding="UTF-16BE"');parts.set('word/document.xml',Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(xml,'utf16le')]));});await assert.rejects(inspectDocx(mismatch),/encoding declaration/);
});

test('package relationships determine the main part and external relationships remain inert',async()=>{
  const bytes=await modify(parts=>{const xml=parts.get('word/document.xml')!;parts.delete('word/document.xml');parts.set('word/manuscript.xml',xml);parts.set('word/_rels/manuscript.xml.rels',parts.get('word/_rels/document.xml.rels')!);parts.delete('word/_rels/document.xml.rels');for(const name of ['_rels/.rels','[Content_Types].xml'])parts.set(name,Buffer.from(parts.get(name)!.toString().replaceAll('word/document.xml','word/manuscript.xml')));parts.set('word/_rels/manuscript.xml.rels',Buffer.from(parts.get('word/_rels/manuscript.xml.rels')!.toString().replace('</Relationships>','<Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://127.0.0.1:9/private" TargetMode="External"/></Relationships>')));});
  const p=await inspectDocx(bytes);assert.equal(p.mainPart,'word/manuscript.xml');assert.ok(p.warnings.some(w=>w.includes('never fetched')));assert.equal((await replaceDocx(bytes,replacement(p),who)).projection.mainPart,p.mainPart);
});

test('malformed XML, DTDs, duplicate names, wrong checksums, missing relationships and macros are rejected',async()=>{
  const variants=[
    (p:Map<string,Buffer>)=>p.set('custom/unknown.xml',Buffer.from('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')),
    (p:Map<string,Buffer>)=>p.set('custom/unknown.xml',Buffer.from('<x><y></x>')),
    (p:Map<string,Buffer>)=>p.set('custom/UNKNOWN.xml',Buffer.from('<x/>')),
    (p:Map<string,Buffer>)=>p.delete('word/footnotes.xml'),
    (p:Map<string,Buffer>)=>p.set('[Content_Types].xml',Buffer.from(p.get('[Content_Types].xml')!.toString().replace('wordprocessingml.document.main+xml','wordprocessingml.document.macroEnabled.main+xml'))),
    (p:Map<string,Buffer>)=>p.set('word/document.xml',Buffer.from('<x>'+ '<y>'.repeat(65) + '</y>'.repeat(65)+'</x>')),
  ];for(const change of variants)await assert.rejects(inspectDocx(await modify(change)),{status:422});
  const stored=await archive(await entries(await fixture()),false);const corrupt=Buffer.from(stored);const needle=Buffer.from('lexical sentinel remains exactly here');const offset=corrupt.indexOf(needle);assert.ok(offset>0);corrupt[offset]=33;await assert.rejects(inspectDocx(corrupt),/checksum/);
});

test('signed packages retain exact no-op bytes and reject edits; cancellation and worker capacity are bounded',async()=>{
  const bytes=await modify(parts=>parts.set('_rels/.rels',Buffer.from(parts.get('_rels/.rels')!.toString().replace('</Relationships>','<Relationship Id="signature" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin" Target="custom/unknown.bin"/></Relationships>'))));const p=await inspectDocx(bytes),change=replacement(p);
  assert.ok(p.warnings.some(w=>w.includes('signatures')));await assert.rejects(replaceDocx(bytes,change,who),/Signed DOCX/);assert.deepEqual(Buffer.from((await replaceDocx(bytes,{...change,replacement:change.quote},who)).bytes),bytes);
  const one=new AbortController(),two=new AbortController();const a=inspectDocx(bytes,one.signal),b=inspectDocx(bytes,two.signal);await assert.rejects(inspectDocx(bytes),{status:503,code:'DOCX_BUSY'});one.abort();two.abort();await Promise.all([assert.rejects(a,{status:499}),assert.rejects(b,{status:499})]);await inspectDocx(bytes);
  const canceled=new AbortController();canceled.abort();await assert.rejects(inspectDocx(bytes,canceled.signal),{status:499});
});

test('unknown XML inside an edited part, emoji boundaries and preserved whitespace remain exact',async()=>{
  const opaque='<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:alien="urn:fixture"><mc:Choice Requires="alien"><alien:object value="  retain  "/></mc:Choice><mc:Fallback><w:p><w:r><w:t>Fallback text</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>';
  const bytes=await modify(parts=>parts.set('word/document.xml',Buffer.from(parts.get('word/document.xml')!.toString().replace('</w:body>',`${opaque}<w:p><w:r><w:t xml:space="preserve">  A 😀 B  </w:t></w:r></w:p></w:body>`))));
  const p=await inspectDocx(bytes),range=p.editableRanges.find(r=>r.text==='  A 😀 B  ');assert.ok(range);assert.equal(p.editableRanges.some(r=>r.text==='Fallback text'),false);
  await assert.rejects(replaceDocx(bytes,{rangeId:range.id,start:4,end:5,quote:'\ud83d',replacement:'x'},who),{status:422});
  const output=await replaceDocx(bytes,{rangeId:range.id,start:4,end:6,quote:'😀',replacement:'review'},who);
  assert.ok((await entries(output.bytes)).get(p.mainPart)!.toString().includes(opaque));
  assert.equal(output.projection.blocks.find(b=>b.runs.some(r=>r.change==='inserted'&&r.text==='review'))?.runs.filter(r=>r.change!=='deleted').map(r=>r.text).join(''),'  A review B  ');
});

test('compressed bytes, actual XML bytes, part counts and declared inflation are hard rejection limits',async()=>{
  await assert.rejects(inspectDocx(new Uint8Array(DOCX_LIMITS.compressedBytes+1)),{status:422});
  const oversized=await modify(parts=>parts.set('custom/unknown.xml',Buffer.from('<x>'+ 'a'.repeat(DOCX_LIMITS.xmlBytes)+'</x>')));await assert.rejects(inspectDocx(oversized),/XML part exceeds/);
  const tooMany=await modify(parts=>{for(let i=0;i<DOCX_LIMITS.parts;i++)parts.set(`custom/part-${i}.bin`,Buffer.alloc(0));});await assert.rejects(inspectDocx(tooMany),/too many parts/);
  const forged=Buffer.from(await fixture());const central=forged.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));assert.ok(central>0);forged.writeUInt32LE(DOCX_LIMITS.inflatedBytes+1,central+24);await assert.rejects(inspectDocx(forged),/inflated byte limit/);
});
