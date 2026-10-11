import type { PaperBuild, PaperBuildInput, PaperSyncTeXMap, PaperSyncTeXPoint } from '../shared/paper-builds';
import type { WorkspaceClient } from './offline';
import { applicationPath } from './mount';
import { assertSession, lockSession, RequestError } from './session';

export interface PaperBuildRequest { id: string; revisionId: string; action: 'compile' | 'retry' | 'cancel'; buildId: string | null; input: PaperBuildInput; createdAt: string }
export function paperRequests(value: unknown, revisionId: string): PaperBuildRequest[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is PaperBuildRequest => Boolean(row && typeof row === 'object' && row.revisionId === revisionId && typeof row.id === 'string' && /^[0-9a-f-]{36}$/i.test(row.id) && ['compile', 'retry', 'cancel'].includes(row.action) && (row.action === 'compile' ? row.buildId === null : typeof row.buildId === 'string') && typeof row.createdAt === 'string' && row.input && ['versionId', 'contentHash', 'entrypoint', 'toolchainId'].every(key => typeof row.input[key] === 'string' && row.input[key].length > 0))).map(row => ({ id: row.id, revisionId, action: row.action, buildId: row.buildId, createdAt: row.createdAt, input: { versionId: row.input.versionId, contentHash: row.input.contentHash, entrypoint: row.input.entrypoint, toolchainId: row.input.toolchainId } }));
}
export function paperRequestMatches(build: PaperBuild, intent: PaperBuildRequest): boolean {
  return build.revisionId === intent.revisionId && (intent.action !== 'cancel' || build.id === intent.buildId) && (intent.action !== 'retry' || build.id !== intent.buildId) && (Object.keys(intent.input) as (keyof PaperBuildInput)[]).every(key => build[key] === intent.input[key]);
}
export function sourcePoint(map: PaperSyncTeXMap, path: string, line: number): PaperSyncTeXPoint | null {
  let selected: PaperSyncTeXPoint | null = null;
  for (const point of map.points) if (point.path === path && (!selected || Math.abs(point.line - line) < Math.abs(selected.line - line))) selected = point;
  return selected;
}
export function pdfPoint(map: PaperSyncTeXMap, page: number, x: number, y: number): PaperSyncTeXPoint | null {
  let selected: PaperSyncTeXPoint | null = null, distance = Infinity;
  for (const point of map.points) {
    if (point.page !== page) continue;
    const dx = Math.max(point.x - x, 0, x - point.x - point.width), dy = Math.max(point.y - y, 0, y - point.y - point.height);
    const candidate = dx * dx + dy * dy;
    if (candidate < distance || (candidate === distance && selected && point.width * point.height < selected.width * selected.height)) { selected = point; distance = candidate; }
  }
  return selected;
}

/** Binary artifacts never enter local storage or use an unguarded public URL. */
export async function paperArtifact(client: WorkspaceClient, revisionId: string, buildId: string, kind: string, expectedBytes: number, expectedHash: string, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const session = client.session; assertSession(session);
  const objectGeneration = session.objectGenerations.get(revisionId) || 0, accessEpoch = session.accessEpoch;
  const sourceId = session.revisionRepositories.get(revisionId), sourceGeneration = sourceId ? session.objectGenerations.get(sourceId) || 0 : 0;
  const controller = new AbortController();
  const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) controller.abort();
  session.controllers.add(controller); session.objectControllers.set(controller, revisionId);
  const verify = () => {
    assertSession(session);
    if (controller.signal.aborted || session.accessEpoch !== accessEpoch || client.unavailableObject(revisionId) || (session.objectGenerations.get(revisionId) || 0) !== objectGeneration || (sourceId && (client.unavailableObject(sourceId) || (session.objectGenerations.get(sourceId) || 0) !== sourceGeneration))) throw new RequestError('Access changed while loading this artifact. Reload its build before opening it.', 409, 'ACCESS_CHANGED');
  };
  try {
    verify();
    const response = await fetch(applicationPath(`/api/revisions/${revisionId}/paper-builds/${encodeURIComponent(buildId)}/artifacts/${kind}`), { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: session.state.sessionContext ? { 'X-Session-Context': session.state.sessionContext } : {}, signal: controller.signal });
    if (response.status === 401) { lockSession('Your session ended. Sign in again.'); throw new RequestError('Your session ended.', 401); }
    verify();
    if (!response.ok) {
      // Use the ordinary guarded read to apply source/repository revocation to
      // the whole workspace, including an already rendered source or PDF.
      if (response.status === 403 || response.status === 404) await client.request(`/api/revisions/${revisionId}`);
      throw new RequestError('The paper artifact is unavailable. Reload the build to verify access.', response.status);
    }
    const epoch = response.headers.get('X-Access-Epoch');
    if (epoch === null || Number(epoch) !== accessEpoch) throw new RequestError('Access changed while loading this artifact. Reload its build.', 409, 'ACCESS_CHANGED');
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || (kind === 'pdf' && expectedBytes === 0) || expectedBytes > 32 * 1024 * 1024 || response.headers.get('Content-Length') !== String(expectedBytes)) throw new Error('The artifact size does not match its immutable build record.');
    const bytes = new Uint8Array(expectedBytes), reader = response.body?.getReader(); let offset = 0;
    if (reader) try { while (true) { const item = await reader.read(); verify(); if (item.done) break; if (offset + item.value.byteLength > expectedBytes) { await reader.cancel(); throw new Error('The artifact exceeded its immutable size.'); } bytes.set(item.value, offset); offset += item.value.byteLength; } } finally { reader.releaseLock(); }
    verify();
    if (offset !== expectedBytes) throw new Error('The artifact was incomplete. Reload it to try again.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); verify();
    if (Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') !== expectedHash) throw new Error('The artifact does not match its immutable build record.');
    return bytes;
  } finally { controller.abort(); signal.removeEventListener('abort', abort); session.controllers.delete(controller); session.objectControllers.delete(controller); }
}
