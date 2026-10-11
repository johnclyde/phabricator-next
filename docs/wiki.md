# Phriction hierarchy and moves

Wiki paths identify documents, independently of their titles and immutable
content versions. The root path is `/`; other canonical paths use lowercase
components and a trailing slash. Repeated separators collapse, URI punctuation
and spaces become underscores, and `.` / `..` components become `dot` / `dotdot`.
New paths are bounded to 128 characters. Existing longer paths remain readable.
The browser previews the canonical destination before creating or moving.

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

Moving a document copies its current content and title to a destination identity
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
  and the first hierarchy page. Existing history and version endpoints retain
  their version-selection semantics.
- `POST /api/documents` creates at the canonical path. An optional
  `expectedAccessEpoch` pins a reviewed creation destination. Browser creation
  uses this pin and retains its parent dependencies with an offline request.
- `PUT /api/documents/W1` edits title/content at the same canonical path;
  `expectedVersion` remains mandatory. Restore appends a new version at that path.
- `GET /api/documents/W1/move-preview?path=research/new/` returns the source,
  destination, destination Space, and complete `defaultInput` pins.
- `POST /api/documents/W1/move` requires `Idempotency-Key` and accepts
  `destinationPath`, `expectedVersion`, `expectedSourceVersionId`,
  `expectedDestinationId` (null for a new path), `expectedDestinationVersion`
  (zero for a new path), `expectedAccessEpoch`, and optional `message`.

Desktop and mobile share breadcrumbs, path navigation, child lists, source
history, and an explicit previewed move. Moves stay online and never enter the
ordinary offline outbox. Same-path content edits and reviewed creation intents
retain their exact versions and authority dependencies. Drafts remain at the
original identity; they are not transferred to the move destination. Losing
access retires cached content and holds unsent work for explicit recovery.

Schema 20 adds a canonical location index. Migration preserves previous entity
JSON, immutable versions, activity, policies, and retry records. Canonical
collisions abort the migration atomically rather than merging documents.

## Upstream evidence and remaining work

The behavioral baseline is pinned Phabricator
`5720a38cfe95b00ca4be5016dd0d2f3195f4fa04`:

- [Path normalization](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/util/PhabricatorSlug.php)
- [Ancestor view filtering](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/query/PhrictionDocumentQuery.php)
- [Creation parent authority](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentTitleTransaction.php)
- [Move, ancestry and policy effects](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/editor/PhrictionTransactionEditor.php)
- [Move destination](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentMoveToTransaction.php)
  and [source marker](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentMoveAwayTransaction.php)

Full Phriction parity is not claimed. Draft versus published content pointers,
delete/undelete controls, upstream content/status import, Conduit mappings,
Remarkup rendering, subscriptions, mail, Herald, full-text indexing, and the
broader wiki transaction model remain open. Current saved content is the only
published source pointer. The location model reserves upstream inactive states
without claiming those lifecycle workflows are implemented.
