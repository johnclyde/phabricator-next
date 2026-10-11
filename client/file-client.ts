import { FILE_MAX_BYTES, type FileRecord, type RevisionAsset, type UploadFileInput } from '../shared/files';
import type { WorkspaceClient } from './offline';
import { applicationPath } from './mount';
import { assertSession, lockSession, RequestError } from './session';

export interface UploadIntent { id: string; name: string; altText: string; sha256: string; bytes: number; createdAt: string }
/** A recovery record must never retain uploaded bytes, URLs or an alternate request body. */
export function uploadIntent(value: unknown): UploadIntent | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.id) || typeof row.name !== 'string' || !row.name || row.name.length > 240 || typeof row.altText !== 'string' || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0 || Number(row.bytes) > FILE_MAX_BYTES || typeof row.createdAt !== 'string') return null;
  return { id: row.id, name: row.name, altText: row.altText, sha256: row.sha256, bytes: Number(row.bytes), createdAt: row.createdAt };
}
/** Reserve one immutable request slot without replacing another tab's unconfirmed intent. */
export async function retainFileIntent<T extends { id: string }>(client: WorkspaceClient, key: string, intent: T): Promise<{ intent: T; accepted: boolean; persisted: boolean }> {
  const commit = () => {
    client.assertActive();
    const memory = client.readStored<T | null>(key, null);
    let durable: T | null = null;
    if (client.durable) try { const raw = localStorage.getItem(client.storageKey(key)); durable = raw ? JSON.parse(raw) as T : null; } catch { /* Retained session memory remains available if storage failed. */ }
    const conflict = [memory, durable].find(row => row && JSON.stringify(row) !== JSON.stringify(intent));
    if (conflict) return { intent: conflict, accepted: false, persisted: !client.draftHasUnsavedMemory(key) };
    const persisted = client.writeStored(key, intent);
    if (JSON.stringify(client.readStored(key, null)) !== JSON.stringify(intent)) throw new Error('This request could not be retained. Export the draft and reload access before saving.');
    return { intent, accepted: true, persisted };
  };
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(client.storageKey(`file-intent:${key}`), commit);
  if (client.durable) throw new Error('This browser cannot safely coordinate saved requests between tabs. Use a browser with Web Locks support before submitting.');
  return commit();
}
export const digestBytes = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
export function uploadMatches(file: FileRecord, intent: UploadIntent): boolean { return /^F\d+$/.test(file.id) && file.sha256 === intent.sha256 && file.bytes === intent.bytes && file.originalName === intent.name; }
export async function uploadBody(intent: UploadIntent, bytes: Uint8Array<ArrayBuffer>): Promise<UploadFileInput> {
  if (bytes.length !== intent.bytes || await digestBytes(bytes) !== intent.sha256) throw new Error('Select the exact original file. Its size and SHA-256 must match the submitted upload.');
  let binary = ''; for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return { name: intent.name, altText: intent.altText, sha256: intent.sha256, bytes: intent.bytes, dataBase64: btoa(binary) };
}
export function assetManifest(assets: readonly RevisionAsset[] = []): RevisionAsset[] { return assets.map(({ path, fileId, sha256, bytes, mediaType }) => ({ path, fileId, sha256, bytes, mediaType })).sort((a, b) => a.path.localeCompare(b.path)); }
export function sameAssets(a: readonly RevisionAsset[] = [], b: readonly RevisionAsset[] = []): boolean { return JSON.stringify(assetManifest(a)) === JSON.stringify(assetManifest(b)); }
export function assetChanges(base: readonly RevisionAsset[] = [], target: readonly RevisionAsset[] = []) {
  return [...new Set([...base.map(item => item.path), ...target.map(item => item.path)])].sort().flatMap(path => {
    const before = base.find(item => item.path === path), after = target.find(item => item.path === path);
    if (before && after && sameAssets([before], [after])) return [];
    return [{ path, before, after, kind: !before ? 'Added' : !after ? 'Removed' : 'Replaced' }];
  });
}
export function fileSize(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

/** Fetch authenticated bytes into bounded session memory; never hand an API URL to a renderer. */
export async function fileBytes(client: WorkspaceClient, file: Pick<FileRecord, 'id' | 'bytes' | 'sha256'>, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const session = client.session; assertSession(session);
  const epoch = session.accessEpoch, generation = session.objectGenerations.get(file.id) || 0;
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) controller.abort();
  session.controllers.add(controller); session.objectControllers.set(controller, file.id);
  const verify = () => { assertSession(session); if (controller.signal.aborted || epoch !== session.accessEpoch || client.unavailableObject(file.id) || generation !== (session.objectGenerations.get(file.id) || 0)) throw new RequestError('File access changed. Reload before downloading.', 409, 'ACCESS_CHANGED'); };
  try {
    verify();
    const response = await fetch(applicationPath(`/api/files/${file.id}/data`), { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: session.state.sessionContext ? { 'X-Session-Context': session.state.sessionContext } : {} });
    if (response.status === 401) { lockSession('Your session ended. Sign in again.'); throw new RequestError('Your session ended.', 401); }
    verify();
    if (!response.ok) { if (response.status === 403 || response.status === 404) client.retireUnavailableObject(file.id); throw new RequestError('This file is unavailable. Reload to verify access.', response.status); }
    if (response.headers.get('X-Access-Epoch') !== String(epoch)) throw new RequestError('File access changed. Reload before downloading.', 409, 'ACCESS_CHANGED');
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > FILE_MAX_BYTES || response.headers.get('Content-Length') !== String(file.bytes) || response.headers.get('X-Content-SHA256') !== file.sha256) throw new Error('File metadata did not match the immutable upload.');
    const bytes = new Uint8Array(file.bytes), reader = response.body?.getReader(); let offset = 0;
    if (reader) try { while (true) { const part = await reader.read(); verify(); if (part.done) break; if (offset + part.value.length > bytes.length) { await reader.cancel(); throw new Error('File exceeded its recorded size.'); } bytes.set(part.value, offset); offset += part.value.length; } } finally { reader.releaseLock(); }
    verify(); if (offset !== bytes.length || await digestBytes(bytes) !== file.sha256) throw new Error('File integrity verification failed.'); verify(); return bytes;
  } finally { controller.abort(); signal.removeEventListener('abort', abort); session.controllers.delete(controller); session.objectControllers.delete(controller); }
}
