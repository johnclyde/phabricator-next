# Project workboards

This document defines the PROJECT-03 workboard slice and the implemented portion of PROJECT-04. A workboard belongs to a project. Its columns and card positions are independent of task status: moving a card does not resolve, reopen, or reassign the task. The task remains the same `T` object, with the same discussion, dependencies and history. A task may have independent positions on multiple unrelated project boards.

## Enabling and arranging a board

A new project has no enabled workboard. An editor explicitly creates it, which initializes Backlog and the project's existing child proxies. Disabling a board preserves its columns, positions and history. Re-enabling restores them. Reads do not create boards, columns or positions.

Normal columns can be created, renamed, reordered and hidden. Hiding keeps their cards in place; it does not move cards into Backlog. Show Hidden reveals these columns to otherwise authorized viewers. The default Backlog column cannot be hidden. Reordering uses a relative column or an explicit start/end position, preserving columns omitted from the client's current view.

A column's optional `pointLimit` is advisory. In this slice every displayed task contributes one unit, and the warning uses only cards visible under the current filter. Zero is a real limit; null means no limit. Exceeding it does not prohibit a move. Task points and point-based presentation remain unfinished.

## Importing a column setup

An editor can initialize a new board by importing another visible project's column setup. The destination must never have had a board: disabling an existing board does not make it eligible for import. A disabled or archived source remains eligible if it retains importable columns and the editor can view it.

The preview lists the source's visible normal columns in their manual order, including the default column and advisory limits. The import preserves these names, order, default status and limits with new column IDs. It skips hidden and proxy columns, and copies no cards, positions, task tags or triggers. The destination's own existing child projects supply its proxy columns. Tasks already tagged with the destination naturally appear in its default column; they are not copied from the source.

Both source and destination board versions are pinned. Importing enables the destination and creates its columns in one transaction, or changes nothing when a pin, permission or write fails. A preview never initializes either board. The browser requires an explicit preview and a live connection; it does not enqueue an import offline or update its reviewed versions automatically.

Copied column configuration becomes part of the destination project. Later changes to the source's columns or permissions do not modify or hide the copied columns. Import history retains the source project and board version, and those source-linked events are shown only while both projects remain visible. A saved import retry still requires current source view and destination edit permission, even though ordinary reads of the copied columns depend only on destination access.

## Project tags and proxy columns

Board membership comes from project tags, including descendants. A direct parent tag normally puts an unpositioned task at the top of Backlog. Existing manual positions remain independent on each board. New unpositioned cards precede manually positioned cards, ordered by descending task ID.

Milestones appear as proxy columns at the end of their parent's board, in milestone-number order. Their names and archive state come from the milestone project. Renaming or archiving the milestone uses its project profile; it does not overwrite a column snapshot in old history. A proxy's advisory limit may be edited on the board, but its name and ordering are inherited. Archived milestones remain available with Show Hidden; hidden destinations cannot receive new moves.

Ordinary subproject proxies are stored but omitted from the board interface, matching the pinned upstream implementation's explicit limitation. Tasks assigned to these proxies do not spill into the parent's Backlog. Open the child's board through the subproject links instead. The parent can still have normal columns.

The current layout chooses one matching child proxy in the task's canonical project-tag order. It considers raw tags and descendants, including references hidden from the reader, before filtering the result. It does not infer membership from the reader's redacted tags. Multiple simultaneous proxy positions remain unfinished. A requested milestone move that would still resolve to a different proxy is rejected without changing the task; the error does not identify hidden tags.

Moving into a normal column adds the owning project's tag. Moving into a milestone proxy adds the milestone tag unless the task already has that proxy's tag or a descendant tag. The existing ordered tag-normalization rules resolve ancestor/descendant and same-parent milestone conflicts. These tag changes and the position change commit atomically. A card move never silently removes an unrelated ordinary subproject tag to manufacture a supported layout.

## Moving a column's tasks in bulk

A bulk preview selects the complete set of visible, editable tasks in one source column under the current status and owner filters. It is independent of how many card pages the browser has loaded. The preview lists each selected task and its version, both boards' versions, and the source and destination columns. More than 100 eligible tasks requires a narrower query or individual moves; the server never silently truncates a bulk selection or reveals skipped hidden-task totals.

The destination is a visible, active normal column on an enabled board. It may be on the same board, but cannot be the source column. Milestone proxies are supported as sources, including archived milestones. An explicitly addressed hidden column or disabled source board remains eligible through the API; the browser offers actions on columns currently presented in its board view. Ordinary subproject proxies remain unsupported sources in this slice. Viewing both projects and editing every selected task is sufficient; project edit permission is not required. A read-scoped credential may preview the tasks its principal could edit, but cannot submit a move.

A cross-project move removes only the exact source-board project tag and adds the destination project tag. It does not remove all source descendants. For example, a task tagged with milestone M under project A can move to unrelated project B while retaining M, so it still appears on A's milestone column. Moving from that milestone to a normal column on A instead adds A, whose ancestor/descendant conflict rule replaces M. Other unrelated tags remain intact. Status, ownership and discussion do not change.

