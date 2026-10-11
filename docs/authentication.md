# Workspace authentication

The application has two explicit modes. `APP_AUTH_MODE=local` is the existing single-user loopback workspace. `APP_AUTH_MODE=password` requires an enabled account for every content read or mutation, including history, exports and review requests. Both modes still bind to loopback. TLS, trusted proxies and remote access are separate milestones. [Object and Space policies](policies.md) restrict access within a workspace.

Existing objects migrate to the shared default Space with explicit workspace-member rules. New Spaces default to selected-member access for their creator. Objects can further restrict viewing, editing and interaction. Bearer scopes and object policies are independent requirements: a token cannot exceed its account’s object access. Account creation is an operator action from the terminal; there is no public registration or web bootstrap endpoint.

## Enable sign-in

Back up the workspace first, using the SQLite backup guidance in the README. Provision an account against the same `DATABASE_PATH` that the server uses:

```sh
npm run accounts -- create editor --name "Workspace Editor"
APP_AUTH_MODE=password npm start
```

The terminal prompts for a password without echo, then asks for confirmation. Passwords must contain at least 15 characters and at most 1024 UTF-8 bytes. Automation can explicitly pass `--password-stdin`; passwords are never accepted as command arguments. Set `APP_AUTH_MODE=password` in the private `.env` to retain this mode across starts.

Password startup fails if no enabled account exists. Activation records an authentication requirement; changing the environment back to `local` fails closed. Workspaces now use schema 29, including revision following and private mute preferences, separate revision metadata, current ownership, reviewer decisions and immutable lifecycle history, so older application versions refuse the database instead of ignoring its access rules. Provisioning an account alone does not activate sign-in. If existing Space or object rules explicitly name the local-only identity, tasks or revisions are owned by it, or it is an active project member, activation refuses rather than stranding those grants and owners. After backing up, explicitly hand them to the intended enabled account with `npm run accounts -- transfer-local editor`, then start password mode. This command replaces only the local identity in selected-member grants (including project join rules), current task and revision ownership, and active project memberships, preserves other selected members, and versions and audits each changed policy, task owner, revision author and project membership. It does not activate authentication. Immutable original/source attribution, task authorship, existing subscription preferences, project watching and silence preferences remain historical; the former owner follows the normal explicit subscription rule. Policy, ownership and membership handoff is atomic, including subscription/history effects. After project conversion, handoff changes the active ordinary leaf memberships and recomputes their ancestor and milestone membership; retired parent rows do not become phantom grants. It is unavailable after password mode has been activated. Stop the local server while making this handoff; local-only content becomes inaccessible to its former local principal as soon as the handoff commits. The operator tool can reset passwords and enable accounts even if all accounts were disabled.

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

Idempotency records and in-flight requests are scoped to the authenticated principal and workspace. Current credentials, required operation scopes and object permissions are checked before replay. Created-object retries also require current access to the resulting object; saved responses are redacted using current reference visibility. A review rechecks authority after a model call returns and before saving evidence, so disabling an account or revoking its credential prevents a late result from being committed.

## Remaining parity

Invitations, verified email, recovery flows, identity providers, MFA, service/agent account kinds, user-facing session management, general custom policy rules, inherited wiki restrictions, full-text search and durable authenticated offline storage remain open work in [the parity inventory](parity.md). These limitations are not hidden behind an enabled login screen.
