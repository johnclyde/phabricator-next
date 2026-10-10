# Maniphest tasks

Tasks have individual `#T123` pages, versioned fields, append-only discussion and structured transaction history. The same task can be opened from lists, project pages, activity, the CLI, or a command such as “open task 123.” This is a partial Maniphest implementation; the remaining upstream capabilities are listed below.

## Fields, discussion and history

Title, description, status, priority, project and owner changes record exact old/new values, the acting principal and credential, and the resulting task version. One field-update request commits one transaction. Description history can be compared as plain text. Updates require `expectedVersion`; a stale editor receives a conflict instead of overwriting newer work. An unchanged update creates no additional history or version. Authorship is recorded from the authenticated creation request and cannot be changed through task editing.

Comments are immutable, attributed transactions requiring interact permission. Posting a comment does not require an edit version and does not change task fields. History has its own increasing sequence, distinct from the task version, so independent comments can coexist. Reads are newest first with an exclusive sequence cursor; older history remains available through pagination. Generic workspace activity is a summary, while task transactions retain the detailed evidence.

Schema 7 adds task history and dependency storage. Existing tasks gain version 1 and an explicit legacy baseline of their latest known fields. The baseline records the migration time and an unknown actor; it does not invent older edits or authors from activity prose. Existing source versions, review discussions, policies and saved mutation responses remain intact. Back up the database before upgrading; older binaries refuse the new schema.

Schema 8 adds owner/author metadata and subscription preferences. Existing tasks start unassigned. An author is recovered only from an attributable original creation transaction whose identity, version and creation timestamp match the task; otherwise authorship remains unknown. This migration does not subscribe historical actors or rewrite old versions, snapshots or saved responses. A historical snapshot lacking ownership metadata means it was not recorded, rather than proving the task was unassigned then.

## Assignment and subscriptions

A task has one owner or is unassigned. Like upstream Maniphest, its owner automatically has view, edit and interact access, including access-rule editing, provided the owner can view the containing Space. Assignment cannot widen Space visibility. Editors may assign an enabled member even when that member cannot currently view the task or Space. Assignment controls explain this access effect; there is no administrator or author bypass.

Creators subscribe explicitly; current owners follow automatically. Reassigning a task subscribes the former owner explicitly. A first comment subscribes its author only if they have no saved preference and are not already following automatically. An explicit unsubscribe persists across later comments. The current owner cannot unsubscribe while ownership makes following automatic; upstream mute behavior remains unfinished.

Any viewer can change their own subscription. Adding another member requires edit or interact access; removing another member requires edit access. Subscription preferences have separate optimistic versions, so they do not invalidate task field drafts. Actual preference changes append attributed transactions; repeated unchanged requests create no extra events. Membership does not grant access or send content. This slice records following preferences; notification and mail delivery are still unimplemented.

Owner changes and subscription changes require a live connection. Ordinary field and comment drafts retain their existing offline behavior. If a successful reassignment removes the editor's own view access, the server returns only a saved acknowledgement and the browser clears the task view while holding other drafts for recovery. Saved retries still require current authority; an old response never restores access.

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
- `PATCH /api/tasks/:id` takes `UpdateTaskInput` with `expectedVersion` and returns `Task`, or `{id,saved:true,accessLost:true,accessEpoch}` after a fresh authorized owner change removes the caller's view access.
- `POST /api/tasks/:id/comments` takes `{body}` and returns `201 TaskTransaction`.
- `POST /api/tasks/:id/dependencies` takes `{taskId, action: "add" | "remove", expectedVersion}` and returns `TaskDetail`.
- `GET /api/tasks/:id/history?before=N&limit=N` returns `TaskHistory`; default 50, maximum 100, exclusive `before` cursor. Responses include the current access epoch.
- `GET /api/tasks/:id/subscriptions?after=PRINCIPAL&limit=N` returns effective subscribers, the viewer's status and a next cursor; default 50, maximum 100, exclusive principal-ID ordering.
- `GET /api/tasks/:id/subscriptions/:principalId` returns one preference, including version 0 for an absent preference, automatic following and effective subscription state.
- `POST /api/tasks/:id/subscriptions` takes `{principalId,action:"subscribe"|"unsubscribe",expectedMembershipVersion}` and returns the resulting status. Membership reads and write presentations include the current access epoch.

Successful writes support the ordinary principal-scoped idempotency contract. Replays are filtered using current access while preserving their historical content; they do not borrow current fields or relationships. Historical task responses predating versioning are not assigned a fabricated current version.

`npm run arc -- tasks` lists your assigned open and in-progress tasks, ordered by priority. `--owner all|me|unassigned|USERNAME`, `--unassigned` and `--subscribed` filter visible results; combine `--owner all --subscribed` to include tasks you follow that are assigned to others. A principal ID or `user:USERNAME` can disambiguate reserved owner names. `--status closed|all`, `--order priority|created|modified`, `--limit N` and `--json` are supported. `npm run arc -- show T123` prints the task detail and first history page. The server URL preserves configured path prefixes, and password workspaces require a scoped environment token. Full Arcanist/Conduit compatibility remains unfinished.

## Upstream evidence and remaining work

The pinned upstream [task detail controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/controller/ManiphestTaskDetailController.php) exposes task details, comments, a transaction timeline and a graph. The [dependency edge type](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/edge/ManiphestTaskDependsOnTaskEdgeType.php) defines inverse edges and cycle prevention. The [description transaction](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/xaction/ManiphestTaskDescriptionTransaction.php) retains old/new text; the [transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/editor/ManiphestTransactionEditor.php) records subtask status changes on parents. Source-edit/destination-view authorization follows the [relationship contract](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/search/relationship/PhabricatorObjectRelationship.php).

Owner access and automatic following are defined by the upstream [task object](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/storage/ManiphestTask.php). The [subscription editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/subscriptions/editor/PhabricatorSubscriptionsEditor.php) distinguishes explicit subscriptions from implicit following and preserved opt-outs.

TASK-01, TASK-02, TASK-04 and P302 remain partial. Multiple project tags, configurable statuses/priorities/forms/fields, duplicate merging, workboards, bulk edits, comment revisions/removal, edit/comment locks, reporting, attachments, mentions, project subscribers, mute, notification delivery, auto-claim on closure, full graph browsing and import/export compatibility are not established by this slice. Upstream [comment editing](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/controller/PhabricatorApplicationTransactionCommentEditController.php) is a separate workflow; the current append-only comments do not implement it.