Newly moved cards are prepended in the preview's source order, matching upstream's sequential insertion. Thus source order A, B, C becomes C, B, A above the destination's existing cards. A selected task already in the destination keeps its position, although removing the source tag may still change that task. The implementation preserves invisible neighbors when recording the resulting order.

Confirmation sends the exact ordered task IDs and reviewed versions. It never expands the list because later permissions expose more tasks. Both boards, all selected task versions, current source-column membership and current authority are checked before the entire batch commits. Any conflict rolls back the whole batch. Every changed task advances once; tag-only changes do not manufacture a column move, and a true no-op creates no history. Source and destination boards retain per-task immutable bulk evidence under a common operation ID. History disappears from a reader's view if any project, proxy or task referenced by that event becomes inaccessible.

Bulk preview text stays in its current view. Submitted request IDs, versions and idempotency keys remain in the verified session's memory, including in local mode; they never enter persistent browser storage or the offline outbox. Permission changes clear rendered preview content. Navigating to another view within the app or losing source-project access retains the minimal request in a workspace-wide export/discard panel, and restored access permits explicitly resuming it on the source board. A full browser reload, closed tab, sign-out or expired session clears this memory; export before leaving. The sign-out export includes these requests.

An explicit retry sends the same submitted IDs, versions and idempotency key. Saved receipts require current authority over both boards and every originally selected task, without reapplying the move or requiring the old placement to remain current. The client validates both projects and receipt versions before clearing the retained request. A late successful save clears only its matching request. Changing the board filter or reloading board data does not silently update a reviewed selection.

## Ordering, versions and evidence

Every direct workboard write includes `expectedBoardVersion`; a card move also includes `expectedTaskVersion`. Board versions cover structure, ordering and current layout inputs, including task changes and project metadata changes that affect the board. Versions advance conservatively: unrelated cards changing on the same board may require a refreshed move preview.

Moves select the destination column and start/end or a specific before/after task. The server rechecks these pins and the anchor's current destination under the writer lock. It uses the complete stored ordering, including invisible cards, rather than replacing it with a filtered list submitted by the browser. A stale, moved or unavailable anchor requires review. This deliberate conflict behavior is stricter than upstream's best-effort fallback to another anchor or the top of a column.

An actual card move advances the task once, even when it also changes project tags. The task's immutable history records the column move alongside tag changes; the board has its own immutable event stream. Column names in these events are snapshots. No-op requests still check authority and versions but do not manufacture a change.

New column-creation events also snapshot default status and the initial advisory limit. Earlier events retain only the evidence originally recorded; the application does not reconstruct missing configuration history from today's values.

Successful writes return minimal receipts with historical board/task versions. They contain no rendered board or task content. Retrying an idempotency key checks current authority before returning the original receipt, without reapplying its changes. A receipt is not a fresh editing baseline: clients reload the board explicitly. Changed CAS values, an anchor's later movement, or a later board disable do not invalidate an otherwise authorized historical receipt.

Schema 13 creates separate board, column, position and immutable-history tables. Existing workspaces receive no fabricated boards or events; preexisting entities, history and saved responses remain unchanged. The position schema permits later multiple-position support, while current operations maintain one effective position per board and task. Migration tests construct the prior schema directly, compare all prior table rows, exercise a failed migration and retry, and verify initialized boards after restart. This is application-schema coverage, not an upstream Phabricator import rehearsal.

## Permissions and pages

Reading a board requires project view permission, and each card independently requires task view permission. Viewing a board grants no access to its tasks. Moving a card requires board view and task edit permission, plus visibility of the destination proxy and any supplied relative anchor. Project edit permission is not required merely to move an editable task. Configuring the board and its columns requires project edit permission. Every write also requires a write-scoped credential.

Column lookups are scoped to the owning board. Missing and inaccessible child references produce the same generic error without declaring the visible board unavailable. Authorization is repeated after acquiring the writer lock and before replay. Fresh version, enabled-state and placement checks run after replay lookup.

Card counts and limit warnings include only visible cards matching the current query. Board and task history omit an entire event when a referenced task or proxy project is no longer visible; filtering happens before pagination. Neither responses nor counts reveal hidden ordering ranks or totals.

The API and CLI support Open (including In Progress), All, a particular owner or unassigned tasks, and Show Hidden. The browser offers All Owners, Assigned to Me and Unassigned. The default is open tasks with all owners. Card pages default to 50 and allow at most 100 cards. Follow-on pages pin the board version. Their board, column, normalized filter and access epoch must match the current view before they are appended. Permission changes clear loaded board contents even when the reader retains access to the parent project.

## Browser, voice and offline behavior

`#PROJ1/workboard` opens the project board. Desktop columns scroll within the board; mobile presents a full-width column with a chooser and previous/next controls. Move Card is an explicit touch and keyboard action with destination and relative-position controls. It does not depend on dragging or hovering.

