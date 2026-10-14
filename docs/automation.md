# Herald and Harbormaster

Herald applies saved rules to workspace changes. Harbormaster runs versioned build plans against immutable revision sources or verified Git commits. These are native TypeScript implementations of the upstream automation model. They are **partial application parity**, with the remaining adapters, execution capabilities and compatibility work enumerated below.

## Using the applications

Open **Herald** to create personal, object or global rules. Choose a content type, all/any conditions, repetition mode and ordered actions. Rule edits create immutable versions. The test console evaluates saved rules together, including rule dependencies, and saves a transcript without applying actions or consuming repetition state. Automatic transcripts show the original event snapshot, each evaluated condition's result, and applied, unchanged, denied or failed actions. Rule and transcript lists and rule history have pagination.

Open **Harbormaster** to create an enabled build plan with named steps. Dependencies form an acyclic graph; independent steps can become ready together. New steps have no dependencies by default; enter preceding step keys explicitly when ordering is required. Select a revision and an exact source version to run a plan. Build detail shows the frozen plan, source hash, targets, attempts, events, logs, unit/lint results and linked artifacts. Revision pages show builds for the selected immutable source. Pause stops new claims and downstream scheduling; existing workers can still report. Resume advances eligible work. Abort invalidates work. Restart creates a new build using the old build's exact plan and source while preserving its history.

Both editors retain unsaved drafts under the workspace's existing storage policy and offer JSON export. Network uncertainty retains the exact request and retry key for explicit recovery. Reconnecting does not submit a rule, run a build or repeat a command automatically. Access changes retire loaded results; retained requests remain available for explicit retry/export and the server rechecks authority. Session lock clears protected-session memory. Voice navigation accepts “open Herald” and “open Harbormaster”; authoring and execution use explicit controls.

## Implemented behavior

| Area | Native behavior |
| --- | --- |
| Rule ownership | Personal rules belong to their author; object rules require related-object Edit; global rules require operator-designated managers. |
| Evaluation | Personal, object, global order; numeric rule order within each group; all/any conditions; every match, first match, or a match after a previous nonmatch; disabled rules; references to another rule's conditions with cycle errors. Empty conditions never match. |
| Conditions | Creation, title/body/comment, status, task priority, actor/author/owner, repository, project tags, subscribers, reviewers, source filenames/content, existence, list membership, literal text, regular expressions and filename/content expression pairs. Available fields depend on the adapter. |
| Adapters | Revisions (code, paper and document), tasks, published Wiki documents, Paste snippets, observed Git commits and proposed Git ref/content changes. Draft-only Wiki saves do not expose draft source to automation. |
| Actions | Self or selected people subscriptions, reviewers and required reviewers, project tags, task assignment/status/priority, comments where supported, run build plans on revisions, and do nothing. |
| Rule evidence | Immutable versions, automatic event deduplication, dry-run transcripts, condition results, action failures and durable repetition state. |
| Build model | Versioned plans, immutable buildables, frozen plan/source per build, dependent targets, durable events, fenced worker attempts, pause/resume/abort/restart. |
| Sources | Exact revision version ID/content hash; or repository ID, verified SHA-1/SHA-256 commit and tree identity obtained from the configured Git observer. |
| Steps | Deterministic local text checks, external workers waiting for reports, operator-configured HTTP dispatch followed by worker reports, and authorized Drydock working copies for exact commits or revision patches. |
| Results | Append-only work/pass/fail messages, log chunks, unit results, lint findings, URI artifacts and idempotent report identities. |
| UI | Rule editor/test/history/transcripts, plan editor, exact-source manual runs, build detail and revision build status, mobile controls and draft recovery. |

Herald freezes all affected object snapshots before executing any rule actions. Conditions see the event's original state even if an earlier action changes a field. Effects do not recursively trigger rules. Original edits, transcripts and successful actions share the writer transaction; each action has a savepoint and notification batch so a failure rolls back that action without emitting its notifications. A retry of a committed edit does not evaluate the event again. With no enabled rules for a content type, ordinary changes do not create redundant transcripts.

