import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { fromBufferPromise } from 'yauzl';
import { ZipFile } from 'yazl';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { DOCX_LIMITS, type DocxBlock, type DocxProjection, type DocxReplacement, type DocxRun, type DocxTextRange } from '../shared/docx.ts';
import { DOCX_DISCUSSION_LIMITS, type DocxPackageComment } from '../shared/docx-discussion.ts';
import { validateDocxBatch, type DocxPassageReplacement } from '../shared/docx-batch.ts';
import { validateDocxResolution, type DocxChangeDecision, type DocxResolutionInspection, type DocxResolutionSegment } from '../shared/docx-resolution.ts';

const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const XML = 'http://www.w3.org/XML/1998/namespace';
const OFFICE_REL = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/', 'http://purl.oclc.org/ooxml/officeDocument/relationships/'];
const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const CHANGES = new Set(['ins', 'del', 'moveFrom', 'moveTo', 'pPrChange', 'rPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange', 'sectPrChange', 'numberingChange', 'cellIns', 'cellDel', 'cellMerge']);
const SAFE_ANCESTORS = new Set(['document', 'body', 'p', 'tbl', 'tr', 'tc', 'footnotes', 'footnote', 'endnotes', 'endnote']);
const RUN_PROPERTIES = new Set(['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath']);
const KNOWN = new Set(['document','body','p','pPr','pStyle','r','rPr','t','delText','tab','br','cr','tbl','tblPr','tblGrid','gridCol','tr','trPr','tc','tcPr','sectPr','footnotes','footnote','endnotes','endnote','footnoteReference','endnoteReference','footnoteRef','endnoteRef','comments','comment','commentRangeStart','commentRangeEnd','commentReference','bookmarkStart','bookmarkEnd','proofErr','lastRenderedPageBreak','hyperlink','fldSimple','fldChar','instrText','delInstrText','styles','style','name','basedOn','next','link','docDefaults','pPrDefault','rPrDefault','latentStyles','lsdException','outlineLvl',...RUN_PROPERTIES,...CHANGES]);
interface Entry { name: string; bytes: Buffer; directory: boolean }
interface Token { start: number; end: number; closing: boolean; selfClosing: boolean; name: string }
interface Node { name: string; local: string; uri: string; attributes: SaxesTagNS['attributes']; start: number; openEnd: number; closeStart: number; end: number; children: Node[]; parent?: Node; text: string }
interface Part { name: string; text: string; encoding: 'utf8' | 'utf16le' | 'utf16be'; bom: Buffer; root: Node; nodes: Node[] }
interface Parsed { entries: Entry[]; parts: Map<string, Part>; projection: DocxProjection; ranges: Map<string, { part: Part; run: Node; text: Node }>; signed: boolean }
function fail(message: string): never { throw new Error(message); }
const isWord = (node: Node, local?: string) => WORD.has(node.uri) && (local === undefined || node.local === local);
const attr = (node: Node, local: string, word = true): string | undefined => Object.values(node.attributes).find(a => a.local === local && (word ? WORD.has(a.uri) : a.uri === ''))?.value;
const child = (node: Node, local: string) => node.children.find(n => isWord(n, local));
const ancestors = (node: Node): Node[] => { const result: Node[] = []; for (let p = node.parent; p; p = p.parent) result.push(p); return result; };
const ancestry = (node: Node, local: string) => ancestors(node).find(p => isWord(p, local));
const id = (kind: string, part: string, node: Node) => JSON.stringify([`docx-${kind}-v1`, part, node.start, node.end]);
const plainText = (node: Node): string => { let result = ''; const visit = (n: Node) => { if (isWord(n) && ['t','delText','instrText','delInstrText'].includes(n.local)) result += n.text; else if (isWord(n, 'tab')) result += '\t'; else if (isWord(n) && ['br','cr'].includes(n.local)) result += '\n'; else n.children.forEach(visit); }; visit(node); return result; };

function partName(name: string): string {
  if (!name || name.length > 500 || /[\\\x00-\x20\x7f?#]/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..') || /%(?:2f|5c)/i.test(name)) fail('DOCX package contains an unsafe part name.');
  let decoded: string; try { decoded = decodeURIComponent(name); } catch { return fail('DOCX package contains an invalid part URI.'); }
  if (decoded.split('/').some(p => p === '.' || p === '..') || /[\\\x00-\x1f\x7f]/.test(decoded)) fail('DOCX package contains an unsafe encoded part name.');
  return decoded.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

async function readZip(input: Uint8Array): Promise<Entry[]> {
  if (!input.length || input.length > DOCX_LIMITS.compressedBytes) fail('DOCX package exceeds the compressed byte limit.');
  const bytes = Buffer.from(input); const zip = await fromBufferPromise(bytes, { strictFileNames: true, validateEntrySizes: true });
  const result: Entry[] = []; const names = new Set<string>(); let total = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (result.length >= DOCX_LIMITS.parts) fail('DOCX package contains too many parts.');
      const directory = entry.fileName.endsWith('/'); const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      const normalized = partName(name); if (names.has(normalized)) fail('DOCX package contains duplicate or aliased part names.'); names.add(normalized);
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (mode && mode !== 0x8000 && mode !== 0x4000) fail('DOCX package contains a special filesystem entry.');
      if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) fail('Encrypted or unsupported ZIP compression is not supported.');
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > DOCX_LIMITS.inflatedBytes - total) fail('DOCX package exceeds its inflated byte limit.');
      // Reject ambiguous local names/flags even though central directory metadata is authoritative.
      const offset = entry.relativeOffsetOfLocalHeader;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) fail('DOCX package has an invalid local ZIP header.');
      const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
      if (offset + 30 + nameLength + extraLength + entry.compressedSize > bytes.length || !bytes.subarray(offset + 30, offset + 30 + nameLength).equals(entry.fileNameRaw)
        || bytes.readUInt16LE(offset + 8) !== entry.compressionMethod || bytes.readUInt16LE(offset + 6) !== entry.generalPurposeBitFlag) fail('DOCX package has inconsistent ZIP headers.');
      const stream = await zip.openReadStreamPromise(entry); const chunks: Buffer[] = []; let length = 0, checksum = 0;
      for await (const raw of stream) { const chunk = Buffer.from(raw); length += chunk.length; total += chunk.length;
        if (total > DOCX_LIMITS.inflatedBytes || length > entry.uncompressedSize) { stream.destroy(); fail('DOCX package exceeds its inflated byte limit.'); }
        checksum = crc32(chunk, checksum); chunks.push(chunk);
      }
      if (length !== entry.uncompressedSize || checksum !== entry.crc32 || (directory && length)) fail('DOCX package has an invalid ZIP size or checksum.');
      result.push({ name: entry.fileName, bytes: Buffer.concat(chunks, length), directory });
    }
  } finally { zip.close(); }
  return result;
}

function tokens(text: string): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < text.length;) {
    const start = text.indexOf('<', index); if (start < 0) break;
    if (text.startsWith('<!--', start)) { const end = text.indexOf('-->', start + 4); if (end < 0) fail('Unclosed XML comment.'); index = end + 3; continue; }
    if (text.startsWith('<![CDATA[', start)) { const end = text.indexOf(']]>', start + 9); if (end < 0) fail('Unclosed XML CDATA.'); index = end + 3; continue; }
    if (text.startsWith('<?', start)) { const end = text.indexOf('?>', start + 2); if (end < 0) fail('Unclosed XML instruction.'); index = end + 2; continue; }
    if (text.startsWith('<!', start)) fail('DOCX XML declarations, DTDs and entities are not supported.');
    let quote = '', end = start + 1;
    for (; end < text.length; end++) { const ch = text[end]!; if (quote) { if (ch === quote) quote = ''; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === '>') break; }
    if (end === text.length) fail('Unclosed XML tag.');
    const raw = text.slice(start, end + 1), closing = raw.startsWith('</'); const name = /^<\/?([^\s/>]+)/.exec(raw)?.[1];
    if (!name) fail('Invalid XML tag.');
    result.push({ start, end: end + 1, closing, selfClosing: /\/\s*>$/.test(raw), name: name! });
    if (result.length > 500_000) fail('DOCX XML contains too many elements.'); index = end + 1;
  }
  return result;
}

