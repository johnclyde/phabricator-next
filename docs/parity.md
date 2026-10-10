# Phabricator parity and expansion roadmap

This document is the project's internal feature tracker for parity with the latest pinned upstream source. It inventories the actual Phabricator and Arcanist heads verified on October 10, 2026 in [upstream.md](upstream.md), preserves explicitly identified 2021 carry-forward capabilities, and separates both from new AI and document workflows. Work is recorded here and in repository documentation, not in GitHub Issues. The [architecture](architecture.md) and [internal roadmap](roadmap.md) set current implementation order.

**Product priority: document iteration first.** Academic papers, legal motions, and other long-form arguments are central, especially word/structure diffs, stable review anchors, and claim/citation provenance. Incremental code review remains part of historical parity but is a secondary initial workflow. Phabricator's durable revision and transaction model is the foundation for both.

**Current stage: bootstrap. No application has full parity.** The running application offers local mode and a password-authenticated shared workspace; consult the [README](../README.md) for the features actually implemented and verified. Every baseline item below remains a planned parity target unless a smaller verified slice is explicitly recorded. A visible navigation item, fixture, simulated reviewer, static document, or successful build is not feature parity.

## Baseline and completion rule

The active baseline is Phabricator `5720a38c` and Arcanist `e50d1bc4`, the latest default-branch heads verified on October 10, 2026. Source inventory: [`src/applications` at 5720a38c](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications). The active tree contains **76 directories**, including internal services and prototypes. The 2021 tree contained 78; Phragment and Releeph remain explicit historical carry-forward targets below. The [latest-source comparison and API inventory](latest-upstream.md) are part of this acceptance scope, including upstream authorization fixes and removal of unsafe obsolete APIs. The upstream [prototype guide](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/docs/user/userguide/prototypes.diviner) explicitly warns that prototypes may lack essential features. “Prototype” below means the application class returns `isPrototype() = true`, not a judgement about our implementation.

For each application, parity requires:

1. Source-backed behavior specifications covering its workflows, permissions, data model, notifications, search, and APIs.
2. Import/export fixtures that preserve identity, versions, relationships, timestamps, authorship, and access policies.
3. Implemented positive and negative paths with integration tests, including unauthorized access and concurrent edits where applicable.
4. A usable desktop and mobile interface, keyboard operation, accessible labels and focus, and no silent loss of work.
5. A documented comparison against the pinned upstream behavior, with intentional differences called out. Modern replacements for PHP-specific internals count only when the supported capability is demonstrated.

No single percentage is reported until these acceptance criteria become a weighted, tested inventory. Counting directories would overstate progress dramatically.

## Delivery sequence

| Milestone | Product outcome | Exit evidence |
| --- | --- | --- |
| M0 — first vertical slice | Familiar Phabricator shell; durable local tasks and revisions; visible review evidence; paper and document source iteration. | End-to-end create/edit/reload checks on a narrow viewport and desktop. Explicit demo versus live reviewer labels. Baseline docs and pinned sources. |
| M1 — shared foundations | Durable object IDs, typed transactions, users/service actors, policies, Spaces, files, drafts, object links, search, API, jobs, audit trails, migration framework. | Permission test matrix includes agents and search. Restart/retry/concurrent-edit tests. Backup and restore round trip. Login and policy enforcement before multi-user exposure. |
| M2 — document-first revisions | Shared Differential-style revision engine; document word/structure diffs; version-bound discussion and evidence. Code review, Git Diffusion, CLI, Owners, audit and landing extend the engine after document paths work. | Review a paper and legal motion across multiple revisions, preserving original anchors and evidence. Then import representative Phabricator revision/commit fixtures and verify stacked-change/landing semantics. No stale approval can authorize changed content. |
| M3 — projects and coordination | Maniphest, Projects/workboards, Herald, notifications, dashboards, subscriptions, feeds. | Task lifecycle, custom fields/forms, dependency checks, project nesting, board moves, saved queries, mail actions, and rule logs survive import/export. |
| M4 — knowledge and document production | Phriction, Files/Paste, Pholio, Diviner, paper builds, legal document exchange, bibliography/cross-reference and claim review. | Wiki histories import; a multi-file LaTeX project produces reproducible PDF/logs in an isolated worker; a motion retains headings, numbering and citation provenance across import/export and review. |
| M5 — automation and operations | Harbormaster, Drydock, Almanac, Passphrase, repository observation/hosting operations, production deployment. | Jobs are idempotent, bounded, cancellable and replayable; secrets are scoped; workers isolated; recovery/backups and monitoring tested. |
| M6 — collaboration breadth | Conpherence, Calendar, Ponder, Slowvote, Phame, badges/tokens/macros, time tracking, links and events. | Import and interaction tests for each application; notification and policy behavior matches declared baseline. |
| M7 — long-tail baseline | Optional prototypes, billing/donations, package and artifact distribution, release management, legacy VCS, admin/developer tools. | Each historical capability either implemented with proof or explicitly recorded as a remaining gap. Optional features stay disabled until safe and useful. |
| M8 — migration and compatibility release | Cohesive replacement deployable beside and then instead of the historical installation. | Full migration rehearsal on a representative export, source count reconciliations, permission reconciliation, attachment integrity, redirects, CLI/API compatibility report, rollback rehearsal. |

