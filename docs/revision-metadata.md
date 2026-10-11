# Revision titles, summaries and Test Plans

Code, paper and Word revisions share an Edit Revision Details form. It saves a
title, summary, Test Plan and optional explanation together, with attributed
before/after history. Current labels update in the revision, workspace, related
revisions and Stack. Metadata has its own version; it does not manufacture a
source version, run a check, invoke AI or alter review acceptance. Existing review
evidence evaluates immutable source files, not these editable descriptions.

## Creation and editing

New ordinary, Git-imported and Word revisions require a Test Plan, including
drafts. The operator may set `REVISION_REQUIRE_TEST_PLAN=false`; only the exact
strings `true` and `false` are accepted. The default is `true`. The workspace and
metadata snapshot expose this setting so clients can explain the requirement.
The plan is authored text describing verification, not a claim by the application
that any check ran or succeeded.

Titles require nonzero length and at most 255 UTF-8 bytes. Summary and Test Plan
each allow 100,000 UTF-16 code units; explanations allow 10,000. New writes reject
NUL and malformed Unicode. Whitespace and line endings are preserved exactly;
whitespace-only text is nonempty under the upstream rule. Summary and Test Plan
reject recognized English commit-message field labels at the beginning of a line
immediately followed by a colon, including aliases such as `CC:` and `Tested:`.
Indenting or rephrasing such a line removes the structural ambiguity. This is
validation of these two fields, not a complete Arcanist message parser.

Full metadata edits require a plan when the setting is enabled. An older revision
without a recorded plan remains readable, and its comment, reviewer and lifecycle
actions continue to work. The UI distinguishes an unknown historical plan from
an explicitly empty optional plan. It never invents verification text during
migration or automatically adds it when source changes.

## Authority, concurrency and recovery

Reads require current View. Edits and retry recovery require current View and
Edit plus a write-scoped credential. Restrictive Spaces, linked repositories and
all historical source File restrictions apply. Cookie writes require CSRF
protection. Authority is checked again under the write lock, including retries.

Each edit pins the metadata version, immutable source number/ID/hash, permission
epoch and metadata configuration digest. A changed source or setting must be
inspected before submitting a new intent. A stale editor cannot silently apply
an old Test Plan to new source. Authorship, reviewer and lifecycle versions are
independent because this operation does not change them.

Successful requests have immutable, principal-bound receipts. Replaying the
exact request and idempotency key recovers the historical result after later
metadata, source or configuration changes, subject to current authority. It
never repeats the mutation. A full save with identical fields records a no-effect
receipt without adding history or advancing metadata version. New requests still
validate the current required-plan setting. Previously saved text/Git/Word
creation receipts without a plan remain recoverable without rewriting them.

The mobile and desktop panel retains unfinished edits, conflict drafts and exact
uncertain requests. Local mode stores these in the identity-partitioned offline
workspace; password mode retains them only in tab memory. Saving is an explicit
online action, never automatic outbox replay. Current source and permissions
are checked on return. Losing View retires protected data; losing Edit holds an
existing draft while permitting authorized reads. History uses bounded pages.

## API and CLI

- `GET /api/revisions/:id/metadata` returns current metadata, source, configuration,
  access and epoch.
- `GET /api/revisions/:id/metadata/history` accepts an exclusive `before` metadata
  version, `limit` from 1 to 100 (default 25), and optional
  `expectedMetadataVersion` for a consistent traversal.
- `POST /api/revisions/:id/metadata` requires `Idempotency-Key` and every field in
  `RevisionMetadataInput`: `title`, `summary`, `testPlan`, `message`,
  `expectedMetadataVersion`, `expectedVersion`, `expectedVersionId`,
  `expectedContentHash`, `expectedAccessEpoch`, and `expectedConfigId`.

Routes respect the configured application mount. Generic revision PATCH remains
closed; this dedicated operation cannot change status, ownership or permissions.

```sh
npm run arc -- revision-metadata P2
npm run arc -- revision-metadata-history P2 --metadata-version 3 --limit 25
npm run arc -- edit-revision-metadata P2 --intent metadata.json --request-id edit-1
npm run arc -- diff --kind paper --title 'A clearer argument' \
  --test-plan 'Read the changed argument and checked its references.' main.tex
```

Inspect the current snapshot before composing `metadata.json`. Retain the exact
request file and request ID if the response is uncertain. CLI intent files are
regular UTF-8 JSON files, bounded to 2 MiB for metadata; terminal controls are
escaped in output. Git creation also accepts `--test-plan`; Word import JSON
includes `testPlan`, or the CLI can supply `--test-plan` when absent.

## Storage and upstream comparison

Schema 28 adds metadata state, immutable baselines, operations and transactions.
Baselines preserve existing title/summary bytes and record an absent plan as
`null`, version zero, with unknown edit time. Earlier accepted titles and legacy
Unicode are preserved even if a fresh edit would need repair. Existing entity,
source, review, File, discussion, policy and receipt rows are unchanged. Current
revision hydration overlays the metadata; subsequent source writes retain the
original entity metadata bytes. Migration is transactional and repeatable; older
application binaries refuse the newer schema.

The pinned archived Phabricator commit is
[`5720a38`](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04).
Its [title transaction](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/xaction/DifferentialRevisionTitleTransaction.php)
sets the nonempty/255-byte boundary. The
[summary](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/xaction/DifferentialRevisionSummaryTransaction.php)
and [Test Plan transactions](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/xaction/DifferentialRevisionTestPlanTransaction.php)
retain exact text and history. The
[configuration](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/config/PhabricatorDifferentialConfigOptions.php)
requires Test Plans by default, and
[corpus validation](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/xaction/DifferentialRevisionTransactionType.php)
rejects embedded commit-message fields. Full Edit Revision validates required
fields; upstream comment/action paths permit unrelated actions on old missing
fields, which the native action routes preserve.

Explicit source/configuration/access pins, bounded corpus sizes and exact retry
receipts are native extensions. Custom fields/forms, translated or custom corpus
labels, Remarkup rendering, full commit-message parsing, repository
reassignment, activity-feed publication, notifications, Conduit metadata edits and upstream
history import remain gaps. [Revision project tags](revision-projects.md) and [revision following](revision-subscriptions.md) have separate contracts. This slice does not establish Differential parity.

## Verification

Storage and migration tests preserve every pre-existing row, source identity and
acceptance record, exercise failed-migration rollback, and recover changed and
no-effect receipts after later edits. API tests cover current object, Space,
repository and File authority, CSRF, credential rotation and revocation under the
writer lock. CLI tests cover root and mounted routes and exact request recovery.
Browser scenarios exercise all three creation forms, accepted text and Word,
history, historical source selection, lost responses, newer unsaved drafts,
offline reopening, stale reads, permission loss and touch dimensions on both
desktop and mobile. Optional isolated TeX execution remains a separate suite.
