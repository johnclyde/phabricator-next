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
npm run arc -- edit-revision-dependencies P1 --intent change.json --request-id retained-request-id
```

The CLI reads a bounded regular UTF-8 JSON intent file without following a final
symlink. It preserves supplied versions and never fetches a newer version to
change the request. Its receipt check verifies the source revision, complete
delta, operation identity and resulting relationship version. Retain the exact
request file and ID when a response is uncertain. All three commands print JSON
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

Full upstream Stack visualization, summary-derived "Depends on" parsing,
revision PHIDs and Conduit edge/edit/query interoperability, notifications,
formal authors/reviewers, and working-copy/landing orchestration remain gaps.
This dependency workflow does not establish full Differential parity.
