# Audit: post-commit review

Audit reviews a saved, immutable Git commit after it is observed by a configured post-receive hook or native landing. It is separate from Differential acceptance before landing. A commit's exact ID, tree, parents, author, committer and message remain attached to every audit decision. Browsing Diffusion alone does not create audit history.

## Workflow

Open **Audit**, choose a commit, and inspect its recorded changes. Request individual auditors, raise a concern, accept the commit, resign from an audit, or leave a comment. Accept and concern actions can enroll the current reviewer. Requesting an existing auditor preserves their decision. Resigned auditors do not contribute to the aggregate status.

A concern takes precedence over other votes. Pending requests yield **Audit required**; a mixture of accepted and pending requests is **Partially audited**. All active auditors accepting yields **Audited**. A commit without active requests is **No audits**. Comments alone do not change votes. These are post-commit decisions and never grant push authority or close a Differential revision.

The source panel renders the literal stored receive patch and its exact changed-file inspection metadata. Binary, non-UTF-8, oversized and Gitlink content remain explicitly unavailable as text. Audit does not need a live Git observer to show this saved evidence. This view currently has whole-commit comments; line-anchored Audit threads remain a gap.

Herald commit rules can **Add auditors** and **Audit self**. Each action runs as the currently authorized rule owner. Re-observing the same commit does not repeat requests, change review decisions or create another history entry. Audit history records Herald provenance without exposing private rule configuration.

Owners packages can request a collective audit when a received commit touches an owned path. Package settings support all commits, unreviewed commits, commits without verified owner involvement, or either missing review or missing owner involvement. The request captures the package version and eligible people at observation. It does **not** turn every package owner into an individually required auditor. One person who was captured in that request and is still a current package owner can satisfy it with their normal Audit acceptance. Personal concerns retain precedence. Resigning a package decision preserves another still-eligible owner's recorded acceptance; without another eligible decision, the request returns to pending.

New package members cannot approve an earlier request they were not part of, and removed members cannot make new package decisions. Project ownership expands effective membership at observation and checks current membership again on decisions. A request with no eligible owners remains pending, with an explicit unavailable routing record; automatic repair or rerouting of that request is not implemented. Current and historical package visibility apply to displayed package names, membership and routing details. A source reader can still see the aggregate audit status when package details are restricted.

Owner involvement is established only by an exact-version accepting reviewer in server-derived related revision evidence. An unverified Git author email or the pusher's identity is not treated as a verified commit author. Consequently, commits whose only owner involvement was authorship may receive a conservative extra audit until verified Git identity mapping exists. Unreviewed detection uses the saved exact-source accepted-revision evidence. Historic observations are never rerouted automatically after a package edit.

## Authority and recovery

Reads inherit the repository's current view policy and Space. Personal comments and decisions require an active account, a write credential and repository Interact permission. Auditor requests and automatic observation require repository Edit permission. A requested auditor must be active and able to view the repository. Every mutation rechecks authority and the exact audit version; stale commands return a conflict. Idempotent retries recover the original result while rechecking current source visibility.

Desktop and mobile controls retain drafts with the selected commit and audit version. Disconnecting never submits them. Uncertain requests offer explicit retry with the same operation identity, and changed audit versions require reopening a current draft. Voice navigation can open Audit; voice approval and full spoken audit editing are not implemented.

Schema 40 adds `audit_commits` and append-only `audit_events`. Migration preserves prior tables and verifies saved post-receive source hashes before creating initial Audit records for historical observations. It does not infer reviewer requests, votes or imported identities. Incompatible table/index/trigger definitions and unverifiable source evidence abort migration transactionally.

## API

All routes are mount-aware and authenticated. Mutations require an `Idempotency-Key`.

- `GET /api/audit/commits`: filter by `repositoryId`, `status`, or `auditorId`; page with `before` and `limit`.
- `GET /api/audit/commits/:id`: commit, auditors, status and paged immutable history.
- `GET /api/audit/commits/:id/files`: recorded received-file evidence.
- `GET /api/owners-routing/:id`: immutable source/package routing results, filtered by current source and package access; `before`/`limit` pagination.
- `POST /api/audit/commits/:id/request`: `expectedVersion`, `auditorIds`, optional `comment`.
- `POST /api/audit/commits/:id/command`: `expectedVersion`, `command` (`comment`, `concern`, `accept`, `resign`), optional `comment`.

IDs are server-owned `GC-…` post-receive subjects. Clients cannot submit commit source metadata. A page returns at most 100 records, and a request can add at most 100 auditors; repeated requests can add more people.

## Upstream baseline and gaps

Primary evidence is the pinned historical source in `reference/phabricator/src/applications/audit/`, its commit audit status/action classes and the Diffusion Herald auditor actions, plus `applications/repository/worker/PhabricatorRepositoryCommitPublishWorker.php`. The native implementation covers individual request aggregation and automatically routed collective Owners package requests. Direct project auditor requests, manual package selection and package-specific decisions, force acceptance on behalf of a package, author-close and needs-verification transitions, inline Audit threads, mail/notifications, full upstream search, Conduit and historical interchange remain open. This is a verified native workflow, not a claim of complete Audit application parity.

## Verification

The release was checked with strict TypeScript, root and subpath production builds, and 120 affected browser checks across desktop/mobile and both hosting paths. The full 2,152-test core run had 2,140 passes, nine optional TeX skips and three subprocess timeouts; the affected Git and markup files then passed all 35 tests in isolated reruns without changing implementation or time limits. Real Git fixtures cover exact acceptance/build gating, forged footer hints, current-source and plan changes, private evidence, native code/paper/document landing, Audit requests and immutable replay. Migration tests verify prior rows/schema, historical commit backfill and transactional failure on collisions or invalid source.
