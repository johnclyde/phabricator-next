# Active revisions

Active is a personal queue for code, papers and documents where you are the current author or a directly assigned reviewer. It groups open work by the next action. Following alone does not make a revision your responsibility.

Open **Active** in a revision list, or say “show active papers,” “show active documents,” or “show active revisions.” The search box matches literal text in the revision ID, title and summary. Each group sorts by last update, then revision ID, newest first. Opening a row reads the revision; the queue never accepts, closes or lands work automatically.

| Group | Included work |
| --- | --- |
| Must Review | Another author's revision needs review and you are blocking it or previously rejected it. |
| Ready to Review | Another author's revision needs review and you were added, or your acceptance is no longer current. |
| Ready to Land | Your accepted revision, while acceptance is configured to remain open. For papers and documents, this is readiness for the author's finalization. |
| Ready to Update | Your revision needs changes or you marked changes planned. |
| Drafts | Your unpublished draft revisions. |
| Waiting on Review | Your revision needs review. |
| Waiting on Authors | A revision you review is accepted, needs changes or has changes planned. |
| Waiting on Other Reviewers | A revision needs review and your own acceptance is still current. |

Author responsibility takes precedence over a reviewer assignment. Other authors' drafts and revisions you resigned from are excluded. Closed and abandoned work is excluded; accepted work is also excluded when the operator enables close-on-accept. An invalidated rejection still belongs in Must Review when review is requested again. An acceptance is current only when it has not been invalidated and its immutable source identity matches the current version.

## Saved filters and offline behavior

Active has a separate selection and search for each revision kind. Switching to it preserves your unfinished [saved-view filters](revision-views.md) and any exact pending save request. Return to saved filters to recover or submit that request. Active cannot be saved as a named filter in the current saved-view format.

Local workspaces can reopen a previously loaded Active queue offline. Password-protected workspaces retain authorized content only in the current verified tab session. Sign-out retires that content. The queue reports unavailable for older caches without a complete responsibility projection, mismatched versions or a changed known access boundary; it does not guess from Following or show an empty queue as if no work were assigned. A delayed earlier workspace response cannot replace a newer processed snapshot or revoke newly visible work.

## API and command line

`GET /api/state` includes `revisionActive`, a viewer-bound `revision-active.v1` projection built in the same read transaction after View filtering. Each authorized revision appears once with its immutable head, author/lifecycle/reviewer versions, status, whether the viewer is its author, the viewer's reviewer status and whether their decision is current. It contains no other reviewer identities, private review drafts or source bodies. It does not confer permission to read hidden revisions.

```sh
npm run arc -- active-revisions --kind paper
npm run arc -- active-revisions --kind document --query "Exact phrase"
```

The command uses a read-only token and one authorized state read. It emits all eight groups, including empty groups, and rejects missing or mismatched projections before printing revision content. It shares the browser's portable grouping rules. This is evaluation of the available workspace snapshot, without server pagination.

## Upstream comparison and remaining gaps

The reference is Phabricator commit `5720a38cfe95b00ca4be5016dd0d2f3195f4fa04`. Its [built-in Active query](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/query/DifferentialRevisionSearchEngine.php) combines responsible users, open statuses and action buckets. The ordered groups and author precedence follow [DifferentialRevisionRequiredActionResultBucket](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/query/DifferentialRevisionRequiredActionResultBucket.php) and [DifferentialRevisionResultBucket](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/query/DifferentialRevisionResultBucket.php). Raw rejection responsibility deliberately differs from whether a rejection currently vetoes acceptance.

This implements direct person assignments. Upstream responsibility expansion through project and package reviewers, historical `commented`/older decision imports, arbitrary responsible-user queries, server search/pagination and Conduit query interchange remain gaps. Native immutable-content acceptance intentionally differs from upstream configurable sticky acceptance; historical decisions must not become proof for changed source. Full Differential parity is not claimed.
