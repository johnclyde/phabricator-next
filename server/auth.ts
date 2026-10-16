import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthContext, AuthMode, AuthScope, AuthToken, PublicAccount, SessionState } from '../shared/auth.ts';
import type { ProjectAudience, ObjectPolicy, Space } from '../shared/policy.ts';
import type { Activity, ActorAttribution } from '../shared/types.ts';
import { normalizeBasePath } from '../shared/mount.ts';
import { HttpError, string } from './validation.ts';
import { hostingConfiguration } from './hosting.ts';
import { localOwnersPackageIds } from './owners.ts';
import type { AuthProviders } from '../shared/google-auth.ts';
import { createGoogleTokenVerifier, googleAuthConfiguration, googleSignInRejected, validGoogleIdentity, GOOGLE_ID_TOKEN_MAX_BYTES, type GoogleAuthConfiguration, type GoogleTokenVerifier } from './google-auth.ts';

export interface AuthOptions { database: DatabaseSync; mode: AuthMode; basePath: string; publicOrigin?: string; googleAuth?: GoogleAuthConfiguration; googleTokenVerifier?: GoogleTokenVerifier; provisioning?: boolean; now?: () => number; transferTaskOwners?: (fromId: string, toId: string, attribution: ActorAttribution) => number; transferRevisionAuthors?: (fromId: string, toId: string, attribution: ActorAttribution) => number; transferLocalProjectMemberships?: (fromId: string, toId: string, attribution: ActorAttribution) => number; transferOwnersPackages?: (fromId: string, toId: string, attribution: ActorAttribution) => number }
export interface LocalPolicyTransfer { account: PublicAccount; spaces: number; objects: number; tasks: number; revisions: number; projectMemberships: number; ownersPackages: number }
type AccountRow = { id: string; username: string; display_name: string; disabled: number; salt: string; password_hash: string; password_scheme: string };
type SessionRow = { id: string; account_id: string; context: string; expires_at: number };
type TokenRow = { id: string; account_id: string; name: string; scopes: string; created_at: number; expires_at: number; revoked: number };
type ChallengeRow = { hash: string; context: string; expires_at: number };
const SCOPES: AuthScope[] = ['read', 'write', 'review:local', 'review:hosted'];
const SESSION_LIFETIME = 12 * 60 * 60 * 1000;
const CHALLENGE_LIFETIME = 10 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const same = (left: string, right: string) => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const publicAccount = (row: AccountRow): PublicAccount => ({ id: row.id, username: row.username, displayName: row.display_name, disabled: Boolean(row.disabled) });

