# Personal revision views

[Active revisions](revision-active.md) provide a separate author/reviewer responsibility queue. Opening Active preserves these saved filters and pending requests.

Named revision views save your own filters across devices for code, papers and documents. A view stores a query, not a copy of revision content or permission to read it. Each opening evaluates the current authorized workspace snapshot. Offline openings use the snapshot already available to the current workspace session.

## Filters and ownership

A view contains its revision kind, literal search text, one status (or all statuses), one project scope (or all projects), Following, and Authored by me. Text matches the revision ID, title and summary without interpreting query operators or regular expressions. Project scope includes visible descendants and milestones whose ancestry is available. Authored uses the current author identity; Following uses the existing explicit and derived following list. The two filters can be combined.

All, Authored and Following are built-in choices. Personal view names and definitions are visible only to their owner. Possessing an `RV` identifier does not grant access. Account identity is derived from the verified session or API token, never accepted in a request body. The local workspace uses its stable local principal.

A selected project that becomes unavailable remains a constraint and matches no revisions. It is never silently replaced with All projects. Personal filters retain only the project ID; current project labels come from the authorized workspace snapshot. You can still rename or delete your own saved view with that unavailable constraint. Selecting a new project requires current access.

Native limits are 100 active personal views per owner, names of 1–80 characters, and literal queries of at most 512 UTF-16 code units. Names are trimmed and unique case-insensitively within each revision kind. These limits are implementation bounds, not upstream compatibility promises.

## Saving and recovery

Save as new creates a separate personal view. Updating a saved view explicitly replaces its name and filters. Deleting removes it from the active inventory. Updates and deletion require the exact observed view version; every fresh successful update increments that version, including an identical replacement. A deleted view retains a server tombstone for retry verification and cannot be reopened or silently recreated by an old request.

Every write requires an explicit request ID and observed access version. An identical retry recovers the original operation result even after later edits; it does not apply the old change again or substitute the latest view. Changing the request body under the same ID fails. A stale view version or access version fails without overwriting newer work. Refreshing current server information does not authorize replacing a retained uncertain request with new versions.

The browser keeps filter edits and the exact pending request separate from current server views. Offline selection and editing do not submit writes or enter the automatic outbox. Reconnect and retry are explicit. Local mode retains visited views and unfinished work in workspace/mount-scoped browser storage; conflicting or quota-failed copies remain exportable in the originating tab. Password-authenticated workspaces retain browser copies only in the verified session's memory, clearing them on lock or account replacement. Server-saved views remain available after signing in again.

Voice selection reads existing views only. For example, “open paper view Literature review”, “show revision view RV1”, “show papers I authored”, or “show my documents”. Names or IDs must match one available view of the requested kind. Voice does not save, rename, delete, or silently discard unfinished filter edits.

## API and CLI

Reads require the `read` scope; mutations require `write`. All responses use the normal authenticated session and current authority checks. Inventory is complete up to the active-view limit; it is not paginated revision search.

| Method and route | Request | Response |
| --- | --- | --- |
| `GET /api/revision-views` | None | `{ views, accessEpoch }` |
| `GET /api/revision-views/RV1` | None | `{ view, accessEpoch }` |
| `POST /api/revision-views` | `{ name, filters, expectedAccessEpoch }` | `{ view, deleted: false, accessEpoch }` |
| `PUT /api/revision-views/RV1` | `{ name, filters, expectedVersion, expectedAccessEpoch }` | `{ view, deleted: false, accessEpoch }` |
| `POST /api/revision-views/RV1/delete` | `{ expectedVersion, expectedAccessEpoch }` | `{ view, deleted: true, accessEpoch }` |

Mutations require `Idempotency-Key`. The server returns not-found for another owner's ID. Query parameters and unsupported fields are rejected. Filter shape:

```json
{
  "kind": "paper",
  "query": "manuscript",
  "status": "needs_review",
  "projectId": null,
  "following": false,
  "authored": true
}
```

Use a current read's access version and, for replacement or deletion, the selected view's version in the request file. Keep that file and its request ID unchanged for uncertain-result recovery.

```sh
arc revision-views
arc revision-views RV1
arc open-revision-view RV1
arc create-revision-view --intent create-view.json --request-id create-reading-list
arc edit-revision-view RV1 --intent edit-view.json --request-id update-reading-list
arc delete-revision-view RV1 --intent delete-view.json --request-id delete-reading-list
```

`open-revision-view` applies the same portable filter evaluator to a fresh authorized workspace snapshot. It returns the observed view and matching revision summaries; if authority changes between the two reads it requires another explicit opening. CLI mutations validate bounded regular JSON files, print recovery identifiers before sending, and validate that the receipt matches the requested operation. They never refresh versions and retry a changed intent automatically.

## Upstream comparison and remaining work

The pinned upstream `5720a38c` separates `PhabricatorNamedQuery` from `PhabricatorSavedQuery`. Personal names are owner-private; query definitions are separately content-keyed and public under upstream policy. The native implementation keeps both name and definition private. It does not expose shareable upstream query keys.

`DifferentialRevisionSearchEngine` provides All and Authored built-ins. Its Active Revisions query selects open work where the viewer is a responsible author/reviewer and uses required-action result buckets. Following is a separate native convenience filter and is not labeled Active.

This slice does not yet reproduce server-side revision search/pagination, indexed full-text syntax, arbitrary author/reviewer/responsible lists, repository/date/path filters, required-action buckets, shared/global views, query ordering/default preferences, saved queries in other applications, or Conduit/Arcanist query compatibility. Those remain parity work.

Schema 36 adds private view storage and immutable operation records without inventing saved views or modifying historical revision content. The required typecheck and root/mounted production builds pass. The full suite passes 1,866 tests, with nine optional TeX integrations skipped. Thirty-six desktop/mobile browser checks at root and mounted paths verify per-kind and cross-device views, exact voice selection, concurrent edits, lost create/delete receipts, offline reopening, revoked projects, account isolation and cancellation of sign-out during a pending save. The complete parity inventory remains open.
