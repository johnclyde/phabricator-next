# Revision lifecycle

Code, paper and Word revisions share an explicit lifecycle and immutable action
history. Author actions work alongside [named reviewer decisions](revision-reviewers.md).
Automatic build publication and mail remain unfinished.

## Actions

Every action requires current View and Edit authority, including the revision's
Space, repository and all historical source File restrictions. A write-scoped
credential is also required. Current authorship is separate from original source
attribution. Reclaim and Reopen may restore Accepted or Changes Requested when
unchanged applicable review state requires it; they do not invent new decisions.

| Action | Availability | Result |
| --- | --- | --- |
| Request Review | Current author on an open revision, or any editor publishing a draft; not already Needs Review | Needs Review; resuming Changes Planned may restore acceptance of the same still-clean reviewed source |
| Plan Changes | Current author on an open, non-draft revision; not already planned | Changes Planned |
| Abandon Revision | Current author on an open revision; operator may allow any editor | Abandoned |
| Reclaim Revision | Current author of an abandoned revision | Draft if review never started; otherwise reassess applicable reviewer/evidence state from Needs Review |
| Accept Reviewed Version | Any editor of Needs Review or Changes Requested, with exact current-version evidence, no error findings, no current or older rejection and no blocking reviewer | Accepted |
| Close Revision | Current author of an accepted open revision; operator may allow any editor | Closed |
| Reopen Revision | Any editor of a closed revision, only when enabled by the operator | Reassess applicable reviewer/evidence state from Needs Review |

Accept Reviewed Version is a deliberate native decision about recorded checks or
explicitly requested AI review. Named reviewers record separate personal decisions. Local deterministic
checks remain labeled as checks. No lifecycle action starts review, compilation,
source changes, repository pushes, merging or filing.

The default configuration disables reopening and limits close/abandon to the
current author. Operators may set `REVISION_ALLOW_REOPEN`,
`REVISION_ALWAYS_ALLOW_CLOSE`, `REVISION_ALWAYS_ALLOW_ABANDON` and
`REVISION_CLOSE_ON_ACCEPT` to exactly `true` or `false`; all default to `false`.
Close-on-accept treats Accepted as terminal for actions and Stack open-parent
counts without rewriting the status to Closed. Abandoned revisions also leave
open-parent counts but remain graph nodes and do not interrupt traversal.

## Drafts and source changes

Text creation, Git import and Word import accept optional `draft: true`. Omission
preserves the default Needs Review state. A draft changes lifecycle behavior,
not visibility; object and Space policies still determine who can read it.

A new immutable source version always advances lifecycle history and invalidates
previous acceptance. Closed revisions remain Closed and drafts remain Draft.
Accepted, Changes Requested, Changes Planned and Abandoned revisions return to
Needs Review if review previously started, otherwise Draft. This applies equally
to text edits, figures, suggestions, Git imports and Word replacements/reimports.
Existing source and review records stay immutable.

Planning changes after accepting a version retains a marker for that exact head.
Request Review may restore that native acceptance only while the head remains
identical and current evidence has no errors, reviewer requirements are satisfied, and the
original acceptance basis is still applicable. New source clears the marker. New error evidence invalidates an Accepted state or clears the planned
marker in the same database transaction as the review; it does not reopen a
closed or abandoned revision. Word files support independent named-reviewer
acceptance of the exact package. Automated Word evidence-based acceptance remains
unavailable until projection-aware review exists.

## Concurrency, history and recovery

`GET /api/revisions/:id/lifecycle` returns lifecycle state, exact source head,
current author identity/version, operator configuration and its SHA-256, bounded
current-head evidence identity, access and available actions with reasons.

`POST /api/revisions/:id/lifecycle` requires an `Idempotency-Key` and every field
below. Copy pins from the inspected lifecycle snapshot; do not select new values
on retry.

```json
{
  "action": "plan_changes",
  "message": "Revise the argument before another review.",
  "expectedLifecycleVersion": 0,
  "expectedReviewerVersion": 0,
  "expectedAuthorVersion": 0,
  "expectedVersion": 1,
  "expectedVersionId": "COPY_FROM_SNAPSHOT",
  "expectedContentHash": "COPY_FROM_SNAPSHOT",
  "expectedAccessEpoch": 1,
  "expectedConfigId": "COPY_FROM_SNAPSHOT",
  "expectedEvidenceSha256": "COPY_FROM_SNAPSHOT"
}
```