All board writes require a live connection in this slice. Single-card move selections retain their exact board/task versions, destination and anchor. A failed or interrupted selection can be reviewed or exported; it is never automatically submitted or silently rebased by Reload Board. After a submission, Retry Submitted Move sends the same saved request and idempotency key, even when later versions have changed, to retrieve its receipt or a conflict. Preparing a replacement move remains an explicit action. Losing authority over the board, moving task, destination proxy or relative anchor holds the selection for recovery. A late successful save cannot erase a newer selection.

Cached boards are read-only offline. A cache for Open cannot answer an All query, and cached positions do not become permission to write. Local-mode caches persist within the configured workspace mount; password-mode content stays in the verified session's memory. Logout and revoked access retain unsaved work only through the existing explicit recovery/export flow.

Voice initially supports opening a visible project's workboard, for example “open workboard for PROJ1.” Spoken card mutations and summaries derived from incomplete or unrelated task lists are not implemented.

## API and command line

Shared contracts live in `shared/workboards.ts`. All routes below begin with `/api/projects/:projectId/workboard`. The base routes have no trailing slash.

| Route suffix | Contract |
| --- | --- |
| `GET` at base | `WorkboardDetail`, filtered columns and first card pages |
| `PUT` at base | `{enabled,expectedBoardVersion}` → `WorkboardReceipt` |
| `POST /columns` | `{name,pointLimit?,expectedBoardVersion}` → receipt |
| `PATCH /columns/:columnId` | `{name?,hidden?,pointLimit?,expectedBoardVersion}` → receipt; proxies permit only limit edits |
| `POST /columns/:columnId/reorder` | `{expectedBoardVersion,position}` → receipt; normal columns only |
| `POST /moves` | `{taskId,columnId,expectedBoardVersion,expectedTaskVersion,position}` → receipt |
| `GET /bulk-move-preview` | `sourceColumnId`, `destinationProjectId`, `destinationColumnId` and task filters → `WorkboardBulkMovePreview`; no pagination or `limit` |
| `POST /bulk-moves` | `BulkMoveWorkboardCardsInput` with both board versions and ordered task/version pairs → `WorkboardBulkMoveReceipt` |
| `GET /import-preview` | `sourceProjectId` query → `WorkboardImportPreview`; destination edit and source view required |
| `POST /import` | `{sourceProjectId,expectedBoardVersion,expectedSourceBoardVersion}` → receipt |
| `GET /columns/:columnId/cards` | `WorkboardCardPage`; query includes `expectedBoardVersion`, optional `after` and the original filters |
| `GET /history` | `WorkboardHistory`; exclusive `before` sequence and `limit` |

Read queries use `status=open|all`, `showHidden=true|false`, `ownerId` and `limit`. Omit `ownerId` for all owners; use the literal `null` for unassigned tasks or a principal ID for a particular owner. Duplicate and unknown query parameters are rejected. Relative positions contain exactly one before/after reference or `edge: "start"|"end"`.

`arc board PROJ1` reads the real board in column order. A visible exact name or alias may replace the ID. `--status open|all`, `--owner me|all|unassigned|USERNAME`, `--unassigned`, `--show-hidden`, `--limit N` and `--json` are supported. Without a limit it follows all column pages; a limit caps cards per column and leaves continuation cursors in JSON. If the board or access changes between pages, it fails before printing a mixed result. The command honors application path prefixes and read-only account tokens.

## Upstream evidence and remaining work

The pinned [board controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/controller/PhabricatorProjectBoardViewController.php) establishes opt-in boards, task visibility and omission of ordinary subproject proxies. The [layout engine](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/engine/PhabricatorBoardLayoutEngine.php), [column positions](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/storage/PhabricatorProjectColumnPosition.php), and [task transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/editor/ManiphestTransactionEditor.php) ground independent positions, proxy tag effects and relative ordering.

The pinned [column import controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/controller/PhabricatorProjectBoardImportController.php) copies active normal columns and their properties into an empty board. The [column model](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/storage/PhabricatorProjectColumn.php) stores default status and limits in those properties, separately from the trigger reference. Our import adds exact version checks and an explicit source-linked audit; upstream records only its hidden board-enable transaction. This UI operation does not import a historical Phabricator database.

The pinned [bulk move controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/controller/PhabricatorProjectColumnBulkMoveController.php) selects visible editable tasks, removes only the exact source project tag for cross-project moves, rejects hidden/proxy destinations, and prepends each newly moved task. Its source query can include hidden columns and disabled source boards. Our explicit bounded preview, exact version checks and whole-batch transaction are deliberate differences from upstream's sequential per-task writes. Generic bulk editing and ordinary-subproject proxy sources remain unfinished.

PROJECT-04 remains partial. Saved/default filters, grouped sorting and its field-changing drag behavior, board backgrounds, ordinary-subproject proxy bulk sources, creating or adding tasks directly from a column, drop triggers and sounds, multiple simultaneous proxy positions, durable offline move submission, drag-and-drop and Conduit/historical import compatibility remain gaps. This slice does not claim full Projects or workboard parity.

Task points and frozen open/closed status are now included in card projections. Columns show the total points of all visible cards matching the current board filter, including pages not yet loaded. Existing advisory column limits continue to count cards. General task-field bulk edits are available in Maniphest; board moves retain their own preview and history.
