# Architecture decisions

## The product center

Phabricator's durable objects, revision history, precise comments and shared context are useful well beyond code. Start with academic manuscripts and legal/general prose, where changes to qualifiers, assumptions, citations and requested relief matter. Keep Differential and the broader 2021 application family on the parity map. Preserve the original visual vocabulary rather than replacing it with a generic assistant chat UI.

The core interaction is an object with a history. Chat and voice are additional ways to operate it. AI reviews attach evidence to a snapshot. Agents should eventually perform bounded work and present a traceable result; the application must not rely on an agent's memory as the source of truth.

## ADR 001: strict TypeScript modular monolith

Use one language for the browser, API, CLI, validation contracts and portable offline processing. TypeScript's discriminated unions make object kinds, states and provider identity explicit. Shared deterministic functions can run unchanged on the device or server. React handles the UI; Vite bundles it. Native Node HTTP and SQLite keep the first install small.

This choice favors iteration speed and shared client/server semantics. It is not a claim that TypeScript is universally superior. Rust would be a useful isolated component for future parsing or local compute; it does not need to own the whole first product. Python integrations can live behind job protocols. PHP is not a runtime dependency.

Stay a modular monolith until real workload boundaries justify separate services. Keep the domain model separate from UI, model providers and job workers. SQLite provides transactional durable storage now; add a PostgreSQL adapter when authenticated multi-user concurrency warrants it. The current synchronous SQLite API is suitable for a local prototype, not an unbounded workload or large model job queue.

## ADR 002: immutable revisions and explicit evidence

`Revision` is the durable identity (code `D`, paper `P`, prose `L`); `RevisionVersion` is an immutable complete file snapshot with a SHA-256 content hash. Uploading another version resets acceptance. Comments retain the version and location they originally described. Review runs retain version, content hash, timestamp, provider and model.

Every edit records activity in the same transaction. Optimistic version checks reject edits based on stale snapshots. Idempotency keys bind successful mutation responses to their method, path and body, allowing uncertain network requests to be retried without duplicating work. A model result is rechecked against the current version after it finishes, since the document may change while the request is running.

Current acceptance is a manual state transition gated by a current-version review with no error findings. It is not an automated quality certificate. Future workflow policy will require independent checks, evidence, test/build results, and scoped authority before permitting unattended integration. One successful text check must not become a universal merge or filing authorization.

## ADR 003: local-first with an honest offline boundary

Production serves a cacheable application shell. Browser snapshots, drafts and an outbox survive reloads. A lost response and a disconnected device use the same idempotent replay protocol. Version conflicts remain visible rather than overwriting another edit. The initial storage adapter uses browser local storage; move larger content, queues and assets to IndexedDB with explicit quota/error handling before large manuscripts.

Local deterministic analysis imports no Node APIs and runs on-device without network. Optional Ollama review calls an operator-configured local model runtime. Hosted review is a distinct explicit action. Offline does not currently mean peer-to-peer sync, a fully on-device language model, offline speech recognition, or conflict-free simultaneous editing. Those are separate milestones.

Voice and keyboard use the same typed intent parser. Unsupported or ambiguous commands do not execute mutations. Recognition is feature-detected, initiated by the user, and can use a browser-hosted service; speech is not advertised as private/offline. Later, add a local transcription worker and a durable dictation inbox so audio can be processed after disconnection.

## ADR 004: document semantics before more code hosting

Source lines remain useful for TeX and code; word changes are the initial prose view. The next document model needs stable paragraph/section IDs, moved-block detection, citation objects, figures, equations, bibliography and provenance. A diff should distinguish formatting changes from changed claims. Anchor migration must preserve the original location and disclose uncertainty when matching it to a later version.

PDF builds belong in isolated workers with pinned toolchains, time/memory limits, no shell escape, no network and a read-only bundle of explicit assets. The API must not run untrusted TeX directly. DOCX import/export needs tracked-change preservation and round-trip fixtures. Legal citation verification and scientific claim checking need retrieved evidence with provenance, not a model inventing sources.

## ADR 005: policies before network deployment

The first server is loopback-only and single-user. Strict Host/Origin validation prevents ordinary websites from operating it; content and request sizes are bounded. Files are stored as data, never executed. API keys remain server-side. Mobile layout works today, but remote phone access needs authentication, TLS and a safe deployment mode.

Before sharing a workspace, implement humans/services/agents as distinct principals, object policies, project membership, Spaces, scoped tokens, auditable agent capabilities and retention controls. Search, model context, notifications and exports must enforce the same policies as object reads. A prompt is not an access-control boundary.

## ADR 006: portable application, separate site operations

The public repository owns the reusable product: application code, authentication and policies, a documented configuration interface, reproducible builds, and tests. Operator-specific domains, DNS/TLS configuration, reverse-proxy rules, infrastructure, identity-provider registrations, secrets, backups and deployment automation belong in a separate site/infrastructure repository. That repository should consume a pinned application commit or immutable release artifact without requiring a site-specific application fork. Public CI checks the product; it does not deploy a particular operator's site.

The local application supports a site root or configurable path prefix through `APP_BASE_PATH`, for example `/workspace/`. Browser/API/CLI paths, assets, canonical redirects, health routes, web-manifest identity/start URL/scope and service-worker registration use the same mount. Build and server configuration must agree; a mismatched build produces a clear error. A future network hosting mode still needs explicit public-origin validation and a documented prefix-preserving trusted-proxy contract. Path mounting alone does not enable network hosting.

Offline support must coexist with other applications: restrict the service worker to the mount and explicit static assets, and keep API/authentication responses out of its shell cache. Namespace caches, drafts, snapshots, outbox entries and cross-tab locks by deployment/workspace identity, and private records by authenticated principal. Define logout, account switching and expired-session behavior before network deployment: another user must not see cached private drafts, and queued writes must never replay as a different principal. Unsynced work needs an explicit retention/export policy rather than silent deletion.

A URL path is a routing boundary, not a browser security boundary. Applications sharing an origin also share browser storage access; namespacing prevents accidental collisions but does not isolate untrusted sibling applications. The site operator must account for that shared trust and any broader service worker already present. See [same-origin behavior](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy) and [service-worker scope](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register).

Authenticated hosting remains gated on ADR 005. Preserve the loopback-only default while adding explicit trusted-proxy handling, session/CSRF protection and object authorization; forwarding traffic through a proxy is not authentication. Scope server-side idempotency records to the principal/workspace and recheck authorization before returning a stored result. Verify root and non-root installations, unrelated sibling routes, desktop/mobile navigation, offline reload, account changes and CLI requests before declaring a release deployable. The current implementation separates offline data by mount while retaining the original root storage keys. It still has one local workspace identity; authenticated account/workspace namespaces and actor-scoped idempotency remain planned.

## Code map

| Directory | Responsibility |
| --- | --- |
| `shared/` | Domain contracts and portable text checks |
| `server/` | SQLite store, API boundary, transactions, provider adapters |
| `client/` | Phabricator-style React interface, offline state, typed/voice commands |
| `cli/` | Initial explicit-file `arc` workflow |
| `tests/` | Shared checks, provider contracts and end-to-end workflows |
| `reference/` | Ignored, pinned read-only upstream source |
| `docs/` | Internal tracker, feature inventory and decisions |

Primary API sources: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Ollama chat](https://docs.ollama.com/api/chat), [Node SQLite](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html). Historical source and UI provenance are recorded in [upstream.md](upstream.md).
