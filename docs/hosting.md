# HTTPS hosting

The application supports one persistent Node process behind a TLS reverse proxy
on the same host. It continues to listen on `127.0.0.1`; the proxy is the only
public listener. SQLite and its WAL/SHM sidecars live outside release directories.
This is a reusable hosting contract. Domains, cloud resources, service units,
credentials, certificate configuration and deployment automation belong in an
operator's separate site/infrastructure repository.

## Configure the public origin

```dotenv
APP_PUBLIC_ORIGIN=https://reviews.example.com
APP_AUTH_MODE=password
APP_BASE_PATH=/
PORT=4310
DATABASE_PATH=/var/lib/review-workspace/workspace.sqlite
SEED_DEMO=false
```

`APP_PUBLIC_ORIGIN` is optional for local use. When supplied, it must be exactly
a canonical HTTPS origin: no trailing slash, path, credentials, query, fragment,
whitespace, uppercase/default-port aliases or backslashes. A nondefault HTTPS
port is allowed and becomes part of the required Host. An empty value is an
error; leave the variable unset for local mode. Hosted configuration requires
password mode and is validated before opening or changing a database.

Use the same `APP_BASE_PATH` when building and starting. Keep an optional mount
path separate from the origin. Frontend/runtime path mismatches fail explicitly.
The public origin is server configuration, never inferred from a request.

## Build and start

Use Node.js 22.13 or newer. Build a pinned commit with the locked dependencies:

```sh
npm ci
npm run check
npm test
npm run build
```

A release needs `dist/`, `server/`, `shared/`, `scripts/`, `cli/`, package manifests,
`LICENSE`, `NOTICE` and production dependencies. `tsx` is a runtime dependency: both the server entrypoint
and disposable DOCX workers load TypeScript. A production install may use
`npm ci --omit=dev`; it does not need Vite, TypeScript or Playwright at runtime.
Keep `.env`, databases, credentials and operator repositories out of the artifact.
Run `npm start` from the release directory with the environment above supplied by
the service manager or a private environment file. Never put passwords in process
arguments, unit files or source control.

Provision the first enabled account with `npm run accounts -- create USERNAME`
against the exact persistent `DATABASE_PATH` before starting password mode. The
terminal prompts privately; automation can explicitly use `--password-stdin`.
There is no public registration or bootstrap endpoint. An empty production
workspace should use `SEED_DEMO=false`. Copying a local workspace requires its
own deliberate backup and identity handoff; see [authentication](authentication.md).
Deploying a new instance does not imply publishing a developer's local database.

## Reverse proxy boundary

The proxy must terminate trusted HTTPS, redirect HTTP to HTTPS, preserve the
complete mount path, and pass the exact configured public Host. Node accepts only
loopback transport, that Host, and—when present—the exact configured Origin.
Duplicate Host headers are rejected. Forwarded and X-Forwarded-* headers confer
no authority and cannot change the allowed host, origin or authentication mode.
Do not rewrite browser Origin headers to a loopback address.

The configured HTTPS origin asserts that the operator has established this TLS
boundary; Node cannot inspect the encrypted connection after the proxy terminates
it. Never route plaintext public traffic to the upstream or expose its port.
A proxy on another machine, an arbitrary proxy chain, and a network-wide bind are
not supported by this mode. TLS certificates, HTTP redirects and any host-wide
HSTS policy are the proxy operator's responsibility.

Challenge, session and logout-deletion cookies use Secure, HttpOnly and
SameSite=Strict, with the configured application path. Browser writes continue to
require the exact origin, CSRF token and session context. Bearer and Conduit
clients may omit Origin; a supplied incorrect Origin is rejected before routing.
Conduit-generated document links use the configured HTTPS origin.

External top-level GET/HEAD navigation may enter only the application root,
its slashless mount redirect or its `index.html`, with the browser's document
navigation metadata and no Origin. This permits links from a portfolio or source
repository. Cross-site API and subresource requests remain rejected. Static shell
access does not authorize protected content reads.

Preserve `Cache-Control: no-store` on authenticated responses; do not place an
HTML/API response cache in front of the app. Allow the Files route's 24 MiB JSON
body. Choose proxy and service-manager deadlines that permit explicit AI requests
up to 120 seconds and a graceful shutdown. The app independently bounds request
bodies, headers, password work, DOCX workers and compiler jobs.

## State, checks and recovery

SQLite contains accounts, sessions, source versions, uploaded Files, original
Word packages, jobs and paper artifacts. Operator-owned bare Git repositories,
compiler images, secrets and optional local models remain separate dependencies.
Run one application process for a database; do not place SQLite on an ephemeral
container filesystem or share it across independently scaled app instances.

`/api/health` is public liveness after the Host/Origin boundary, not a database
integrity or worker-readiness check. A local probe must send the configured public
Host. After deployment, verify TLS, sign-in, an authenticated read/write and
restart persistence against a disposable test record before relying on the service.

SIGTERM/SIGINT initiate graceful shutdown before closing SQLite. For a stopped
backup, preserve the database and any WAL/SHM sidecars together, then verify the
copy with SQLite integrity and foreign-key checks. Keep a matching release ID and
rehearse restoration. Updating the app must not overwrite the data directory.
An older binary may refuse a newer database schema; rolling back then requires
the matching database backup, not just replacing application files.

TeX builds require the separately prepared, digest-pinned isolated runtime in
[the compiler guide](tex-worker.md). Hosted AI review remains an explicit operation
and needs operator-configured credentials; no provider is enabled by hosting.
Password-mode drafts stay in the current tab's memory. Reloading protected work
offline, offline speech recognition, multi-instance hosting and public account
recovery remain separate capabilities.

## Verification

The hosting slice passed `npm run check`, root and mounted production builds,
and the full suite: 1,573 passing tests, nine optional TeX-runtime skips and no
failures. Request-boundary tests cover malformed configuration, Host/Origin
spoofing, duplicate headers, cross-site entry, scoped tokens and private downloads.
The 24 existing desktop/mobile auth and mount browser cases passed; one slow
login assertion passed on an isolated retry without source changes.

Four additional HTTPS browser flows cover root/mounted desktop/mobile entry,
Secure cookies, sign-in, authenticated reads/writes, reload and logout. They use
temporary self-signed certificates with certificate validation bypassed only in
isolated test contexts; they do not verify a public certificate or physical phone.
A clean Node 22.14/macOS production-only install passed account provisioning,
server startup, actual DOCX worker edits and session/data restart persistence.
Its frontend is byte-identical to the new build. Linux deployment and restoration
of operator backups still require the deployment checks above. The live local
preview, schema 34 and all 91 existing records remained unchanged.

Optional [revision landing](revision-landing.md) requires explicit local bare-repository and branch bindings. Installation does not enable a destination, remote push, or worker fleet. Keep actual paths and deployment settings in the operator repository.
