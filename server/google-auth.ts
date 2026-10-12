import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { GoogleAuthPublicConfig } from '../shared/google-auth.ts';
import { HttpError } from './validation.ts';

export interface GoogleAuthConfiguration extends GoogleAuthPublicConfig {
  readonly accounts: Readonly<Record<string, string>>;
}
export interface GoogleIdentity { uid: string; issuedAt: number; authenticatedAt: number; expiresAt: number }
export type GoogleTokenVerifier = (idToken: string) => Promise<GoogleIdentity>;
export const GOOGLE_LOGIN_MAX_AGE_SECONDS = 300;
export const GOOGLE_ID_TOKEN_MAX_BYTES = 16_384;
const keyURL = new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
const invalidConfiguration = () => new Error('APP_GOOGLE_AUTH must contain a valid Firebase web configuration and explicit Firebase UID to existing workspace username mappings.');
export const googleSignInRejected = () => new HttpError(401, 'Google sign-in could not be completed. Use an approved account and sign in again.', 'GOOGLE_SIGN_IN_REJECTED');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const uid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

/** Copy operator input once; neither caller mutation nor token claims may change account linking. */
export function googleAuthConfiguration(value: unknown): GoogleAuthConfiguration {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'accounts,apiKey,appId,authDomain,projectId'
    || typeof value.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.projectId)
    || typeof value.apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(value.apiKey)
    || value.authDomain !== `${value.projectId}.firebaseapp.com`
    || typeof value.appId !== 'string' || !/^1:[0-9]{1,30}:web:[a-f0-9]{8,64}$/.test(value.appId)
    || !record(value.accounts)) throw invalidConfiguration();
  const entries = Object.entries(value.accounts);
  if (!entries.length || entries.length > 1000 || entries.some(([id, name]) => !uid(id) || typeof name !== 'string' || !/^[a-z][a-z0-9._-]{2,63}$/.test(name))) throw invalidConfiguration();
  const accounts = Object.freeze(Object.fromEntries(entries) as Record<string, string>);
  return Object.freeze({ projectId: value.projectId, apiKey: value.apiKey, authDomain: value.authDomain, appId: value.appId, accounts });
}

export function googleAuthFromEnvironment(environment: NodeJS.ProcessEnv = process.env): GoogleAuthConfiguration | undefined {
  const raw = environment.APP_GOOGLE_AUTH;
  if (raw === undefined) return undefined;
  try { if (Buffer.byteLength(raw) > 256_000) throw invalidConfiguration(); return googleAuthConfiguration(JSON.parse(raw)); }
  catch { throw invalidConfiguration(); }
}

/** Recheck freshness after asynchronous verification, immediately before issuing a local session. */
export function validGoogleIdentity(identity: GoogleIdentity, now = Date.now()): boolean {
  const seconds = Math.floor(now / 1000);
  return record(identity) && uid(identity.uid)
    && [identity.issuedAt, identity.authenticatedAt, identity.expiresAt].every(value => Number.isSafeInteger(value) && value > 0)
    && identity.issuedAt <= seconds && identity.expiresAt > seconds && identity.expiresAt > identity.issuedAt
    && identity.authenticatedAt <= identity.issuedAt && seconds - identity.authenticatedAt <= GOOGLE_LOGIN_MAX_AGE_SECONDS;
}

/** The injected key resolver is for signed-token tests; production always uses Google's fixed HTTPS JWKS. */
export function createGoogleTokenVerifier(configuration: GoogleAuthConfiguration, options: { keySet?: JWTVerifyGetKey; now?: () => number } = {}): GoogleTokenVerifier {
  const config = googleAuthConfiguration(configuration), now = options.now ?? Date.now;
  const keys = options.keySet ?? createRemoteJWKSet(keyURL, { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 60 * 60 * 1000 });
  return async token => {
    try {
      if (typeof token !== 'string' || token.length > GOOGLE_ID_TOKEN_MAX_BYTES || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw googleSignInRejected();
      const time = now();
      const { payload, protectedHeader } = await jwtVerify(token, keys, {
        algorithms: ['RS256'], issuer: `https://securetoken.google.com/${config.projectId}`, audience: config.projectId,
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'auth_time'], currentDate: new Date(time), clockTolerance: 0,
      });
      const firebase = payload.firebase;
      const identity = { uid: payload.sub!, issuedAt: payload.iat!, authenticatedAt: payload.auth_time as number, expiresAt: payload.exp! };
      if (protectedHeader.alg !== 'RS256' || typeof protectedHeader.kid !== 'string' || !protectedHeader.kid || protectedHeader.kid.length > 256
        || payload.aud !== config.projectId || payload.iss !== `https://securetoken.google.com/${config.projectId}`
        || payload.email_verified !== true || typeof payload.email !== 'string' || !payload.email || payload.email.length > 320
        || !record(firebase) || firebase.sign_in_provider !== 'google.com' || Object.hasOwn(firebase, 'tenant') || Object.hasOwn(payload, 'tenant')
        || payload.user_id !== undefined && payload.user_id !== payload.sub || !validGoogleIdentity(identity, time)) throw googleSignInRejected();
      return identity;
    } catch { throw googleSignInRejected(); }
  };
}
