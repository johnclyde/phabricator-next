# Project workboards

This document defines the PROJECT-03 workboard slice and the implemented portion of PROJECT-04. A workboard belongs to a project. Its columns and card positions are independent of task status: moving a card does not resolve, reopen, or reassign the task. The task remains the same `T` object, with the same discussion, dependencies and history. A task may have independent positions on multiple unrelated project boards.

## Enabling and arranging a board

A new project has no enabled workboard. An editor explicitly creates it, which initializes Backlog and the project's existing child proxies. Disabling a board preserves its columns, positions and history. Re-enabling restores them. Reads do not create boards, columns or positions.

Normal columns can be created, renamed, reordered and hidden. Hiding keeps their cards in place; it does not move cards into Backlog. Show Hidden reveals these columns to otherwise authorized viewers. The default Backlog column cannot be hidden. Reordering uses a relative column or an explicit start/end position, preserving columns omitted from the client's current view.

A column's optional `pointLimit` is advisory. In this slice every displayed task contributes one unit, and the warning uses only cards visible under the current filter. Zero is a real limit; null means no limit. Exceeding it does not prohibit a move. Task points and point-based presentation remain unfinished.

## Project tags and proxy columns

Board membership comes from project tags, including descendants. A direct parent tag normally puts an unpositioned task at the top of Backlog. Existing manual positions remain independent on each board. New unpositioned cards precede manually positioned cards, ordered by descending task ID.

Milestones appear as proxy columns at the end of their parent's board, in milestone-number order. Their names and archive state come from the milestone project. Renaming or archiving the milestone uses its project profile; it does not overwrite a column snapshot in old history. A proxy's advisory limit may be edited on the board, but its name and ordering are inherited. Archived milestones remain available with Show Hidden; hidden destinations cannot receive new moves.

Ordinary subproject proxies are stored but omitted from the board interface, matching the pinned upstream implementation's explicit limitation. Tasks assigned to these proxies do not spill into the parent's Backlog. Open the child's board through the subproject links instead. The parent can still have normal columns.

The current layout chooses one matching child proxy in the task's canonical project-tag order. It considers raw tags and descendants, including references hidden from the reader, before filtering the result. It does not infer membership from the reader's redacted tags. Multiple simultaneous proxy positions remain unfinished. A requested milestone move that would still resolve to a different proxy is rejected without changing the task; the error does not identify hidden tags.

Moving into a normal column adds the owning project's tag. Moving into a milestone proxy adds the milestone tag unless the task already has that proxy's tag or a descendant tag. The existing ordered tag-normalization rules resolve ancestor/descendant and same-parent milestone conflicts. These tag changes and the position change commit atomically. A card move never silently removes an unrelated ordinary subproject tag to manufacture a supported layout.

## Ordering, versions and evidence

Every direct workboard write includes `expectedBoardVersion`; a card move also includes `expectedTaskVersion`. Board versions cover structure, ordering and current layout inputs, including task changes and project metadata changes that affect the board. Versions advance conservatively: unrelated cards changing on the same board may require a refreshed move preview.

Moves select the destination column and start/end or a specific before/after task. The server rechecks these pins and the anchor's current destination under the writer lock. It uses the complete stored ordering, including invisible cards, rather than replacing it with a filtered list submitted by the browser. A stale, moved or unavailable anchor requires review. This deliberate conflict behavior is stricter than upstream's best-effort fallback to another anchor or the top of a column.

An actual card move advances the task once, even when it also changes project tags. The task's immutable history records the column move alongside tag changes; the board has its own immutable event stream. Column names in these events are snapshots. No-op requests still check authority and versions but do not manufacture a change.

Successful writes return minimal receipts with historical board/task versions. They contain no rendered board or task content. Retrying an idempotency key checks current authority before returning the original receipt, without reapplying its changes. A receipt is not a fresh editing baseline: clients reload the board explicitly. Changed CAS values, an anchor's later movement, or a later board disable do not invalidate an otherwise authorized historical receipt.

