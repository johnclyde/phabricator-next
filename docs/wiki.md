# Phriction hierarchy and moves

Wiki paths identify documents, independently of their titles and immutable
content versions. The root path is `/`; other canonical paths use lowercase
components and a trailing slash. Repeated separators collapse, URI punctuation
and spaces become underscores, and `.` / `..` components become `dot` / `dotdot`.
New paths are bounded to 128 characters. Existing longer paths remain readable.
The browser previews the canonical destination before creating or moving.

## Saved drafts and publication

A document has a latest saved content version and a separate published content
pointer. The ordinary page, navigation titles and workspace listings use the
published title and content. Saved drafts are immutable versions in the same
history and are visible to everyone who can read the document. They are not
private personal drafts. Unsaved browser drafts remain separate local work.

Saving a draft appends a content version without replacing the published pointer.
The editor opens the latest saved content. When latest and published content
differ, ordinary edits continue to save drafts, matching the archived editor.
Publishing selects an exact existing content ID, including an earlier version;
it does not copy content, allocate a content version, or replace its author and
date. A publication revision advances for every lifecycle operation, including
these pointer-only changes, so a stale editor cannot overlook an intervening
publication simply because the latest content number stayed the same.

Delete is an explicit soft-delete operation on an active document. It appends a
blank deletion marker, publishes that marker, and retains the document's identity,
path, policies, children and history. Repeated deletion of deleted, moved or stub
documents is rejected. Restore as New Version copies selected nonempty historical
content into a new active version at the same path. Publishing and restoring are
different operations: publishing an earlier content record does not change the
document's status, including when it is deleted or moved. Historical deletion
and move markers can also be selected as the published content, as upstream
allows. New authored content must contain at least one character; whitespace
is preserved and existing empty historical content remains readable.

As in the archived title transaction, changing a draft's title relative to the
published title reactivates an inactive document and clears its move destination.
The published content pointer still remains unchanged. Two deliberate changes
make submitted intent consistent: a draft save always remains unpublished,
including title-only changes with an unchanged body, and each explicit authored
save records a new immutable version even if its text is identical. Upstream's
transaction filtering can silently publish a title-only draft and suppress an
entirely unchanged save. Those filtering effects are not reproduced.

Content history and lifecycle history are separate immutable records. The latter
records the actor, exact before/after publication and location, operation digest,
and newly allocated content ID when there is one. Imported legacy records start
with a marked baseline; migration does not invent previous publication events.
Lifecycle mutations pin the latest content number and ID, published ID,
publication revision and access epoch. Current document and ancestor permissions
are checked on every operation and retry. A recovered response remains evidence
of the original operation, even after a later edit or publication.

Every new document requires all of its ancestors to exist, including the root.
The writer must be able to view those ancestors and edit the immediate parent.
New documents inherit the parent's access rules and Space unless the writer
explicitly selects another permitted configuration. The root uses the shared
workspace default. Existing documents migrated from the older flat wiki may
have missing ancestors: they remain readable and editable at the same path.
Missing parents can be created explicitly; migration does not invent content,
authors, history, or permissions for them.

Every existing ancestor's view policy and Space limits its descendants. An
ancestor still imposes this boundary when its own content has moved away.
Ordinary editing of an existing child needs the child's edit permission and
ancestor view permission; it does not require parent edit permission. These
rules apply to direct reads, history, comparisons, workspace discovery,
activity, attachment grants, and mutation receipts.

## A move preserves both identities

Moving a document copies its published content and title to a destination identity
and appends an immutable version there. The source identity keeps its original
path and history, gains a blank moved-marker version, and links to the destination
when the viewer can access it. Descendants keep their original paths and IDs.
Moving into a descendant path does not create a hierarchy cycle: neither path
identity is reparented.

An active destination cannot be overwritten. An inactive destination is reused
with its existing history; a new destination receives a new identity. A moved,
deleted, or stub source cannot move. Source and destination writes, both history
records, activity, access configuration, and the retry receipt commit together.
Changing the path through an ordinary content edit is rejected and directs the
writer to the move operation. Old queued renames are never silently converted.

The destination adopts the source's view/edit/interact rules. Existing
destination history becomes subject to those rules as well. Its Space is kept;
a newly created destination inherits the destination parent's Space. Source
rules do not bypass this Space or ancestor visibility. Current edit access to
an existing destination is required before its policy is replaced. Our move
operation also requires destination-parent edit permission, a deliberate
strengthening of the archived controller's new-destination behavior.
New destinations cannot be created in archived Spaces. Reusing an existing
inactive identity is an edit within its retained Space, so it follows the same
archived-Space rule as other edits to existing objects.

