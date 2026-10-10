# Maniphest tasks

Tasks have individual `#T123` pages, versioned fields, append-only discussion and structured transaction history. The same task can be opened from lists, project pages, activity, the CLI, or a command such as “open task 123.” This is a partial Maniphest implementation; the remaining upstream capabilities are listed below.

## Fields, discussion and history

Title, description, status, priority and project changes record exact old/new values, the acting principal and credential, and the resulting task version. One field-update request commits one transaction. Description history can be compared as plain text. Updates require `expectedVersion`; a stale editor receives a conflict instead of overwriting newer work. An unchanged update creates no additional history or version.

Comments are immutable, attributed transactions requiring interact permission. Posting a comment does not require an edit version and does not change task fields. History has its own increasing sequence, distinct from the task version, so independent comments can coexist. Reads are newest first with an exclusive sequence cursor; older history remains available through pagination. Generic workspace activity is a summary, while task transactions retain the detailed evidence.

Schema 7 adds task history and dependency storage. Existing tasks gain version 1 and an explicit legacy baseline of their latest known fields. The baseline records the migration time and an unknown actor; it does not invent older edits or authors from activity prose. Existing source versions, review discussions, policies and saved mutation responses remain intact. Back up the database before upgrading; older binaries refuse the new schema.

## Dependencies

Adding “A depends on B” also makes A appear in B's “blocks” list. The server stores one directed edge and derives its inverse. Edges are added or removed individually, so a filtered client never replaces relationships it cannot see. Relationship changes record transactions and advance the versions of both endpoints atomically. Resolving or reopening B records its status change in dependent task history; A retains its own status.

The caller needs current edit access to A and view access to B. The inverse relationship is a consequence of that operation, not permission to edit B's fields. Self-dependencies, duplicate additions, missing removals and cycles fail explicitly. Cycle detection runs under the writer lock across the complete stored graph, including hidden intermediate tasks. Errors never reveal a hidden path. Concurrent opposite-edge additions cannot both succeed.

Task pages show **visible dependencies**, their current statuses and the inverse links. A filtered list is not evidence that every dependency is finished. Closing a task is an explicit status change; dependency completion neither automatically closes a parent nor prohibits manually closing it. Dependency changes require a live connection and are never queued offline.

## Access and offline behavior

Task details, comments, history, related task references and saved retries use current object and Space policies. Hidden related tasks are removed from dependency lists and relationship transactions before history pagination. Historical project values are redacted when the project is unavailable, without changing the stored evidence. Activity for relationship operations avoids embedding related task names or identifiers in free text.

Policy changes invalidate task-detail caches and in-flight task reads, including still-visible parents that previously contained a now-hidden dependency. Pages discard those rendered snapshots before reloading. Independently composed drafts remain available through the existing export/discard recovery flow. Protected workspaces keep drafts in verified tab memory; local workspaces can retain them on the device.

Field drafts keep their original expected version, and comment drafts retain their task identity. Local-mode field updates and comments may be queued; stale updates stop for attention rather than silently adopting the latest version. Pre-schema-7 queued task updates have no concurrency evidence and are held for explicit export/discard. Late saves cannot erase a newer draft created while a request was in flight.

## API and CLI

- `POST /api/tasks` takes `TaskInput` and returns `201 Task`.
- `GET /api/tasks/:id` returns `TaskDetail`, including the first history page and visible dependency references.
- `PATCH /api/tasks/:id` takes `UpdateTaskInput` with `expectedVersion` and returns `Task`.
- `POST /api/tasks/:id/comments` takes `{body}` and returns `201 TaskTransaction`.
- `POST /api/tasks/:id/dependencies` takes `{taskId, action: "add" | "remove", expectedVersion}` and returns `TaskDetail`.
- `GET /api/tasks/:id/history?before=N&limit=N` returns `TaskHistory`; default 50, maximum 100, exclusive `before` cursor. Responses include the current access epoch.

Successful writes support the ordinary principal-scoped idempotency contract. Replays are filtered using current access while preserving their historical content; they do not borrow current fields or relationships. Historical task responses predating versioning are not assigned a fabricated current version.

`npm run arc -- tasks` lists visible open and in-progress tasks, ordered by priority. `--status closed|all`, `--order priority|created|modified`, `--limit N` and `--json` are supported. `npm run arc -- show T123` prints the task detail and first history page. The server URL preserves configured path prefixes, and password workspaces require a scoped environment token. Assignment filters and full Arcanist/Conduit compatibility remain unfinished.

## Upstream evidence and remaining work

The pinned upstream [task detail controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/controller/ManiphestTaskDetailController.php) exposes task details, comments, a transaction timeline and a graph. The [dependency edge type](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/edge/ManiphestTaskDependsOnTaskEdgeType.php) defines inverse edges and cycle prevention. The [description transaction](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/xaction/ManiphestTaskDescriptionTransaction.php) retains old/new text; the [transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/editor/ManiphestTransactionEditor.php) records subtask status changes on parents. Source-edit/destination-view authorization follows the [relationship contract](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/search/relationship/PhabricatorObjectRelationship.php).

TASK-01, TASK-02 and P302 remain partial. Assignment, subscribers, multiple project tags, configurable statuses/priorities/forms/fields, duplicate merging and redirects, workboards, bulk edits, comment revisions/removal, edit/comment locks, reporting, attachments, mentions, notifications, full graph browsing and import/export compatibility are not established by this slice. Upstream [comment editing](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/controller/PhabricatorApplicationTransactionCommentEditController.php) is a separate workflow; the current append-only comments do not implement it.