Schema 13 creates separate board, column, position and immutable-history tables. Existing workspaces receive no fabricated boards or events; preexisting entities, history and saved responses remain unchanged. The position schema permits later multiple-position support, while current operations maintain one effective position per board and task. Migration tests construct the prior schema directly, compare all prior table rows, exercise a failed migration and retry, and verify initialized boards after restart. This is application-schema coverage, not an upstream Phabricator import rehearsal.

## Permissions and pages

Reading a board requires project view permission, and each card independently requires task view permission. Viewing a board grants no access to its tasks. Moving a card requires board view and task edit permission, plus visibility of the destination proxy and any supplied relative anchor. Project edit permission is not required merely to move an editable task. Configuring the board and its columns requires project edit permission. Every write also requires a write-scoped credential.

Column lookups are scoped to the owning board. Missing and inaccessible child references produce the same generic error without declaring the visible board unavailable. Authorization is repeated after acquiring the writer lock and before replay. Fresh version, enabled-state and placement checks run after replay lookup.

Card counts and limit warnings include only visible cards matching the current query. Board and task history omit an entire event when a referenced task or proxy project is no longer visible; filtering happens before pagination. Neither responses nor counts reveal hidden ordering ranks or totals.

The API and CLI support Open (including In Progress), All, a particular owner or unassigned tasks, and Show Hidden. The browser offers All Owners, Assigned to Me and Unassigned. The default is open tasks with all owners. Card pages default to 50 and allow at most 100 cards. Follow-on pages pin the board version. Their board, column, normalized filter and access epoch must match the current view before they are appended. Permission changes clear loaded board contents even when the reader retains access to the parent project.

## Browser, voice and offline behavior

`#PROJ1/workboard` opens the project board. Desktop columns scroll within the board; mobile presents a full-width column with a chooser and previous/next controls. Move Card is an explicit touch and keyboard action with destination and relative-position controls. It does not depend on dragging or hovering.

All board writes require a live connection in this slice. Move selections retain their exact board/task versions, destination and anchor. A failed or interrupted selection can be reviewed or exported; it is never automatically submitted or silently rebased by Reload Board. After a submission, Retry Submitted Move sends the same saved request and idempotency key, even when later versions have changed, to retrieve its receipt or a conflict. Preparing a replacement move remains an explicit action. Losing authority over the board, moving task, destination proxy or relative anchor holds the selection for recovery. A late successful save cannot erase a newer selection.

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
| `GET /columns/:columnId/cards` | `WorkboardCardPage`; query includes `expectedBoardVersion`, optional `after` and the original filters |
| `GET /history` | `WorkboardHistory`; exclusive `before` sequence and `limit` |

Read queries use `status=open|all`, `showHidden=true|false`, `ownerId` and `limit`. Omit `ownerId` for all owners; use the literal `null` for unassigned tasks or a principal ID for a particular owner. Duplicate and unknown query parameters are rejected. Relative positions contain exactly one before/after reference or `edge: "start"|"end"`.

`npm run arc -- board PROJ1` reads the real board in column order. A visible exact name or alias may replace the ID. `--status open|all`, `--owner me|all|unassigned|USERNAME`, `--unassigned`, `--show-hidden`, `--limit N` and `--json` are supported. Without a limit it follows all column pages; a limit caps cards per column and leaves continuation cursors in JSON. If the board or access changes between pages, it fails before printing a mixed result. The command honors application path prefixes and read-only account tokens.

## Upstream evidence and remaining work

The pinned [board controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/controller/PhabricatorProjectBoardViewController.php) establishes opt-in boards, task visibility and omission of ordinary subproject proxies. The [layout engine](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/engine/PhabricatorBoardLayoutEngine.php), [column positions](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/storage/PhabricatorProjectColumnPosition.php), and [task transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/editor/ManiphestTransactionEditor.php) ground independent positions, proxy tag effects and relative ordering.

PROJECT-04 remains partial. Saved/default filters, grouped sorting and its field-changing drag behavior, board backgrounds, column import/default cloning, cross-project bulk moves, creating or adding tasks directly from a column, drop triggers and sounds, task points, multiple simultaneous proxy positions, durable offline move submission, drag-and-drop and Conduit/import compatibility remain gaps. This slice does not claim full Projects or workboard parity.
