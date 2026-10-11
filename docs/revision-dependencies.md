# Revision dependencies

Code revisions, papers and document drafts can have parent and child revisions.
A child depends on its parents. A paper can depend on a companion appendix; a
filing can depend on a supporting memorandum. Links describe that relationship
without copying source or granting access to either document.

## Reading and editing

The Related Revisions panel appears in both text and Word review. Parents are
revisions this object depends on; children depend on this object. Each visible
entry links to its own review, with its current title, kind and status. Opening
that review preserves its existing source-version selection.

Add and remove explicit selections from either direction. Saving applies all
selected changes atomically. The request retains the relationship version and
access epoch inspected by the editor. Concurrent relationship edits require a
fresh inspection; a stale request never silently adopts a newer version.
Unrelated or hidden edges are never removed by replacing the entire list.

Relationship versions are separate from content versions. A successful batch
increments the edited revision's relationship version and each affected peer's
relationship version once. It records immutable history on both endpoints for
every added or removed edge, with the same operation identity and authenticated
actor. Editing relationships does not change source files, immutable versions,
content hashes, review evidence, acceptance or manual revision status. Open
parents do not introduce an implicit acceptance or closure requirement.

Self-dependencies and cycles are rejected. The cycle check and all writes occur
under the database writer lock, including when two clients concurrently propose
opposite edges. Cycle detection uses the complete stored graph, including
inaccessible intermediates; its error never includes a hidden path. Validation,
conflicts and traversal limits reject the entire operation without partial edges
or partial history.

## Stack

Open Stack in Related Revisions to see the complete visible connected graph,
including siblings, branches and shared parents. Rows follow a deterministic
child-before-parent order. Closed revisions stay visible. The advisory open-parent
count includes distinct transitive parents, traverses closed intermediates and
excludes the current revision. Accepted revisions remain open under this
application's manual closure model; the count never gates acceptance or closure.

Each row shows current status, title and current author, or "Not recorded" when
ownership is unknown. The selection also shows immutable original attribution
from version one. Selecting a row highlights
its traces and lists exact parent and child links. Trace lanes scroll separately
on narrow screens. Following a revision link preserves its selected source version;
the graph always describes current relationships and metadata.

One database read snapshot supplies the graph, current source-head identities,
relationship versions, authors and access epoch. The browser and CLI verify a
canonical SHA256 before using it. A changed visible node, edge, source-head identity
or access epoch changes the snapshot. Format `phabricator.revision-stack.v2`
includes current author, original author and ownership version; old v1 caches
are retired. Stored source hashes identify immutable
heads; reading Stack does not inspect or rehash manuscript contents. A snapshot
hash grants no authority, and every server read checks current access.

Graph traversal stops at inaccessible revisions. It returns no hidden IDs,
placeholders, counts, or visible nodes reached only through hidden intermediates.
Reads admit at most 1,000 visible nodes, 5,000 visible edges, 10,000 candidate
visibility checks, 50,000 scanned incident-edge rows, and 2 MiB of canonical UTF-8
data. Unsupported larger graphs fail explicitly without a partial graph. Cyclic
or inconsistent stored data also fails rather than producing misleading traces.

Visited verified stacks follow the same local/tab-memory cache policy as related
revisions. Focus, reconnect, known metadata changes, relationship edits and access
changes retire stale graphs and narration. Offline views label saved snapshots.
If device storage is full, the current tab can retain its newer verified snapshot.
"Read stack", "read current stack revision", "next stack revision" and "previous
stack revision" share the touch cursor and use the existing on-device response
voice. These commands navigate and read; they do not edit relationships or sources.

## Authority and offline work

The edited revision requires current view and edit permission. Every explicitly
added or removed peer requires current view permission, including its Space,
repository and source File restrictions. A peer need not be editable. Authority
therefore follows the chosen direction: editing a parent's children requires
parent edit plus child view; editing a child's parents requires child edit plus
parent view. Hidden and missing peers produce the same unavailable response.

Dependency links never become inherited source-access requirements. Losing
access to a parent removes its link and related history from authorized reads;
it does not make an otherwise visible child unavailable. History is filtered by
current peer visibility before paging. Responses contain no hidden peer IDs,
titles or placeholders. Monotonic relationship versions and history sequence
gaps can indicate intervening changes; they are concurrency metadata and do not
identify the hidden objects.

