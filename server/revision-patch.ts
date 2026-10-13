import { createHash } from 'node:crypto';
import type { GitImportSnapshot, GitObjectFormat, GitSourceProvenance } from '../shared/repositories.ts';
import { isRevisionId } from '../shared/revision-dependencies.ts';
import { isPortableWorkingCopyPath, revisionPatchBaseline, type RevisionPatchChange, type RevisionPatchFile, type RevisionPatchIdentity, type RevisionPatchManifestEntry, type RevisionPatchPayload } from '../shared/revision-patch.ts';
import { sourceSnapshotCanonical, validateSourceSnapshot } from '../shared/source-snapshot.ts';
import type { RevisionVersion, SourceFile } from '../shared/types.ts';
import { files as validateFiles, HttpError } from './validation.ts';

export interface RevisionPatchTreeObject { type: 'tree'; objectId: string; bytes: Buffer }
export interface RevisionPatchTree { treeId: string; objects: RevisionPatchTreeObject[] }
const invalid = (): HttpError => new HttpError(422, 'The immutable revision patch could not be verified. It requires a complete, portable Git text tree with matching source identities.', 'REVISION_PATCH_INVALID');
const byPath = (a: { path: string }, b: { path: string }): number => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const oid = (value: unknown, format: GitObjectFormat): value is string => typeof value === 'string' && (format === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value);
const hash = (files: readonly SourceFile[]): string => createHash('sha256').update(sourceSnapshotCanonical(files)).digest('hex');
export const revisionPatchObjectId = (format: GitObjectFormat, type: 'tree' | 'blob', bytes: Uint8Array): string => createHash(format).update(`${type} ${bytes.byteLength}\0`).update(bytes).digest('hex');

function portablePaths(entries: readonly { path: string }[]): void {
  try { validateSourceSnapshot(entries.map(({ path }) => ({ path, content: '' }))); } catch { throw invalid(); }
  for (const { path } of entries) if (!isPortableWorkingCopyPath(path)) throw invalid();
}

function manifest(input: unknown, format: GitObjectFormat): RevisionPatchManifestEntry[] {
  if (!Array.isArray(input) || input.length > 20_000) throw invalid();
  const entries = input.map((value: unknown): RevisionPatchManifestEntry => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some(key => !['path', 'mode', 'objectId'].includes(key)) || typeof entry.path !== 'string' || !['100644', '100755'].includes(String(entry.mode)) || !oid(entry.objectId, format)) throw invalid();
    return { path: entry.path, mode: entry.mode as RevisionPatchManifestEntry['mode'], objectId: entry.objectId };
  }).sort(byPath);
  portablePaths(entries);
  return entries;
}

/** Construct Git's canonical raw tree objects without invoking Git or filters. */
export function buildRevisionPatchTree(input: readonly RevisionPatchManifestEntry[], format: GitObjectFormat): RevisionPatchTree {
  if (format !== 'sha1' && format !== 'sha256') throw invalid();
  const entries = manifest(input, format);
  interface Directory { children: Map<string, Directory | RevisionPatchManifestEntry> }
  const root: Directory = { children: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split('/'); let directory = root;
    for (const part of parts.slice(0, -1)) {
      let child = directory.children.get(part);
      if (!child) { child = { children: new Map() }; directory.children.set(part, child); }
      if (!('children' in child)) throw invalid();
      directory = child;
    }
    const name = parts.at(-1)!; if (directory.children.has(name)) throw invalid(); directory.children.set(name, entry);
  }
  const objects: RevisionPatchTreeObject[] = [];
  const build = (directory: Directory): string => {
    const records = [...directory.children].map(([name, child]) => 'children' in child
      ? { name, sort: Buffer.from(`${name}/`), mode: '40000', objectId: build(child) }
      : { name, sort: Buffer.from(name), mode: child.mode, objectId: child.objectId });
    records.sort((a, b) => Buffer.compare(a.sort, b.sort));
    const bytes = Buffer.concat(records.flatMap(entry => [Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.objectId, 'hex')]));
    const objectId = revisionPatchObjectId(format, 'tree', bytes); objects.push({ type: 'tree', objectId, bytes }); return objectId;
  };
  return { treeId: build(root), objects };
}

function textFiles(input: unknown): SourceFile[] {
  let result: SourceFile[];
  try { result = validateFiles(input); } catch { throw invalid(); }
  portablePaths(result);
  for (const file of result) if (/[\uD800-\uDFFF]/u.test(file.content) || file.content.includes('\0')) throw invalid();
  return result.sort(byPath);
}

