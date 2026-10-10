# Internal implementation tracker

The product goal is a familiar Phabricator workspace for documents, code and agents. Full parity with the latest pinned upstream source is the ongoing completion target, alongside voice, offline work and explicit AI workflows. Capabilities removed after the original 2021 baseline remain historical carry-forward targets. [parity.md](parity.md) inventories all upstream applications and defines completion evidence. No GitHub Issues are used.

## Foundation delivered in the first slice

| ID | Scope | State / boundary |
| --- | --- | --- |
| F001 | Download historical sources and inventory all applications | Done; exact commits and reproduction script recorded |
| F002 | Strict TypeScript browser/API/CLI foundation | Implemented; one process plus browser |
| F003 | SQLite transactions, version snapshots, comments and evidence | Implemented; local single-user only |
| F004 | Tasks, projects, wiki, repository registry, activity | Partial legacy parity; no hosted repositories or object ACLs |
| F005 | Paper and prose drafts with source/word comparisons | Implemented first slice; no PDF or DOCX engine |
| F006 | Offline checks, drafts, snapshot reads and mutation outbox | Implemented first slice; conflicts require attention |
| F007 | Hosted and local model review adapters | Implemented; credentials/runtime required; live provider evaluation pending |
| F008 | Familiar responsive shell and typed/voice commands | Implemented first slice; speech recognition browser-dependent; direct D/P/L/W object navigation supported |
| F009 | Wiki history and comparisons (WIKI-01 local slice) | Implemented immutable content versions, summaries, paging, arbitrary version comparison and restore-as-new; legacy migration preserves only known content; authenticated authorship and WIKI-02–04 remain gaps |

## Next: useful document iteration

| ID | Work | Acceptance criterion |
| --- | --- | --- |
| D101 | Paragraph and sentence anchors | Comments survive insertions; moved/deleted text remains understandable; ambiguous relocation is disclosed |
| D102 | Document compare controls | Compare any versions, distinguish moves, filter formatting changes, navigate and read changes aloud |
| D103 | Sandboxed TeX jobs and PDF artifacts | Reproducible build manifest, source/PDF alignment, compile diagnostics, no unsafe shell or network access |
| D104 | Citation/evidence objects | Import BibTeX and structured sources; show where a claim came from and whether the source was actually checked |
| D105 | DOCX interchange | Preserve headings, footnotes, comments and tracked changes across golden-fixture round trips |
| D106 | Review threads and resolutions | Resolve/reopen findings, propose a patch, show its exact scope, apply atomically to the expected version |
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
| O207 | Configurable path-prefix hosting | Implemented for local mode; APP_BASE_PATH covers browser/API/CLI, assets, canonical redirects, manifest and service-worker scope; root and mounted browser tests cover desktop/mobile and offline reload; network hosting still requires O204/P301 |
| O208 | Account-aware offline storage | Mount-specific caches/drafts/outbox/locks implemented without discarding root data; workspace/principal isolation, logout/account switching and retention/export policy remain planned |
| O209 | Portable release and hosting contract | Planned; document validated origin/base-path/proxy configuration, persistent data and health interface; reproduce a pinned release with independent site configuration and no operator-specific files or credentials in this repository |

For hosted access, complete the authentication and object-policy requirements in O204/P301 alongside O207–O209 before exposing a workspace. These requirements are reusable product work. Site-specific infrastructure and rollout plans remain in a separate repository; see [ADR 006](architecture.md#adr-006-portable-application-separate-site-operations).

## Then: scale the Phabricator platform

| ID | Work | Acceptance criterion |
| --- | --- | --- |
| P301 | Users, projects, policies, Spaces and agent principals | Object access enforced consistently in reads, edits, search, model context and exports |
| P302 | Tasks/workboards/custom fields and transactions | Real Maniphest workflows, dependencies, subscriptions, batching and auditability |
| P303 | Git observation, browsing and Arcanist-compatible flow | Local Git fixtures prove revision ranges, patch application, rebases and safe land behavior |
| P304 | Herald and build/review workers | Typed events, scoped actions, durable jobs, test evidence and configurable approval policies |
| P305 | Conduit/import/export compatibility | Historical fixtures migrate without losing identities, versions, policies or discussion context |
| P306 | Remaining apps and infrastructure | Advance each row in the full parity inventory with demonstrable behavior, not just matching names |

The source is public under Apache 2.0. The working title, hosting implementation and long-term compatibility promises remain product decisions. The boundary between the reusable application and site operations is established in ADR 006. None blocks using this local foundation to iterate.