export class Auth {
  readonly workspaceId: string;
  readonly mode: AuthMode;
  private readonly database: DatabaseSync;
  private readonly basePath: string;
  private readonly publicOrigin: string | undefined;
  private readonly now: () => number;
  private readonly sessionCookie: string;
  private readonly challengeCookie: string;
  private readonly provisioning: boolean;
  private readonly transferTaskOwners: AuthOptions['transferTaskOwners'];
  private readonly transferRevisionAuthors: AuthOptions['transferRevisionAuthors'];
  private readonly transferLocalProjectMemberships: AuthOptions['transferLocalProjectMemberships'];
  private readonly transferOwnersPackages: AuthOptions['transferOwnersPackages'];
  private deriving = 0;
  private readonly googleAuth: GoogleAuthConfiguration | undefined;
  private readonly googleTokenVerifier: GoogleTokenVerifier | undefined;
  private readonly googleAccounts = new Map<string, { id: string; username: string }>();
  private verifyingGoogle = 0;
  constructor(options: AuthOptions) {
    this.publicOrigin = hostingConfiguration(options.publicOrigin, options.mode)?.origin;
    if (options.googleAuth !== undefined && (options.mode !== 'password' || !this.publicOrigin || options.provisioning)) throw new Error('APP_GOOGLE_AUTH requires a provisioned password workspace and APP_PUBLIC_ORIGIN HTTPS hosting.');
    if (options.googleTokenVerifier && options.googleAuth === undefined) throw new Error('A Google token verifier requires Google authentication configuration.');
    this.googleAuth = options.googleAuth === undefined ? undefined : googleAuthConfiguration(options.googleAuth);
    this.database = options.database;
    this.mode = options.mode;
    this.provisioning = options.provisioning ?? false;
    this.transferTaskOwners = options.transferTaskOwners;
    this.transferRevisionAuthors = options.transferRevisionAuthors;
    this.transferLocalProjectMemberships = options.transferLocalProjectMemberships;
    this.transferOwnersPackages = options.transferOwnersPackages;
    this.basePath = normalizeBasePath(options.basePath);
    this.now = options.now ?? Date.now;
    this.googleTokenVerifier = this.googleAuth ? options.googleTokenVerifier ?? createGoogleTokenVerifier(this.googleAuth, { now: this.now }) : undefined;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS auth_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, salt TEXT NOT NULL, password_hash TEXT NOT NULL, password_scheme TEXT NOT NULL DEFAULT 'scrypt-v1');
      CREATE TABLE IF NOT EXISTS auth_sessions (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL REFERENCES auth_accounts(id), context TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_tokens (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL REFERENCES auth_accounts(id), name TEXT NOT NULL, scopes TEXT NOT NULL CHECK(json_valid(scopes)), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS auth_challenges (hash TEXT PRIMARY KEY, context TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_login_limits (name TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    `);
    if (!(this.database.prepare('PRAGMA table_info(auth_accounts)').all() as { name: string }[]).some(column => column.name === 'password_scheme')) this.database.exec("ALTER TABLE auth_accounts ADD COLUMN password_scheme TEXT NOT NULL DEFAULT 'scrypt-v1'");
    for (const [uid, username] of Object.entries(this.googleAuth?.accounts ?? {})) {
      const account = this.database.prepare('SELECT * FROM auth_accounts WHERE username = ?').get(username) as AccountRow | undefined;
      if (!account) throw new Error('Every APP_GOOGLE_AUTH mapping must name an existing workspace account.');
      this.googleAccounts.set(uid, { id: account.id, username: account.username });
    }
    this.database.prepare('INSERT OR IGNORE INTO auth_meta (name, value) VALUES (?, ?)').run('workspace_id', randomUUID());
    this.workspaceId = this.meta('workspace_id')!;
    const suffix = hash(`${this.workspaceId}:${this.basePath}`).slice(0, 20);
    this.sessionCookie = `phab_session_${suffix}`;
    this.challengeCookie = `phab_challenge_${suffix}`;
    if (this.mode === 'password') {
      const active = this.database.prepare('SELECT id FROM auth_accounts WHERE disabled = 0 LIMIT 1').get();
      if (!active && !options.provisioning) throw new Error('Password authentication is not initialized. Provision an account from the terminal before starting.');
      if (active && !options.provisioning) {
        this.database.exec('SAVEPOINT auth_activation');
        try {
          // Serialize activation with policy edits and account provisioning.
          // A private local principal has no corresponding password account.
          this.database.prepare("UPDATE auth_meta SET value = value WHERE name = 'workspace_id'").run();
          if (!this.database.prepare('SELECT id FROM auth_accounts WHERE disabled = 0 LIMIT 1').get()) throw new Error('Password authentication is not initialized. Provision an account from the terminal before starting.');
          if (this.meta('require_auth') !== 'true') this.requirePortablePolicies();
          this.database.prepare("INSERT INTO auth_meta (name, value) VALUES ('require_auth', 'true') ON CONFLICT(name) DO UPDATE SET value = excluded.value").run();
          // Older binaries know no authentication boundary. Raise the schema
          // floor so they refuse this database instead of exposing its data.
          const version = (this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
          if (version < 3) this.database.exec('PRAGMA user_version = 3');
          this.database.exec('RELEASE auth_activation');
        } catch (error) { this.database.exec('ROLLBACK TO auth_activation; RELEASE auth_activation'); throw error; }
      }
    } else if (this.meta('require_auth') === 'true' && !options.provisioning) {
      throw new Error('This workspace requires password authentication. Start with APP_AUTH_MODE=password.');
    }
  }
  private meta(name: string): string | undefined { return (this.database.prepare('SELECT value FROM auth_meta WHERE name = ?').get(name) as { value: string } | undefined)?.value; }
  private requirePortablePolicies(): void {
    const localPrincipal = `local:${this.workspaceId}`;
    if (localOwnersPackageIds(this.database, localPrincipal).length) throw new Error('Password authentication cannot be activated while Owners packages reference local-only ownership or routing authority. Keep APP_AUTH_MODE=local and run npm run accounts -- transfer-local USERNAME for a deliberately chosen enabled account before trying again. No packages were transferred.');
    if (this.localRevisionAuthors(localPrincipal)) throw new Error('Password authentication cannot be activated while revision ownership references the local-only principal. Keep APP_AUTH_MODE=local and run npm run accounts -- transfer-local USERNAME for a deliberately chosen enabled account before trying again. No revision owners were reassigned.');
    if (this.localProjectMemberships(localPrincipal)) throw new Error('Password authentication cannot be activated while project membership references the local-only principal. Keep APP_AUTH_MODE=local and run npm run accounts -- transfer-local USERNAME for a deliberately chosen enabled account before trying again. No memberships were transferred.');
    if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entities'").get()
      && this.database.prepare("SELECT 1 FROM entities WHERE kind = 'task' AND json_extract(data, '$.ownerId') = ? LIMIT 1").get(localPrincipal)) {
      throw new Error('Password authentication cannot be activated while task ownership references the local-only principal. Keep APP_AUTH_MODE=local and run npm run accounts -- transfer-local USERNAME for a deliberately chosen enabled account before trying again. No task owners were reassigned.');
    }
    const tables = [
      { name: 'policy_spaces', paths: ['$.view.principalIds', '$.edit.principalIds'] },
      { name: 'object_policies', paths: ['$.rules.view.principalIds', '$.rules.edit.principalIds', '$.rules.interact.principalIds', '$.rules.join.principalIds'] },
    ];
    for (const table of tables) {
      if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table.name)) continue;
      for (const path of table.paths) {
        // Table names are fixed above; both the JSON path and identity are bound.
        const grant = this.database.prepare(`SELECT 1 FROM ${table.name} AS policies, json_each(policies.data, ?) AS principal WHERE principal.value = ? LIMIT 1`).get(path, localPrincipal);
        if (grant) throw new Error('Password authentication cannot be activated while policies reference the local-only principal. Keep APP_AUTH_MODE=local and run npm run accounts -- transfer-local USERNAME for a deliberately chosen enabled account before trying again. No access rules were reassigned.');
      }
    }
  }
  private localProjectMemberships(principalId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_relations'").get()
      && this.database.prepare("SELECT 1 FROM project_relations WHERE principal_id = ? AND relation = 'member' AND active = 1 LIMIT 1").get(principalId));
  }
  private localRevisionAuthors(principalId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'revision_authorship'").get()
      && this.database.prepare('SELECT 1 FROM revision_authorship WHERE author_id = ? LIMIT 1').get(principalId));
  }
  private writeTransaction<T>(work: () => T): T {
    this.database.exec('SAVEPOINT auth_credentials_write');
    try {
      // Acquire a write lock before reading credential state: another process
      // may be resetting a password or disabling an account from the terminal.
      this.database.prepare("UPDATE auth_meta SET value = value WHERE name = 'workspace_id'").run();
      const result = work(); this.database.exec('RELEASE auth_credentials_write'); return result;
    } catch (error) { this.database.exec('ROLLBACK TO auth_credentials_write; RELEASE auth_credentials_write'); throw error; }
  }
  private account(id: string): AccountRow | undefined { return this.database.prepare('SELECT * FROM auth_accounts WHERE id = ?').get(id) as AccountRow | undefined; }
  private cookie(req: IncomingMessage, name: string): string | undefined {
    const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
    if (values.length > 1) throw new HttpError(401, 'Ambiguous session cookie. Sign in again.');
    return values[0];
  }
  private setCookie(name: string, value: string, seconds: number): string {
    return `${name}=${value}; Path=${this.basePath}; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.publicOrigin ? '; Secure' : ''}`;
  }
  private sameOrigin(req: IncomingMessage): void {
    if (!req.headers.host || req.headers.origin !== (this.publicOrigin ?? `http://${req.headers.host}`)) throw new HttpError(403, 'A same-origin browser request is required.');
  }
  private header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    return typeof value === 'string' ? value : undefined;
  }
  private requireHeader(req: IncomingMessage, name: string, expected: string, status = 403): void {
    const actual = this.header(req, name);
    if (!actual || !same(actual, expected)) throw new HttpError(status, 'The session context changed. Sign in again.');
  }
  private sessionRow(req: IncomingMessage): SessionRow | undefined {
    const value = this.cookie(req, this.sessionCookie);
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
    return this.database.prepare('SELECT id, account_id, context, expires_at FROM auth_sessions WHERE secret_hash = ?').get(hash(value)) as SessionRow | undefined;
  }
  private sessionState(row: SessionRow): SessionState {
    const account = this.account(row.account_id);
    if (!account || account.disabled || row.expires_at <= this.now()) throw new HttpError(401, 'This session has expired. Sign in again.');
    return { mode: this.mode, workspaceId: this.workspaceId, account: publicAccount(account), sessionContext: row.context, csrfToken: row.context, expiresAt: new Date(row.expires_at).toISOString() };
  }
  private local(): AuthContext {
    const context: AuthContext = { workspaceId: this.workspaceId, principalId: `local:${this.workspaceId}`, displayName: 'You', credentialId: null, kind: 'local', sessionContext: null, scopes: [...SCOPES] };
    this.revalidate(context); return context;
  }
  session(req: IncomingMessage): { session: SessionState; cookie?: string } {
    if (this.mode === 'local') {
      const context = this.local();
      return { session: { mode: 'local', workspaceId: this.workspaceId, account: { id: context.principalId, username: 'local', displayName: 'You', disabled: false }, sessionContext: null, csrfToken: null, expiresAt: null } };
    }
    const current = this.sessionRow(req);
    if (current && current.expires_at > this.now()) {
      const account = this.account(current.account_id);
      if (account && !account.disabled) return { session: this.sessionState(current) };
    }
    const now = this.now();
    this.database.prepare('DELETE FROM auth_challenges WHERE expires_at <= ?').run(now);
    const challengeSecret = this.cookie(req, this.challengeCookie);
    const existing = challengeSecret ? this.database.prepare('SELECT * FROM auth_challenges WHERE hash = ?').get(hash(challengeSecret)) as ChallengeRow | undefined : undefined;
    if (existing) return { session: { mode: 'password', workspaceId: this.workspaceId, account: null, sessionContext: null, csrfToken: existing.context, expiresAt: null } };
    const count = (this.database.prepare('SELECT count(*) AS count FROM auth_challenges').get() as { count: number }).count;
    if (count >= 1000) throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    const value = secret(); const context = secret();
    this.database.prepare('INSERT INTO auth_challenges (hash, context, expires_at) VALUES (?, ?, ?)').run(hash(value), context, now + CHALLENGE_LIFETIME);
    return { session: { mode: 'password', workspaceId: this.workspaceId, account: null, sessionContext: null, csrfToken: context, expiresAt: null }, cookie: this.setCookie(this.challengeCookie, value, CHALLENGE_LIFETIME / 1000) };
  }
  private async derive(password: string, salt: string): Promise<Buffer> {
    if (this.deriving >= 2) throw new HttpError(429, 'Authentication is busy. Try again later.');
    this.deriving += 1;
    try {
      return await new Promise<Buffer>((resolve, reject) => scrypt(password, Buffer.from(salt, 'hex'), 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
    } finally { this.deriving -= 1; }
  }
  private password(value: unknown): string {
    if (typeof value !== 'string' || [...value].length < 15 || Buffer.byteLength(value) > 1024 || value.includes('\0')) throw new HttpError(400, 'Use a password of at least 15 characters and at most 1024 UTF-8 bytes.');
    return value;
  }
  private throttle(username: string): void {
    const now = this.now();
    this.database.prepare('DELETE FROM auth_login_limits WHERE expires_at <= ?').run(now);
    for (const [name, maximum] of [['global', 50], [`account:${hash(username)}`, 10]] as const) {
      const row = this.database.prepare('SELECT count FROM auth_login_limits WHERE name = ?').get(name) as { count: number } | undefined;
      if ((row?.count ?? 0) >= maximum) throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    }
    for (const name of ['global', `account:${hash(username)}`]) this.database.prepare('INSERT INTO auth_login_limits (name, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(name) DO UPDATE SET count = count + 1').run(name, now + LOGIN_WINDOW);
  }
  providers(): AuthProviders {
    const config = this.googleAuth;
    return { google: config ? { projectId: config.projectId, apiKey: config.apiKey, authDomain: config.authDomain, appId: config.appId } : null };
  }
  private loginChallenge(req: IncomingMessage): ChallengeRow {
    this.sameOrigin(req);
    const challengeSecret = this.cookie(req, this.challengeCookie);
    const challenge = challengeSecret ? this.database.prepare('SELECT * FROM auth_challenges WHERE hash = ?').get(hash(challengeSecret)) as ChallengeRow | undefined : undefined;
    if (!challenge || challenge.expires_at <= this.now()) throw new HttpError(403, 'Reload the sign-in form before trying again.');
    this.requireHeader(req, 'x-csrf-token', challenge.context);
    return challenge;
  }
  /** Must run inside the credential writer transaction after method-specific verification. */
  private completeLogin(req: IncomingMessage, row: AccountRow, challenge: ChallengeRow): { cookie: string; session: SessionState } {
    const current = this.account(row.id);
    const liveChallenge = this.database.prepare('SELECT * FROM auth_challenges WHERE hash = ?').get(challenge.hash) as ChallengeRow | undefined;
    if (!current || current.disabled || current.username !== row.username || current.password_hash !== row.password_hash || current.password_scheme !== row.password_scheme || !liveChallenge || liveChallenge.expires_at <= this.now() || liveChallenge.context !== challenge.context) throw new HttpError(401, 'Sign-in could not be completed. Reload the sign-in form.');
    // Keep the browser challenge-cookie identity stable across tabs, rotating its one-use CSRF context.
    this.database.prepare('UPDATE auth_challenges SET context = ?, expires_at = ? WHERE hash = ?').run(secret(), this.now() + CHALLENGE_LIFETIME, challenge.hash);
    const previous = this.sessionRow(req);
    if (previous) this.database.prepare('DELETE FROM auth_sessions WHERE id = ?').run(previous.id);
    this.database.prepare('DELETE FROM auth_login_limits WHERE name = ?').run(`account:${hash(row.username)}`);
    this.database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(this.now());
    const value = secret();
    const session: SessionRow = { id: randomUUID(), account_id: row.id, context: secret(), expires_at: this.now() + SESSION_LIFETIME };
    this.database.prepare('INSERT INTO auth_sessions (id, secret_hash, account_id, context, expires_at) VALUES (?, ?, ?, ?, ?)').run(session.id, hash(value), row.id, session.context, session.expires_at);
    return { cookie: this.setCookie(this.sessionCookie, value, SESSION_LIFETIME / 1000), session: this.sessionState(session) };
  }
  async login(req: IncomingMessage, username: unknown, password: unknown): Promise<{ cookie: string; session: SessionState }> {
    if (this.mode !== 'password') throw new HttpError(400, 'Password sign-in is not enabled.');
    const challenge = this.loginChallenge(req);
    const name = typeof username === 'string' ? username.toLowerCase() : '';
    if (name.length > 64 || typeof password !== 'string' || Buffer.byteLength(password) > 1024) throw new HttpError(401, 'The username or password is incorrect.');
    this.throttle(name);
    const row = this.database.prepare('SELECT * FROM auth_accounts WHERE username = ?').get(name) as AccountRow | undefined;
    const derived = await this.derive(password, row?.password_scheme === 'scrypt-v1' ? row.salt : '00'.repeat(32));
    if (!row || row.disabled || row.password_scheme !== 'scrypt-v1' || !same(derived.toString('hex'), row.password_hash)) throw new HttpError(401, 'The username or password is incorrect.');
    return this.writeTransaction(() => this.completeLogin(req, row, challenge));
  }
  async loginGoogle(req: IncomingMessage, idToken: unknown): Promise<{ cookie: string; session: SessionState }> {
    if (!this.googleTokenVerifier) throw new HttpError(400, 'Google sign-in is not enabled.');
    const challenge = this.loginChallenge(req);
    if (req.headers.authorization !== undefined) throw new HttpError(400, 'Use the browser sign-in form without an API token.');
    const requireAnonymous = () => {
      const session = this.sessionRow(req);
      if (session && session.expires_at > this.now() && this.account(session.account_id)?.disabled === 0) throw new HttpError(409, 'The browser is already signed in. Sign out before choosing a different account.', 'SESSION_CHANGED');
    };
    requireAnonymous();
    if (typeof idToken !== 'string' || !idToken || Buffer.byteLength(idToken) > GOOGLE_ID_TOKEN_MAX_BYTES) throw googleSignInRejected();
    this.throttle(`google-challenge:${challenge.hash}`);
    if (this.verifyingGoogle >= 2) throw new HttpError(429, 'Authentication is busy. Try again later.');
    // Pin credential state before awaiting an external verifier, so password reset/disable cannot race session issuance.
    const accounts = new Map([...this.googleAccounts.values()].map(mapping => [mapping.id, this.account(mapping.id)]));
    this.verifyingGoogle++;
    try {
      let identity;
      try { identity = await this.googleTokenVerifier(idToken); } catch { throw googleSignInRejected(); }
      return this.writeTransaction(() => {
        requireAnonymous();
        if (!validGoogleIdentity(identity, this.now())) throw googleSignInRejected();
        const mapping = this.googleAccounts.get(identity.uid), row = mapping && accounts.get(mapping.id);
        if (!mapping || !row || row.disabled || row.username !== mapping.username) throw googleSignInRejected();
        return this.completeLogin(req, row, challenge);
      });
    } finally { this.verifyingGoogle--; }
  }
  authenticate(req: IncomingMessage, scope: AuthScope = 'read'): AuthContext {
    if (this.mode === 'local') return this.local();
    const authorization = this.header(req, 'authorization');
    if (authorization !== undefined) {
      if (this.cookie(req, this.sessionCookie)) throw new HttpError(401, 'Use one authentication method per request.');
      const match = /^Bearer (phab_[A-Za-z0-9_-]{43})$/.exec(authorization);
      return this.tokenContext(match?.[1], scope);
    }
    const row = this.sessionRow(req);
    if (!row) throw new HttpError(401, 'Sign in to this workspace.');
    const state = this.sessionState(row);
    this.requireHeader(req, 'x-session-context', row.context, 401);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) { this.sameOrigin(req); this.requireHeader(req, 'x-csrf-token', row.context); }
    const context: AuthContext = { workspaceId: this.workspaceId, principalId: row.account_id, displayName: state.account!.displayName, credentialId: row.id, kind: 'session', sessionContext: row.context, scopes: [...SCOPES] };
    this.revalidate(context, scope); return context;
  }
  /** Git clients use access tokens, never browser cookies or local implicit authority. */
  authenticateGit(req: IncomingMessage, scope: 'read' | 'write' = 'read'): AuthContext {
    const authorization = this.header(req, 'authorization');
    const names = req.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
    if (names.filter(name => name === 'authorization').length !== 1 || names.includes('cookie') || req.headers.cookie !== undefined || !authorization || authorization.length > 1_024) {
      throw new HttpError(401, 'Git access requires one access token and no browser cookies.');
    }
    const bearer = /^Bearer (phab_[A-Za-z0-9_-]{43})$/i.exec(authorization);
    let token: string | undefined = bearer?.[1], username: string | undefined;
    if (!bearer) {
      const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
      const decoded = basic ? Buffer.from(basic[1]!, 'base64') : null;
      if (!basic || !decoded || decoded.toString('base64') !== basic[1]) throw new HttpError(401, 'A valid Git access token is required.');
      const credentials = /^([a-z][a-z0-9._-]{2,63}):(phab_[A-Za-z0-9_-]{43})$/.exec(decoded.toString('utf8'));
      if (!credentials) throw new HttpError(401, 'Use your workspace username and access token for Git.');
      username = credentials[1]; token = credentials[2];
    }
    const context = this.tokenContext(token, scope);
    if (username !== undefined && this.account(context.principalId)?.username !== username) throw new HttpError(401, 'A valid Git access token is required.');
    if (scope === 'write') this.revalidate(context, 'read');
    return context;
  }
  /** Conduit carries tokens in its body. Never rewrite headers or weaken cookie CSRF checks. */
  authenticateConduit(req: IncomingMessage, token: unknown, scope: AuthScope = 'read'): AuthContext {
    const authorization = req.headers.authorization;
    const cookie = this.cookie(req, this.sessionCookie);
    if (token !== undefined) {
      if (authorization !== undefined || cookie !== undefined) throw new HttpError(401, 'Use one authentication method per request.');
      return this.tokenContext(token, scope);
    }
    if (authorization !== undefined) {
      if (cookie !== undefined) throw new HttpError(401, 'Use one authentication method per request.');
      return this.tokenContext(typeof authorization === 'string' ? /^Bearer (phab_[A-Za-z0-9_-]{43})$/.exec(authorization)?.[1] : undefined, scope);
    }
    return this.authenticate(req, scope);
  }
  private tokenContext(token: unknown, scope: AuthScope): AuthContext {
    const row = typeof token === 'string' && /^phab_[A-Za-z0-9_-]{43}$/.test(token)
      ? this.database.prepare('SELECT * FROM auth_tokens WHERE secret_hash = ?').get(hash(token)) as TokenRow | undefined : undefined;
    if (!row) throw new HttpError(401, 'A valid access token is required.');
    const account = this.account(row.account_id);
    const context: AuthContext = { workspaceId: this.workspaceId, principalId: row.account_id, displayName: account?.display_name ?? '', credentialId: row.id, kind: 'token', sessionContext: null, scopes: JSON.parse(row.scopes) as AuthScope[] };
    this.revalidate(context, scope); return context;
  }
  revalidate(context: AuthContext, scope?: AuthScope): void {
    if (context.workspaceId !== this.workspaceId) throw new HttpError(401, 'This credential belongs to another workspace.');
    if (context.kind === 'local') {
      if (this.mode !== 'local' || context.principalId !== `local:${this.workspaceId}` || this.meta('require_auth') === 'true') throw new HttpError(401, 'This workspace requires password authentication. Restart the server in password mode.');
      return;
    }
    const account = this.account(context.principalId);
    if (!account || account.disabled) throw new HttpError(401, 'This account is unavailable.');
    if (context.kind === 'session') {
      const row = this.database.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(context.credentialId) as SessionRow | undefined;
      if (!row || row.account_id !== context.principalId || row.expires_at <= this.now() || context.sessionContext !== row.context) throw new HttpError(401, 'This session has expired. Sign in again.');
    } else {
      const row = this.database.prepare('SELECT * FROM auth_tokens WHERE id = ?').get(context.credentialId) as TokenRow | undefined;
      if (!row || row.account_id !== context.principalId || row.revoked || row.expires_at <= this.now()) throw new HttpError(401, 'This access token is expired or revoked.');
      if (scope && !(JSON.parse(row.scopes) as AuthScope[]).includes(scope)) throw new HttpError(403, `This access token does not permit ${scope}.`);
    }
  }
  logout(context: AuthContext): { cookie: string } {
    this.revalidate(context);
    if (context.kind !== 'session') throw new HttpError(400, 'Only browser sessions can sign out here.');
    this.database.prepare('DELETE FROM auth_sessions WHERE id = ?').run(context.credentialId);
    return { cookie: this.setCookie(this.sessionCookie, '', 0) };
  }
  async createAccount(input: { username: string; displayName: string; password: string }): Promise<PublicAccount> {
    const username = string(input.username, 'Username', 64).toLowerCase();
    if (!/^[a-z][a-z0-9._-]{2,63}$/.test(username)) throw new HttpError(400, 'Username must use 3–64 lowercase letters, numbers, dots, underscores or hyphens, starting with a letter.');
    const displayName = string(input.displayName, 'Display name', 120);
    const password = this.password(input.password);
    if (this.database.prepare('SELECT id FROM auth_accounts WHERE username = ?').get(username)) throw new HttpError(409, 'This username is already registered.');
    const salt = randomBytes(32).toString('hex'); const derived = await this.derive(password, salt);
    const id = randomUUID();
    try { this.database.prepare('INSERT INTO auth_accounts (id, username, display_name, salt, password_hash) VALUES (?, ?, ?, ?, ?)').run(id, username, displayName, salt, derived.toString('hex')); }
    catch (error) { if (this.database.prepare('SELECT id FROM auth_accounts WHERE username = ?').get(username)) throw new HttpError(409, 'This username is already registered.'); throw error; }
    return { id, username, displayName, disabled: false };
  }
  listAccounts(): PublicAccount[] { return (this.database.prepare('SELECT * FROM auth_accounts ORDER BY username').all() as AccountRow[]).map(publicAccount); }
  /** Explicit terminal handoff, never an HTTP administrator or creator bypass. */
  transferLocalPolicies(accountId: string): LocalPolicyTransfer {
    if (!this.provisioning) throw new HttpError(403, 'Local policy transfer requires terminal provisioning access.');
    return this.writeTransaction(() => {
      if (this.meta('require_auth') === 'true') throw new HttpError(409, 'Local policy transfer is only available before password authentication is activated.');
      const account = this.account(accountId);
      if (!account || account.disabled) throw new HttpError(404, 'Active account not found.');
      for (const table of ['policy_spaces', 'object_policies', 'policy_meta', 'activity']) {
        if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw new Error('Workspace policies are not initialized. Run the accounts command with the current application version.');
      }
      const localPrincipal = `local:${this.workspaceId}`;
      const transfer = <T extends ProjectAudience>(audience: T): T => (audience.kind === 'principals' && audience.principalIds.includes(localPrincipal)
        ? { kind: 'principals', principalIds: [...new Set(audience.principalIds.map(id => id === localPrincipal ? account.id : id))] }
        : audience) as T;
      const nextVersion = (version: number): number => {
        if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(version + 1)) throw new HttpError(409, 'A policy has reached the supported version limit. No grants were transferred.');
        return version + 1;
      };
      const result: LocalPolicyTransfer = { account: publicAccount(account), spaces: 0, objects: 0, tasks: 0, revisions: 0, projectMemberships: 0, ownersPackages: 0 };
      const requestId = randomUUID();
      const createdAt = new Date(this.now()).toISOString();
      const audit = (objectId: string) => {
        const activity: Activity = {
          id: randomUUID(), objectId, actor: 'Terminal operator', action: 'local_grants_transferred',
          detail: 'A terminal operator reassigned local-only access grants to a workspace account.', createdAt,
          attribution: { principalId: `operator:${this.workspaceId}`, displayName: 'Terminal operator', credentialId: null, requestId },
        };
        this.database.prepare('INSERT INTO activity (id, object_id, data) VALUES (?, ?, ?)').run(activity.id, objectId, JSON.stringify(activity));
      };
      const spaces = this.database.prepare(`SELECT id, data FROM policy_spaces AS space WHERE
        EXISTS (SELECT 1 FROM json_each(space.data, '$.view.principalIds') WHERE value = ?) OR
        EXISTS (SELECT 1 FROM json_each(space.data, '$.edit.principalIds') WHERE value = ?)
      `).all(localPrincipal, localPrincipal) as { id: string; data: string }[];
      for (const row of spaces) {
        const original = JSON.parse(row.data) as Space;
        const view = transfer(original.view); const edit = transfer(original.edit);
        if (view === original.view && edit === original.edit) continue;
        const space: Space = { ...original, view, edit, version: nextVersion(original.version) };
        this.database.prepare('UPDATE policy_spaces SET data = ? WHERE id = ?').run(JSON.stringify(space), row.id);
        audit(row.id); result.spaces += 1;
      }
      const objects = this.database.prepare(`SELECT object_id, data FROM object_policies AS policy WHERE
        EXISTS (SELECT 1 FROM json_each(policy.data, '$.rules.view.principalIds') WHERE value = ?) OR
        EXISTS (SELECT 1 FROM json_each(policy.data, '$.rules.edit.principalIds') WHERE value = ?) OR
        EXISTS (SELECT 1 FROM json_each(policy.data, '$.rules.interact.principalIds') WHERE value = ?) OR
        EXISTS (SELECT 1 FROM json_each(policy.data, '$.rules.join.principalIds') WHERE value = ?)
      `).all(localPrincipal, localPrincipal, localPrincipal, localPrincipal) as { object_id: string; data: string }[];
      for (const row of objects) {
        const original = JSON.parse(row.data) as ObjectPolicy;
        const policy: ObjectPolicy = original.kind === 'project'
          ? { ...original, version: nextVersion(original.version), rules: { view: transfer(original.rules.view), edit: transfer(original.rules.edit), interact: transfer(original.rules.interact), join: transfer(original.rules.join) } }
          : { ...original, version: nextVersion(original.version), rules: { view: transfer(original.rules.view), edit: transfer(original.rules.edit), interact: transfer(original.rules.interact) } };
        this.database.prepare('UPDATE object_policies SET data = ? WHERE object_id = ?').run(JSON.stringify(policy), row.object_id);
        audit(row.object_id); result.objects += 1;
      }
      if (this.database.prepare("SELECT 1 FROM entities WHERE kind = 'task' AND json_extract(data, '$.ownerId') = ? LIMIT 1").get(localPrincipal)) {
        if (!this.transferTaskOwners) throw new Error('Task ownership transfer requires the current accounts command. No grants or owners were transferred.');
        result.tasks = this.transferTaskOwners(localPrincipal, account.id, { principalId: `operator:${this.workspaceId}`, displayName: 'Terminal operator', credentialId: null, requestId });
        if (!Number.isSafeInteger(result.tasks) || result.tasks < 1 || this.database.prepare("SELECT 1 FROM entities WHERE kind = 'task' AND json_extract(data, '$.ownerId') = ? LIMIT 1").get(localPrincipal)) throw new Error('Task ownership transfer was incomplete. No grants or owners were transferred.');
      }
      if (this.localRevisionAuthors(localPrincipal)) {
        if (!this.transferRevisionAuthors) throw new Error('Revision ownership transfer requires the current accounts command. No grants or owners were transferred.');
        result.revisions = this.transferRevisionAuthors(localPrincipal, account.id, { principalId: `operator:${this.workspaceId}`, displayName: 'Terminal operator', credentialId: null, requestId });
        if (!Number.isSafeInteger(result.revisions) || result.revisions < 1 || this.localRevisionAuthors(localPrincipal)) throw new Error('Revision ownership transfer was incomplete. No grants or owners were transferred.');
      }
      if (this.localProjectMemberships(localPrincipal)) {
        if (!this.transferLocalProjectMemberships) throw new Error('Project membership transfer requires the current accounts command. No grants, owners or memberships were transferred.');
        result.projectMemberships = this.transferLocalProjectMemberships(localPrincipal, account.id, { principalId: `operator:${this.workspaceId}`, displayName: 'Terminal operator', credentialId: null, requestId });
        if (!Number.isSafeInteger(result.projectMemberships) || result.projectMemberships < 1 || this.localProjectMemberships(localPrincipal)) throw new Error('Project membership transfer was incomplete. No grants, owners or memberships were transferred.');
      }
      if (localOwnersPackageIds(this.database, localPrincipal).length) {
        if (!this.transferOwnersPackages) throw new Error('Owners package transfer requires the current accounts command. No grants or packages were transferred.');
        result.ownersPackages = this.transferOwnersPackages(localPrincipal, account.id, { principalId: 'operator:' + this.workspaceId, displayName: 'Terminal operator', credentialId: null, requestId });
        if (!Number.isSafeInteger(result.ownersPackages) || result.ownersPackages < 1 || localOwnersPackageIds(this.database, localPrincipal).length) throw new Error('Owners package transfer was incomplete. No grants or packages were transferred.');
      }
      if (result.spaces || result.objects) {
        const epoch = (this.database.prepare("SELECT value FROM policy_meta WHERE name = 'epoch'").get() as { value: number }).value;
        if (!Number.isSafeInteger(epoch + 1)) throw new HttpError(409, 'The workspace has reached the supported policy epoch limit. No grants were transferred.');
        this.database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
      }
      return result;
    });
  }
  setAccountDisabled(accountId: string, disabled: boolean): void {
    if (!this.account(accountId)) throw new HttpError(404, 'Account not found.');
    this.database.exec('SAVEPOINT auth_account_status');
    try {
      this.database.prepare('UPDATE auth_accounts SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, accountId);
      if (disabled) this.invalidateCredentials(accountId);
      this.database.exec('RELEASE auth_account_status');
    } catch (error) { this.database.exec('ROLLBACK TO auth_account_status; RELEASE auth_account_status'); throw error; }
  }
  private invalidateCredentials(accountId: string): void {
    this.database.prepare('DELETE FROM auth_sessions WHERE account_id = ?').run(accountId);
    this.database.prepare('UPDATE auth_tokens SET revoked = 1 WHERE account_id = ?').run(accountId);
  }
  async resetPassword(accountId: string, password: string): Promise<void> {
    if (!this.account(accountId)) throw new HttpError(404, 'Account not found.');
    const value = this.password(password); const salt = randomBytes(32).toString('hex'); const derived = await this.derive(value, salt);
    this.database.exec('SAVEPOINT auth_password_reset');
    try {
      this.database.prepare("UPDATE auth_accounts SET salt = ?, password_hash = ?, password_scheme = 'scrypt-v1' WHERE id = ?").run(salt, derived.toString('hex'), accountId);
      this.invalidateCredentials(accountId);
      this.database.exec('RELEASE auth_password_reset');
    } catch (error) { this.database.exec('ROLLBACK TO auth_password_reset; RELEASE auth_password_reset'); throw error; }
  }
  createToken(accountId: string, input: { name: string; scopes: AuthScope[]; expiresInDays?: number }): { token: string; record: AuthToken } {
    const name = string(input.name, 'Token name', 120);
    if (!Array.isArray(input.scopes) || !input.scopes.length || input.scopes.length > SCOPES.length || new Set(input.scopes).size !== input.scopes.length || input.scopes.some(scope => !SCOPES.includes(scope))) throw new HttpError(400, 'Choose valid, nonduplicate token scopes.');
    const days = input.expiresInDays ?? 30;
    if (!Number.isSafeInteger(days) || days < 1 || days > 90) throw new HttpError(400, 'Token lifetime must be 1–90 days.');
    return this.writeTransaction(() => {
      const account = this.account(accountId);
      if (!account || account.disabled) throw new HttpError(404, 'Active account not found.');
      const now = this.now(); const token = `phab_${secret()}`;
      const record: AuthToken = { id: randomUUID(), name, accountId, scopes: [...input.scopes], createdAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86_400_000).toISOString(), revoked: false };
      this.database.prepare('INSERT INTO auth_tokens (id, secret_hash, account_id, name, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(record.id, hash(token), accountId, name, JSON.stringify(input.scopes), now, now + days * 86_400_000);
      return { token, record };
    });
  }
  listTokens(accountId: string): AuthToken[] {
    if (!this.account(accountId)) throw new HttpError(404, 'Account not found.');
    return (this.database.prepare('SELECT * FROM auth_tokens WHERE account_id = ? ORDER BY created_at DESC').all(accountId) as TokenRow[]).map(row => ({ id: row.id, name: row.name, accountId: row.account_id, scopes: JSON.parse(row.scopes) as AuthScope[], createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(), revoked: Boolean(row.revoked) }));
  }
  revokeToken(accountId: string, tokenId: string): void {
    const result = this.database.prepare('UPDATE auth_tokens SET revoked = 1 WHERE id = ? AND account_id = ?').run(tokenId, accountId);
    if (!result.changes) throw new HttpError(404, 'Access token not found.');
  }
}

export function createAuth(options: AuthOptions): Auth { return new Auth(options); }