Build results remain attached to their original source after a newer version arrives. Local checks are labeled deterministic, never AI, and do not compile or execute submitted code. Builds do not invent reviewer decisions or acceptance. The existing paper compilation service is separate; Harbormaster does not silently start it or send source to an AI provider.

## Operator configuration

The reusable server accepts these environment variables. Store actual values in the operator's private configuration, outside the application repository.

| Variable | Value |
| --- | --- |
| `APP_AUTOMATION_MANAGERS` | Comma-separated existing account IDs or usernames permitted to manage global rules and other people's build plans. |
| `APP_HARBORMASTER_WORKERS` | Comma-separated existing account IDs or usernames permitted to claim targets and report worker results. |
| `APP_HARBORMASTER_HTTP_ORIGINS` | Comma-separated exact HTTP(S) origins permitted for outbound build dispatch, without paths, credentials or trailing slashes. Empty disables outbound dispatch. |
| `APP_HARBORMASTER_HTTP_WORKER` | Existing active worker account ID or username for HTTP callbacks. Must also be in the worker list. |

Local single-user mode permits its local principal to manage rules and report work. Authenticated mode grants no global-rule or worker privilege by default. Ordinary writers can own build plans and personal rules. Self-assignment and self-reviewer actions still require Edit, matching the ordinary membership and ownership APIs; personal following uses Interact. Rule owners and workers must retain current object permissions. The account directory is not an administrative role service.

HTTP plans use an endpoint under an explicitly allowed origin. Dispatch sends build metadata, exact source identities and a target lease; it sends **no source files**. It refuses redirects and bounds request duration. The external worker authenticates with its own account's write token, uses the configured worker label, and obtains source only through an explicit authorized claim or its own repository credentials. Never place provider secrets in plan names, descriptions, endpoints, logs or artifacts; these are visible workspace records. Secret-vault references are a remaining capability.

Target claims last five minutes. `work` reports renew the claim. Another authorized worker can reclaim an expired external target into a new fenced attempt; an old lease cannot report into that attempt. Uncertain/expired HTTP dispatch is not blindly resent: it fails with an explicit restart path. Startup resumes pending dispatch from durable state. Paused, aborted, inaccessible or disabled-principal work is not dispatched.

## Native API

All routes require the existing authentication scheme. All mutations require `Idempotency-Key`; credentials and current object authority are checked again inside the writer transaction. Read envelopes carry `accessEpoch`. Lists and receipts are projected through current visibility.

| Method and route | Input or result |
| --- | --- |
| `GET /api/herald/rules` | Rules, edit capabilities, pagination; optional content type/enabled filters. |
| `POST /api/herald/rules` | A `HeraldRuleInput` from `shared/herald.ts`. |
| `GET /api/herald/rules/:id` | One visible rule. |
| `PUT /api/herald/rules/:id` | Complete rule input plus `expectedVersion`. |
| `GET /api/herald/rules/:id/history` | Immutable versions, `before`/`limit`. |
| `POST /api/herald/test` | `{ "objectId": "D1" }`; dry-run transcript. |
| `GET /api/herald/transcripts` | Visible transcripts; `objectId`, `before`, `limit`. |
| `GET /api/herald/transcripts/:id` | One visible transcript. |
| `GET/POST /api/harbormaster/plans` | List/create plans using `BuildPlanInput`. |
| `GET/PUT /api/harbormaster/plans/:id` | Read/edit plan; edits require complete configuration and `expectedVersion`. |
| `GET /api/harbormaster/builds` | Visible builds and their buildables; optional `revisionId` or `objectId`. |
| `POST /api/harbormaster/builds` | `planId`, `planVersion`, and either `revisionId`/`versionId`/`contentHash` or `repositoryId`/`commitId`. |
| `GET /api/harbormaster/builds/:id` | Full authorized build detail. |
| `POST /api/harbormaster/builds/:id/commands` | `command`: pause/resume/abort/restart, plus `expectedVersion`. |
| `POST /api/harbormaster/targets/:id/claim` | `expectedVersion`, `worker`; returns exact source, target and lease. |
| `POST /api/harbormaster/targets/:id/report` | `leaseToken`, unique `reportId`, `type`: work/pass/fail; optional log, unit, lint and artifacts. |