Fresh actions require the reviewer-version pin too; only proven historical
receipts can recover an older input without that field. The writer transaction
checks all pins and current author/configuration rules
before saving an immutable operation and history record. Evidence is bounded to
1,000 reviews and 16 MiB of stored review data. Receipts bind the canonical input,
actor, historical source, evidence, author and transition. Replaying the identical
request requires current write scope and View/Edit, but does not require the
source, owner or configuration to remain unchanged. The response confirms the
original action and reports current access epoch. There is no access-losing
lifecycle acknowledgment exception.

`GET /api/revisions/:id/lifecycle/history` supports `before`, `limit` (1–100) and
`expectedLifecycleVersion`, newest first. Source changes and acceptance
invalidation share the version sequence with manual actions. The UI can retain
up to 500 loaded transactions, with explicit further-page controls. Selecting a
historical source does not retarget the current-head action; the UI identifies
the head being acted on.

The retired generic `PATCH /api/revisions/:id` status setter returns a conflict
with explicit-action guidance. Historical saved responses remain untouched, but
cannot be replayed as verified lifecycle receipts because they contain no
immutable lifecycle operation proof.

Local mode retains visited lifecycle readings and exact drafts/uncertain
requests. Password mode retains them only in the verified tab session. Actions
are online-only, never added to an automatic outbox. Reconnection does not submit
them. Access changes retire readings and quarantine drafts; exact receipt
confirmation removes only the corresponding request and matching draft, keeping
newer edits intact.

## CLI

```sh
arc revision-lifecycle P2
arc revision-lifecycle-history P2 --lifecycle-version 3 --limit 25
arc edit-revision-lifecycle P2 --intent action.json --request-id stable-key
arc diff --title 'Draft argument' --kind paper --draft --test-plan 'Read the argument and checked its assumptions.' main.tex
arc import-git R1 --commit FULL_COMMIT_ID --title 'Draft change' --draft --test-plan 'Inspect the committed source.'
```

`import-docx` also accepts `draft: true` in its request file. The action CLI prints
the request identity before sending, validates the returned receipt and supports
root or mounted servers. It never silently refreshes mutation pins.

## Migration and upstream evidence

Schema 26 adds lifecycle state, immutable operations and immutable transactions.
It observes existing status at version zero without inventing events or actors.
Legacy revisions start with `reviewStarted: true`: their constructors originally
created Needs Review, including revisions later set to Draft with the old generic
setter. Historical closure provenance remains unknown. Existing table rows,
source bytes, policy versions, credentials and saved receipts are preserved.

Pinned upstream Phabricator commit
`5720a38cfe95b00ca4be5016dd0d2f3195f4fa04` supplies these contracts:

- `src/applications/differential/xaction/DifferentialRevisionActionTransaction.php`
  requires editing permission for lifecycle actions.
- `DifferentialRevisionRequestReviewTransaction.php`,
  `DifferentialRevisionPlanChangesTransaction.php`,
  `DifferentialRevisionAbandonTransaction.php`,
  `DifferentialRevisionReclaimTransaction.php`,
  `DifferentialRevisionCloseTransaction.php` and
  `DifferentialRevisionReopenTransaction.php` in that directory define roles and
  state prerequisites.
- `DifferentialRevisionUpdateTransaction.php` preserves closed/draft source
  updates and returns changed planned/rejected/abandoned work to review.
- `config/PhabricatorDifferentialConfigOptions.php` defines the four operator
  options and defaults.
- `editor/DifferentialTransactionEditor.php` recalculates final status from
  reviewer votes and handles broadcast/build behavior.

People acting as themselves now have membership, accept/request-changes/resign
decisions, blocking review, self-accept configuration and reviewer-state
reassessment, including author handoff effects. See [reviewer contracts](revision-reviewers.md).
Collective reviewers, force acceptance, Harbormaster publication,
commit-driven closure, Conduit edits, imported
lifecycle history and landing remain gaps. [Revision following](revision-subscriptions.md) and [inbox delivery](notifications.md)
now respect draft broadcast state. Exact-version acceptance deliberately
replaces upstream sticky acceptance. Full Differential parity is not claimed.