The preview pins the exact source content version and immutable version ID,
destination identity and version (or its absence), and current access epoch.
Any intervening content, occupancy, or access change rejects a fresh submission.
A retry keeps the original pins and request ID. Successful receipts are checked
against the immutable source/destination pair and operation digest; a retry
never borrows newer content or becomes a fresh move. Current authorization is
checked before replay. Hidden move references are removed from presented
history and markers, without changing the stored evidence.

## API and browser behavior

- `GET /api/wiki?path=research/` resolves a path, visible ancestors and paged
  children, including missing intermediate paths supported by visible descendants.
  Missing pages return creation eligibility and inherited access defaults.
  `after` is an opaque continuation; `limit` bounds visible results. A bounded
  scan may return an empty page with a continuation.
- `GET /api/documents/W1` returns the document, its immutable history, access,
  latest saved `head`, publication pointers, and the first hierarchy page.
  `document.version` remains the highest saved content number; `document.title`
  and `document.content` are the published content. Existing history and version
  endpoints retain their version-selection semantics.
- `GET /api/documents/W1/transactions?before=20&limit=20` pages the lifecycle
  ledger independently of content history.
- `POST /api/documents` creates at the canonical path. An optional
  `expectedAccessEpoch` pins a reviewed creation destination. Browser creation
  uses this pin and retains its parent dependencies with an offline request.
- `PUT /api/documents/W1` edits title/content at the same canonical path;
  `expectedVersion` remains mandatory. Full publication pins are required once
  saved and published content diverge or a pointer-only publication has occurred.
  Restore appends a new active version at that path. Both return a verified
  historical document snapshot and the current access epoch.
- `POST /api/documents/W1/drafts` saves `title`, `content` and optional `message`.
- `POST /api/documents/W1/publish` selects `targetVersionId` and optional `message`.
- `POST /api/documents/W1/delete` accepts optional `message`.
  These three routes require `Idempotency-Key` and the complete
  `expectedVersion`, `expectedHeadVersionId`, `expectedPublishedVersionId`,
  `expectedPublicationRevision`, and `expectedAccessEpoch` pins. Responses pair
  the exact document snapshot with its immutable lifecycle transaction.
- `GET /api/documents/W1/move-preview?path=research/new/` returns the source,
  destination, destination Space, and complete `defaultInput` pins.
- `POST /api/documents/W1/move` requires `Idempotency-Key` and accepts
  `destinationPath`, `expectedVersion`, `expectedSourceVersionId`,
  `expectedDestinationId` (null for a new path), `expectedDestinationVersion`
  (zero for a new path), `expectedAccessEpoch`, and optional `message`.
  Previews also supply `expectedPublicationRevision` and
  `expectedPublishedVersionId`, plus `expectedDestinationPublicationRevision`
  and `expectedDestinationPublishedVersionId` for an existing destination.
  Publication pins are mandatory for a source or destination with nontrivial
  publication history.

Desktop and mobile share breadcrumbs, path navigation, child lists, source
history, and an explicit previewed move. Moves stay online and never enter the
ordinary offline outbox. Same-path content edits and reviewed creation intents
retain their exact versions and authority dependencies. Drafts remain at the
original identity; they are not transferred to the move destination. Losing
access retires cached content and holds unsent work for explicit recovery.

Schema 20 adds a canonical location index. Schema 21 adds publication pointers
and the lifecycle ledger. Migration preserves previous entity JSON, immutable
versions, activity, policies, and retry records. Canonical collisions abort the
location migration atomically rather than merging documents.

## Upstream evidence and remaining work

The behavioral baseline is pinned Phabricator
`5720a38cfe95b00ca4be5016dd0d2f3195f4fa04`:

- [Path normalization](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/util/PhabricatorSlug.php)
- [Ancestor view filtering](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/query/PhrictionDocumentQuery.php)
- [Creation parent authority](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentTitleTransaction.php)
- [Move, ancestry and policy effects](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/editor/PhrictionTransactionEditor.php)
- [Move destination](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentMoveToTransaction.php)
  and [source marker](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentMoveAwayTransaction.php)
- [Saved drafts](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentDraftTransaction.php),
  [publication](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentPublishTransaction.php),
  [soft deletion](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentDeleteTransaction.php),
  and [editor behavior](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/controller/PhrictionEditController.php)

Full Phriction parity is not claimed. Upstream content/status import, Conduit mappings,
Remarkup rendering, subscriptions, mail, Herald, full-text indexing, and the
broader wiki transaction model remain open. The location model reserves the
upstream stub state, but explicit stub creation and upstream interchange remain
open. The current wiki list includes all visible statuses; upstream's default
Active query, All query and configurable saved defaults remain to be implemented.
Automatic publication from offline requests is not introduced: new browser
lifecycle requests retain exact pins for explicit online submission and recovery.
