import type { RevisionAsset } from './files';
import { FILE_MAX_BYTES, REVISION_ASSET_MAX_BYTES, REVISION_ASSET_MAX_COUNT } from './files';
import type { SourceFile } from './types';

const byPath = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** Preserve historical text-only identities; binary bindings introduce an explicit format version. */
export function sourceSnapshotCanonical(files: readonly SourceFile[], assets: readonly RevisionAsset[] = []): string {
  const text = [...files].sort(byPath).map(({ path, content }) => ({ path, content }));
  if (!assets.length) return JSON.stringify(text);
  return JSON.stringify({ format: 'phabricator.source.v2', files: text,
    assets: [...assets].sort(byPath).map(({ path, fileId, sha256, bytes, mediaType }) => ({ path, fileId, sha256, bytes, mediaType })) });
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
