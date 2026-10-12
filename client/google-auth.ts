import { deleteApp, initializeApp } from 'firebase/app';
import { browserPopupRedirectResolver, GoogleAuthProvider, initializeAuth, inMemoryPersistence, signInWithPopup, signOut } from 'firebase/auth';
import type { GoogleAuthPublicConfig } from '../shared/google-auth';

export interface PreparedGoogleAuth { signIn(signal: AbortSignal): Promise<string>; dispose(): void }
const cancelled = () => new DOMException('Sign-in cancelled.', 'AbortError');

/** Prepare Firebase's anonymous popup helper; no identity is requested until the explicit sign-in click. */
export async function prepareGoogleAuth(config: GoogleAuthPublicConfig, signal: AbortSignal): Promise<PreparedGoogleAuth> {
  if (signal.aborted) throw cancelled();
  const app = initializeApp(config, `phabricator-google-${crypto.randomUUID()}`);
  let auth: ReturnType<typeof initializeAuth>;
  try { auth = initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver }); }
  catch (error) { void deleteApp(app).catch(() => {}); throw error; }
  let disposed = false, used = false;
  const clearIdentity = () => { void signOut(auth).catch(() => {}); void deleteApp(app).catch(() => {}); };
  const dispose = () => { if (disposed) return; disposed = true; signal.removeEventListener('abort', dispose); clearIdentity(); };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    // Firebase proactively initializes the popup resolver on mobile/Safari during Auth setup.
    await auth.authStateReady();
    if (signal.aborted || disposed) throw cancelled();
  } catch (error) { dispose(); throw error; }
  return {
    dispose,
    signIn(attemptSignal) {
      if (disposed || used || signal.aborted || attemptSignal.aborted) return Promise.reject(cancelled());
      used = true;
      const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: 'select_account' });
      let abort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => { abort = () => { dispose(); reject(cancelled()); }; attemptSignal.addEventListener('abort', abort, { once: true }); });
      // This call stays synchronous with the user's click. No challenge fetch or module import precedes it.
      let popup: ReturnType<typeof signInWithPopup>;
      try { popup = signInWithPopup(auth, provider); }
      catch (error) { attemptSignal.removeEventListener('abort', abort); dispose(); throw error; }
      // The SDK can settle after outer cancellation. Retire any late provider identity too.
      void popup.then(() => { if (disposed || attemptSignal.aborted) clearIdentity(); }, () => {});
      return (async () => {
        try {
          const result = await Promise.race([popup, aborted]);
          if (disposed || attemptSignal.aborted) throw cancelled();
          const token = await Promise.race([result.user.getIdToken(), aborted]);
          if (disposed || attemptSignal.aborted) throw cancelled();
          return token;
        } finally { attemptSignal.removeEventListener('abort', abort); dispose(); }
      })();
    },
  };
}
