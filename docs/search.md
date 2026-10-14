# Workspace search and saved queries

The Search application searches current content across the workspace. It is an authenticated application when the server uses account authentication. A public source repository does not grant access to the workspace.

## Full-text behavior

Search uses a portable TypeScript positional inverted index. Each request projects the current caller's authorized objects inside one SQLite read snapshot, builds that caller's index, and then evaluates the query. There is no asynchronous indexing window and no external search service or model call. The index is discarded after the response. Supported Node SQLite builds do not all provide FTS5, so search does not depend on that optional native module.

Words match regardless of case or diacritics. Separate terms must all match. Quotes select a phrase, a trailing `*` selects a word prefix, and a leading minus excludes a word or quoted phrase:

```text
"legal motion" evid* -obsolete
```

Words such as `OR`, `NEAR`, and `title:admin` are literal text rather than query operators. Search does not perform automatic English stemming, fuzzy matching, semantic retrieval, or translation. Punctuation separates words; phrase positions do not cross title/body boundaries.

Relevance uses BM25 with a title weighting. Title, creation date, and update date are also supported sort orders. Plain-text snippets come only from the authorized current projection; the server does not insert HTML highlighting into authored text.

The indexed applications are:

| Application | Indexed content |
| --- | --- |
| Maniphest | Current title, description, custom field values, and published task comments |
| Differential, papers, and document revisions | Current title, summary, test plan, current source files and their paths, and comments bound to the current version |
| Phriction | Published active page title, path, and body |
| Projects | Current name, description, aliases, and primary slug |
| Diffusion | Repository registry name, description, URL, and default branch |
| Paste | Current title and current paste content |
| Files | Current name, original name, media type, and alternative text |
| Almanac | Current object title, description, address, and properties |
| Conpherence | Conversations visible to the current participant, including topic and messages |
| Calendar | Current title, description, location, and comments |
| Slowvote | Question, description, and available answer labels |
| Phame | Blog descriptions and currently published post bodies/comments |
| Legalpad | Current agreement title, preamble, body, and comments |

Historical source versions, unpublished wiki drafts, moved/deleted wiki pages, unpublished Phame posts, private review drafts, AI proposals, vote ballots, signature personal details, and import assertions do not enter this index. Archived task/project/paste/file/suite objects remain searchable where their application permits access; status filters can select them. Files are searched by metadata, without OCR or extraction of arbitrary binary attachment contents. Repository Git tree and commit history search is not included.

## Typed filters and paging

`GET /api/search` accepts one occurrence of each supported parameter:

- `text`: the full-text expression.
- `kinds`: a JSON array of application kinds from `shared/search.ts`.
- `statuses`, `priorities`, `ownerIds`, `projectIds`: JSON string arrays.
- `createdAfter`, `createdBefore`, `updatedAfter`, `updatedBefore`: ISO dates or UTC timestamps.
- `order`: `relevance`, `updated`, `created`, or `title`.
- `limit`: 1–100 results per page; default 50.
- `cursor`: the opaque continuation returned by the preceding response.

Status, priority, and owner lists match any selected value. Project lists require all selected direct tags. A project query does not currently expand descendant projects. `ownerIds` accepts an exact account ID, `me`, or `none` (`unassigned` is also accepted). Ownership means task assignee or the application's author/owner where available. Date starts are inclusive and ends are exclusive; an end date at midnight excludes that date. Objects without a timestamp do not match a timestamp filter.

Counts, ranking, snippets, and page boundaries are computed only after object and field visibility filtering. A newly unavailable selected project produces no search matches. The server never reports hidden-object counts or emits partial pages based on scanning hidden rows.

The response contains the canonical query, `items`, `total`, `nextCursor`, and `accessEpoch`. Cursors are signed and bound to the principal, canonical query, page size, current visible corpus, and access epoch. A changed visible corpus or policy returns `SEARCH_RESULTS_CHANGED` and requires restarting at page one. Malformed, forged, cross-account, changed-query, or process-restart cursors are rejected. Pagination limits response size, not the total number of matches.

## Saved queries

Saved queries preserve reusable filter definitions; they do not store result bodies or another person's authorization. Existing private revision views remain a separate application preference.

- `GET /api/search/queries` lists the caller's private queries and currently visible workspace-shared queries.
- `GET /api/search/queries/:id` returns a query and `canEdit`.
- `POST /api/search/queries` creates `{name, visibility, query}`.
- `POST /api/search/queries/:id` updates the full definition with `expectedVersion`.
- `POST /api/search/queries/:id/delete` deletes with `{expectedVersion}`.

Visibility must be explicitly `private` or `workspace`. Only the immutable owner can update or delete a query. Workspace sharing exposes the query's name and filters to other signed-in workspace members; it does not grant any access to objects matched by those filters. Queries referencing a project the viewer cannot currently access are omitted from discovery and unavailable by ID. New or edited filters may reference only projects visible to their owner.

Names are unique per owner after Unicode normalization and case folding. Updates use exact versions, and mutations require an `Idempotency-Key`. Repeating the same key/body acknowledges the original operation while returning the currently visible definition. The receipt retains its original operation/version, distinct from the current query version. Different content under a reused key conflicts. Deleted queries retain tombstones and immutable operation records, allowing an exact retry to acknowledge deletion without recreating the query. Credentials and owner authority are rechecked under the writer lock, including retries. Query changes advance the access epoch so cached shared definitions are invalidated when visibility changes.

Dashboards may explicitly copy a saved query's filters into a panel. Panel results are always obtained through the viewer's own search request. Copying a query is not a live reference to its owner's private preferences.

## Verification and remaining scope

Service, portable-index, and HTTP tests cover phrase/prefix/exclusion matching, Unicode normalization, relevance/snippets, typed filter validation, current-content replacement, rollback, unpublished/deleted wiki content, source-version exclusion, policy revocation, cursor integrity, saved-query sharing/ownership/versioning/retry evidence, revoked credentials, and root/subpath HTTP routes. A 1,000-task fixture verifies complete counts with paged responses and measures projection plus index construction; local focused runs were approximately 0.15–0.2 seconds. This is a fixture measurement, not a production capacity guarantee.

The implementation intentionally rebuilds the authorized snapshot for every request. A larger installation will need measured scaling work, such as a durable policy-aware index with exact transactional invalidation. Search does not claim complete upstream Search/ApplicationSearchEngine parity: missing features include all application-specific field types, custom-field structured predicates, inherited project filter operators, author/reviewer/subscriber distinctions, upstream saved-query migration, query ordering/default navigation preferences, Elasticsearch compatibility, and every historical application indexer. Those gaps are separate from the completed cross-application search and reusable query workflows.

Historical behavior was researched from the read-only pinned upstream Search application, particularly `PhabricatorApplicationSearchEngine.php`, full-text storage engines, named query records, and the search compiler. No PHP runtime or vendored dependencies were imported.
