# Internal implementation tracker

The product goal is a familiar Phabricator workspace for documents, code and agents. Full parity with the latest pinned upstream source is the ongoing completion target, alongside voice, offline work and explicit AI workflows. Capabilities removed after the original 2021 baseline remain historical carry-forward targets. [parity.md](parity.md) inventories all upstream applications and defines completion evidence. No GitHub Issues are used.

## Foundation delivered in the first slice

| ID | Scope | State / boundary |
| --- | --- | --- |
| F001 | Download historical sources and inventory all applications | Done; exact commits and reproduction script recorded |
| F002 | Strict TypeScript browser/API/CLI foundation | Implemented; one process plus browser |
| F003 | SQLite transactions, version snapshots, comments and evidence | Implemented; local mode and attributed authenticated writes |
| F004 | Tasks, projects, wiki, repository registry, activity | Partial legacy parity; object policies implemented, no hosted repositories |
| F005 | Paper and prose drafts with source/word comparisons | Implemented first slice; no PDF or DOCX engine |
| F006 | Offline checks, drafts, snapshot reads and mutation outbox | Implemented first slice; conflicts require attention |
| F007 | Hosted and local model review adapters | Implemented; credentials/runtime required; live provider evaluation pending |
| F008 | Familiar responsive shell and typed/voice commands | Implemented first slice; speech recognition browser-dependent; direct D/P/L/W/T/PROJ object navigation supported |
| F009 | Wiki history and comparisons (WIKI-01 local slice) | Implemented immutable content versions, summaries, paging, arbitrary version comparison and restore-as-new; legacy migration preserves only known content; new authenticated writes retain principal/credential attribution; WIKI-02–04 remain gaps |
| F010 | Accounts and request authority (AUTH-01/02 slice) | Password sessions, terminal provisioning/reset/disable, scoped revocable tokens, account attribution and principal-scoped retries implemented; invitations, MFA and remote hosting remain open |
| F011 | Object and Space policies (POLICY-01 slice) | Explicit workspace/member view, edit and interact rules; restrictive Spaces; policy-aware reads/search input/history/exports/review calls; atomic replay and revocation checks; mobile access controls and draft quarantine (durable locally, tab-memory-only when authenticated). Project-specific membership/join rules implemented; project audiences on other objects, inherited wiki restrictions and full-text search remain gaps |
| F012 | Project profiles and membership (PROJECT-01 slice) | Versioned profiles, names/aliases, icons/colors, archive/restore, member management and join/leave, independent watching, private silence preferences, Space-bounded member visibility, mobile profiles and CLI filters. F014 adds initial workboards; notification delivery and remaining profile capabilities remain gaps in [project contracts](projects.md) |
| F013 | Project hierarchy and milestones (PROJECT-02 slice) | Ordinary subprojects, parent-scoped milestones, first-child membership conversion, inherited members/watch preferences and milestone policies, ancestor view restrictions, visible descendant filters and ordered task-tag conflicts. Creation pins parent metadata/hierarchy/membership versions; mobile drafts retain those versions. Import compatibility remains a gap; F014 adds initial board integration. |
| F014 | Project workboards (PROJECT-03 and first PROJECT-04 slice) | Opt-in boards, independent column/card ordering, milestone proxies, atomic task-tag moves, column administration, version-pinned imports of column setups, advisory visible-card limits, immutable history, mobile/keyboard move controls and paged CLI reads. Writes stay online with retained version-pinned intents. Triggers, bulk moves, grouped sorting, saved defaults, points, drag-and-drop, historical data imports and multiple proxy positions remain gaps. See [workboard contracts](workboards.md). |

## Next: useful document iteration

