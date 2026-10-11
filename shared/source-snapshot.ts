import type { RevisionAsset } from './files';
import { FILE_MAX_BYTES, REVISION_ASSET_MAX_BYTES, REVISION_ASSET_MAX_COUNT } from './files';
import type { SourceFile } from './types';
import { DOCX_LIMITS, type DocxSource } from './docx';

const byPath = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** Preserve historical text-only identities; binary bindings introduce an explicit format version. */
export function sourceSnapshotCanonical(files: readonly SourceFile[], assets: readonly RevisionAsset[] = [], docx?: DocxSource): string {
  if (docx !== undefined) {
    validateDocxSource(docx);
    if (files.length || assets.length) throw new Error('DOCX versions cannot also contain text files or figure bindings.');
    return JSON.stringify({ format: 'phabricator.source.v3', docx: canonicalObject(docx) });
  }
  const text = [...files].sort(byPath).map(({ path, content }) => ({ path, content }));
  if (!assets.length) return JSON.stringify(text);
  return JSON.stringify({ format: 'phabricator.source.v2', files: text,
    assets: [...assets].sort(byPath).map(({ path, fileId, sha256, bytes, mediaType }) => ({ path, fileId, sha256, bytes, mediaType })) });
}

function canonicalObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalObject((value as Record<string, unknown>)[key])]));
  return value;
}

/** The projection is immutable review data; it is never executable markup. */
export function validateDocxSource(source: DocxSource): void {
  const fail = (): never => { throw new Error('Invalid immutable DOCX source.'); };
  let nodes = 0;
  const json = (value: unknown, depth: number): void => {
    if (++nodes > 200_000 || depth > 32) fail();
    if (typeof value === 'string') { if (value.length > DOCX_LIMITS.projectionBytes || /[\uD800-\uDFFF]/u.test(value) || value.includes('\0')) fail(); return; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return; }
    if (value === null || typeof value === 'boolean') return;
    if (!value || typeof value !== 'object') fail();
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail();
    for (const child of Object.values(value as object)) json(child, depth + 1);
  };
  json(source, 0);
  if (new TextEncoder().encode(JSON.stringify(source)).length > DOCX_LIMITS.projectionBytes + 4096) fail();
  const validDigest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const validBytes = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= DOCX_LIMITS.compressedBytes;
  if (source.format !== 'docx' || typeof source.fileName !== 'string' || !source.fileName || source.fileName.length > 240
    || /[\x00-\x1f\x7f/\\]/.test(source.fileName) || !validDigest(source.sha256) || !validBytes(source.bytes)
    || !source.sourceFile || !/^F[1-9]\d{0,14}$/.test(source.sourceFile.fileId) || !validDigest(source.sourceFile.sha256) || !validBytes(source.sourceFile.bytes)) fail();
  const projection = source.projection;
  if (new TextEncoder().encode(JSON.stringify(projection)).length > DOCX_LIMITS.projectionBytes) fail();
  if (!projection || projection.format !== 'phabricator.docx.projection.v1' || typeof projection.mainPart !== 'string' || !projection.mainPart
    || !Array.isArray(projection.blocks) || !Array.isArray(projection.notes) || !Array.isArray(projection.comments) || !Array.isArray(projection.changes)
    || !Array.isArray(projection.editableRanges) || !Array.isArray(projection.warnings) || projection.warnings.some(value => typeof value !== 'string')) fail();
  const blocks = [...projection.blocks, ...projection.notes.flatMap(note => { if (!note || typeof note.id !== 'string' || !['footnote', 'endnote'].includes(note.kind) || !Array.isArray(note.blocks)) return fail(); return note.blocks; }),
    ...projection.comments.flatMap(comment => { if (!comment || typeof comment.id !== 'string' || !Array.isArray(comment.blocks)) return fail(); return comment.blocks; })];
  const blockIds = new Map<string, string>();
  for (const block of blocks) {
    if (!block || typeof block.id !== 'string' || !block.id || blockIds.has(block.id) || typeof block.part !== 'string' || !block.part
      || !['paragraph', 'table-cell'].includes(block.kind) || typeof block.text !== 'string' || !Array.isArray(block.runs)
      || (block.headingLevel !== undefined && (!Number.isSafeInteger(block.headingLevel) || block.headingLevel < 1 || block.headingLevel > 9))) fail();
    blockIds.set(block.id, block.part);
    for (const run of block.runs) if (!run || typeof run.text !== 'string' || (run.change !== undefined && !['inserted', 'deleted', 'moveFrom', 'moveTo'].includes(run.change))
      || (run.commentIds !== undefined && (!Array.isArray(run.commentIds) || run.commentIds.some(id => typeof id !== 'string')))) fail();
  }
  const ranges = new Set<string>();
  for (const range of projection.editableRanges) {
    if (!range || typeof range.id !== 'string' || !range.id || ranges.has(range.id) || typeof range.part !== 'string' || typeof range.text !== 'string'
      || blockIds.get(range.blockId) !== range.part) fail();
    ranges.add(range.id);
  }
  for (const change of projection.changes) if (!change || typeof change.id !== 'string' || typeof change.part !== 'string' || typeof change.kind !== 'string' || typeof change.text !== 'string') fail();
}

/** One portable filesystem namespace prevents platform-dependent text/figure shadowing. */
export function validateSourceSnapshot(files: readonly SourceFile[], assets: readonly RevisionAsset[] = []): void {
  if (!Array.isArray(files) || !Array.isArray(assets) || assets.length > REVISION_ASSET_MAX_COUNT) throw new Error('Source assets exceed the supported count limit.');
  const entries = new Map<string, { path: string; file: boolean }>();
  for (const item of [...files, ...assets]) {
    const path = item.path;
    if (typeof path !== 'string' || !path || path.length > 240 || /[\x00-\x1f\x7f:\\]/.test(path) || /[\uD800-\uDFFF]/u.test(path)
      || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Source paths must be unique safe relative paths.');
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      const prefix = parts.slice(0, index + 1).join('/');
      // Upper/lower folding also catches common multi-character case aliases such as sharp S.
      const key = prefix.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
      const file = index === parts.length - 1;
      const previous = entries.get(key);
      if (previous && previous.path !== prefix) throw new Error('Source paths must not collide by Unicode normalization or case.');
      if (previous && (previous.file || file)) throw new Error(previous.file && file ? 'Source paths must be unique.' : 'A source file cannot also be a directory.');
      if (!previous) entries.set(key, { path: prefix, file });
    }
  }
  let total = 0;
  for (const asset of assets) {
    if (!/^F[1-9]\d{0,14}$/.test(asset.fileId) || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > FILE_MAX_BYTES
      || !['image/png', 'image/jpeg', 'application/pdf'].includes(asset.mediaType)) throw new Error('Binary asset identities must contain a valid file, digest, byte length and supported media type.');
    total += asset.bytes;
  }
  if (total > REVISION_ASSET_MAX_BYTES) throw new Error('Binary assets exceed the supported byte limit.');
}
