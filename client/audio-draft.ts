import type { AudioClip } from './audio-inbox';
import { assertSession, sessionIsActive, type WorkspaceSession } from './session';

export interface TemporaryAudio { clip: AudioClip; notice: string }
const drafts = new WeakMap<WorkspaceSession, TemporaryAudio>();
const registered = new WeakSet<WorkspaceSession>();
export function temporaryAudio(session: WorkspaceSession | null): TemporaryAudio | null {
  return sessionIsActive(session) ? drafts.get(session) || null : null;
}
export function hasTemporaryAudio(session: WorkspaceSession | null): boolean { return temporaryAudio(session) !== null; }
export function retainTemporaryAudio(session: WorkspaceSession, value: TemporaryAudio): void {
  assertSession(session);
  if (!registered.has(session)) {
    registered.add(session);
    const hide = () => drafts.delete(session);
    const cleanup = () => { drafts.delete(session); registered.delete(session); if (typeof window !== 'undefined') window.removeEventListener('pagehide', hide); };
    session.cleanupCallbacks.add(cleanup);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', hide);
  }
  drafts.set(session, value);
}
export function discardTemporaryAudio(session: WorkspaceSession): void { assertSession(session); drafts.delete(session); }