function xmlPart(entry: Entry): Part {
  if (entry.bytes.length > DOCX_LIMITS.xmlBytes) fail('A DOCX XML part exceeds 8 MiB.');
  const bytes = entry.bytes; let encoding: Part['encoding'] = 'utf8', bom: Buffer = Buffer.alloc(0), offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { bom = bytes.subarray(0, 3); offset = 3; }
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf16le'; bom = bytes.subarray(0, 2); offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf16be'; bom = bytes.subarray(0, 2); offset = 2; }
  else if (bytes[0] === 0x3c && bytes[1] === 0) encoding = 'utf16le';
  else if (bytes[0] === 0 && bytes[1] === 0x3c) encoding = 'utf16be';
  let text: string; try { text = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset)); } catch { return fail('DOCX XML is not valid UTF-8 or UTF-16.'); }
  const markup = tokens(text), nodes: Node[] = [], stack: Node[] = []; let cursor = 0, root: Node | undefined;
  const parser = new SaxesParser({ xmlns: true });
  let declared: string | undefined;
  parser.on('xmldecl', declaration=>{declared=declaration.encoding?.toLowerCase();if(declaration.version!=='1.0')fail('Only XML 1.0 DOCX parts are supported.');});
  parser.on('doctype', () => fail('DOCX XML DTDs are not supported.'));
  parser.on('opentag', tag => {
    const token = markup[cursor++]; if (!token || token.closing || token.name !== tag.name) fail('DOCX XML token positions are inconsistent.');
    if (stack.length >= 64) fail('DOCX XML nesting exceeds its limit.');
    const node: Node = { name: tag.name, local: tag.local, uri: tag.uri, attributes: tag.attributes, start: token.start, openEnd: token.end, closeStart: token.end, end: token.end, children: [], text: '', ...(stack.length ? { parent: stack.at(-1)! } : {}) };
    if (node.parent) node.parent.children.push(node); else root = node;
    nodes.push(node); stack.push(node);
  });
  parser.on('text', value => { if (stack.length) stack.at(-1)!.text += value; });
  parser.on('cdata', value => { if (stack.length) stack.at(-1)!.text += value; });
  parser.on('closetag', tag => {
    const node = stack.pop(); if (!node || node.name !== tag.name) fail('DOCX XML structure is inconsistent.');
    if (!tag.isSelfClosing) { const token = markup[cursor++]; if (!token?.closing || token.name !== node.name) fail('DOCX closing XML token is inconsistent.'); node.closeStart = token.start; node.end = token.end; }
  });
  parser.write(text).close();
  if (declared && !(encoding === 'utf8' ? ['utf-8','utf8'].includes(declared) : ['utf-16',encoding==='utf16le'?'utf-16le':'utf-16be'].includes(declared))) fail('DOCX XML encoding declaration does not match supported bytes.');
  if (!root || cursor !== markup.length) fail('DOCX XML part has no valid root.');
  return { name: entry.name, text, encoding, bom, root: root!, nodes };
}

interface Relationship { id: string; type: string; target: string; external: boolean }
function relationships(parts: Map<string, Part>, source: string): Relationship[] {
  const name = source ? posix.join(posix.dirname(source), '_rels', `${posix.basename(source)}.rels`) : '_rels/.rels';
  const part = parts.get(name); if (!part) return [];
  if (part.root.uri !== REL || part.root.local !== 'Relationships') fail('DOCX package has invalid relationships.');
  const ids = new Set<string>(); return part.root.children.map(node => {
    if (node.uri !== REL || node.local !== 'Relationship') fail('DOCX package has an unsupported relationship element.');
    const id = attr(node, 'Id', false), type = attr(node, 'Type', false), target = attr(node, 'Target', false), mode = attr(node, 'TargetMode', false);
    if (!id || !type || !target || ids.has(id) || (mode !== undefined && !['Internal','External'].includes(mode))) fail('DOCX package has invalid relationship metadata.');
    ids.add(id!); return { id: id!, type: type!, target: target!, external: mode === 'External' };
  });
}
const relKind = (relationship: Relationship, kind: string) => OFFICE_REL.some(prefix => relationship.type === prefix + kind);
function targetPart(source: string, target: string): string {
  if (/[\\\x00-\x20\x7f?#]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) fail('DOCX contains an unsafe internal relationship.');
  const resolved = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(source), target)); partName(resolved); return resolved;
}