function verifiedSource(repositoryId: string, sourceFiles: readonly SourceFile[], source: GitSourceProvenance): { files: SourceFile[]; manifest: RevisionPatchManifestEntry[] } {
  if (!source || source.kind !== 'git' || source.repositoryId !== repositoryId || source.scope !== 'complete-text-tree' || !['sha1', 'sha256'].includes(source.objectFormat) || !oid(source.commitId, source.objectFormat) || !oid(source.treeId, source.objectFormat)) throw invalid();
  const files = textFiles(sourceFiles), entries = manifest(source.manifest, source.objectFormat);
  if (files.length !== entries.length || files.some((file, index) => file.path !== entries[index]!.path || revisionPatchObjectId(source.objectFormat, 'blob', Buffer.from(file.content)) !== entries[index]!.objectId) || buildRevisionPatchTree(entries, source.objectFormat).treeId !== source.treeId) throw invalid();
  return { files, manifest: entries };
}

function versionFiles(version: RevisionVersion): SourceFile[] {
  if (!version || !isRevisionId(version.revisionId) || !identifier(version.id) || !Number.isSafeInteger(version.number) || version.number < 1 || version.docx || version.assets?.length || !digest(version.contentHash)) throw invalid();
  const files = textFiles(version.files); if (hash(files) !== version.contentHash) throw invalid(); return files;
}

export function revisionPatchIdentity(patch: RevisionPatchIdentity): RevisionPatchIdentity {
  return { revisionId: patch.revisionId, versionId: patch.versionId, versionNumber: patch.versionNumber, contentHash: patch.contentHash, baseVersionId: patch.baseVersionId, baseContentHash: patch.baseContentHash, baseCommitId: patch.baseCommitId, baseTreeId: patch.baseTreeId, targetTreeId: patch.targetTreeId, objectFormat: patch.objectFormat, patchSha256: patch.patchSha256 };
}

function payloadDigest(patch: Omit<RevisionPatchPayload, 'patchSha256'>): string {
  return createHash('sha256').update(JSON.stringify({ format: patch.format, repositoryId: patch.repositoryId, revisionId: patch.revisionId, versionId: patch.versionId, versionNumber: patch.versionNumber, contentHash: patch.contentHash, baseVersionId: patch.baseVersionId, baseContentHash: patch.baseContentHash, baseCommitId: patch.baseCommitId, baseTreeId: patch.baseTreeId, targetTreeId: patch.targetTreeId, objectFormat: patch.objectFormat, baseManifest: patch.baseManifest, files: patch.files })).digest('hex');
}

function createPatch(repositoryId: string, version: RevisionVersion, base: { files: readonly SourceFile[]; source: GitSourceProvenance; versionId: string | null; contentHash: string }, targetModes?: readonly RevisionPatchManifestEntry[]): RevisionPatchPayload {
  if (!/^R[1-9]\d*$/.test(repositoryId)) throw invalid();
  const source = verifiedSource(repositoryId, base.files, base.source), target = versionFiles(version);
  if (hash(source.files) !== base.contentHash || base.versionId !== null && !identifier(base.versionId)) throw invalid();
  let modes = targetModes ? manifest(targetModes, base.source.objectFormat) : source.manifest;
  if (version.gitSource) {
    const imported = verifiedSource(repositoryId, target, version.gitSource);
    if (version.gitSource.objectFormat !== base.source.objectFormat) throw invalid();
    modes = imported.manifest;
  }
  const modeMap = new Map(modes.map(entry => [entry.path, entry.mode]));
  const files: RevisionPatchFile[] = target.map(file => ({ path: file.path, mode: modeMap.get(file.path) ?? '100644', content: file.content }));
  const targetManifest = files.map(file => ({ path: file.path, mode: file.mode, objectId: revisionPatchObjectId(base.source.objectFormat, 'blob', Buffer.from(file.content)) }));
  const patch: Omit<RevisionPatchPayload, 'patchSha256'> = { format: 'revision-text-tree-v1', repositoryId, revisionId: version.revisionId, versionId: version.id, versionNumber: version.number, contentHash: version.contentHash, baseVersionId: base.versionId, baseContentHash: base.contentHash, baseCommitId: base.source.commitId, baseTreeId: base.source.treeId, targetTreeId: buildRevisionPatchTree(targetManifest, base.source.objectFormat).treeId, objectFormat: base.source.objectFormat, baseManifest: source.manifest, files };
  return { ...patch, patchSha256: payloadDigest(patch) };
}

/** Edited versions use the most recent verified complete Git import. Selecting
 * the import itself is valid and produces an unchanged exact working copy. */
