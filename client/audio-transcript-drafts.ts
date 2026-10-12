import type { LocalTranscript } from '../shared/local-transcription';
import { assertSession, type WorkspaceSession } from './session';

export interface TemporaryTranscript {
  pending: LocalTranscript | null;
  draft: { runId: string; text: string } | null;
  selectedRunId: string;
}
const drafts = new WeakMap<WorkspaceSession, Map<string, TemporaryTranscript>>();
export function temporaryTranscript(session: WorkspaceSession | null, clipId: string): TemporaryTranscript | null {
  try { assertSession(session); return drafts.get(session)?.get(clipId) ?? null; } catch { return null; }
}
export function hasTemporaryTranscripts(session: WorkspaceSession | null): boolean {
  try { assertSession(session); return Boolean(drafts.get(session)?.size); } catch { return false; }
}
export function retainTemporaryTranscript(session: WorkspaceSession, clipId: string, value: TemporaryTranscript): void {
  assertSession(session);
  let records = drafts.get(session);
  if (!records) {
    records = new Map(); drafts.set(session, records);
    const current = records;
    const hide = () => { current.clear(); };
    const cleanup = () => { hide(); drafts.delete(session); if (typeof window !== 'undefined') window.removeEventListener('pagehide', hide); };
    session.cleanupCallbacks.add(cleanup);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', hide);
  }
  records.set(clipId, structuredClone(value));
}
export function discardTemporaryTranscript(session: WorkspaceSession, clipId: string): void { assertSession(session); drafts.get(session)?.delete(clipId); }