function build(entries: Entry[]): Parsed {
  const parts = new Map<string, Part>(); const entryNames = new Set(entries.filter(e => !e.directory).map(e => e.name)); let xmlBytes = 0;
  for (const entry of entries) if (!entry.directory && (entry.name.endsWith('.xml') || entry.name.endsWith('.rels'))) { xmlBytes += entry.bytes.length; if (xmlBytes > 32 * 1024 * 1024) fail('DOCX package contains too much XML.'); parts.set(entry.name, xmlPart(entry)); }
  const types = parts.get('[Content_Types].xml'); if (!types || types.root.uri !== CT || types.root.local !== 'Types') fail('DOCX package is missing content types.');
  const overrides = new Map<string,string>(), defaults = new Map<string,string>();
  for (const n of types.root.children) {
    if (n.uri !== CT || !['Default','Override'].includes(n.local)) fail('DOCX content types are invalid.');
    const type = attr(n, 'ContentType', false); if (!type) fail('DOCX content type is missing.');
    if (/macroEnabled|vbaProject|activeX/i.test(type!)) fail('Macro-enabled or ActiveX DOCX packages are not supported.');
    if (n.local === 'Override') { const name = attr(n, 'PartName', false); if (!name?.startsWith('/')) fail('DOCX content type part name is invalid.'); const actual = name!.slice(1); partName(actual); if (overrides.has(actual)) fail('DOCX has duplicate content type overrides.'); overrides.set(actual,type!); }
    else { const ext = attr(n, 'Extension', false); if (!ext || defaults.has(ext.toLowerCase())) fail('DOCX has duplicate content type defaults.'); defaults.set(ext.toLowerCase(), type!); }
  }
  for (const name of entryNames) if (name !== '[Content_Types].xml' && !overrides.has(name) && !defaults.has(name.slice(name.lastIndexOf('.')+1).toLowerCase())) fail('DOCX part is missing a content type.');
  const rootRels = relationships(parts, ''), office = rootRels.filter(r => relKind(r, 'officeDocument'));
  if (office.length !== 1 || office[0]!.external) fail('DOCX must contain one internal Word document relationship.');
  const mainPart = targetPart('', office[0]!.target), main = parts.get(mainPart);
  if (!main || !isWord(main.root,'document') || (overrides.get(mainPart) ?? defaults.get(posix.extname(mainPart).slice(1))) !== MAIN_TYPE) fail('Package is not a supported DOCX document.');
  const warnings = new Set<string>();
  const warn = (message: string) => { if (warnings.size < 100) warnings.add(message); };
  let signed = false;
  for (const name of parts.keys()) if (name.endsWith('.rels')) {
    const source = name === '_rels/.rels' ? '' : name.replace(/(^|\/)\_rels\//, '$1').slice(0, -5);
    for (const rel of relationships(parts, source)) {
      if (/digital-signature/i.test(rel.type)) signed = true;
      if (rel.external) warn('External relationships are preserved but never fetched.');
      else if (!entryNames.has(targetPart(source,rel.target))) fail('DOCX contains an unresolved internal relationship.');
    }
  }
  if (signed) warn('Package signatures are retained; signed packages cannot be edited.');
  const documentRels = relationships(parts, mainPart);
  const related = (kind: string): Part | undefined => { const rows = documentRels.filter(r => relKind(r,kind)); if (rows.length > 1 || rows.some(r=>r.external)) fail(`DOCX has invalid ${kind} relationships.`); return rows.length ? parts.get(targetPart(mainPart, rows[0]!.target)) : undefined; };
  const styles = related('styles'), styleMap = new Map<string, Node>();
  if (styles) for (const node of styles.root.children.filter(n=>isWord(n,'style'))) { const key = attr(node,'styleId'); if (key && styleMap.has(key)) fail('DOCX contains duplicate style IDs.'); if (key) styleMap.set(key,node); }
  const defaultStyles=[...styleMap.values()].filter(n=>attr(n,'type')==='paragraph'&&['true','1','on'].includes(attr(n,'default')??''));
  if(defaultStyles.length>1)fail('DOCX has multiple default paragraph styles.');
  const paragraphDefaults=styles&&child(styles.root,'docDefaults'); const pDefault=paragraphDefaults&&child(paragraphDefaults,'pPrDefault'); const defaultProps=pDefault&&child(pDefault,'pPr');
  const heading = (paragraph: Node): number | undefined => {
    const props = child(paragraph,'pPr'); let level = props && child(props,'outlineLvl'); const styleRef = props && child(props,'pStyle'); let key=styleRef?attr(styleRef,'val'):defaultStyles[0]&&attr(defaultStyles[0],'styleId'); const seen = new Set<string>();
    while (!level && key) { if (seen.has(key) || seen.size > 64) { warn('Cyclic or deeply inherited paragraph styles have uncertain heading levels.'); return undefined; } seen.add(key); const style = styleMap.get(key); if (!style) { warn('Some paragraph styles are unavailable; heading levels may be incomplete.'); return undefined; } const styleProps = child(style,'pPr'); level = styleProps && child(styleProps,'outlineLvl'); const based=child(style,'basedOn');key=based&&attr(based,'val'); }
    level??=defaultProps&&child(defaultProps,'outlineLvl');
    const value = level && attr(level,'val'); if(level&&(value===undefined||!/^\d$/.test(value)))warn('A paragraph outline level is unsupported.'); return value !== undefined && /^[0-8]$/.test(value) ? Number(value)+1 : undefined;
  };
  const ranges: Parsed['ranges'] = new Map(); const editableRanges: DocxTextRange[] = []; const changes: DocxProjection['changes'] = [];
  const collectBlocks = (part: Part, root: Node, editable: boolean): DocxBlock[] => {
    const blocks: DocxBlock[] = [], comments = new Set<string>(); let fieldDepth = 0;
    const paragraphNodes: Node[] = []; const findParagraphs = (n: Node) => { if(isWord(n,'p'))paragraphNodes.push(n); n.children.forEach(findParagraphs); }; findParagraphs(root);
    for (const paragraph of paragraphNodes) {
      const headingLevel=heading(paragraph);
      const block: DocxBlock = { id: id('block',part.name,paragraph), part:part.name, kind: ancestry(paragraph,'tc') ? 'table-cell':'paragraph', runs:[], text:'', ...(headingLevel ? { headingLevel } : {}) };
      const walk = (n: Node, change?: DocxRun['change']) => {
        if (n !== paragraph && isWord(n,'p')) return;
        if (!WORD.has(n.uri)) { warn('Unsupported XML markup is preserved; affected text is not editable.'); }
        else if (!KNOWN.has(n.local)) warn('Some Word structures are preserved without complete semantic interpretation.');
        if (isWord(n,'commentRangeStart')) { const value = attr(n,'id'); if (value) comments.add(value); }
        if (isWord(n,'commentRangeEnd')) { const value = attr(n,'id'); if (value) comments.delete(value); }
        if (isWord(n,'fldChar')) { const type = attr(n,'fldCharType'); if (type === 'begin') fieldDepth++; else if (type === 'end') fieldDepth = Math.max(0,fieldDepth-1); }
        if(isWord(n,'fldChar')||isWord(n,'fldSimple'))warn('Field results are stored text; fields are never evaluated and are not editable.');
        if (isWord(n) && ['ins','del','moveFrom','moveTo'].includes(n.local)) change = ({ins:'inserted',del:'deleted',moveFrom:'moveFrom',moveTo:'moveTo'} as const)[n.local as 'ins'|'del'|'moveFrom'|'moveTo'];
        if (isWord(n) && ['t','delText','tab','br','cr','footnoteReference','endnoteReference'].includes(n.local)) {
          const run: DocxRun = { text: n.local === 'tab' ? '\t' : ['br','cr'].includes(n.local) ? '\n' : ['t','delText'].includes(n.local) ? n.text : '', ...(change ? {change}:{}), ...(comments.size ? {commentIds:[...comments]}:{}) };
          if (['footnoteReference','endnoteReference'].includes(n.local)) run.noteId = `${n.local === 'footnoteReference'?'footnote':'endnote'}:${attr(n,'id') ?? ''}`;
          const parent = n.parent;
          if (editable && !fieldDepth && !change && isWord(n,'t') && parent && isWord(parent,'r') && safeRun(part,parent,n,paragraph)) {
            const rangeId = id('range',part.name,parent); run.rangeId = rangeId; ranges.set(rangeId,{part,run:parent,text:n}); editableRanges.push({id:rangeId,part:part.name,blockId:block.id,text:n.text});
          }
          block.runs.push(run); block.text += run.text;
        }
        n.children.forEach(c=>walk(c,change));
      };
      walk(paragraph); blocks.push(block);
    }
    if (fieldDepth) warn('Unclosed field structure is preserved and not editable.');
    return blocks;
  };
  const mainBlocks = collectBlocks(main,main.root,true), notes: DocxProjection['notes'] = [], comments: DocxProjection['comments'] = [];
  for (const kind of ['footnote','endnote'] as const) { const part = related(`${kind}s`); if (!part) continue; const seen = new Set<string>(); for (const note of part.root.children.filter(n=>isWord(n,kind))) { const key=attr(note,'id'); if (key === undefined || seen.has(key)) fail('DOCX contains missing or duplicate note IDs.'); seen.add(key); notes.push({id:`${kind}:${key}`,kind,blocks:collectBlocks(part,note,true)}); } }
  const commentPart = related('comments'); if (commentPart) { const seen=new Set<string>(); for (const note of commentPart.root.children.filter(n=>isWord(n,'comment'))) { const key=attr(note,'id'); if (key === undefined || seen.has(key)) fail('DOCX contains missing or duplicate comment IDs.'); seen.add(key); comments.push({id:key, ...(attr(note,'author') !== undefined?{author:attr(note,'author')}:{}), ...(attr(note,'date') !== undefined?{date:attr(note,'date')}:{}), blocks:collectBlocks(commentPart,note,false)}); } }
  for (const part of parts.values()) for (const n of part.nodes) if (isWord(n) && CHANGES.has(n.local)) changes.push({id:id('change',part.name,n),part:part.name,kind:n.local,text:plainText(n),...(attr(n,'author')!==undefined?{author:attr(n,'author')}:{}),...(attr(n,'date')!==undefined?{date:attr(n,'date')}: {})});
  const allBlocks = [...mainBlocks,...notes.flatMap(n=>n.blocks)];
  const noteIds = new Set(notes.map(n=>n.id)), commentIds = new Set(comments.map(c=>c.id));
  for (const b of allBlocks) for (const r of b.runs) { if (r.noteId && !noteIds.has(r.noteId)) warn('A note reference has no matching note body.'); if (r.commentIds?.some(key=>!commentIds.has(key))) warn('A comment range has no matching comment body.'); }
  if (documentRels.some(r=>!['styles','footnotes','endnotes','comments','settings','numbering','fontTable','theme','image'].some(k=>relKind(r,k)))) warn('Additional document parts are preserved; their content may not appear in this review projection.');
  warn('This structural review is not Word page layout; unsupported formatting and objects remain in the DOCX package.');
  const projection: DocxProjection = {format:'phabricator.docx.projection.v1',mainPart,blocks:mainBlocks,notes,comments,changes,editableRanges,warnings:[...warnings]};
  if (Buffer.byteLength(JSON.stringify(projection)) > DOCX_LIMITS.projectionBytes) fail('DOCX structural projection exceeds its 2 MiB limit.');
  return {entries,parts,projection,ranges,signed};
}

const unsafePropertyCache=new WeakMap<Node,boolean>();
function unsafeProperties(node:Node):boolean {
  const cached=unsafePropertyCache.get(node);if(cached!==undefined)return cached;
  const visit=(n:Node):boolean=>!WORD.has(n.uri)||CHANGES.has(n.local)||n.children.some(visit);
  const unsafe=node.children.filter(n=>isWord(n)&&['pPr','tblPr','trPr','tcPr','sectPr'].includes(n.local)).some(visit);
  unsafePropertyCache.set(node,unsafe);return unsafe;
}
function safeRun(part: Part, run: Node, text: Node, _paragraph: Node, revision?: Node): boolean {
  const textKind = revision && isWord(revision, 'del') ? 'delText' : 't';
  if (!text.text.length || text.children.length || run.children.filter(n=>isWord(n,textKind)).length !== 1 || run.children.some(n=>!isWord(n) || !['rPr',textKind].includes(n.local))) return false;
  if(run.children.length>2||run.children.at(-1)!==text||(run.children.length===2&&!isWord(run.children[0]!,'rPr'))||/<(?:!--|\?)/.test(part.text.slice(text.openEnd,text.closeStart)))return false;
  if (Object.values(run.attributes).some(a=>a.uri !== 'http://www.w3.org/2000/xmlns/' && !(WORD.has(a.uri) && ['rsidR','rsidRPr','rsidDel'].includes(a.local)))) return false;
  if (Object.values(text.attributes).some(a=>a.uri !== 'http://www.w3.org/2000/xmlns/' && !(a.uri === XML && a.local === 'space'))) return false;
  for (const p of ancestors(run)) if (p !== revision && (!WORD.has(p.uri) || !SAFE_ANCESTORS.has(p.local) || unsafeProperties(p))) return false;
  const props=child(run,'rPr'); if (props && props.children.some(n=>!isWord(n) || !RUN_PROPERTIES.has(n.local) || n.children.length)) return false;
  let cursor=run.openEnd; for(const n of run.children) { if(part.text.slice(cursor,n.start).trim())return false; cursor=n.end; } if(part.text.slice(cursor,run.closeStart).trim())return false;
  return true;
}

function encode(part: Part, text: string): Buffer { let bytes=Buffer.from(text,part.encoding==='utf8'?'utf8':'utf16le'); if(part.encoding==='utf16be')bytes=bytes.swap16(); return Buffer.concat([part.bom,bytes]); }
const escape = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const validText = (value: string) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value) && !/[\uD800-\uDFFF]/u.test(value);
const splitSurrogate = (text: string, offset: number) => offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1]!)&&/[\uDC00-\uDFFF]/.test(text[offset]!);
async function writeZipChanges(entries: Entry[], replacements: Map<string, Buffer>, additions: Entry[] = []): Promise<Uint8Array> {
  const zip=new ZipFile(), chunks:Buffer[]=[]; let count=0;
  const done=new Promise<Buffer>((resolve,reject)=>{zip.outputStream.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>DOCX_LIMITS.compressedBytes){(zip.outputStream as Readable).destroy();reject(new Error('Edited DOCX exceeds 16 MiB.'));}else chunks.push(chunk);});zip.outputStream.once('error',reject);zip.outputStream.once('end',()=>resolve(Buffer.concat(chunks,count)));zip.once('error',reject);});
  for(const entry of [...entries,...additions]){if(entry.directory)zip.addEmptyDirectory(entry.name,{mtime:new Date('2000-01-01T00:00:00Z'),mode:0o40755});else zip.addBuffer(replacements.get(entry.name)??entry.bytes,entry.name,{mtime:new Date('2000-01-01T00:00:00Z'),mode:0o100644,compressionLevel:6});}zip.end();return done;
}
async function writeZip(entries: Entry[], name: string, replacement: Buffer): Promise<Uint8Array> { return writeZipChanges(entries, new Map([[name, replacement]])); }

const COMMENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const REL_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';
const escapeText = (value: string) => escape(value).replaceAll('\r', '&#13;');
const escapeAttribute = (value: string) => escapeText(value).replaceAll('\n', '&#10;').replaceAll('\t', '&#9;');
// ST_DecimalNumber is signed and unbounded. Normalize lexically instead of
// rounding through Number or rejecting a valid large imported identifier.
function commentId(value: string | undefined): string {
  const normalized = value?.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (normalized === undefined || !/^[+-]?\d+$/.test(normalized)) return fail('DOCX contains an invalid comment identifier.');
  const negative = normalized.startsWith('-'), magnitude = normalized.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
}
/** Word IDs share ST_DecimalNumber lexical aliases, including +1 and whitespace. */
function greatestRevisionId(parsed: Parsed): number {
  let greatest = 0;
  for (const part of parsed.parts.values()) for (const node of part.nodes) {
    const value = attr(node, 'id'); if (value === undefined) continue;
    let normalized: string; try { normalized = commentId(value); } catch { return fail('DOCX contains an invalid revision or object identifier.'); }
    if (normalized.startsWith('-')) continue;
    const numeric = Number(normalized);
    if (!Number.isSafeInteger(numeric) || numeric > 2_147_483_640) fail('DOCX revision IDs exceed the supported edit range.');
    greatest = Math.max(greatest, numeric);
  }
  return greatest;
}
function contentType(parsed: Parsed, name: string): string | undefined {
  const root = parsed.parts.get('[Content_Types].xml')!.root;
  const overrides = root.children.filter(node => node.local === 'Override' && partName(attr(node, 'PartName', false)!.slice(1)) === partName(name));
  if (overrides.length > 1) fail('DOCX contains aliased content type overrides.');
  if (overrides.length) return attr(overrides[0]!, 'ContentType', false);
  const fallback = root.children.find(node => node.local === 'Default' && attr(node, 'Extension', false)?.toLowerCase() === posix.extname(name).slice(1).toLowerCase());
  return fallback ? attr(fallback, 'ContentType', false) : undefined;
}
function freshPrefix(texts: string[], seed: string): string {
  let prefix = seed; while (texts.some(text => text.includes(`${prefix}:`) || text.includes(`xmlns:${prefix}`))) prefix += 'X'; return prefix;
}
function appendXml(part: Part, addition: string): string {
  const opening = part.text.slice(part.root.start, part.root.openEnd);
  const result = /\/\s*>$/.test(opening)
    ? part.text.slice(0, part.root.start) + opening.replace(/\/\s*>$/, '>') + addition + `</${part.root.name}>` + part.text.slice(part.root.end)
    : part.text.slice(0, part.root.closeStart) + addition + part.text.slice(part.root.closeStart);
  if (Buffer.byteLength(result, part.encoding === 'utf8' ? 'utf8' : 'utf16le') + part.bom.length > DOCX_LIMITS.xmlBytes) fail('Exported DOCX XML exceeds its part limit.');
  return result;
}

/** Validate classic linkage before adding anything. Point comments (reference
 * only) and unused bodies are preserved; partial ranges and ambiguous IDs are
 * rejected rather than silently repaired. */