export function resolveRevisionPatch(repositoryId: string, versions: readonly RevisionVersion[], versionId: string, contentHash: string): RevisionPatchPayload {
  const selection = revisionPatchBaseline(repositoryId, versions, versionId);
  if (selection.reason || !selection.version || !selection.baseline?.gitSource || selection.version.contentHash !== contentHash) throw invalid();
  const baseline = selection.baseline; versionFiles(baseline);
  return createPatch(repositoryId, selection.version, { files: baseline.files, source: baseline.gitSource!, versionId: baseline.id, contentHash: baseline.contentHash });
}

/** Landing may choose an explicit verified Git baseline, including an imported
 * commit's parent. Null baseVersionId never impersonates a revision version. */
export function createRevisionPatchFromGitBase(repositoryId: string, version: RevisionVersion, snapshot: GitImportSnapshot, targetModes?: readonly RevisionPatchManifestEntry[]): RevisionPatchPayload {
  if (snapshot.repositoryId !== repositoryId || snapshot.objectFormat !== snapshot.provenance?.objectFormat) throw invalid();
  return createPatch(repositoryId, version, { files: snapshot.files, source: snapshot.provenance, versionId: null, contentHash: hash(snapshot.files) }, targetModes);
}

/** Validate a transported patch before using paths, file bytes, or Git IDs. */
export function verifyRevisionPatch(input: unknown): RevisionPatchPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['format', 'repositoryId', 'revisionId', 'versionId', 'versionNumber', 'contentHash', 'baseVersionId', 'baseContentHash', 'baseCommitId', 'baseTreeId', 'targetTreeId', 'objectFormat', 'patchSha256', 'baseManifest', 'files'].includes(key)) || value.format !== 'revision-text-tree-v1' || typeof value.repositoryId !== 'string' || !/^R[1-9]\d*$/.test(value.repositoryId) || !isRevisionId(value.revisionId) || !identifier(value.versionId) || !Number.isSafeInteger(value.versionNumber) || Number(value.versionNumber) < 1 || !digest(value.contentHash) || value.baseVersionId !== null && !identifier(value.baseVersionId) || !digest(value.baseContentHash) || !digest(value.patchSha256) || value.objectFormat !== 'sha1' && value.objectFormat !== 'sha256' || !Array.isArray(value.files)) throw invalid();
  const format = value.objectFormat;
  if (!oid(value.baseCommitId, format) || !oid(value.baseTreeId, format) || !oid(value.targetTreeId, format)) throw invalid();
  const baseManifest = manifest(value.baseManifest, format);
  const rawFiles = value.files.map((item: unknown): RevisionPatchFile => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid();
    const file = item as Record<string, unknown>;
    if (Object.keys(file).some(key => !['path', 'mode', 'content'].includes(key)) || typeof file.path !== 'string' || typeof file.content !== 'string' || file.mode !== '100644' && file.mode !== '100755') throw invalid();
    return { path: file.path, mode: file.mode, content: file.content };
  }).sort(byPath);
  const sources = textFiles(rawFiles.map(({ path, content }) => ({ path, content })));
  const patch: RevisionPatchPayload = { format: 'revision-text-tree-v1', repositoryId: value.repositoryId, revisionId: value.revisionId, versionId: value.versionId, versionNumber: value.versionNumber as number, contentHash: value.contentHash, baseVersionId: value.baseVersionId as string | null, baseContentHash: value.baseContentHash, baseCommitId: value.baseCommitId, baseTreeId: value.baseTreeId, targetTreeId: value.targetTreeId, objectFormat: format, patchSha256: value.patchSha256, baseManifest, files: rawFiles };
  const target = rawFiles.map(file => ({ path: file.path, mode: file.mode, objectId: revisionPatchObjectId(format, 'blob', Buffer.from(file.content)) }));
  if (hash(sources) !== patch.contentHash || buildRevisionPatchTree(baseManifest, format).treeId !== patch.baseTreeId || buildRevisionPatchTree(target, format).treeId !== patch.targetTreeId || payloadDigest(patch) !== patch.patchSha256) throw invalid();
  return patch;
}

export function revisionPatchChanges(input: RevisionPatchPayload): RevisionPatchChange[] {
  const patch = verifyRevisionPatch(input), before = new Map(patch.baseManifest.map(entry => [entry.path, entry])), after = new Map(patch.files.map(file => [file.path, { path: file.path, mode: file.mode, objectId: revisionPatchObjectId(patch.objectFormat, 'blob', Buffer.from(file.content)), content: file.content }]));
  const result: RevisionPatchChange[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const oldFile = before.get(path) ?? null, newFile = after.get(path) ?? null;
    if (oldFile?.objectId === newFile?.objectId && oldFile?.mode === newFile?.mode) continue;
    result.push({ path, before: oldFile, after: newFile });
  }
  return result;
}