Types and strict input validation live in `shared/herald.ts` and `shared/harbormaster.ts`. Schema 37 adds automation tables; it does not rewrite historical source, review, task, wiki, subscription or notification records. Keep a verified backup before upgrading; an older binary refuses the newer schema.

## Conduit compatibility

The following upstream method names have a native adapter: `harbormaster.build.search`, `harbormaster.buildable.search`, `harbormaster.buildplan.search`, `harbormaster.buildstep.search`, `harbormaster.target.search`, `harbormaster.buildlog.search`, `harbormaster.artifact.search`, legacy `harbormaster.querybuilds`/`querybuildables`, `harbormaster.sendmessage`, `harbormaster.createartifact` and `harbormaster.buildplan.edit`.

This is explicitly **partial compatibility**: identities are native IDs rather than migrated Phabricator PHIDs; worker messages/artifacts require the native `leaseToken` and `reportId`, plus an idempotency header. URI artifacts are supported. Plan edits support name/status and native description/complete-step transactions, with `expectedVersion` for existing plans. Unsupported fields/types fail explicitly. Search cursors bind query, principal and current access epoch. Existing upstream workers require adaptation rather than being assumed interchangeable.

## Upstream evidence and remaining parity

The pinned source is recorded in [upstream.md](upstream.md). Relevant primary files under `reference/phabricator/src/` include `docs/user/userguide/herald.diviner`, `docs/user/userguide/harbormaster.diviner`, `applications/herald/storage/HeraldRule.php`, `applications/herald/engine/HeraldEngine.php`, and the application's adapter, action, field, buildstep, query and Conduit directories. Reference PHP is research material, not an executable dependency.