function classicComments(parsed: Parsed): { part: Part | undefined; ids: Set<string> } {
  const main = parsed.projection.mainPart, links = relationships(parsed.parts, main).filter(rel => relKind(rel, 'comments'));
  if (links.length > 1 || links.some(rel => rel.external)) fail('DOCX has invalid classic comments relationships.');
  const mainRels = parsed.parts.get(posix.join(posix.dirname(main), '_rels', `${posix.basename(main)}.rels`));
  if (mainRels && (contentType(parsed, mainRels.name) !== REL_TYPE || mainRels.root.text.trim() || mainRels.root.children.some(node => node.children.length || node.text.trim()))) fail('DOCX has malformed document relationships.');
  const part = links.length ? parsed.parts.get(targetPart(main, links[0]!.target)) : undefined;
  const ids = new Set<string>();
  if (links.length && (!part || !isWord(part.root, 'comments') || part.root.text.trim() || contentType(parsed, part.name) !== COMMENT_TYPE)) fail('DOCX has an invalid classic comments part or content type.');
  if (part) for (const node of part.root.children) {
    if (!isWord(node, 'comment')) fail('Unsupported markup in the classic comments collection.');
    const key = commentId(attr(node, 'id')); if (ids.has(key)) fail('DOCX contains duplicate or aliased comment identifiers.'); ids.add(key);
  }
  const anchors = new Map<string, { start?: Node; end?: Node; reference?: Node; part: string }>();
  for (const source of parsed.parts.values()) {
    if (source.name.endsWith('.rels')) {
      const owner = source.name === '_rels/.rels' ? '' : source.name.replace(/(^|\/)\_rels\//, '$1').slice(0, -5);
      if (owner !== main && relationships(parsed.parts, owner).some(rel => relKind(rel, 'comments'))) fail('Comments relationships outside the main document are unsupported for export.');
    }
    for (const node of source.nodes) {
      if (!isWord(node) || !['commentRangeStart', 'commentRangeEnd', 'commentReference'].includes(node.local)) continue;
      if (node.children.length || node.text.trim()) fail('DOCX contains malformed classic comment anchors.');
      const key = commentId(attr(node, 'id')); if (!ids.has(key) || source === part) fail('DOCX contains a dangling or unsupported classic comment anchor.');
      const row = anchors.get(key) ?? { part: source.name };
      const kind = node.local === 'commentRangeStart' ? 'start' : node.local === 'commentRangeEnd' ? 'end' : 'reference';
      if (row.part !== source.name || row[kind]) fail('DOCX contains ambiguous classic comment anchors.');
      row[kind] = node; anchors.set(key, row);
    }
  }
  for (const row of anchors.values()) {
    if (!row.reference || Boolean(row.start) !== Boolean(row.end) || (row.start && row.end && (row.start.start >= row.end.start || row.end.start >= row.reference.start))) fail('DOCX contains an incomplete or out-of-order classic comment range.');
  }
  return { part, ids };
}

async function exportDiscussion(parsed: Parsed, input: DocxPackageComment[]): Promise<{ bytes: Uint8Array; projection: DocxProjection }> {
  if (parsed.signed) fail('Signed DOCX packages cannot receive comments without invalidating their signatures.');
  if (!Array.isArray(input) || !input.length || input.length > DOCX_DISCUSSION_LIMITS.threads) fail('Select between one and 64 DOCX discussion threads.');
  const existing = classicComments(parsed), main = parsed.parts.get(parsed.projection.mainPart)!;
  // Comment identifiers have their own namespace, but avoiding other numeric
  // Word IDs too is inexpensive and keeps generated IDs unambiguous to tools.
  for (const part of parsed.parts.values()) for (const node of part.nodes) {
    const value = attr(node, 'id'); if (value !== undefined && /^[+-]?\d+$/.test(value)) existing.ids.add(commentId(value));
  }
  type Selected = { comment: DocxPackageComment; id: string; range: NonNullable<ReturnType<Parsed['ranges']['get']>> };
  const selected: Selected[] = []; let total = 0, nextId = 1;
  for (const comment of input) {
    if (!comment || typeof comment.body !== 'string' || !comment.body.length || !validText(comment.body) || typeof comment.author !== 'string' || !comment.author.trim() || comment.author.length > 255 || !validText(comment.author)
      || typeof comment.date !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(comment.date) || !Number.isFinite(Date.parse(comment.date))
      || new Date(comment.date).toISOString() !== comment.date.replace(/(?<=:\d\d)Z$/, '.000Z')) fail('DOCX comments require valid text, author and UTC date metadata.');
    total += comment.body.length; if (comment.body.length > DOCX_DISCUSSION_LIMITS.bodyLength || total > DOCX_DISCUSSION_LIMITS.bodyLength) fail('DOCX discussion text exceeds its export limit.');
    const passage = comment.passage, range = passage && typeof passage.rangeId === 'string' ? parsed.ranges.get(passage.rangeId) : undefined;
    if (!range || range.part !== main || !Number.isSafeInteger(passage.start) || !Number.isSafeInteger(passage.end) || typeof passage.quote !== 'string'
      || passage.start < 0 || passage.end <= passage.start || passage.end > range.text.text.length || passage.quote.length > DOCX_DISCUSSION_LIMITS.quoteLength
      || range.text.text.slice(passage.start, passage.end) !== passage.quote || splitSurrogate(range.text.text, passage.start) || splitSurrogate(range.text.text, passage.end)) fail('Choose an exact supported passage in the main DOCX document.');
    while (existing.ids.has(String(nextId))) nextId++;
    const key = String(nextId++); existing.ids.add(key); selected.push({ comment, id: key, range });
  }
  const prefix = freshPrefix([main.text, existing.part?.text ?? ''], 'docxComment'), uri = main.root.uri;
  const groups = new Map<Node, Selected[]>();
  for (const item of selected) { const group = groups.get(item.range.run) ?? []; group.push(item); groups.set(item.range.run, group); }
  const patches: { start: number; end: number; text: string }[] = [];
  for (const [run, group] of groups) {
    const text = group[0]!.range.text, props = child(run, 'rPr'), propsRaw = props ? main.text.slice(props.start, props.end) : '';
    const rawOpen = main.text.slice(run.start, run.openEnd), rawClose = main.text.slice(run.closeStart, run.end);
    let textOpen = main.text.slice(text.start, text.openEnd);
    for (const attribute of Object.values(text.attributes)) if (attribute.uri === XML && attribute.local === 'space') textOpen = textOpen.replace(new RegExp(`\\s+${attribute.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:"[^"]*"|'[^']*')`), '');
    textOpen = textOpen.replace(/\s*\/?>$/, ' xml:space="preserve">');
    const fragments: string[] = []; let length = 0;
    const append = (fragment: string) => { length += Buffer.byteLength(fragment, main.encoding === 'utf8' ? 'utf8' : 'utf16le'); if (length > DOCX_LIMITS.xmlBytes) fail('DOCX passage fragmentation exceeds its XML limit.'); fragments.push(fragment); };
    const fragment = (value: string) => `${rawOpen}${propsRaw}${textOpen}${escapeText(value)}</${text.name}>${rawClose}`;
    const boundaries = [...new Set([0, text.text.length, ...group.flatMap(item => [item.comment.passage.start, item.comment.passage.end])])].sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length; index++) {
      const offset = boundaries[index]!;
      for (const item of group.filter(item => item.comment.passage.end === offset).reverse()) append(`<${prefix}:commentRangeEnd xmlns:${prefix}="${uri}" ${prefix}:id="${item.id}"/><${prefix}:r xmlns:${prefix}="${uri}"><${prefix}:commentReference ${prefix}:id="${item.id}"/></${prefix}:r>`);
      for (const item of group.filter(item => item.comment.passage.start === offset)) append(`<${prefix}:commentRangeStart xmlns:${prefix}="${uri}" ${prefix}:id="${item.id}"/>`);
      const end = boundaries[index + 1]; if (end !== undefined && end > offset) append(fragment(text.text.slice(offset, end)));
    }
    patches.push({ start: run.start, end: run.end, text: fragments.join('') });
  }
  let mainText = main.text;
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    mainText = mainText.slice(0, patch.start) + patch.text + mainText.slice(patch.end);
    if (Buffer.byteLength(mainText, main.encoding === 'utf8' ? 'utf8' : 'utf16le') + main.bom.length > DOCX_LIMITS.xmlBytes) fail('Exported DOCX XML exceeds its part limit.');
  }
  const replacements = new Map<string, Buffer>([[main.name, encode(main, mainText)]]), additions: Entry[] = [];
  const occupied = new Set(parsed.entries.map(entry => partName(entry.directory ? entry.name.slice(0, -1) : entry.name)));
  const types = parsed.parts.get('[Content_Types].xml')!;
  for (const node of types.root.children) if (node.local === 'Override') occupied.add(partName(attr(node, 'PartName', false)!.slice(1)));
  let typesText = types.text;
  const requireType = (name: string, type: string) => {
    if (contentType(parsed, name) === type) return;
    const override = types.root.children.find(node => node.local === 'Override' && partName(attr(node, 'PartName', false)!.slice(1)) === partName(name));
    if (override) fail('DOCX comments require an unambiguous matching content type.');
    const p = freshPrefix([typesText], 'docxType');
    typesText = appendXml(xmlPart({ name: types.name, bytes: encode(types, typesText), directory: false }), `<${p}:Override xmlns:${p}="${CT}" PartName="/${escapeAttribute(name)}" ContentType="${type}"/>`);
  };
  let commentsName = existing.part?.name;
  if (!commentsName) {
    let suffix = 0; do { commentsName = posix.join(posix.dirname(main.name), `comments${suffix ? `-${suffix}` : ''}.xml`); suffix++; } while (occupied.has(partName(commentsName)));
    occupied.add(partName(commentsName)); requireType(commentsName, COMMENT_TYPE);
    const relsName = posix.join(posix.dirname(main.name), '_rels', `${posix.basename(main.name)}.rels`), rels = parsed.parts.get(relsName);
    if (rels && contentType(parsed, relsName) !== REL_TYPE) fail('DOCX has invalid document relationship content types.');
    const identifiers = new Set(relationships(parsed.parts, main.name).map(rel => rel.id)); let relationshipId = 'rIdPhabricatorComments'; while (identifiers.has(relationshipId)) relationshipId += 'X';
    const rp = freshPrefix([rels?.text ?? ''], 'docxRelationship');
    const type = OFFICE_REL[uri === 'http://purl.oclc.org/ooxml/wordprocessingml/main' ? 1 : 0] + 'comments';
    const relationship = `<${rp}:Relationship xmlns:${rp}="${REL}" Id="${relationshipId}" Type="${type}" Target="${escapeAttribute(posix.relative(posix.dirname(main.name), commentsName))}"/>`;
    if (rels) replacements.set(relsName, encode(rels, appendXml(rels, relationship)));
    else {
      if (occupied.has(partName(relsName))) fail('DOCX relationship part name is unavailable.');
      requireType(relsName, REL_TYPE); additions.push({ name: relsName, directory: false, bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL}">${relationship}</Relationships>`) });
    }
  }
  const bodyParts: string[] = []; let bodyBytes = 0;
  const appendBody = (fragment: string) => { bodyBytes += Buffer.byteLength(fragment, existing.part?.encoding === 'utf16le' || existing.part?.encoding === 'utf16be' ? 'utf16le' : 'utf8'); if (bodyBytes > DOCX_LIMITS.xmlBytes) fail('Exported DOCX comments exceed their XML limit.'); bodyParts.push(fragment); };
  for (const item of selected) {
    appendBody(`<${prefix}:comment xmlns:${prefix}="${uri}" ${prefix}:id="${item.id}" ${prefix}:author="${escapeAttribute(item.comment.author)}" ${prefix}:date="${escapeAttribute(item.comment.date)}"><${prefix}:p><${prefix}:r>`);
    const body = item.comment.body; let start = 0;
    const text = (value: string) => { if (value) appendBody(`<${prefix}:t xml:space="preserve">${escapeText(value)}</${prefix}:t>`); };
    for (const match of body.matchAll(/[\n\t]/g)) { text(body.slice(start, match.index)); appendBody(match[0] === '\n' ? `<${prefix}:br/>` : `<${prefix}:tab/>`); start = match.index + 1; }
    text(body.slice(start)); appendBody(`</${prefix}:r></${prefix}:p></${prefix}:comment>`);
  }
  const bodies = bodyParts.join('');
  if (existing.part) replacements.set(commentsName, encode(existing.part, appendXml(existing.part, bodies)));
  else additions.push({ name: commentsName, directory: false, bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><${prefix}:comments xmlns:${prefix}="${uri}">${bodies}</${prefix}:comments>`) });
  if (typesText !== types.text) replacements.set(types.name, encode(types, typesText));
  const output = await writeZipChanges(parsed.entries, replacements, additions), checked = build(await readZip(output));
  classicComments(checked);
  const after = new Map(checked.entries.map(entry => [entry.name, entry.bytes]));
  for (const entry of parsed.entries) if (!after.has(entry.name) || !replacements.has(entry.name) && !entry.bytes.equals(after.get(entry.name)!)) fail('DOCX preservation verification failed.');
  if (checked.entries.length !== parsed.entries.length + additions.length || plainText(main.root) !== plainText(checked.parts.get(main.name)!.root)) fail('DOCX text preservation verification failed.');
  const anchors = new Map(selected.map(item => [item.id, '']));
  for (const block of checked.projection.blocks) for (const run of block.runs) for (const key of run.commentIds ?? []) if (anchors.has(key)) anchors.set(key, anchors.get(key)! + run.text);
  for (const item of selected) {
    const comment = checked.projection.comments.find(comment => comment.id === item.id);
    if (anchors.get(item.id) !== item.comment.passage.quote || comment?.author !== item.comment.author || comment.date !== item.comment.date || comment.blocks.length !== 1 || comment.blocks[0]!.text !== item.comment.body) fail('DOCX comment linkage verification failed.');
  }
  return { bytes: output, projection: checked.projection };
}

export async function processDocx(bytes: Uint8Array, replacement?: DocxReplacement, attribution?: {author:string;date:string}, comments?: DocxPackageComment[], replacements?: DocxPassageReplacement[], resolution?: true | DocxChangeDecision[]): Promise<{bytes:Uint8Array;projection:DocxProjection;resolution?:DocxResolutionInspection}> {
  const parsed=build(await readZip(bytes));
  if (resolution !== undefined) {
    if (replacement || comments !== undefined || replacements !== undefined) fail('DOCX operations cannot be combined.');
    const inspection = inspectResolution(parsed);
    return resolution === true ? { bytes, projection: parsed.projection, resolution: inspection } : resolveChanges(parsed, resolution, inspection);
  }
  if (replacements !== undefined) { if (replacement || comments !== undefined) fail('DOCX operations cannot be combined.'); return replaceBatch(parsed, replacements, attribution); }
  if(comments!==undefined){if(replacement)fail('DOCX operations cannot be combined.');return exportDiscussion(parsed,comments);} if(!replacement)return {bytes,projection:parsed.projection};
  if(!replacement||typeof replacement.rangeId!=='string'||typeof replacement.quote!=='string'||typeof replacement.replacement!=='string'||!Number.isSafeInteger(replacement.start)||!Number.isSafeInteger(replacement.end))fail('Choose an exact editable DOCX text range.');
  const range=parsed.ranges.get(replacement.rangeId); if(!range)fail('That DOCX text range is unsupported or no longer matches the source.');
  const {part,run,text}=range!; const {start,end,quote}=replacement;
  if(start<0||end<=start||end>text.text.length||end-start>DOCX_LIMITS.replacementLength||replacement.replacement.length>DOCX_LIMITS.replacementLength||text.text.slice(start,end)!==quote||splitSurrogate(text.text,start)||splitSurrogate(text.text,end)||!validText(replacement.replacement)||/[\r\n\t]/.test(replacement.replacement))fail('Replacement must match one supported run and contain valid single-line text.');
  if(quote===replacement.replacement)return {bytes,projection:parsed.projection};
  if(parsed.signed)fail('Signed DOCX packages cannot be edited without invalidating their signatures.');
  if(!attribution||typeof attribution.author!=='string'||!attribution.author.trim()||attribution.author.length>255||!validText(attribution.author)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(attribution.date)||!Number.isFinite(Date.parse(attribution.date)))fail('Tracked replacement requires valid author and UTC date metadata.');
  const max = greatestRevisionId(parsed);
  let prefix='docxEdit';while(part.text.includes(`${prefix}:`)||part.text.includes(`xmlns:${prefix}`))prefix+='X';
  const rawOpen=part.text.slice(run.start,run.openEnd),rawClose=part.text.slice(run.closeStart,run.end),props=child(run,'rPr');
  const propsRaw=props?part.text.slice(props.start,props.end):'';
  const fragment=(value:string,deleted=false)=>{
    let open=part.text.slice(text.start,text.openEnd).replace(/\s+xml:space\s*=\s*(?:"[^"]*"|'[^']*')/g,'').replace(/\s*\/?>$/,' xml:space="preserve">');
    const name=deleted?text.name.replace(/(?:^|:)t$/,(m)=>m.startsWith(':')?':delText':'delText'):text.name;
    if(deleted)open=open.replace(new RegExp(`^<${text.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=[\\s>])`),`<${name}`);
    return `${rawOpen}${propsRaw}${open}${escape(value)}</${name}>${rawClose}`;
  };
  const mark=(kind:'ins'|'del',value:string,n:number)=>`<${prefix}:${kind} xmlns:${prefix}="${run.uri}" ${prefix}:id="${n}" ${prefix}:author="${escape(attribution.author)}" ${prefix}:date="${escape(attribution.date)}">${fragment(value,kind==='del')}</${prefix}:${kind}>`;
  const patch=(start?fragment(text.text.slice(0,start)):'')+mark('del',quote,max+1)+(replacement.replacement?mark('ins',replacement.replacement,max+2):'')+(end<text.text.length?fragment(text.text.slice(end)):'');
  const output=await writeZip(parsed.entries,part.name,encode(part,part.text.slice(0,run.start)+patch+part.text.slice(run.end)));
  const checked=build(await readZip(output));
  // The hash comparison deliberately covers all opaque and unsupported parts too.
  const after=new Map(checked.entries.map(e=>[e.name,e.bytes]));for(const entry of parsed.entries)if(entry.name!==part.name&&createHash('sha256').update(entry.bytes).digest('hex')!==createHash('sha256').update(after.get(entry.name)!).digest('hex'))fail('DOCX preservation verification failed.');
  return {bytes:output,projection:checked.projection};
}

async function replaceBatch(parsed: Parsed, replacements: DocxPassageReplacement[], attribution?: { author: string; date: string }): Promise<{ bytes: Uint8Array; projection: DocxProjection }> {
  validateDocxBatch(parsed.projection, replacements);
  if (parsed.signed) fail('Signed DOCX packages cannot be edited without invalidating their signatures.');
  if (!attribution || typeof attribution.author !== 'string' || !attribution.author.trim() || attribution.author.length > 255 || !validText(attribution.author)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(attribution.date) || !Number.isFinite(Date.parse(attribution.date))) fail('Tracked replacement requires valid author and UTC date metadata.');
  const part = parsed.parts.get(parsed.projection.mainPart)!;
  const nodes = new Map(part.nodes.filter(node => isWord(node, 'p')).map(node => [id('block', part.name, node), node]));
  const groups = new Map<string, DocxPassageReplacement[]>();
  for (const edit of replacements) { const group = groups.get(edit.blockId) ?? []; group.push(edit); groups.set(edit.blockId, group); }
  const paragraphs: { edits: DocxPassageReplacement[]; runs: { run: Node; text: Node; start: number; end: number }[] }[] = [];
  // Validate every selected paragraph, including the last edit, before preparing XML.
  for (const [blockId, edits] of groups) {
    const paragraph = nodes.get(blockId);
    if (!paragraph || !paragraph.parent || !isWord(paragraph.parent, 'body') || paragraph.text.trim() || unsafeProperties(paragraph)
      || paragraph.children.some((node, index) => !isWord(node, 'r') && !(index === 0 && isWord(node, 'pPr')))) fail('Batch edits require ordinary main-document paragraphs without fields, notes, revisions, tables or complex markup.');
    const runs: { run: Node; text: Node; start: number; end: number }[] = []; let offset = 0;
    for (const run of paragraph.children.filter(node => isWord(node, 'r'))) {
      const text = child(run, 't');
      if (!text || !safeRun(part, run, text, paragraph) || !parsed.ranges.has(id('range', part.name, run))) fail('The complete selected paragraph must contain ordinary editable runs.');
      runs.push({ run, text, start: offset, end: offset + text.text.length }); offset += text.text.length;
    }
    paragraphs.push({ edits: [...edits].sort((a, b) => a.start - b.start), runs });
  }
  let nextId = greatestRevisionId(parsed);
  const prefix = freshPrefix([part.text], 'docxBatch');
  const patches: { start: number; end: number; xml: string }[] = [];
  for (const paragraph of paragraphs) {
    let editIndex = 0;
    for (const { run, text, start, end } of paragraph.runs) {
      while (paragraph.edits[editIndex] && paragraph.edits[editIndex]!.end <= start) editIndex++;
      const edits: DocxPassageReplacement[] = [];
      for (let index = editIndex; index < paragraph.edits.length && paragraph.edits[index]!.start < end; index++) edits.push(paragraph.edits[index]!);
      if (!edits.length) continue;
      const props = child(run, 'rPr'), properties = props ? part.text.slice(props.start, props.end) : '';
      const fragment = (value: string, deleted = false) => {
        const name = deleted ? text.name.replace(/(?:^|:)t$/, match => match.startsWith(':') ? ':delText' : 'delText') : text.name;
        let open = part.text.slice(text.start, text.openEnd).replace(/\s+xml:space\s*=\s*(?:"[^"]*"|'[^']*')/g, '').replace(/\s*\/?>$/, ' xml:space="preserve">');
        if (deleted) open = `<${name}${open.slice(text.name.length + 1)}`;
        return `${part.text.slice(run.start, run.openEnd)}${properties}${open}${escapeText(value)}</${name}>${part.text.slice(run.closeStart, run.end)}`;
      };
      const mark = (kind: 'ins' | 'del', value: string) => {
        if (++nextId > 2_147_483_647) fail('DOCX revision IDs exceed the supported edit range.');
        return `<${prefix}:${kind} xmlns:${prefix}="${run.uri}" ${prefix}:id="${nextId}" ${prefix}:author="${escapeAttribute(attribution.author)}" ${prefix}:date="${escapeAttribute(attribution.date)}">${fragment(value, kind === 'del')}</${prefix}:${kind}>`;
      };
      let cursor = 0, xml = '';
      for (const edit of edits) {
        const from = Math.max(start, edit.start) - start, to = Math.min(end, edit.end) - start;
        if (from > cursor) xml += fragment(text.text.slice(cursor, from));
        xml += mark('del', text.text.slice(from, to));
        if (edit.start >= start && edit.start < end && edit.replacement) xml += mark('ins', edit.replacement);
        cursor = to;
      }
      if (cursor < text.text.length) xml += fragment(text.text.slice(cursor));
      patches.push({ start: run.start, end: run.end, xml });
    }
  }
  let cursor = 0; const chunks: string[] = [];
  for (const patch of patches.sort((a, b) => a.start - b.start)) { chunks.push(part.text.slice(cursor, patch.start), patch.xml); cursor = patch.end; }
  chunks.push(part.text.slice(cursor));
  const changed = encode(part, chunks.join(''));
  if (changed.length > DOCX_LIMITS.xmlBytes) fail('Edited DOCX XML exceeds its part limit.');
  const bytes = await writeZip(parsed.entries, part.name, changed), checked = build(await readZip(bytes));
  const after = new Map(checked.entries.map(entry => [entry.name, entry.bytes]));
  for (const entry of parsed.entries) if (entry.name !== part.name && !entry.bytes.equals(after.get(entry.name)!)) fail('DOCX preservation verification failed.');
  return { bytes, projection: checked.projection };
}

function inspectResolution(parsed: Parsed): DocxResolutionInspection {
  const result: DocxResolutionInspection = { format: 'phabricator.docx.resolution.v1', changes: [], paragraphs: [], unsupportedChanges: [] };
  const part = parsed.parts.get(parsed.projection.mainPart)!, unsafe = new Set<Node>(), ranges = new Set<string>(); let fields = 0;
  // Fields and annotation/move ranges can begin in an earlier paragraph.
  for (const node of part.nodes) {
    const paragraph = isWord(node, 'p') ? node : ancestry(node, 'p');
    if (paragraph && (fields || ranges.size)) unsafe.add(paragraph);
    if (!isWord(node)) continue;
    if (node.local === 'fldChar') { if (paragraph) unsafe.add(paragraph); if (attr(node, 'fldCharType') === 'begin') fields++; else if (attr(node, 'fldCharType') === 'end') fields = Math.max(0, fields - 1); }
    const range = /^(commentRange|bookmark|moveFromRange|moveToRange)(Start|End)$/.exec(node.local);
    if (range) { if (paragraph) unsafe.add(paragraph); let key: string; try { key = `${range[1]}:${commentId(attr(node, 'id'))}`; } catch { key = `${range[1]}:invalid`; }
      if (range[2] === 'Start') ranges.add(key); else ranges.delete(key);
    }
  }
  for (const paragraph of part.nodes.filter(node => isWord(node, 'p'))) {
    const revisions = paragraph.children.filter(node => isWord(node) && ['ins', 'del'].includes(node.local));
    if (!revisions.length || parsed.signed || unsafe.has(paragraph) || !paragraph.parent || !isWord(paragraph.parent, 'body') || paragraph.text.trim() || unsafeProperties(paragraph)) continue;
    const segments: DocxResolutionSegment[] = []; let valid = true;
    for (const [index, node] of paragraph.children.entries()) {
      if (index === 0 && isWord(node, 'pPr')) continue;
      if (isWord(node, 'r')) {
        const text = child(node, 't'); if (!text || !safeRun(part, node, text, paragraph)) { valid = false; break; }
        segments.push({ text: text.text }); continue;
      }
      if (!isWord(node) || !['ins', 'del'].includes(node.local) || !node.children.length || node.text.trim()
        || Object.values(node.attributes).some(attribute => attribute.uri !== 'http://www.w3.org/2000/xmlns/' && !(WORD.has(attribute.uri) && ['id', 'author', 'date'].includes(attribute.local)))) { valid = false; break; }
      const kind = node.local as 'ins' | 'del', runs: string[] = [];
      for (const run of node.children) {
        const text = child(run, kind === 'del' ? 'delText' : 't');
        if (!isWord(run, 'r') || !text || !safeRun(part, run, text, paragraph, node)) { valid = false; break; }
        runs.push(text.text);
      }
      if (!valid) break;
      segments.push({ text: runs.join(''), kind, changeId: id('change', part.name, node) });
    }
    if (!valid) continue;
    const blockId = id('block', part.name, paragraph); result.paragraphs.push({ blockId, segments });
    for (const node of revisions) result.changes.push({ changeId: id('change', part.name, node), blockId, kind: node.local as 'ins' | 'del', text: plainText(node), ...(attr(node, 'author') !== undefined ? { author: attr(node, 'author') } : {}), ...(attr(node, 'date') !== undefined ? { date: attr(node, 'date') } : {}) });
  }
  const supported = new Set(result.changes.map(change => change.changeId));
  result.unsupportedChanges = parsed.projection.changes.filter(change => !supported.has(change.id)).map(change => ({ changeId: change.id, reason: parsed.signed ? 'Signed packages cannot be changed.' : 'Only ordinary main-document paragraph text changes without nested revisions, fields, notes, tables, annotation ranges or complex markup are supported.' }));
  if (Buffer.byteLength(JSON.stringify(result)) > DOCX_LIMITS.projectionBytes) fail('DOCX change inspection exceeds its 2 MiB limit.');
  return result;
}

async function resolveChanges(parsed: Parsed, decisions: DocxChangeDecision[], inspection: DocxResolutionInspection): Promise<{ bytes: Uint8Array; projection: DocxProjection }> {
  validateDocxResolution(parsed.projection, decisions, inspection);
  const part = parsed.parts.get(parsed.projection.mainPart)!, nodes = new Map(part.nodes.filter(node => isWord(node) && ['ins', 'del'].includes(node.local)).map(node => [id('change', part.name, node), node]));
  const patches: { start: number; end: number; text: string }[] = [];
  for (const decision of decisions) {
    const node = nodes.get(decision.changeId)!;
    if (decision.action === (node.local === 'ins' ? 'reject' : 'accept')) { patches.push({ start: node.start, end: node.end, text: '' }); continue; }
    const inner: { start: number; end: number; text: string }[] = [];
    const namespaces = Object.values(node.attributes).filter(attribute => attribute.uri === 'http://www.w3.org/2000/xmlns/');
    for (const run of node.children) {
      // Removing a revision wrapper must retain namespace bindings used by runs,
      // properties or text beneath it, including a locally declared default NS.
      const inherited = namespaces.filter(attribute => !Object.values(run.attributes).some(own => own.name === attribute.name));
      if (inherited.length) inner.push({ start: run.start, end: run.openEnd, text: part.text.slice(run.start, run.openEnd).replace(/>$/, `${inherited.map(attribute => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`).join('')}>`) });
      if (node.local === 'del') {
        const text = child(run, 'delText')!, name = text.name.replace(/(?:^|:)delText$/, match => match.startsWith(':') ? ':t' : 't');
        inner.push({ start: text.start + 1, end: text.start + 1 + text.name.length, text: name }, { start: text.closeStart + 2, end: text.closeStart + 2 + text.name.length, text: name });
      }
    }
    let cursor = node.openEnd, body = '';
    for (const patch of inner.sort((a, b) => a.start - b.start)) { body += part.text.slice(cursor, patch.start) + patch.text; cursor = patch.end; }
    body += part.text.slice(cursor, node.closeStart); patches.push({ start: node.start, end: node.end, text: body });
  }
  let cursor = 0, xml = '';
  for (const patch of patches.sort((a, b) => a.start - b.start)) { xml += part.text.slice(cursor, patch.start) + patch.text; cursor = patch.end; }
  xml += part.text.slice(cursor);
  const changed = encode(part, xml); if (changed.length > DOCX_LIMITS.xmlBytes) fail('Resolved DOCX XML exceeds its part limit.');
  const bytes = await writeZip(parsed.entries, part.name, changed), checked = build(await readZip(bytes)), after = new Map(checked.entries.map(entry => [entry.name, entry.bytes]));
  for (const entry of parsed.entries) if (entry.name !== part.name && !entry.bytes.equals(after.get(entry.name)!)) fail('DOCX preservation verification failed.');
  return { bytes, projection: checked.projection };
}
