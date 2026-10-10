import { mountPath, normalizeBasePath } from '../shared/mount';

/** The HTML shell carries the same mount used by Vite and the server. */
export function applicationBase(): string {
  return normalizeBasePath(typeof document === 'undefined' ? '/' : document.querySelector<HTMLMetaElement>('meta[name="application-base"]')?.content || '/');
}

export function applicationPath(path: string): string { return mountPath(path, applicationBase()); }

/** Mounts separate installations' browser data; they are not a security boundary. */
export function storageKey(key: string, basePath = applicationBase()): string {
  const base = normalizeBasePath(basePath);
  // Preserve existing root installations' drafts and outboxes without migration.
  return base === '/' ? `phabricator-next:${key}` : `phabricator-next:mount:${encodeURIComponent(base)}:${key}`;
}
