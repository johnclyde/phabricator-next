# Revision authorship

Code revisions, papers and Word documents have a current author independently
of their immutable source attribution. Current authorship may be handed to
another active workspace member. The original author remains the principal
recorded on version one; later contributors and transfers do not rewrite it.
Historical records without trustworthy version-one attribution show “Not
recorded” instead of an invented owner.

## Reading and changing authorship

The Current Author panel shows both authors, the ownership version and paged
immutable handoff history. Any current editor may transfer a revision to an
active member, including a closed revision. Commandeer assigns the acting editor
as author and is unavailable on closed revisions, including Accepted when the
operator enables close-on-accept. Abandoned revisions remain commandeerable. Assigning the current author
again is a conflict. Ownership starts at version zero; each transfer increments
it once and records the actor, previous and new authors, message, exact source
head, operation identity and time.

The current author automatically receives view and edit access, including policy
editing, within existing Space, linked repository and historical source File
visibility requirements. Ownership grants no automatic interact permission.
Token scopes and enabled-account requirements still apply. The recipient need
not already be able to read the revision, but ownership cannot bypass those
source or Space restrictions. A handoff may remove the former author's access.

Transfers pin the inspected ownership, reviewer and lifecycle versions, source
version number, immutable source version ID, content hash and workspace access
epoch. These are checked
under the database writer lock. A successful transfer increments the access
epoch once. It adds the previous author as a reviewer, removes the new author
from the reviewer list and reassesses acceptance atomically. The handoff can
change review status when the removed reviewer supplied the accepting decision.
Source bytes, source history, recorded check/AI evidence and dependencies remain
unchanged. Stored hashes are source identities; this operation does not rehash
manuscript contents. See [reviewer rules](revision-reviewers.md).

## Drafts and exact recovery

Local-mode drafts and verified snapshots can survive an offline reload.
Authenticated workspaces retain them in the verified tab's memory. Changes are
submitted explicitly online and never enter the automatic outbox. Reconnecting
does not submit a draft, and refreshing never replaces its concurrency pins.
An uncertain submission retains its exact input and request ID for retry or
export. Confirmation removes only the matching submitted request and its
unchanged draft; a newer draft survives.

Ordinary receipt replay requires current view and edit access. One narrow
exception permits an active credential of the original principal to confirm
their own exact handoff after it removed view or edit access. The server verifies
the saved canonical input, operation, actor, previous author, new author and
historical source identity. It returns only the revision ID, operation ID,
input digest, saved/access-lost flags and current access epoch. It returns no
source, title, author history or current manuscript metadata. The browser can
explicitly confirm this retained request from the recovery card even after
the revision disappears. This does not restore access or submit a different
draft. Revoked credentials and another editor's access-losing changes do not
qualify.

## API and CLI

- `GET /api/revisions/:id/authorship` returns current and original authors,
  ownership/reviewer/lifecycle versions, exact source head, status, close-on-accept configuration, access and access epoch.
- `GET /api/revisions/:id/authorship/history` returns immutable transfers in
  descending ownership-version order. Optional `before`, `limit` and
  `expectedAuthorVersion` support stable paging (25 by default, at most 100).
- `POST /api/revisions/:id/authorship` requires an `Idempotency-Key` and the exact
  input below. Normal write scopes, session CSRF and principal-scoped replay
  rules apply.

```json
{
  "action": "assign",
  "authorId": "recipient-principal-id",
  "message": "Handing off the manuscript",
  "expectedAuthorVersion": 0,
  "expectedReviewerVersion": 0,
  "expectedLifecycleVersion": 0,
  "expectedVersion": 1,
  "expectedVersionId": "exact-source-version-id",
  "expectedContentHash": "exact-lowercase-sha256",
  "expectedAccessEpoch": 12
}
```

Fresh requests require all fields, including a message (which may be empty and is limited
to 10,000 characters). For `"action": "commandeer"`, omit `authorId`. Unknown
fields and coerced numeric values are rejected. Proven saved receipts from before
reviewer support retain their original input without the two newer pins; new
mutations cannot omit them.

```sh
npm run arc -- revision-author P1
npm run arc -- revision-author-history P1 --limit 50 --author-version 2
npm run arc -- edit-revision-author P1 --intent handoff.json --request-id retained-request-id
```

The CLI reads a bounded regular UTF-8 JSON intent file, preserves its exact
pins and validates the canonical input digest and operation result before
printing a receipt. It never fetches newer pins to retry a stale request.
Retain the exact intent and request ID after an uncertain response.

## Storage and upstream comparison

Schema 25 adds separate current-ownership, immutable transaction and immutable
operation tables. It preserves prior entity JSON, source versions, evidence,
activity and saved receipts. Migration creates version-zero baselines only
from trustworthy version-one attribution; it does not invent transfer history.
New text, Git and Word revisions initialize ownership from their first attributed
version. Migration is transactional and older binaries refuse the new schema.
Back up before upgrading; binary rollback requires restoring that backup too.

Before first enabling password sign-in, local-only current owners require an
explicit operator handoff with `npm run accounts -- transfer-local USERNAME`.
This transfers current ownership through immutable author transactions while
preserving original attribution, source and evidence. It is atomic with other
local policy/task/project handoffs and is unavailable after activation. See
[authentication](authentication.md).

Stack format `phabricator.revision-stack.v3` includes current author, original
author, ownership/lifecycle versions and close-on-accept configuration in its canonical digest. Old v1/v2 caches are retired
instead of silently interpreting original attribution as current ownership.

The pinned upstream [author transaction](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/xaction/DifferentialRevisionAuthorTransaction.php)
permits editors to assign a valid user. Its
[Commandeer transaction](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/xaction/DifferentialRevisionCommandeerTransaction.php)
rejects the current author and published revisions. The
[revision policy](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/storage/DifferentialRevision.php)
grants the author automatic view/edit access. This implementation adds exact
concurrency pins, explicit receipt recovery and stricter repository/File ceilings.

Upstream's [transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/editor/DifferentialTransactionEditor.php)
also removes the new author from reviewers, adds the former author and
recalculates review state. These effects now apply to new handoffs in the
[named-reviewer workflow](revision-reviewers.md); migration does not fabricate
reviewer effects for older handoffs. Model/check evidence remains separate from
personal decisions. [Revision notifications](notifications.md) now deliver handoff
updates. Collective reviewers, profile handles and
PHIDs/Conduit author edits remain explicit parity gaps.

The [revision lifecycle](revision-lifecycle.md) now provides explicit author actions and operator close-on-accept semantics. Stack v3 binds lifecycle versions and this terminal-status configuration in its canonical identity.
