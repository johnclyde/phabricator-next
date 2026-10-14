# Private review drafts and publication

Keep several comments private, inspect the complete review, then publish them
together. Saved entries belong to one principal and revision and travel with
that principal across devices. Private saves produce no shared activity,
discussion, mention delivery, following change, notification, source edit,
acceptance or review evidence.

The first implementation supports new text/Word threads, exact text suggestions,
replies to existing published threads, and one optional summary. Entries may
address different historical versions. Original source identities and quotations
stay unchanged; replies separately record their original root and viewed version.
The discussion composer offers explicit private staging alongside immediate
comment/reply publication. A private review panel supports editing, discard and
complete preview. Unfinished local edits remain separate: save them before
preparing the review. Preview represents the saved entries it displays.

## Versions, publication and recovery

Each entry has a stable UUID and independent version. Creation requires
`expectedEntryVersion: 0`; editing or discarding requires its exact current
version. Saving another entry does not invalidate this edit version. Discarded
and published IDs cannot be reused. Discard is logical removal, not permanent
erasure: tombstones and immutable operation evidence support retry recovery.
Undo/restore is not implemented.

Publication pins the complete set version, ordered entry IDs/versions/hashes,
immutable sources, current revision head, access epoch and every reply thread's
version. Replies pin both viewed and original root sources when different.
Changing any saved entry, source head, reply thread or access epoch requires a
new preview. Private work and original anchors remain intact.

All entries publish in one transaction through ordinary comment/reply writers.
Failure on the last entry, receipt or notification delivery rolls back the whole
publication. Exact retries recover the original principal-bound result after
later changes, subject to current permission, without repeating side effects.
Changed requests cannot reuse a key. Publication never applies suggestions,
resolves threads, casts reviewer votes, submits lifecycle actions or invokes AI.

Limits are explicit: 50 entries, one summary, 20,000 UTF-16 code units per
body/quotation/replacement, and 250,000 characters across serialized payloads.
Bodies must contain non-whitespace text. Literal whitespace and line endings
are preserved; malformed Unicode and NUL are rejected. The server never silently
truncates a review.

## Ownership and offline work

The server derives ownership from the authenticated principal. Other reviewers
cannot discover these entries through shared details, search, activity, counts,
exports or private draft routes. Discovery filters current visibility before
paging. Local mode uses the workspace's local principal; password mode uses the
signed-in account.

Reads and own-draft discard require current View. Save and publish additionally
require Interact. Mutations require a write-scoped bearer credential or browser
CSRF protection. Restrictive Spaces, linked repositories and historical source
Files still apply. Authority is rechecked under the write lock and for retries.

Save/discard/publish are explicit online actions, never automatic outbox replay.
Local-mode unfinished edits and exact request recovery may persist on the device.
Password-mode browser retention stays in the verified tab; successfully saved
server drafts persist for the account. Access loss retires protected snapshots
and holds unfinished local work for the existing export/discard workflow.
Reconnecting or a voice command never automatically publishes a review.

## API

Routes honor the configured mount and use `Cache-Control: no-store`.

| Method and route | Contract |
| --- | --- |
| `GET /api/review-drafts` | Own accessible pending revisions; optional exclusive `after` revision ID and `limit` 1–100; returns `nextAfter`. |
| `GET /api/revisions/:id/review-drafts` | Own complete active set, set version, source head and access epoch. |
| `GET /api/revisions/:id/review-drafts/preview` | Complete set plus publication manifest; an empty set conflicts. |
| `PUT /api/revisions/:id/review-drafts/:entryId` | `{ expectedEntryVersion, expectedAccessEpoch, payload }`. |
| `POST /api/revisions/:id/review-drafts/:entryId/discard` | `{ expectedEntryVersion, expectedAccessEpoch }`. |
| `POST /api/revisions/:id/review-drafts/publish` | `{ manifest }` from the complete preview. |

Every mutation requires `Idempotency-Key`. Payload variants in
[`shared/review-drafts.ts`](../shared/review-drafts.ts) are:

- `comment`: `body`, `versionId`, `contentHash`, nullable `filePath` and `line`,
  with optional exact `passage`, `docxPassage`, or text `suggestion`.