The first repository adapter is Git, but Mercurial and Subversion remain required gaps for full historical parity. M4 document work can progress alongside M2; it should use the same revision, review, artifact, and policy primitives. Milestones group capabilities and dependencies, not calendar promises; document iteration takes priority over completing the code-specific remainder of M2.

## Core workflow acceptance

| Capability | Baseline behavior to recover | AI-era or paper extension | First milestone |
| --- | --- | --- | --- |
| Differential | Revision states; immutable diff versions; reviewers and subscribers; inline/range comments; resolution; diff-of-diffs; binary changes; dependencies; test plans; draft/update/abandon/reopen/close; commit association. | Documents and code use the same versioned change object. Word, paragraph and structure changes are primary views. Independent agent findings contain evidence and provenance. Approval binds to a content digest and policy version. | M2 |
| Diffusion / Repository | Host or observe Git/Hg/SVN; branches/tags; source browsing; blame/history/diffs; commit references; symbols; push policies; hooks; imports; mirrors and clustered service behavior. | Workers and agents read repository snapshots within their authorization. Evidence retains exact commits and tool versions. | M2, M5, M7 |
| Arcanist | Working-copy detection; authentication; `diff`, `patch`, `land`, `lint`, `unit`; revision ranges, stacks and rebase handling; configurable lint/test engines; machine-readable results. | A TypeScript CLI supports code or paper changes, agent review requests, evidence inspection, and safe landing. Compatibility is tested, not assumed. | M2 |
| Maniphest | Tasks with status/priority/owner; configurable fields/forms; projects; dependencies; duplicate merging; comments; bulk edits; search/reporting. | Agents can propose and execute scoped task work; every mutation names its actor and explains its evidence. | M3 |
| Projects | Tags, membership, nested projects and milestones, workboards, columns, board moves, policies, profiles, activity. | Boards expose human and agent work, blocked states, costs and evidence without inventing a second task system. | M3 |
| Review automation | Owners selects relevant responsibility; Herald evaluates conditions/actions and logs results; Harbormaster links builds to reviewed artifacts. | Configurable checks and risk thresholds replace mandatory human review for eligible work. Humans remain available for exceptions and contested findings. | M2–M5 |
| Knowledge | Wiki document hierarchy/history, code documentation, files, paste snippets, visual mock review, object references and search. | Claims, citations, equations, figures and experiments become addressable evidence attached to paper revisions. | M4 |
| Integration | Conduit search/edit pagination, custom fields, webhooks, outbound/inbound email, external object links, auth providers. | Typed API tools and event subscriptions for agents, with least-privilege service actors and traceable run IDs. | M1, M3, M5 |
| Shared invariants | Stable IDs, transaction history, subscriptions, object policies, Spaces, full-text search, file access, drafts, notifications. | The same policy applies to model context, retrieval results, generated summaries, review findings, artifacts and caches. | M1 |

The [upstream Differential FAQ](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/docs/user/userguide/differential_faq.diviner) documents configurable sticky acceptance after updates. Our proposed exact-content approval intentionally tightens that behavior for automated landing: updating the reviewed content requires fresh applicable evidence. This is a recorded difference, not an accidental loss of compatibility. Preserve imported historical accept events as history; do not reinterpret them as current proof.