| Remaining capability | Gap or deliberate difference |
| --- | --- |
| Rule policy bypass | Upstream global/object rules can bypass source policy. Native effects require their active owner's current source permissions; they never grant visibility implicitly. Restricted referenced objects are omitted from reader projections. |
| Regular-expression dialect | Native JavaScript `/pattern/imsu` with bounded server evaluation. PCRE-specific patterns need conversion; unsupported patterns are rejected. |
| More adapters | Pre-diff blocking, rule edits, projects and applications not yet implemented (including calendar, Pholio, Ponder and Phame). Browsing a commit does not fabricate an observation event. |
| More fields/actions | Changed-only paths/added/removed content for non-Git adapters, explicit Herald Owners conditions/actions, author/repository project relationships, email/notifications, webhooks, flags, direct project audit requests and Legalpad. Owners package settings now route review/subscription and collective post-commit Audit independently of Herald rules. |
| Richer build execution | SSH/cloud/Almanac resources, remote command execution, remote revision staging, secret-vault references, upstream builtin build protocols, custom step extensions and complete historical status semantics. External execution currently requires an operator-supplied worker. |
| Evidence integration | P309 connects exact reviewed revisions and current-plan builds to push/native landing gates. Build waivers, full upstream Differential status interchange and broader acceptance configuration remain open. See [receive gates](git-automation.md#reviewed-revisions-and-required-builds). |
| Search/operations | Full upstream saved-query/reporting behavior, mail, notification events for build transitions, fine-grained plan policy management, retention controls and advanced log/artifact browsing. |
| Interchange | Import/export fixtures preserving upstream identities/policies/history, all Conduit methods/transactions, binary and specialized artifact types, and unchanged upstream worker interoperability. |

These rows remain open in [parity.md](parity.md) and [roadmap.md](roadmap.md); the presence of the two applications in navigation does not close application parity.

## Commit/push rules and Drydock

Schema 38 adds a trusted Git pre/post-receive adapter with push rejection, immutable receive records, exact commit-triggered builds and stored-evidence dry runs. Drydock adds authorized working-copy blueprints, fenced leases/resources, an actual local Git materialization worker and Harbormaster dependency integration. See [Git receive contracts](git-automation.md) and [Drydock contracts](drydock.md) for setup, verification boundaries and remaining gaps. Neither implies full application parity.

## Release verification

Schema-38 release validation passed type checking, root and subpath production builds, and 2,057 local tests: 2,048 passed, nine optional TeX-environment tests skipped, zero failures. Worker regressions verify renewal after reconnect, expiry cleanup during API/auth failures, and current authority and fencing on provision-claim replay while preserving assigned cleanup access.

The schema-38 browser matrix passed 128 checks: 32 cases per desktop/mobile and root/subpath combination, with no failures or skips. It covers Herald push receipts and stored-evidence replay, Drydock authorizations/allocation/renewal/release, Harbormaster working-copy sources, retained offline requests, repository reads, authentication/Google, policy isolation, mounts and workspace navigation. Real Git hooks separately verify accepted/rejected pushes and API-outage rejection; the real Drydock worker provisions and cleans a disposable working copy through the actual HTTP API. Schema-38 migration checks preserve existing tables and rows and reject collisions atomically.

Focused tests cover repetition and dependency cycles, bounded expressions, action/notification rollback, privilege escalation, hidden historical rule projection, immutable source/plan evidence, worker leases, HTTP metadata-only dispatch and shutdown, Conduit cursors and retries, asynchronous Git access revocation, reply/batch comment conditions and schema preservation. External worker tests use controlled fixtures; they do not certify an operator's CI installation. Physical mobile devices and full upstream migration remain unverified.

Schema 39 adds [revision patches and local squash landing](revision-landing.md), connecting exact revision-source working copies to Harbormaster and native Herald pre/post decisions to explicit landing. Remote Git staging/push and full upstream interoperability remain gaps.

## Owners routing

Owners package settings operate independently of enabled Herald rules. New repository-backed revision source versions route eligible people into ordinary reviewer membership or explicit subscription. The non-owner-author modes skip a package when the revision author is an owner; the always modes still route other owners. Authors are never automatically added as their own reviewers. Explicit resignations and unfollows remain respected, and routing never grants source visibility, overwrites a decision, or carries acceptance onto changed content. The original collective blocking-review modes are rejected explicitly until collective Differential reviewer support exists.

Routing matches literal changed paths. Git receives provide the complete inspected path inventory, including removed paths and both sides of a rename (the collector disables rename folding). Binary and oversized blobs still have exact paths; unavailable text does not imply unavailable ownership. Incomplete receive inventories fail before routing. For edited revisions with a verified imported tree, path differences use that tree as the baseline. Authored-only revisions compare with the previous version, and initial sources route all submitted paths. This does not infer an unavailable Git parent diff for an initial imported tree. Text, mode changes and attached asset paths are considered.

A schema-45 append-only routing record pins the source version/hash, matching package versions, resolved/eligible owner identities, outcomes and path basis. Delivery retries reuse the existing record. Current source access plus current and historical package visibility filter `GET /api/owners-routing/:objectId?before=…&limit=25`. Package names and configuration are never copied into public reviewer or Audit history; ordinary source membership changes retain generic Owners attribution. Package edits affect future source events, not old routing records.

Post-receive package settings create collective [Audit requests](audit.md), with one eligible owner's acceptance sufficient for a package. Empty eligible sets remain pending rather than inventing a successful audit. Collective Differential reviewers, blocking package review, explicit Herald package conditions/actions, retrospective rerouting and full upstream interchangeable APIs remain gaps.