- `summary`: `body`, `versionId`, `contentHash`.
- `reply`: `body`, `threadId`, `viewedVersionId`, `viewedContentHash`.

Word passages cannot combine with text anchors or suggestions. Quotations use
half-open UTF-16 offsets checked against immutable source. Receipts bind the
canonical input hash, actor, entry generations and published comment mapping;
the presenter verifies durable evidence before returning a receipt.

## CLI

```sh
arc review-drafts --limit 25
arc review-drafts P2
arc save-review-draft P2 DRAFT_UUID \
  --intent entry.json --request-id save-entry-1

# Inspect the complete file before explicitly publishing it.
arc preview-review-drafts P2 > review-preview.json
arc publish-review-drafts P2 \
  --intent review-preview.json --request-id publish-review-1

arc discard-review-draft P2 DRAFT_UUID \
  --intent discard.json --request-id discard-entry-1

# Retain an identical copy of piped JSON for retry recovery.
cat entry.json | arc save-review-draft P2 DRAFT_UUID \
  --intent - --request-id save-entry-1
```

Use actual revision/source identities and access epochs from inspected snapshots,
and a fresh UUID for each new entry. An `entry.json` example for a summary is:

```json
{
  "expectedEntryVersion": 0,
  "expectedAccessEpoch": 7,
  "payload": {
    "kind": "summary",
    "body": "The argument is clearer. I have two questions about the evidence.",
    "versionId": "IMMUTABLE_VERSION_ID",
    "contentHash": "REPLACE_WITH_THE_EXACT_64_CHARACTER_SHA256"
  }
}
```

Discard JSON contains only `expectedEntryVersion` and `expectedAccessEpoch`.
Publication requires the **complete unchanged JSON from `preview-review-drafts`**,
including entries and manifest. The CLI sends its manifest and checks returned
text, supplied root anchors and reply target/viewed-version identities. The
server additionally verifies inherited original reply anchors against immutable
discussion. A raw API `{ manifest }` body alone is insufficient for this CLI
command.

Intent files must be regular UTF-8 JSON files of at most 2 MiB; final symlinks and
nonregular files are rejected. `--intent -` accepts one bounded UTF-8 JSON object.
Output is JSON with terminal controls escaped. Before sending, stderr records
path, request ID, intent path and digest without private text. Keep that ID and
identical JSON after an uncertain result. The CLI makes one explicit request;
it never refreshes pins or retries itself. `--server`/`PHABRICATOR_URL` select the
root or mounted server; `PHABRICATOR_TOKEN` selects the account.

## Storage and upstream gaps

Schema 35 adds private sets, versioned entries and immutable operations while
preserving all existing shared rows and historical receipts. Migration rejects
conflicting schema definitions and rolls back atomically. Older binaries reject
the new format.

The target is archived Phabricator
[`5720a38`](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04).
Its [inline query](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/diff/query/PhabricatorDiffInlineCommentQuery.php)
selects the viewer's unpublished, undeleted entries and applies their latest
nonempty editing drafts. Its
[Differential edit engine](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/editor/DifferentialRevisionEditEngine.php)
includes all publishable inlines in submission. Explicit complete-set manifests,
source/access pins and durable exact retries are native extensions.

Full parity still requires upstream Save/Cancel/Undo and live editing-state
semantics, pending-inline reply graphs, pending Done/Undone and combined
reviewer/lifecycle submission, old/new-side ghost remapping, advanced draft
queries, and full Remarkup control metadata/file attachment behavior. Upstream
distinguishes embedded references from intentional attachments; this slice does
not implement that metadata contract. Mail/Herald/Conduit, imported upstream
draft history and spoken private review authoring/publication remain gaps.
Immediate comment/reply routes remain available. This is partial Differential
parity.

## Verification

Domain tests cover owner isolation, CAS/tombstones, source/Word anchors, multiple
replies to one thread, complete-set conflicts, restart recovery and rollback on
final-comment, receipt or delivery failure. Migration tests preserve old rows and
reject collisions. API tests exercise ownership, permissions, CSRF, historical
source restrictions and exact receipts. CLI tests cover root/mounted workspaces,
stdin/file bounds, private discovery, discard, read-only tokens, exact retries and
altered-preview/receipt rejection. Browser verification is tracked separately in
the parity inventory and roadmap.
