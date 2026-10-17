import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { LockKeyhole, LogOut, ShieldCheck } from 'lucide-react';
import type { SessionState } from '../shared/auth';
import type { GoogleAuthPublicConfig } from '../shared/google-auth';
import { createWorkspaceClient, type WorkspaceClient } from './offline';
import { applicationPath, storageKey } from './mount';
import { sessionAudioClipCount } from './audio-inbox';
import { hasTemporaryAudio } from './audio-draft';
import { hasTemporaryTranscripts } from './audio-transcript-drafts';
import { authProvidersRequest, activateSession, broadcastSessionChange, currentSession, lockSession, logoutPending, markLogoutPending, onSessionLocked, rememberedLocalSession, rememberMode, RequestError, sessionRequest } from './session';

interface WorkspaceAccess extends WorkspaceClient { signOut: () => void }
const WorkspaceContext = createContext<WorkspaceAccess | null>(null);
export function useWorkspace(): WorkspaceAccess {
  const client = useContext(WorkspaceContext);
  if (!client) throw new Error('A verified workspace session is required.');
  return client;
}
function exportDrafts(client: WorkspaceClient): void {
  const blob = new Blob([JSON.stringify({ workspaceId: client.session?.state.workspaceId, drafts: client.draftRecords() }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = 'workspace-drafts.json'; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SessionGate({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<WorkspaceClient | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [google, setGoogle] = useState<GoogleAuthPublicConfig | null>(null);
  const [googleAuth, setGoogleAuth] = useState<import('./google-auth').PreparedGoogleAuth | null>(null);
  const [googleSetup, setGoogleSetup] = useState(0);
  const [pageActive, setPageActive] = useState(true);
  const [googleError, setGoogleError] = useState('');
  const [googleAttempt, setGoogleAttempt] = useState(false);
  const [googleExchanging, setGoogleExchanging] = useState(false);
  const googlePosted = useRef(false);
  const signingIn = useRef(false);
  const operation = useRef(0);
  const transport = useRef<AbortController | null>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const pendingLogout = useRef(logoutPending());

  const install = useCallback((next: SessionState) => {
    rememberMode(next); setSession(next); setError('');
    if (next.mode === 'password' && !next.account) {
      if (currentSession()) lockSession('Sign in to open this workspace.');
      setClient(null); return;
    }
    const current = currentSession();
    if (current && current.state.mode === next.mode && current.state.workspaceId === next.workspaceId && current.state.sessionContext === next.sessionContext && current.state.csrfToken === next.csrfToken) return;
    const context = activateSession(next);
    setClient(createWorkspaceClient(context)); setNotice('');
  }, []);

  const bootstrap = useCallback(async () => {
    const ticket = ++operation.current;
    if (signingIn.current) setGoogleSetup(value => value + 1);
    signingIn.current = false; googlePosted.current = false; setGoogleAttempt(false); setGoogleExchanging(false);
    transport.current?.abort();
    const controller = new AbortController(); transport.current = controller;
    if (!currentSession()) setBusy(true);
    try {
      let next = await sessionRequest('/api/session', { signal: controller.signal });
      if (ticket !== operation.current) return;
      if (pendingLogout.current || logoutPending()) {
        pendingLogout.current = true;
        if (next.mode === 'password' && next.account) next = await sessionRequest('/api/logout', { body: {}, csrfToken: next.csrfToken, sessionContext: next.sessionContext, signal: controller.signal });
        if (ticket !== operation.current) return;
        pendingLogout.current = false; markLogoutPending(false);
      }
      install(next);
    } catch (failure) {
      if (ticket !== operation.current || controller.signal.aborted) return;
      if (!currentSession() && !pendingLogout.current && failure instanceof TypeError) {
        const local = rememberedLocalSession();
        if (local) { install(local); return; }
      }
      if (!currentSession()) setError(pendingLogout.current
        ? 'Sign out is not complete on the server. Reconnect and retry to revoke the session. This tab remains locked.'
        : failure instanceof TypeError ? 'Reconnect to verify this workspace session. Protected workspaces cannot be opened offline.' : failure instanceof Error ? failure.message : 'Could not verify this workspace.');
    } finally { if (ticket === operation.current) setBusy(false); }
  }, [install]);

  useEffect(() => {
    const controller = new AbortController();
    let prepared: import('./google-auth').PreparedGoogleAuth | null = null;
    setGoogle(null); setGoogleAuth(null); setGoogleError('');
    if (pageActive && session?.mode === 'password' && !session.account && !pendingLogout.current) void (async () => {
      try {
        const providers = await authProvidersRequest(controller.signal);
        if (controller.signal.aborted || !providers.google) return;
        setGoogle(providers.google);
        const provider = await import('./google-auth');
        if (controller.signal.aborted) return;
        prepared = await provider.prepareGoogleAuth(providers.google, controller.signal);
        if (!controller.signal.aborted) setGoogleAuth(prepared); else prepared.dispose();
      } catch { if (!controller.signal.aborted) setGoogleError('Google sign-in is unavailable. Use your workspace password or retry Google setup.'); }
    })();
    return () => { controller.abort(); prepared?.dispose(); };
  }, [session?.mode, session?.workspaceId, Boolean(session?.account), googleSetup, pageActive]);

  useEffect(() => {
    const unsubscribe = onSessionLocked(reason => {
      setClient(null); setSession(null); setConfirmLogout(false); setPassword(''); setNotice(reason);
      if (!pendingLogout.current) void bootstrap();
    });
    void bootstrap();
    const storage = (event: StorageEvent) => {
      if (event.key !== storageKey('session-event') && event.key !== storageKey('logout-pending') && event.key !== null) return;
      pendingLogout.current = logoutPending();
      lockSession('Your session changed in another tab. Verifying access…');
      void bootstrap();
    };
    const resume = () => { if (document.visibilityState === 'visible') { setPageActive(true); if (!signingIn.current) void bootstrap(); } };
    const hide = () => { setPageActive(false); operation.current++; transport.current?.abort(); signingIn.current = false; googlePosted.current = false; setGoogleAttempt(false); setGoogleExchanging(false); setBusy(false); if (currentSession()?.state.mode === 'password') lockSession('Verify your session to reopen this workspace.'); };
    const unload = (event: BeforeUnloadEvent) => {
      const current = currentSession();
      if (current && (createWorkspaceClient(current).draftRecords().length > 0 || sessionAudioClipCount(current) > 0 || hasTemporaryAudio(current) || hasTemporaryTranscripts(current))) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('storage', storage); window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume);
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', resume);
    window.addEventListener('beforeunload', unload);
    return () => {
      operation.current += 1; transport.current?.abort(); unsubscribe();
      window.removeEventListener('storage', storage); window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume);
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', resume);
      window.removeEventListener('beforeunload', unload);
    };
  }, [bootstrap]);
  useEffect(() => {
    const expiresAt = client?.session?.state.expiresAt;
    if (!expiresAt) return;
    const timeout = setTimeout(() => { lockSession('Your session expired. Sign in again.'); void bootstrap(); }, Math.max(0, Date.parse(expiresAt) - Date.now()));
    return () => clearTimeout(timeout);
  }, [client, bootstrap]);
  useEffect(() => { if (confirmLogout) confirmation.current?.showModal(); }, [confirmLogout]);

  const login = async (event: FormEvent) => {
    event.preventDefault(); if (!session || signingIn.current || pendingLogout.current || logoutPending()) return;
    signingIn.current = true;
    const ticket = ++operation.current; transport.current?.abort();
    const controller = new AbortController(); transport.current = controller;
    setBusy(true); setError('');
    try {
      // Other tabs may have rotated the challenge cookie since this form opened.
      // Fetch its current context before the one explicitly requested login.
      const fresh = await sessionRequest('/api/session', { signal: controller.signal });
      if (ticket !== operation.current) return;
      rememberMode(fresh); setSession(fresh);
      if (fresh.mode !== 'password' || fresh.account) {
        setPassword(''); install(fresh);
        setNotice('Another tab changed this browser’s session. Sign out before switching accounts.');
        return;
      }
      const next = await sessionRequest('/api/login', { body: { username, password }, csrfToken: fresh.csrfToken, signal: controller.signal });
      if (ticket !== operation.current) return;
      setPassword(''); install(next); broadcastSessionChange('login');
    } catch (failure) {
      if (ticket !== operation.current || controller.signal.aborted) return;
      setPassword('');
      if (failure instanceof RequestError && failure.status === 403) {
        // Never silently resend credentials after a context mismatch.
        try {
          const refreshed = await sessionRequest('/api/session', { signal: controller.signal });
          if (ticket !== operation.current) return;
          install(refreshed);
          setError('The sign-in form changed while you were signing in. It has been refreshed. Enter your password and try again.');
        } catch (refreshFailure) {
          if (ticket === operation.current && !controller.signal.aborted) setError('The sign-in form could not be refreshed. Reconnect, enter your password, and try again.');
        }
      } else setError(failure instanceof Error ? failure.message : 'Sign in failed.');
    } finally { if (ticket === operation.current) { signingIn.current = false; setBusy(false); } }
  };
  const loginGoogle = async () => {
    if (!session || session.mode !== 'password' || session.account || !google || !googleAuth || signingIn.current || pendingLogout.current || logoutPending()) return;
    const ticket = ++operation.current; transport.current?.abort();
    const controller = new AbortController(); transport.current = controller;
    signingIn.current = true; googlePosted.current = false; setGoogleExchanging(false); setGoogleAttempt(true); setBusy(true); setError(''); setNotice('Complete sign-in in the Google window.'); setPassword('');
    const current = () => ticket === operation.current && !controller.signal.aborted && !pendingLogout.current && !logoutPending();
    try {
      // Do not await a challenge read before opening the popup: mobile browsers require this click's gesture.
      const idToken = await googleAuth.signIn(controller.signal);
      if (!current()) return;
      const fresh = await sessionRequest('/api/session', { signal: controller.signal });
      if (!current()) return;
      rememberMode(fresh); setSession(fresh);
      if (fresh.mode !== 'password' || fresh.account) { install(fresh); setNotice('Another tab changed this browser’s session. Sign out before switching accounts.'); return; }
      googlePosted.current = true; setGoogleExchanging(true); setNotice('Finishing workspace sign-in…');
      const next = await sessionRequest('/api/login/google', { body: { idToken }, csrfToken: fresh.csrfToken, signal: controller.signal });
      if (!current()) return;
      install(next); broadcastSessionChange('login');
    } catch (failure) {
      if (!current()) return;
      setNotice('');
      if (failure instanceof RequestError) setError(failure.message);
      else {
        const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
        setError(code === 'auth/popup-blocked' ? 'Your browser blocked the Google window. Allow popups for this workspace and try again, or use your password.' : code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' ? 'Google sign-in was cancelled. Your workspace remains locked.' : 'Google sign-in could not finish. Check your connection and try again, or use your workspace password.');
      }
    } finally { if (ticket === operation.current) { signingIn.current = false; googlePosted.current = false; setGoogleAuth(null); setGoogleAttempt(false); setGoogleExchanging(false); setBusy(false); setGoogleSetup(value => value + 1); } }
  };
  const cancelGoogle = () => { if (googlePosted.current) return; operation.current++; transport.current?.abort(); signingIn.current = false; googlePosted.current = false; setGoogleAttempt(false); setGoogleExchanging(false); setBusy(false); setNotice('Google sign-in cancelled in this tab.'); setGoogleAuth(null); setGoogleSetup(value => value + 1); };
  const logout = async () => {
    const previous = client?.session?.state;
    if (!previous) return;
    const ticket = ++operation.current; transport.current?.abort();
    const controller = new AbortController(); transport.current = controller;
    pendingLogout.current = true; markLogoutPending(true);
    lockSession('Signing out…'); broadcastSessionChange('logout'); setBusy(true); setError('');
    try {
      const next = await sessionRequest('/api/logout', { body: {}, csrfToken: previous.csrfToken, sessionContext: previous.sessionContext, signal: controller.signal });
      if (ticket !== operation.current) return;
      pendingLogout.current = false; markLogoutPending(false); install(next); setNotice('Signed out.');
    } catch (failure) {
      if (ticket === operation.current && !controller.signal.aborted) setError('Sign out is not complete on the server. Reconnect and retry to revoke the session. This tab remains locked.');
    } finally { if (ticket === operation.current) setBusy(false); }
  };
  const signOut = () => { setConfirmLogout(true); };

  if (client?.session) return <WorkspaceContext.Provider key={client.session.generation} value={{ ...client, signOut }}>
    {children}
    {confirmLogout && <dialog className="modal session-confirm" ref={confirmation} onCancel={event => { event.preventDefault(); setConfirmLogout(false); }}><div className="modal-heading"><h2>Sign out of this browser?</h2></div><div className="modal-body"><p>Signing out ends this session in every tab of this workspace and clears unsaved drafts in all of them. Export any drafts you need from each tab before continuing. Workspace drafts, audio clips and transcripts are kept only in memory. Deliberately saved device papers remain in this browser profile; manage or delete them from Papers on this device. Download audio and transcripts separately from Audio before signing out; the draft JSON export does not include them.</p></div><div className="modal-footer"><button className="button" disabled={!client.draftRecords().length} onClick={() => exportDrafts(client)}>Export drafts from this tab</button><button className="button" onClick={() => setConfirmLogout(false)}>Cancel</button><button className="button danger" onClick={() => void logout()}><LogOut size={15}/>Sign out and clear drafts</button></div></dialog>}
  </WorkspaceContext.Provider>;

  return <main className="session-gate"><a className="session-brand" href="#home"><img src={applicationPath('/icon.svg')} alt=""/>Phabricator <span>NEXT</span></a><section className="session-card"><div className="session-emblem"><LockKeyhole size={25}/></div><h1>{busy ? 'Verifying workspace…' : session?.mode === 'password' && !pendingLogout.current ? 'Sign in to your workspace' : 'Workspace locked'}</h1><p>Your documents and review history are available after your session is verified.</p>{notice && <p className="session-notice" role="status">{notice}</p>}{error && <div className="banner error" role="alert">{error}</div>}
    {session?.mode === 'password' && !pendingLogout.current ? <>{google && <div className="session-google"><button type="button" className="button google-signin" disabled={busy || !googleAuth} onClick={() => void loginGoogle()}>{googleExchanging ? 'Finishing workspace sign-in…' : googleAttempt ? 'Signing in with Google…' : googleAuth ? 'Continue with Google' : 'Preparing Google sign-in…'}</button>{googleAttempt && <button type="button" className="button" disabled={googleExchanging} onClick={cancelGoogle}>Cancel Google sign-in</button>}<p className="small muted">Or sign in with your workspace password.</p></div>}{googleError && <div className="session-google"><p className="session-notice" role="status">{googleError}</p><button type="button" className="button" disabled={busy} onClick={() => setGoogleSetup(value => value + 1)}>Retry Google setup</button></div>}<form onSubmit={login}><label className="field"><span>Username</span><input required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} disabled={busy}/></label><label className="field"><span>Password</span><input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy}/></label><button className="button primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign In'}</button></form></> : <button className="button primary" disabled={busy} onClick={() => void bootstrap()}>{busy ? 'Connecting…' : pendingLogout.current ? 'Retry sign out' : 'Retry connection'}</button>}
    <a className="button device-paper-session-link" href="#device-papers">Open papers on this device</a>
    <div className="session-explanation"><ShieldCheck size={17}/><span>Protected workspaces keep drafts in this tab only. Export unsaved work before signing out or leaving; closing the tab or an expired session clears it. Signing in replaces this browser’s previous session and clears its unsaved drafts in other tabs.</span></div>
  </section></main>;
}