| ID | Work | Acceptance criterion |
| --- | --- | --- |
| D101 | Paragraph and sentence anchors | Partial: immutable source-passage anchors and exact-quote projection across versions; repeated/changed/missing passages retain explicit uncertainty and original context. Semantic paragraph identities and rename/rebase mapping remain open. See [review threads](review-threads.md). |
| D102 | Document compare controls | Compare any versions, distinguish moves, filter formatting changes, navigate and read changes aloud |
| D103 | Sandboxed TeX jobs and PDF artifacts | Reproducible build manifest, source/PDF alignment, compile diagnostics, no unsafe shell or network access |
| D104 | Citation/evidence objects | Import BibTeX and structured sources; show where a claim came from and whether the source was actually checked |
| D105 | DOCX interchange | Preserve headings, footnotes, comments and tracked changes across golden-fixture round trips |
| D106 | Review threads and resolutions | Partial: immutable replies, optimistic resolve/reopen, version-bound state history, exact single-passage suggestions and atomic application as new versions. Multi-passage/file proposals, rebasing, upstream publication semantics and automated proposal provenance remain open. See [suggested edits](suggested-edits.md). |
| D107 | Review evaluations | Curated code/paper/prose fixtures measure false positives, groundedness, missed defects, cost and latency per model |

## Next: private, hands-off and mobile work

| ID | Work | Acceptance criterion |
| --- | --- | --- |
| O201 | IndexedDB storage and durable job queue | Large drafts survive reload/quota failures; jobs have cancellation, retry, expiry and version binding |
| O202 | Local audio inbox and transcription | Record while disconnected; transcription stays local when requested; raw audio retention is explicit |
| O203 | Full spoken review workflow | Navigate findings, dictate comments, read changed passages, request explicit actions and stop hands-free |
| O204 | Authenticated mobile deployment | Real phone access over TLS with sessions/tokens, private drafts and installable app testing on iOS/Android |
| O205 | Cross-device synchronization | Multiple devices retain drafts and detect conflicts; no silent last-write-wins for manuscript revisions |
| O206 | Local model lifecycle | Model availability/context checks, cancellation, resource budgets, trusted local-only configuration and evaluations |
| O207 | Configurable path-prefix hosting | Implemented for local and password modes; APP_BASE_PATH covers browser/API/CLI, assets, canonical redirects, manifest and service-worker scope; root and mounted browser tests cover desktop/mobile and offline reload; network hosting still requires O204/P301 |
| O208 | Account-aware offline storage | Local mount caches retained; password mode uses verified-session memory only, export-before-signout, request cancellation and context validation across tabs. Durable authenticated offline storage and trusted-device retention remain planned |
| O209 | Portable release and hosting contract | Planned; document validated origin/base-path/proxy configuration, persistent data and health interface; reproduce a pinned release with independent site configuration and no operator-specific files or credentials in this repository |

For hosted access, complete the authentication and object-policy requirements in O204/P301 alongside O207–O209 before exposing a workspace. These requirements are reusable product work. Site-specific infrastructure and rollout plans remain in a separate repository; see [ADR 006](architecture.md#adr-006-portable-application-separate-site-operations).

## Then: scale the Phabricator platform

| ID | Work | Acceptance criterion |
| --- | --- | --- |
| P301 | Users, projects, policies, Spaces and agent principals | Object access enforced consistently in reads, edits, search, model context and exports |
| P302 | Tasks/workboards/custom fields and transactions | Partial: task detail pages, version-checked fields, ownership/authorship, upstream owner access, subscription preferences, immutable comments/transactions, directed dependencies, dependency cycle prevention, parent status history, atomic single/batch duplicate merging with subscriber carry-over, and multiple project tags with add/remove/replace operations, filtered history and offline replay. Initial project workboards now provide independent ordering, atomic tag/card moves and immutable column history. Notification delivery, configurable fields/forms, advanced board behavior and general bulk edits remain open. See [task contracts](tasks.md) and [workboard contracts](workboards.md). |
| P303 | Git observation, browsing and Arcanist-compatible flow | Local Git fixtures prove revision ranges, patch application, rebases and safe land behavior |
| P304 | Herald and build/review workers | Typed events, scoped actions, durable jobs, test evidence and configurable approval policies |
| P305 | Conduit/import/export compatibility | Historical fixtures migrate without losing identities, versions, policies or discussion context |
| P306 | Remaining apps and infrastructure | Advance each row in the full parity inventory with demonstrable behavior, not just matching names |

The source is public under Apache 2.0. The working title, hosting implementation and long-term compatibility promises remain product decisions. The boundary between the reusable application and site operations is established in ADR 006. None blocks using this local foundation to iterate.
