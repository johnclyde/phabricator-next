# Workspace authentication

The application has two explicit modes. `APP_AUTH_MODE=local` is the existing single-user loopback workspace. `APP_AUTH_MODE=password` requires an enabled account for every content read or mutation, including history, exports and review requests. Both modes still bind to loopback. TLS, trusted proxies, remote access and fine-grained object/Space permissions are separate milestones.

**Every enabled account currently shares the whole workspace.** There are no private projects, documents or Spaces yet. A bearer token restricts permitted operations, not which objects it can see. Account creation is an operator action from the terminal; there is no public registration or web bootstrap endpoint.

## Enable sign-in

Back up the workspace first, using the SQLite backup guidance in the README. Provision an account against the same `DATABASE_PATH` that the server uses:

```sh
npm run accounts -- create editor --name "Workspace Editor"
APP_AUTH_MODE=password npm start
```

The terminal prompts for a password without echo, then asks for confirmation. Passwords must contain at least 15 characters and at most 1024 UTF-8 bytes. Automation can explicitly pass `--password-stdin`; passwords are never accepted as command arguments. Set `APP_AUTH_MODE=password` in the private `.env` to retain this mode across starts.

Password startup fails if no enabled account exists. Activation records an authentication requirement and advances the database to schema 3; changing the environment back to `local` fails closed, and previous schema-2 application versions refuse that database. Local databases that have not activated authentication remain schema 2. Provisioning an account alone does not activate sign-in. The operator tool can reset passwords and enable accounts even if all accounts were disabled.

```sh
npm run accounts -- list
npm run accounts -- reset editor
npm run accounts -- disable editor
npm run accounts -- enable editor
```

Disabling an account or resetting its password revokes its sessions and tokens. Re-enabling does not restore revoked credentials. Each workspace and account has a persistent identity. New edits, snapshots, comments and review requests record the initiating principal, display name, credential ID and request ID. Existing records retain their historical labels; their authorship is not retroactively verified.

## CLI and automation tokens

Create a token with explicit scopes. The secret is printed once; keep it outside this repository and supply it to `arc` through `PHABRICATOR_TOKEN` in the process environment.

```sh
npm run accounts -- token editor --name "Paper CLI" --scopes read,write,review:local --days 30
npm run accounts -- tokens editor
npm run accounts -- revoke editor TOKEN_ID
```

`read` permits content reads; `write` permits ordinary edits; `review:local` permits deterministic checks and explicitly configured local-model reviews; `review:hosted` permits explicitly configured hosted reviews. A review request also requires `read`. Scopes are independent: `write` does not authorize hosted review. Tokens expire after 30 days by default, with an operator-selected lifetime of 1–90 days. Token secrets are stored as hashes and are never returned by listings. The CLI refuses redirects and refuses to transmit a token over HTTP except to a loopback host. The `check` command remains entirely offline.

## Browser sessions and offline work

Sessions expire after 12 hours. Cookies are HttpOnly, SameSite=Strict and scoped to the configured application path, with names tied to workspace and mount. They currently omit Secure because this mode is restricted to HTTP loopback; this is not a production network-hosting configuration. Applications on the same browser origin are not mutually isolated by cookie paths.

Sign-in uses a one-use, expiring challenge and exact-origin validation. Protected browser requests carry a session-context token on reads as well as writes; writes additionally require CSRF validation. A cookie changed in another tab cannot silently switch the account under an older tab's requests. Login rotates a previous session, logout revokes it, and mixed cookie/bearer authentication is rejected. Passwords use salted, versioned scrypt hashing with bounded concurrency and persistent login throttling. The current scheme uses N=32768, r=8, p=3 and 32-byte salts/keys, one of the configurations in the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).

The browser verifies its session before mounting the workspace or reading its content caches. Password-mode content and draft caches remain in memory in the current tab. It does not read or replay a previous local-mode outbox and does not persist protected content in localStorage or the service-worker cache. Disconnecting keeps an already-open draft available in that tab, but saving requires reconnection. Export unsaved drafts before closing or signing out; the sign-out dialog offers export and explains clearing. Session expiry and account changes lock the workspace, abort requests and stop voice activity. A failed server logout leaves the browser locked with a retry option.

Password workspaces cannot be reopened offline after a reload. Durable authenticated offline work needs a separate trusted-device, encryption and retention design. The existing local mode retains persistent drafts, cached snapshots and its offline outbox. Enabling password mode cannot remotely erase copies previously saved by a local-mode client; those older local drafts are preserved without automatic import into an authenticated session.

Idempotency records and in-flight requests are scoped to the authenticated principal and workspace. Current credentials and required operation scopes are checked before replay. A review rechecks authority after a model call returns and before saving evidence, so disabling an account or revoking its credential prevents a late result from being committed.

## Remaining parity

Invitations, verified email, recovery flows, identity providers, MFA, service/agent account kinds, user-facing session management, project membership, object policies, restrictive Spaces, policy-aware search and durable authenticated offline storage remain open work in [the parity inventory](parity.md). These limitations are not hidden behind an enabled login screen.
