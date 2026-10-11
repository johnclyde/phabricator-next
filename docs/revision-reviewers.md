# Named reviewers and exact-version decisions

Code, paper and Word revisions share a named reviewer list and an immutable
decision history. A person can accept the current version, request changes or
resign from review. Each decision records the acting account, explanation,
immutable source ID, version number and content hash. Word decisions identify
the exact imported or edited package; they do not require an automated text
review to exist.

## Authority and membership

Editors can add active people, remove reviewers and mark a reviewer blocking or
nonblocking. An existing disabled reviewer can still be removed or made
nonblocking; adding a person or imposing a new requirement needs an enabled
account. A blocking reviewer prevents acceptance until that reviewer accepts,
resigns, is removed or is made nonblocking. Requesting changes replaces the
blocking requirement with a rejection, which still prevents acceptance. Adding
an existing member is rejected without changing their decision; changing blocking
state resets it. Historical decisions stay in the transaction history.

Personal decisions require current View and Interact permission, plus a
write-scoped credential. They do not require Edit. Accepting or requesting changes
can enroll the acting person as a reviewer. Membership changes require View and
Edit. Space, linked repository and all historical source File restrictions apply
to reads, writes and receipt recovery. Assigning a reviewer grants no access.

The current author cannot request changes on their own revision. Self-acceptance
is disabled by default; an operator can enable it with
`REVISION_ALLOW_SELF_ACCEPT=true`. Values must be exactly `true` or `false`.
This setting does not bypass object permissions or source restrictions.

Accept and Request Changes are unavailable on drafts and terminal revisions.
Resign is unavailable on terminal revisions. Accepted is terminal when the
operator enables close-on-accept; Abandoned and Closed are always terminal for
review decisions. Planning changes does not erase the review conversation.

## Status and evidence

Needs Review, Changes Requested and Accepted are reassessed after relevant
reviewer changes. Acceptance based on named reviewers requires at least one
person accepting the exact current source, no current or older outstanding rejection, no blocking
reviewer, and no error findings in current-version review evidence. A current
rejection produces Changes Requested. Removing or resigning the last relevant
decision may return the revision to Needs Review. Draft, Changes Planned,
Abandoned and Closed do not change status merely because membership changes.

Named decisions are separate from recorded checks and explicitly requested AI
reviews. A person can review a Word file without manufacturing a `ReviewRun`.
The existing **Accept Reviewed Version** action remains available for editorial
acceptance based on recorded evidence, subject to reviewer rejection and blocking
rules. Neither route runs a model, compiles, merges, pushes or files a document.

Acceptance records its basis: named reviewer decisions, native evidence-based
acceptance, or an unknown historical basis. Migration never invents reviewers or
turns legacy acceptance into a verified current decision. Introducing this model
does not silently reinterpret a previously accepted revision.

A new source version invalidates acceptance and retains previous decisions with
their original source identity. An outstanding rejection of older source still
blocks acceptance until resolved by a new decision, reviewer removal/resignation
or Request Review. Request Review voids prior decisions, except that undoing
Changes Planned can preserve applicable decisions about the same source.
Current-version error findings veto both acceptance routes.

Changing authorship adds the previous author to the reviewer list, removes the
new author and reassesses status in the same transaction. This can invalidate
acceptance when the new author was its only accepting reviewer. Existing source
versions and recorded review evidence remain immutable. Historical handoffs are
not retroactively given reviewer effects.

## Exact requests and history

- `GET /api/revisions/:id/reviewers` returns the reviewer state and its independent
  version, source head, lifecycle, authorship, current evidence, configuration,
  permissions and available personal actions.
- `GET /api/revisions/:id/reviewers/history` returns immutable transactions,
  newest first, with `before`, `limit` and `expectedReviewerVersion` for paging.
- `POST /api/revisions/:id/reviewers` requires an `Idempotency-Key` and a complete
  intent copied from an inspected snapshot.

Actions are `add`, `remove`, `block`, `unblock`, `accept`, `request_changes` and
`resign`. Membership actions name `reviewerId`; personal decisions always act as
the authenticated principal and must omit it. Every intent includes `message`
and these concurrency pins:

```text
expectedReviewerVersion
expectedLifecycleVersion
expectedAuthorVersion
expectedVersion
expectedVersionId
expectedContentHash
expectedAccessEpoch
expectedConfigId
expectedEvidenceSha256
```

The writer checks all pins before changing membership, decisions or lifecycle.
Configuration identity includes both reviewer settings and lifecycle terminal
settings. Immutable receipts bind the canonical request, actor and resulting
transaction. An identical retry returns its original result only while the caller
retains the authority required by that operation; it does not apply the operation
again to a newer version.

Fresh lifecycle actions also pin reviewer state. Fresh authorship transfers pin
reviewer and lifecycle state. Proven older saved receipts remain recoverable;
their historical input is not rewritten to add new fields.

```sh
npm run arc -- revision-reviewers P1
npm run arc -- revision-reviewer-history P1 --limit 50 --reviewer-version 2
npm run arc -- edit-revision-reviewers P1 --intent review.json --request-id retained-request-id
```

The CLI reads a bounded regular UTF-8 intent file, prints its request identity
before sending and validates the response. Retain that file and request ID for
recovery. It never fetches fresh pins to retry an
uncertain or stale mutation.

## Mobile and offline work

The shared Reviewers panel is available for text and Word revisions. It displays
the current source separately from any older source being inspected. Saving a
decision does not move the selected source version.

Authorized snapshots and drafts follow the existing workspace retention rules:
local-mode offline storage and authenticated current-tab memory. Decisions and
membership changes require explicit online submission. Reconnecting does not
send them. Uncertain requests retain their original input and request ID for
explicit retry or export; confirmation removes only the matching unchanged
draft. Access changes set aside affected work without replaying it under new
authority.

## Storage and migration

Schema 27 adds reviewer state, immutable per-revision baselines, immutable
operations and immutable transactions. Existing entity JSON, source versions,
review evidence, author/lifecycle history, credentials, policy rows and saved
receipts remain unchanged. Baselines contain no invented reviewer memberships
or personal decisions. Existing native evidence acceptance is identified only
when supported by preserved lifecycle history; otherwise its basis remains
unknown. Baseline author and lifecycle counters bound compatibility with older
receipts that predate reviewer pins.

Source changes, reviewer decisions, author handoffs and resulting lifecycle
changes commit atomically. A failed history write rolls back the whole change.
Back up before upgrading; restoring an older application binary also requires
restoring its matching database backup.

## Upstream comparison and remaining gaps

Behavior is based on Phabricator
[`5720a38c`](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential):

- `DifferentialRevisionReviewersTransaction` defines membership updates and
  preservation/reset of decisions when blocking state changes.
- `DifferentialRevisionReviewTransaction` applies personal decisions, enrollment,
  acting identity and exact diff association.
- `DifferentialRevisionAcceptTransaction`, `DifferentialRevisionRejectTransaction`
  and `DifferentialRevisionResignTransaction` define author and terminal rules.
- `DifferentialTransactionEditor::updateReviewStatus` defines current and older
  rejection, blocking reviewers and acceptance reassessment. The editor also
  swaps reviewers when authorship changes.

This slice covers people acting as themselves. Project and Owners-package
reviewers, acting for a collective reviewer, force acceptance, Herald assignment,
notifications, Conduit interoperability and upstream migration remain gaps.
Upstream sticky acceptance is deliberately replaced by exact-source acceptance;
new content requires a new applicable decision. The native current-evidence error
veto and explicit concurrency/receipt checks are additional safeguards. Full
Differential parity remains unfinished.