Visited relationship pages may be cached in local mode. Authenticated workspaces
retain them in verified tab memory. Access changes retire related snapshots and
stale links without denying the remaining visible manuscript. Drafts store
explicit IDs and version pins separately from submitted requests. Saving is an
explicit online operation: it never enters the ordinary outbox, and reconnecting
does not submit it. An uncertain result retains its exact request and request ID
for explicit retry or export; a later draft is not erased by an older receipt.

Saved retries are bound to the original principal, normalized request, operation
record and immutable receipt. Current source edit and peer view authority still
apply. A replay confirms its historical relationship version and delta, rather
than substituting today's graph; read again for current relationships.

## API and CLI

- `GET /api/revisions/:id/dependencies?direction=parents|children` returns a
  permission-filtered page, relationship version, access epoch and `nextAfter`.
  Optional `after`, `limit` and `expectedRelationshipVersion` support stable
  relationship paging. The default page size is 25, maximum 100.
- `GET /api/revisions/:id/dependencies/history` returns filtered immutable
  transactions, relationship version, access epoch and `nextBefore`. Optional
  `before`, `limit` and `expectedRelationshipVersion` use the same page limits.
- `GET /api/revisions/:id/dependencies/graph` returns one complete authorized Stack
  snapshot. Optional `expectedSnapshotId` requires an exact lowercase SHA256;
  a changed snapshot returns 409 after current access checks. Oversized graphs
  return 422. There is no partial paging and this read does not write storage.
- `POST /api/revisions/:id/dependencies` accepts the exact intent below and
  returns an operation receipt. A stable `Idempotency-Key` is required for each
  change and its retries. Read and write token scopes, cookie CSRF checks
  and principal-scoped idempotency follow the normal application contract.

```json
{
  "direction": "parents",
  "add": ["P2"],
  "remove": [],
  "expectedRelationshipVersion": 0,
  "expectedAccessEpoch": 12
}
```

All fields are required. The combined add/remove lists must contain 1–64 distinct
revision IDs. Adding an existing edge or removing an absent edge is a conflict.
The relationship version starts at zero for a revision with no recorded changes.
Graph traversal is bounded to 10,000 visited revisions and 50,000 visited edges;
an unsupported larger traversal fails explicitly.

```sh
npm run arc -- revision-dependencies P1 --direction parents --limit 50
npm run arc -- revision-dependency-history P1 --limit 50
npm run arc -- revision-stack P1
npm run arc -- revision-stack P1 --snapshot EXACT_SHA256
npm run arc -- edit-revision-dependencies P1 --intent change.json --request-id retained-request-id
```

The CLI reads a bounded regular UTF-8 JSON intent file without following a final
symlink. It preserves supplied versions and never fetches a newer version to
change the request. Its receipt check verifies the source revision, complete
delta, operation identity and resulting relationship version. Retain the exact
request file and ID when a response is uncertain. Stack reads also validate the
complete graph structure and its digest before printing. All four commands print JSON
with terminal control and direction-changing characters escaped.

## Storage and upstream relationship

Schema 24 adds revision relationship versions, canonical dependency edges,
immutable endpoint transactions and operation receipts. The migration does not
rewrite prior entities, source versions, review records, activity or saved retry
responses. Existing relationships are not invented from manuscript wording.
Migration failure rolls back the entire addition, and older binaries refuse the
new schema. Back up an existing workspace before upgrading.

The pinned upstream [parent edge](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/edge/DifferentialRevisionDependsOnRevisionEdgeType.php)
and [child edge](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/edge/DifferentialRevisionDependedOnByRevisionEdgeType.php)
define direction, inverse transactions and cycle prevention. The
[relationship controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/search/controller/PhabricatorSearchRelationshipController.php)
uses add/remove deltas and destination view checks. This implementation adds
explicit concurrency pins and extends the relationship to papers and documents.

The pinned [Stack controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/controller/DifferentialRevisionViewController.php)
loads the whole connected graph and counts open transitive parents. Its
[object graph](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/graph/PhabricatorObjectGraph.php)
retains closed nodes and traverses topology before filtering handles. This native
Stack intentionally tightens privacy by stopping at hidden nodes, rather than
showing hidden placeholders or bridges. Equal-order rows use lexical IDs for
determinism. [Revision authorship](revision-authorship.md) separately implements
mutable ownership, transfer history and commandeering; author profile handles
remain unfinished.

Configurable accepted-as-closed behavior, summary-derived "Depends on" parsing,
revision PHIDs and Conduit edge/edit/query interoperability, notifications,
reviewer assignments and their transfer effects, and working-copy/landing orchestration remain gaps.
This dependency workflow does not establish full Differential parity.
