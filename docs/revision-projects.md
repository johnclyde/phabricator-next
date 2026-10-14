# Revision project tags

D113 implements this bounded native workflow. Remaining parity gaps are tracked
in [the internal roadmap](roadmap.md).

Code, papers and Word drafts share multiple project tags. Tags organize a
revision independently of its source versions, current author, reviewers,
following preferences and acceptance. They never grant access to the revision or
its source repository and Files.

## Tag actions

An editor can add selected tags, remove selected tags, or deliberately replace
the entire set. Replacement removes omitted hidden tags as well as visible ones;
the interface warns about this before submission. Add and remove retain unrelated
tags. Adding a conflicting project still replaces the conflict, including when
the previous tag is hidden from the editor.

Hierarchy normalization uses the complete project graph. Later selections win
when one project is an ancestor of another or when two milestones share a parent.
Ordinary sibling projects can coexist. Archived projects remain selectable and
are labeled as archived. Selection order is meaningful when resolving conflicts;
the saved set has a stable canonical order.

Fresh writes require current revision View and Edit and current View of every
explicitly selected project. Project Edit is not required. The same authority is
checked when recovering a saved request. Object, Space, repository and historical
File restrictions continue to apply. Tagging neither bypasses these restrictions
nor enrolls project members as followers or reviewers.

Each revision has an independent project-tag version. Actions pin that version
and the access epoch. Source-only updates do not invalidate a tag draft. A stale
tag version or access change requires inspection and a deliberate new action.
No-effect actions return saved receipts without advancing the tag version or
inventing a transaction.

## Reads, history and recovery

Snapshots, revision lists, histories and saved receipts expose only currently
visible project identities. They do not publish hidden names, identity hashes or
hidden-tag counts. A visible history entry can have identical visible before/after
sets when the underlying action affected only hidden tags.

An exact request ID and intent identify a mutation. The immutable operation binds
the original scoped retry key, input, previous tag state, hierarchy used for
normalization and resulting receipt. The server verifies the original operation
before applying current visibility filtering. Retrying a completed request does
not normalize against a different project graph or change tags a second time.

Creation accepts a `projectIds` array, or the legacy single `projectId` field,
never both. Text, Git and Word creation use the same hierarchy rules. Historical
creation and source-update receipts retain their original tag snapshots rather
than acquiring current tags on replay.

New saved source responses also bind their observed tag projection to the
original request key and fingerprint. A different valid historical tag set is
not a valid replacement for that response. Earlier saved responses retain their
original bytes and compatibility behavior; migration does not invent bindings
for them.

## Native API and CLI

Paths are relative to the configured application mount.

- `GET /api/revisions/:id/projects` reads current visible tags, their independent
  version, current object capabilities and access epoch.
- `GET /api/revisions/:id/projects/history` reads bounded immutable history.
- `POST /api/revisions/:id/projects` applies one explicit `add`, `remove` or `set`
  operation and requires an `Idempotency-Key`.

The action body contains `action`, ordered `projectIds`,
`expectedProjectVersion` and `expectedAccessEpoch`. It has no source-version pins.
Exact CLI recovery uses a retained JSON intent and request ID; it never silently
refreshes concurrency versions.

History accepts `before` (an exclusive tag version), `limit` from 1 to 100
(default 25), and `expectedProjectVersion` to pin pagination. A revision supports
at most 100 current tags and 100 distinct selected IDs in a single action. This
native bound is a documented difference from the upstream edge store.

```sh
arc revision-projects P2
arc revision-project-history P2 --project-version 3
arc edit-revision-projects P2 --intent tags.json --request-id tags-1
```

New text and Git revisions accept repeated `--project` options. An existing
revision's tags use the separate edit command; a source update cannot silently
change them. Word creation's exact JSON intent accepts the same array field.

## Mobile, offline and voice

The text and Word interfaces share a Project Tags editor, current tag chips and
history. A revision list can filter by a visible project and its visible
descendants. Project profiles expose accessible tagged revisions as well as
tasks. These views do not infer a path through hidden projects.

Offline snapshots and drafts are separated by workspace and person. Local mode
can retain them on the device; authenticated mode uses current-tab memory. Tag
writes require an explicit online action and never enter automatic offline
replay. An uncertain request keeps its original intent and ID; completing it
cannot erase a newer draft. Losing View retires cached server content and holds
unsent drafts for export. Losing Edit holds edits while retaining permitted
reading.

Voice commands such as “show papers in project Research” and “open documents
tagged with project Filing” select an authorized list. “Show papers in all
projects” clears the project filter. These commands never change tags.

## Storage and compatibility

The schema 30 migration adds current tag state, known initial state, immutable
operations, transactions and source-response bindings. It preserves existing
entity, source, discussion, policy, evidence and idempotency rows. A historical scalar project association
becomes the known version-zero baseline, with no fabricated edit event.

Current revision responses expose `projectIds` and `projectVersion`. A scalar
`projectId` remains a compatibility projection; clients should use the array.
Later source writes preserve the original stored scalar instead of copying a
mutable projection over historical fields.

## Upstream comparison

The baseline remains Phabricator
[`5720a38`](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04).
Its [project edit extension](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/engineextension/PhabricatorProjectsEditEngineExtension.php)
provides add, remove and set transactions for project-aware objects. The
[transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php#L4745-L4863)
resolves hierarchy and milestone conflicts using the complete graph with later
selections taking precedence. Its
[edge capability rules](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php#L1977-L2034)
require source Edit without requiring Edit on the inverse project association.

The [project datasource](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/typeahead/PhabricatorProjectDatasource.php)
includes archived projects with a status label. The
[project search extension](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/engineextension/PhabricatorProjectsSearchEngineExtension.php)
adds tag constraints and project attachments.

Existing tagged-project and ancestor people watchers now receive visible revision
updates through the [notification inbox](notifications.md). Herald, project/package reviewer groups,
subscription inheritance, generic bulk editing, revision workboard cards, full
saved-query logic, Conduit/Arcanist field interoperability and upstream history
import and unlimited tag scale remain parity gaps. Repository reassignment also
remains separate: it must preserve the original Git source's continuing visibility restriction.

## Verification

Core and migration tests exercise hierarchy conflicts, no-effect receipts,
immutable operations, exact response bindings, rollback and byte-preserving
legacy baselines. API and CLI tests cover current source/project authority,
credential changes, exact request recovery, hidden tags, canonical receipt
substitution and overlapping Word saves. Older unbound receipts retain their
original validation.

Client and browser checks cover text/Git/Word creation, tag history and editing,
visible descendant filters, project navigation, voice filters, lost responses,
newer drafts, offline reopening, revoked references and late reads on desktop
and mobile at root and mounted paths. A migration rehearsal on a copy of the
local database preserved every existing row, schema object and foreign key.
Full application parity is not claimed.