## Next acceptance slices

These identifiers are internal tracking keys. The rows describe required acceptance evidence, not completed work. Record implemented subsets and their tests in the roadmap; do not mark an entire application complete after one slice. Detailed pinned source entry points are in [latest-upstream.md](latest-upstream.md#foundation-acceptance-details).

| Key | Capability | Required evidence |
| --- | --- | --- |
| AUTH-01 | Accounts and sessions | Operator bootstraps an administrator; invited users sign in and out; sessions expire, revoke and survive only as intended across restarts. Disabled users and anonymous callers cannot read or mutate protected objects. |
| AUTH-02 | Request and credential boundaries | Session rotation, password hashing, CSRF protection, throttling and safe return URLs are exercised. Browser cookies and CLI tokens have distinct scope/revocation tests; mount paths do not bypass checks. |
| AUTH-03 | Identity lifecycle | Registration approval, email verification/recovery, account linking, provider configuration, service actors, MFA and SSH keys have explicit implemented/unsupported status. No placeholder provider is reported as working. |
| POLICY-01 | Objects and Spaces | View/edit/interact, project membership and a restrictive Space are evaluated for both direct IDs and list/search. Inaccessible objects and counts cannot leak through activity, attachments or model context. |
| POLICY-02 | Offline and automated identity | Offline drafts/outbox/cache are partitioned by authenticated identity and server. Logout/account switch cannot replay one user's writes as another. Agents have attributed, bounded authority. |
| WIKI-01 | Durable content history | Every wiki edit creates immutable content with actor/time/edit summary; view any version and compare two versions. A restart preserves histories, and concurrent updates conflict rather than overwrite. |
| WIKI-02 | Hierarchy and movement | Canonical slugs, root/parent/child navigation, missing ancestors, move destinations and redirects are defined. Moving a subtree preserves descendants and stable document IDs; collisions and cycles fail safely. |
| WIKI-03 | Delete, draft and publish | Soft deletion, restoration, draft versus published state and publishing an earlier version preserve historical content and policy checks. |
| WIKI-04 | Wiki policy and interoperability | Parent/ancestor restrictions apply to view/edit/history/search/preview. Mentions and file references do not widen permissions. Import/export retains histories, hierarchy and authorship; Phriction APIs are mapped. |
| TASK-01 | Attributed transactions | Owner, author, subscribers, multiple project tags, status, priority and comments have durable transaction history. Stale updates fail explicitly, and bulk edit results report each object. |
| TASK-02 | Dependencies and duplicates | Create/remove parent-child dependencies; reject dependency cycles; resolve/unblock and merge duplicate tasks with preserved histories and bidirectional relationships. |
| TASK-03 | Configurable work | Custom status/priority, fields, forms, required fields, points, ordering and edit permissions are validated consistently through UI and API. |
| TASK-04 | Queries and notifications | Saved filters, cursor pagination, reporting, subscriptions, inbound/outbound mail and Herald actions use the same policy checks and retry-safe events. |
| PROJECT-01 | Project identity and membership | Multiple tags, members/watchers, join/leave, edit/archive, icons/colors, aliases, profiles and activity persist with policies and transactions. |
| PROJECT-02 | Hierarchy and milestones | Parent/subproject/milestone relationships and inherited membership semantics match pinned source; reject cycles and invalid reparenting. |
| PROJECT-03 | Real workboards | Ordered per-project columns and card positions are independent of task status. Move cards through a touch/keyboard action, survive reload, handle concurrent ordering, and support a task on multiple boards. |
| PROJECT-04 | Board administration | Column edit/hide, WIP limits, triggers, board enable/disable, filtering, bulk moves and policy failures are visible and attributable. |

The AUTH-01/02 slice implements terminal-provisioned password accounts, expiring/revocable sessions, CSRF/context checks and scoped CLI tokens. Object and Space rules now restrict the shared workspace; invitations, account lifecycle parity and durable authenticated offline work remain gaps.

The POLICY-01 slice implements explicit workspace/member audiences, separate view/edit/interact capabilities and restrictive Spaces for every current object type. Direct reads, current list/search input, activity, wiki history, exports, references, mutation retries and model calls enforce these rules. Browser access changes remove cached server content and set aside unsaved drafts for explicit export/discard. General custom rules, project-member audiences on other objects, inherited wiki restrictions, attachment policies, full-text indexes and agent identities remain gaps; see [policy semantics and limits](policies.md).

The D101/D106 discussion slice adds immutable passage anchors, conservative exact-quotation projection, threaded replies and optimistic resolve/reopen with source-version provenance. Existing comments become threads without rewriting their records. All-version discussion preserves original context when passages move, repeat or disappear. This remains partial: semantic paragraph identity, rename/rebase mapping, deleted-side comments, owner-specific Done permissions, unpublished discussion drafts and multi-passage/file patches are unfinished. Single-passage suggested replacements now apply atomically as a new version after exact source/thread checks; see [suggested edits](suggested-edits.md). See [the thread contract and upstream comparison](review-threads.md).

The TASK-01/02 slice adds individual task pages, version-checked field edits, append-only comments, structured immutable history and directed dependencies with inverse links, cycle rejection and parent status-change history. Related-task visibility applies to details, paged history and saved retries; offline drafts retain concurrency evidence. Task ownership/authorship, Space-bounded automatic owner access, subscription preferences and owner/following filters are implemented. Single and batch duplicate merges preserve both task histories, record inverse relationships and explicitly add source followers at the destination. Multiple project tags support creation, add/remove deltas, deliberate full replacement, visible project filtering and versioned offline replay. Notification delivery, mute, project subscribers, configurable fields and bulk edits remain gaps. Initial workboards are implemented in the separate PROJECT-03 slice below; advanced board behavior remains partial. See [task contracts and upstream evidence](tasks.md).

The PROJECT-01 slice adds versioned profiles, names/aliases, icons/colors, reversible archiving, members, separate joining rules, watching and private silence preferences. Member visibility is bounded by Spaces and does not grant access to tagged objects. Browser profiles and CLI filters expose these workflows; notification delivery, images, configurable forms and membership-lock capabilities remain gaps. PROJECT-02 adds ordinary subprojects and milestones, explicit first-child member transfer, derived membership, inherited watching and milestone rules, ancestor visibility, visible descendant filters and ordered tag conflicts. Import compatibility remains unfinished. See [project contracts and source evidence](projects.md).

The PROJECT-03 workboard slice adds opt-in boards, normal and milestone columns, independent per-board ordering, version-pinned touch/keyboard moves, atomic tag effects, visible-card limits, filtered history and paged CLI reads. The first PROJECT-04 administration features include enable/disable, column rename/hide/reorder, advisory limits, version-pinned column imports into new boards and atomic bulk moves within or across projects. Bulk moves preview the complete eligible selection up to 100 tasks and preserve exact source-tag removal and upstream prepend ordering. Triggers, points, grouped sorting, saved defaults, generic bulk edits, ordinary-subproject proxy bulk sources, historical data imports, drag-and-drop and multiple simultaneous proxy positions remain gaps. The global task-status columns are a separate view. See [workboard contracts and upstream evidence](workboards.md).

The WIKI-01 local slice stores immutable snapshots, edit summaries, paged history and comparisons. Expanded history survives background head refreshes, including missing middle pages after a large head jump; restore-as-new is distinct from upstream publication-pointer semantics. New authenticated writes retain principal/credential attribution. Hierarchy, drafts/publication, inherited ancestor policies and interoperability remain gaps. See the roadmap for verified implementation slices.

## Every active and historical upstream application directory

Each row describes scope still to implement or verify. There are 76 active-source rows and two explicitly marked historical carry-forward rows. Several directories contribute infrastructure to the same user-facing application. “Standard” means not flagged as an upstream prototype; it does not certify maturity. The source's own Harbormaster guide, for example, warns of incomplete capabilities despite having no prototype flag.

| Directory | Application / role | Baseline scope and acceptance anchor | Upstream kind | Milestone |
| --- | --- | --- | --- | --- |
| `almanac` | Almanac | Devices, services, bindings, networks, properties, service discovery and policies. | Standard | M5 |
| `aphlict` | Live event transport | Authenticated real-time notification delivery, reconnect and failure behavior. | Internal | M1, M3 |
| `arcanist` | Arcanist server integration | Associate repositories/projects and working-copy workflows with the CLI. | Internal | M2 |
| `audit` | Audit | Post-commit audit requests, comments, concern/accept states and filtering. | Standard | M2 |
| `auth` | Authentication | Login, registration, providers, sessions, account recovery, MFA and credential revocation. | Standard | M1 |
| `badges` | Badges | Award/revoke badges, descriptions, recipients and access control. | Standard | M6 |
| `base` | Shared application framework | Routing, controllers, base UI, application integration and request behavior. | Internal | M0, M1 |
| `cache` | Cache infrastructure | Scoped caches, invalidation and administrative management. | Internal | M1, M5 |
| `calendar` | Calendar | Events, invitations, recurrence, availability and calendar imports. | Prototype | M6 |
| `celerity` | Asset delivery | Versioned assets, dependency resolution, themes and cache-busted bundles. | Internal | M0, M5 |
| `chatlog` | ChatLog | Historical chat logs and query behavior; deprecated upstream, preserve import/export. | Prototype / deprecated | M7 |
| `conduit` | Conduit API | Token auth, API console, method discovery, search/edit, errors and pagination. | Standard | M1, M8 |
| `config` | Configuration | Validated configuration, setup checks, overrides and administrator tooling. | Standard | M1, M5 |
| `conpherence` | Conpherence | Persistent conversation threads, participants, messages, files and notifications. | Standard | M6 |
| `console` | Developer console | Request-level debugging and diagnostic panels; replace PHP coupling. | Internal | M5, M7 |
| `countdown` | Countdown | Named target dates, visible counters, ownership and sharing. | Standard | M6 |
| `daemon` | Worker management | Queue execution, task state, retries, worker health and control. | Standard | M1, M5 |
| `dashboard` | Dashboards | Custom dashboards, panels, layouts, queries, profiles and access policies. | Standard | M3 |
| `differential` | Differential | Complete revision/diff review lifecycle, inline comments, dependencies and links to commits. | Standard | M2 |
| `diffusion` | Diffusion | Repository UI: browse, history, blame, branches, tags, diffs and administration. | Standard | M2, M7 |
| `diviner` | Diviner | Documentation books, atoms, indexes, symbols, publishing and cross-links. | Standard | M4 |
| `doorkeeper` | External integration | Durable links to external objects, synchronization and provider metadata. | Standard | M5 |
| `draft` | Draft storage | Recover in-progress comments/forms with correct author and object scope. | Internal | M1 |
| `drydock` | Drydock | Resource blueprints, leases, allocation, working copies and repository automation. | Standard | M5 |
| `fact` | Facts | Derived metrics, facts, aggregation and chart queries. | Standard | M3, M7 |
| `favorites` | Favorites | User-configured application/navigation shortcuts. | Standard | M3 |
| `feed` | Feed | Permission-filtered activity stories, queries and cross-object updates. | Standard | M3 |
| `files` | Files | Upload/download, transformations, previews, attachments, storage engines, access control and integrity. | Standard | M1, M4 |
| `flag` | Flags | Private colored bookmarks attached to objects with personal notes. | Standard | M3 |
| `fund` | Fund | Initiative funding and donation records, with Phortune integration. | Prototype | M7 |
| `guides` | Guides | Onboarding/tutorial content and contextual entry points. | Standard | M0, M7 |
| `harbormaster` | Harbormaster | Buildables, build plans/steps/targets, statuses, artifacts, logs and external result reporting. | Standard | M5 |
| `help` | Help | Contextual documentation navigation and help affordances. | Internal | M0, M7 |
| `herald` | Herald | Global/personal/object rules, conditions, actions, transcripts and dry runs. | Standard | M3, M5 |
| `home` | Home | Personal landing page, application navigation and configurable menu. | Standard | M0, M3 |
| `legalpad` | Legalpad | Versioned agreements, signatures, signer verification and access restrictions. | Standard | M7 |
| `lipsum` | Fixture generator | Controlled synthetic objects for development/testing; never production-only dependencies. | Internal | M0, M7 |
| `macro` | Macro | Image macros, aliases, Remarkup integration and management. | Standard | M6 |
| `maniphest` | Maniphest | Task lifecycle, priorities, custom forms/fields, dependencies, duplicates and bulk actions. | Standard | M0, M3 |
| `meta` | Applications | Application inventory, configuration, installation/enabling and capability visibility. | Standard | M0, M7 |
| `metamta` | Mail | Outbound mail, inbound command/reply handling, delivery logs and routing. | Standard | M3, M5 |
| `multimeter` | Multimeter | Sampled performance events and inspection. | Prototype | M7 |
| `notification` | Notifications | Unread state, delivery preferences, badge counts and object links. | Standard | M3 |
| `nuance` | Nuance | Sources, queues, items, routing and high-volume triage. | Prototype | M7 |
| `oauthserver` | OAuth Server | OAuth client registration, authorization, token grants/revocation and scopes. | Prototype | M7 |
| `owners` | Owners | Code ownership packages, paths, exclusions and review/audit routing. | Standard | M2 |
| `packages` | Packages | Publishers, packages, versions and release distribution as present in prototype. | Prototype | M7 |
| `passphrase` | Passphrase | Credential metadata, restricted secret access, consumers, revocation and audit. | Standard | M5 |
| `paste` | Paste | Text snippets, languages, revisions, forks, policies and links. | Standard | M4 |
| `people` | People | Users, service actors, profiles, account management, disabling and administrative actions. | Standard | M1 |
| `phame` | Phame | Blogs/posts, drafts, publishing, authorship, domains and access control. | Standard | M6 |
| `phid` | Global identifiers | Stable typed object identities, handle resolution and cross-object references. | Internal | M1 |
| `phlux` | Phlux | Versioned key/value configuration, editing, access policy and API. | Prototype | M7 |
| `pholio` | Pholio | Mock collections, image versions, region comments, status and review history. | Standard | M4 |
| `phortune` | Phortune | Accounts, merchants, carts/orders, payment providers and billing records. | Prototype | M7 |
| `phpast` | PHPAST | Preserve PHP parser inspection capability where useful; modern parser/debug adapter. | Developer tool | M7 |
| `phragment` | Phragment | Historical versioned hierarchical artifacts, snapshots and patch/download behavior. Removed in latest upstream; carry forward from the 2021 source. | Historical prototype, removed | M7 |
| `phrequent` | Phrequent | Start/stop time tracking, tracked objects, durations and reporting. | Prototype | M6 |
| `phriction` | Phriction | Wiki hierarchy, edit history, diffs, moves, deletes, restoration and policies. | Standard | M4 |
| `phurl` | Phurl | Managed shortened URLs, redirects, aliases, policies and history. | Prototype | M6 |
| `policy` | Policies | View/edit/interact checks, capabilities, custom rules and inherited restrictions. | Internal | M1 |
| `ponder` | Ponder | Questions, answers, voting, status, comments and search. | Standard | M6 |
| `project` | Projects | Tags, membership, nested projects, milestones, workboards, columns and moves. | Standard | M3 |
| `releeph` | Releeph | Historical release-branch requests, pull/pick decisions and branch workflow. Removed in latest upstream; carry forward from the 2021 source. | Historical prototype, removed | M7 |
| `remarkup` | Remarkup | Formatting, code/math, mentions, object links, embeds and safe rendering. | Internal | M1, M4 |
| `repository` | Repository engine | Storage/import, polling, Git/Hg/SVN adapters, push hooks, mirrors and clustering. | Internal | M2, M5, M7 |
| `search` | Search | Application/full-text search, saved queries, pagination, indexes and policy filtering. | Standard | M1, M3 |
| `settings` | Settings | User preferences, locale/timezone, accessibility and notification settings. | Standard | M1, M3 |
| `slowvote` | Slowvote | Polls, options, voting rules, visibility and results. | Standard | M6 |
| `spaces` | Spaces | Policy namespaces that further restrict every contained object's visibility. | Standard | M1 |
| `subscriptions` | Subscriptions | Subscribe/unsubscribe behavior, automatic subscriptions and notification routing. | Internal | M1, M3 |
| `support` | Support | Instance support entry points and diagnostic context; replace upstream vendor destination. | Internal | M7 |
| `system` | System | System status and operational diagnostics. | Internal | M5 |
| `tokens` | Tokens | Awardable object reactions/trinkets, counts, history and visibility. | Standard | M6 |
| `transactions` | Transactions | Validated edits, comments, history, actor attribution, attachments and concurrency. | Internal | M1 |
| `typeahead` | Typeahead | Permission-aware autocomplete, token selection, object resolution and accessibility. | Internal | M1 |
| `uiexample` | UIExamples | Component gallery and interaction regression fixtures. | Prototype / developer tool | M0, M7 |
| `xhprof` | XHProf | Performance profiles and call-tree inspection; replace PHP runtime dependency. | Developer tool | M7 |

## Beyond the application directories

The directory list omits significant baseline obligations. Track these explicitly before claiming full parity:

| Area | Work still required |
| --- | --- |
| Arcanist repository | Audit the CLI workflow classes, lint engines, unit engines, working-copy adapters, configuration loading, extension points and formatting protocols. Establish the supported compatibility surface command by command. |
| libphutil lineage | Recover behavioral lessons from async processes, futures, encoding, parsing, filesystem handling, safe HTML, logging and libraries. Replace them with tested TypeScript/Node primitives; a line-for-line library port is unnecessary. |
| Data / migration | Schema evolution, PHID mapping, historical authors/timestamps, comments and attachments, custom fields, edges, policies, deleted objects, legacy URL redirects, incremental imports, reconciliation reports and rollback. |
| Platform | Administrative CLI, setup checks, deployment configuration, storage backends, queue operations, backups/restores, TLS/proxy configuration, rate limits, mail, localization, timezone correctness and accessible themes. |
| Extensibility | Typed application modules, registered transaction handlers, custom fields/forms, search providers, auth providers, notification channels, reviewer/worker providers and a documented extension API. |
| Operational parity | Repository storage consistency, replication and disaster recovery, file/blob integrity, secret management, job idempotency, observability, data retention and export. |
| Security invariants | Authorization before object lookup returns data, safe content rendering, CSRF/session boundaries, path isolation, SSRF controls, secret redaction, untrusted code/TeX execution isolation and cross-tenant access tests. |
| Mobile and accessibility | Every accepted workflow works on narrow screens, keyboard and assistive technology; diff review, comments, task editing, boards and paper reading are first-class, not read-only fallbacks. |

## AI review as evidence, not a mandatory human queue

The objective is to make useful automated work normal. A reviewer agent is a named actor with narrow permissions, an immutable run record, and attributable findings. Humans can review, but a blanket human-review requirement is not the default design.

- Each run records model/provider, configuration, task and instructions version, exact input revision digest, authorized context references, tools invoked, costs/usage, timestamps, outputs and failure state. A local heuristic demonstration must not present itself as a model review.
- Findings reference specific files/lines, source spans, claims, citations, figures or build artifacts. Separate observed failures from speculative concerns, and retain evidence sufficient to reproduce a finding.
- Review policies define required checks, acceptable evidence, risk classes and exceptions. Multiple model opinions do not establish correctness. Deterministic checks, builds, tests, proof obligations and independent sources carry explicit weight.
- Automation can approve or land eligible work once declared policy succeeds for that exact tree. New diffs invalidate stale evidence as appropriate. Reruns are cancellable and idempotent; provider failures and partial runs are visible.
- An author or reviewer can dispute a finding, accept a fix, waive a requirement with a recorded reason, or ask for an independent run. No hidden change to source or history occurs because a model suggested it.
- Agent-created patches pass through the same diff, policy, evidence and transaction system. Retrieval, summaries, logs and caches cannot leak objects outside the agent's policies or Space.
- Model credentials stay on the server/worker side. Source text, comments, bibliography, PDFs and repository files are untrusted task data; they cannot expand tool permissions.
- Local/offline model providers are first-class. An Ollama-compatible adapter can keep document content on the user's machine; provider reachability, selected model, limitations and failed runs remain visible. Remote calls must be explicit in provider configuration rather than silently substituting for a local model.

These are product contracts with only an initial implementation slice. The application has explicit hosted and local model adapters, with separate local/hosted review token scopes; current object/Space authorization applies to review requests and returned evidence. Isolated workers, evaluation datasets and automatic landing remain acceptance gaps. Configured real-provider success must be verified separately from deterministic checks and mocked adapter tests.

## Academic papers and LaTeX

Paper projects should be normal repositories with domain-aware views. The same revision object can contain LaTeX, BibTeX, images, data and scripts. Review should answer what changed, why it is justified, what evidence supports it, and whether the result builds reproducibly.

| Workflow | Required capability | Acceptance example |
| --- | --- | --- |
| Authoring | Multi-file source tree, entry-point selection, preserved assets, editable bibliography, drafts and durable revisions. | Edit a section and bibliography on desktop or mobile; restore an earlier version without losing comments. |
| Builds | Isolated TeX worker, pinned engine/toolchain, resource/time limits, no shell escape by default, captured logs, digest-addressed PDFs and assets. | Rebuild the same revision with the same toolchain; report failure honestly and retain the last successful artifact separately. |
| Review | Source diff, prose/structure diff, equations/figures/citations, rendered PDF comparison, inline discussions anchored to immutable versions. | A paragraph moves; the system shows the move and preserves the original comment anchor instead of attaching it silently elsewhere. |
| Evidence | Claim-to-citation and claim-to-experiment links, citation metadata checks, unresolved references, missing figures, reproducibility records and explicit uncertainty. | Flag a citation absent from the bibliography and distinguish that deterministic error from an agent's unsupported critique of a claim. |
| Iteration | Coauthor comments, suggested edits, independent reviewer runs, rebuttal/response tracking and revision dependencies. | Turn reviewer comments into tasks, apply a patch, regenerate evidence and show which comments were addressed by which revision. |
| Sharing | Policy-controlled review links, review packets, portable source bundles, PDFs, bibliography and full history export. | Export a submission packet with exact source revision, build manifest and attachments; no hosted-only lock-in. |

Do not claim a novel capability does not exist elsewhere; validate demand through actual author/reviewer workflows. The differentiator to test is a cohesive Phabricator-style workbench with durable change history, evidence-based automated review, and clean paper builds.

## Legal motions and general document iteration

Legal motions and academic arguments share a need for exact versions, stable references, structured changes and evidence. The document review model should also support non-LaTeX text and, later, loss-aware Word/PDF import and export. A file conversion must report unsupported constructs rather than silently dropping footnotes, numbering, tables or tracked changes.

| Workflow | Planned acceptance requirement |
| --- | --- |
| Word and structure diffs | Compare words, paragraphs, moved passages, sections, numbered propositions, footnotes and tables. Preserve original content; a semantic summary supplements the literal diff. |
| Stable anchors | Attach a comment or finding to an immutable version plus a source span/structure identity. Show relocated or stale anchors explicitly after edits. |
| Claim and citation provenance | Link each factual claim to supplied evidence and each authority citation to its source/version, quoted passage and verification record. Distinguish formatting/existence checks from substantive support. |
| Cross-references | Detect broken section, exhibit, footnote and bibliography references; retain amendment history and source context. |
| Reviewer iteration | Track requested edits, disagreements, responses and resolution against the exact revision that addressed each item. |
| Local work | Continue drafting, comparing versions and using configured local models offline; display unavailable remote capabilities clearly. |
| Voice | Optional dictation and spoken review/navigation with a visible transcript and editable preview. Speech must not silently publish, delete, or submit a document. |
| Portable delivery | Export source, review history, attachments and a reproducible final document. Preserve attribution, identifiers and citation evidence in a review packet. |

Automated legal drafting review must show which sources were actually checked, when, and how they support the finding. Fluent model text is not a verified authority, and a citation string alone is not proof of a case's holding or continuing validity. These are data and evidence requirements for the tool, not a claim that the current bootstrap performs legal research.

## Mobile acceptance contract

Preserve Phabricator's recognizable top navigation, application sidebar, object IDs, compact list rows, status accents, property groups, actions and timelines. At narrow widths, convert navigation to an accessible drawer, collapse properties deliberately, use unified diffs by default, and make actions reachable without hover. Paper source/PDF switching should retain position and context. Interactive controls need touch-sized targets; no viewport-wide horizontal overflow outside intentional code/diff scrollers. Workboard cards need accessible move actions in addition to drag-and-drop.

Before closing any milestone, verify its critical path at 390px, 768px and desktop widths, with keyboard navigation, form validation, long titles, slow/failing requests, empty states, large diffs and interrupted sessions. Screenshot similarity alone does not establish mobile usability.
