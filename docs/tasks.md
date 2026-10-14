# Maniphest tasks

Tasks have individual `#T123` pages, versioned fields, append-only discussion and structured transaction history. The same task can be opened from lists, project pages, activity, the CLI, or a command such as “open task 123.” This is a partial Maniphest implementation; the remaining upstream capabilities are listed below.

## Fields, discussion and history

Title, description, status, priority, owner, points and custom-field changes record exact old/new values, the acting principal and credential, and the resulting task version. One field-update request commits one transaction. Description history can be compared as plain text. Updates require `expectedVersion`; a stale editor receives a conflict instead of overwriting newer work. An unchanged update creates no additional history or version. Authorship is recorded from the authenticated creation request and cannot be changed through task editing.

F026 adds [core formatted descriptions](remarkup.md) to the current task reader and expanded task-list rows. Closed list descriptions do not mount or parse a reader. Exact source and copying remain available; history and editing preserve literal text. Description mentions remain plain syntax without resolving people, subscribing anyone or sending notifications. The existing offline and permission boundaries remain in force.

Comments are immutable, attributed transactions requiring interact permission. Posting a comment does not require an edit version and does not change task fields. History has its own increasing sequence, distinct from the task version, so independent comments can coexist. Reads are newest first with an exclusive sequence cursor; older history remains available through pagination. Generic workspace activity is a summary, while task transactions retain the detailed evidence.

Schema 7 adds task history and dependency storage. Existing tasks gain version 1 and an explicit legacy baseline of their latest known fields. The baseline records the migration time and an unknown actor; it does not invent older edits or authors from activity prose. Existing source versions, review discussions, policies and saved mutation responses remain intact. Back up the database before upgrading; older binaries refuse the new schema.

Schema 8 adds owner/author metadata and subscription preferences. Existing tasks start unassigned. An author is recovered only from an attributable original creation transaction whose identity, version and creation timestamp match the task; otherwise authorship remains unknown. This migration does not subscribe historical actors or rewrite old versions, snapshots or saved responses. A historical snapshot lacking ownership metadata means it was not recorded, rather than proving the task was unassigned then.

Schema 9 adds immutable duplicate relationships. Existing tasks and all prior transaction, subscription and replay records are preserved; no duplicates are inferred from titles or comments.

Schema 10 adds task/project tag relationships. Each existing scalar project association becomes one edge. The migration does not change existing entity bytes, versions, timestamps, histories, subscriptions or saved responses, and does not invent tag-edit transactions.

## Task configuration, forms and points

Schema 44 adds versioned Maniphest configuration and immutable configuration history. It leaves prior tasks, histories and saved replies intact. An operator can designate task administrators with `APP_MANIPHEST_ADMIN_PRINCIPAL_IDS` (a JSON array); local single-user mode can configure directly. Administration does not grant view or edit permission on tasks.

**Configure Tasks** manages named statuses with open/closed meaning, named priorities with sort ranks, text/integer/yes-no/select fields, and named creation forms with selected fields and default values. Existing keys, field types, select options and status open/closed meanings cannot be removed or reinterpreted. Disable retired choices instead. `open`, `duplicate`, `normal` and the default form remain available; entering `duplicate` requires the merge workflow. Existing tasks may retain disabled choices. Their ordinary unrelated edits continue to work when an administrator adds a newly required field; new tasks and explicitly cleared required values must satisfy the new requirement. Custom-field patches preserve omitted values, including retired fields.

Every new task/status edit records `statusClosed` alongside its status. Merging sets it true and reopening sets it from the chosen status. This keeps open/closed filtering consistent for custom statuses, workboards, CLI lists and reports. Historical responses are never filled with current configuration metadata.

Points are optional nonnegative numbers with up to two decimal places. Task details and history show them; the report groups current visible tasks and points by status, priority, owner or visible project. Optional creation-date, status and project filters apply before aggregation. Multi-project rows may count a task several times; the overall total counts it once. Reports use current access and Space ceilings, contain no hidden-task counts, and can be exported. Historical burnup/burndown, closure timestamps, velocity and time tracking remain separate gaps.

Creation and editing drafts retain their original task/configuration versions. A changed configuration requires an explicit review of the current form. Forms customize the interface and initial values; they are not additional task permissions. Administrators configure the workspace, while ordinary editors use the forms and edit fields under the task's existing policies.

## General bulk editing

**Bulk Edit** selects exact currently visible editable tasks and previews old/new values before applying. The API accepts multiple changes to status, priority, owner, points and custom fields in one atomic request; the UI previews one selected field at a time. It does not implicitly include tasks that appear later or silently drop denied tasks.

The submitted task versions, task-configuration version and access epoch are checked under the writer lock. A stale or unauthorized task aborts the whole batch, including task history, subscriptions, dependency status effects, notifications and board updates. Status changes may advance other selected tasks through their dependency relationship; these in-transaction advances do not make the reviewed batch spuriously stale. All ordinary task edit semantics remain in effect. Up to 1,000 tasks may be submitted per transaction; this operational batch size is unrelated to revision suggestions.

Bulk actions require a connection. The exact request and retry key are retained for explicit recovery after an unknown response, and reconnecting never submits it automatically. Receipts contain operation identity and resulting task versions, without task content. Replays recheck current authority. Project-tag bulk edits, bulk comments, subscriber operations and arbitrary task deletion remain unimplemented.

## Project tags

A task can have several project tags. Current task responses expose `projectIds`; each project lists and counts only tasks the viewer can see. Tags organize work without granting task access, project membership or subscription. The typed or spoken command “show tasks in project NAME” opens the matching visible project filter; unavailable or ambiguous names are not resolved. Task creation accepts `projectIds`, or the deprecated `projectId` alias for one initial tag, never both. Revision project fields remain unchanged.

**Add** keeps existing nonconflicting tags and then applies submitted tags in their original order. A later tag replaces any earlier ancestor or descendant, and replaces an earlier milestone with the same parent. Ordinary siblings and milestones with different parents may coexist. These conflict rules apply even when an old conflicting tag is hidden, so the form always explains the possible replacement without revealing hidden identities or counts. **Remove** changes only the explicitly submitted associations and preserves other tags. **Replace All Project Tags** deliberately replaces the complete set; omitted tags are removed even when they are hidden. The confirmation always explains that effect, regardless of whether hidden tags exist. An empty replacement clears all tags. Creation and replacement use the same last-input-wins normalization. The final stored IDs are canonicalized only after resolving conflicts; sorting the submitted IDs first would change the result.

Each request names an action, up to 100 unique project IDs and the task's `expectedVersion`. Task edit access and visibility of every explicitly submitted project are required when the write commits and when a saved result is replayed. Project edit permission is unnecessary, and a full replacement does not require visibility of implicitly removed old tags. Invalid references receive the same generic error whether missing or hidden. A stale task version aborts without partial changes.

An actual change advances the task once and writes one immutable transaction per added or removed project, grouped by operation identifier. Unchanged operations still check the version but create no new version, history or activity. Reads filter tag relationships and transactions using current visibility before history pagination. Generic activity contains no project identifiers or names. Saved retries retain their original evidence instead of borrowing current tags; old task responses derive an array only from their own saved scalar field. Stored history and response bytes remain unchanged.

Tag drafts retain their original task version. Local workspaces can queue explicit tag changes offline; conflicts stop for review on reconnection. Password workspaces require reconnection to submit and retain drafts only in the verified tab. Fresh scalar project patches are rejected rather than reinterpreted as replacements. Older field drafts and queued patches that actually change the scalar project field are held whole for export or discard, including other edits in the same request. Unrelated field drafts remain usable. Existing queued task creation can still use the creation alias.

## Workboard positions

[Project workboards](workboards.md) organize the same tasks in columns independently of status and priority. A task can occupy different columns on different project boards. A move may normalize project tags to enter a normal or milestone column; tags, position, immutable column snapshots and the single task-version increment commit together. It never automatically resolves or reassigns the task.

Move Card requires a live connection and pins both the board and task versions. Its retained selection is separate from ordinary offline task/tag drafts. A competing move or relevant task update requires a new reviewed selection; the client does not silently replace its saved versions. Current access filters column history, including the owning board and source/destination proxy references.

## Assignment and subscriptions

A task has one owner or is unassigned. Like upstream Maniphest, its owner automatically has view, edit and interact access, including access-rule editing, provided the owner can view the containing Space. Assignment cannot widen Space visibility. Editors may assign an enabled member even when that member cannot currently view the task or Space. Assignment controls explain this access effect; there is no administrator or author bypass.

Creators subscribe explicitly; current owners follow automatically. Reassigning a task subscribes the former owner explicitly. A first comment subscribes its author only if they have no saved preference and are not already following automatically. An explicit unsubscribe persists across that person's later comments. A new
[mention by an authorized commenter](mentions.md) explicitly subscribes the
mentioned person even after an opt-out; current owners and existing followers
need no new preference, and private mute remains effective. The current owner cannot unsubscribe while ownership makes following automatic; private [task mute](task-notifications.md) can silence delivery without giving up ownership.

Any viewer can change their own subscription. Adding another member requires edit or interact access; removing another member requires edit access. Subscription preferences have separate optimistic versions, so they do not invalidate task field drafts. Actual preference changes append attributed transactions; repeated unchanged requests create no extra events. Membership does not grant access or send content. The private notification inbox now delivers visible task changes to current followers and tagged-project watchers. Mail delivery remains unfinished.

Owner changes and subscription changes require a live connection. Ordinary field and comment drafts retain their existing offline behavior. If a successful reassignment removes the editor's own view access, the server returns only a saved acknowledgement and the browser clears the task view while holding other drafts for recovery. Saved retries still require current authority; an old response never restores access.

## Notifications

[Task notification contracts](task-notifications.md) define the event matrix,
private mute history, exact retry recovery, mobile/offline controls and API/CLI.
Task and revision events share one personal inbox. Notification and preference
writes commit atomically with their evidence, and current access applies on
every read and replay. Schema 32 adds private task mute storage without backfill
or rewriting earlier task, source or revision-notification evidence.

## Dependencies

Adding “A depends on B” also makes A appear in B's “blocks” list. The server stores one directed edge and derives its inverse. Edges are added or removed individually, so a filtered client never replaces relationships it cannot see. Relationship changes record transactions and advance the versions of both endpoints atomically. Resolving or reopening B records its status change in dependent task history; A retains its own status.

The caller needs current edit access to A and view access to B. The inverse relationship is a consequence of that operation, not permission to edit B's fields. Self-dependencies, duplicate additions, missing removals and cycles fail explicitly. Cycle detection runs under the writer lock across the complete stored graph, including hidden intermediate tasks. Errors never reveal a hidden path. Concurrent opposite-edge additions cannot both succeed.

Task pages show **visible dependencies**, their current statuses and the inverse links. A filtered list is not evidence that every dependency is finished. Closing a task is an explicit status change; dependency completion neither automatically closes a parent nor prohibits manually closing it. Dependency changes require a live connection and are never queued offline.

## Duplicate merging

**Close As Duplicate** closes the current task as a duplicate of a selected destination. **Merge Duplicates In** closes one or more selected tasks into the current task, with up to 100 sources per atomic request. Both actions require current view and edit access on every endpoint. Selectors start with open tasks and can include closed tasks; the server does not require an open status. The confirmation retains the versions selected for every task. A stale version or unavailable endpoint aborts the entire operation.

Each source keeps its own URL, description, author, owner, comments, source subscription preferences and dependency relationships. Its status becomes `duplicate`, and it receives a visible destination link and an attributed merge transaction. The destination keeps its current fields and status, gains inverse links and merge history, and explicitly subscribes the sources' authors, owners and effective subscribers. These explicit additions override destination opt-outs; they do not grant anyone access. The initiating actor is not subscribed merely for merging. The inbox sends one event per source and destination after carryover; a private mute on the destination still suppresses delivery.

There is no canonical-task redirect or automatic content migration. Duplicate links are durable directed relationships: a task may have several merge destinations, and duplicate cycles are allowed, as in the pinned upstream edge contract. A self-merge is rejected. Reopening a duplicate keeps its merge links and history; ordinary task editing cannot newly enter duplicate status. A fresh explicit merge into an existing destination can close it again and carry current followers over. That operation records new merge history while preserving the original link record; a saved idempotent retry never repeats those effects. Dependency cycles remain prohibited independently.

All affected tasks advance once per merge operation, even when a task is also a dependent parent or depends on multiple merged sources. The source and destination transactions share an operation identifier. This implementation also records source status changes in dependent parent history, preserving the existing task-history invariant; upstream's merge-specific transaction does not produce its ordinary status-transaction parent notification. Parent status itself is unchanged unless that parent is explicitly selected as a source.

Merging requires a live connection and is never queued. Visible links and merge history respect current access, including filtered history pagination and historical mutation retries. A saved retry rechecks edit access on every original endpoint and never repeats follower additions or borrows newer links. Pre-schema-9 saved detail responses may present empty duplicate lists as their historical state, without rewriting stored response bytes.

## Access and offline behavior

Task details, comments, history, related task references and saved retries use current object and Space policies. Hidden related tasks and projects are removed from relationship lists and transactions before history pagination. Historical project values are redacted when the project is unavailable, without changing the stored evidence. Activity for relationship operations avoids embedding related task names or identifiers in free text.

Policy changes invalidate task-detail caches and in-flight task reads, including still-visible parents that previously contained a now-hidden dependency. Pages discard those rendered snapshots before reloading. Independently composed drafts remain available through the existing export/discard recovery flow. Protected workspaces keep drafts in verified tab memory; local workspaces can retain them on the device.

Field drafts keep their original expected version, and comment drafts retain their task identity. Local-mode field updates, tag changes and comments may be queued; stale updates stop for attention rather than silently adopting the latest version. Pre-schema-7 queued task updates have no concurrency evidence and are held for explicit export/discard. Late saves cannot erase a newer draft created while a request was in flight.

## API and CLI

- `GET /api/maniphest/config` returns the current configuration and whether the caller may configure it.
- `PUT /api/maniphest/config` takes `expectedVersion`, `statuses`, `priorities`, `fields` and `forms`; requires a task administrator and retry key.
- `GET /api/maniphest/config/history?before=N` returns up to 50 older configurations to a task administrator.
- `POST /api/maniphest/bulk/preview` takes `{expectedConfigVersion, expectedAccessEpoch, tasks:[{id,expectedVersion}], changes}` and returns a side-effect-free old/new preview.
- `POST /api/maniphest/bulk` takes that same reviewed input plus a retry key and commits all selected edits atomically.
- `GET /api/maniphest/report?groupBy=status|priority|owner|project` accepts optional `status`, `ownerId`, `projectId`, `createdAfter` and `createdBefore` filters (dates use `YYYY-MM-DD`).
- Task creation additionally accepts `formKey`, `expectedConfigVersion`, `points` and `customFields`; ordinary field edits accept the latter three. Defaults are applied before validation.

- `POST /api/tasks` takes `TaskInput` and returns `201 Task`.
- `GET /api/tasks/:id` returns `TaskDetail`, including the first history page, visible dependency references, `duplicateOf` destinations and `duplicates` sources.
- `PATCH /api/tasks/:id` takes `UpdateTaskInput` with `expectedVersion` and returns `Task`, or `{id,saved:true,accessLost:true,accessEpoch}` after a fresh authorized owner change removes the caller's view access.
- `POST /api/tasks/:id/projects` takes `{action: "add" | "remove" | "set", projectIds: [], expectedVersion}` and returns `TaskDetail`. Project fields are not accepted by fresh ordinary task patches.
- `POST /api/tasks/:id/comments` takes `{body}` and returns `201 TaskTransaction`.
- `POST /api/tasks/:id/dependencies` takes `{taskId, action: "add" | "remove", expectedVersion}` and returns `TaskDetail`.
- `POST /api/tasks/:sourceId/merge` takes `{taskId: destinationId, expectedVersion, expectedTargetVersion}` and returns the source's `TaskDetail`.
- `POST /api/tasks/:destinationId/merge-in` takes `{sources: [{taskId, expectedVersion}], expectedVersion}` and returns the destination's `TaskDetail`. The outer version belongs to the destination; every source has its own expected version.
- `GET /api/tasks/:id/history?before=N&limit=N` returns `TaskHistory`; default 50, maximum 100, exclusive `before` cursor. Responses include the current access epoch.
- `GET /api/tasks/:id/subscriptions?after=PRINCIPAL&limit=N` returns effective subscribers, the viewer's status and a next cursor; default 50, maximum 100, exclusive principal-ID ordering.
- `GET /api/tasks/:id/subscriptions/:principalId` returns one preference, including version 0 for an absent preference, automatic following and effective subscription state.
- `POST /api/tasks/:id/subscriptions` takes `{principalId,action:"subscribe"|"unsubscribe",expectedMembershipVersion}` and returns the resulting status. Membership reads and write presentations include the current access epoch.

Successful writes support the ordinary principal-scoped idempotency contract. Replays are filtered using current access while preserving their historical content; they do not borrow current fields or relationships. Historical task responses predating versioning are not assigned a fabricated current version.

`arc tasks` lists your assigned open and in-progress tasks, ordered by priority. `--owner all|me|unassigned|USERNAME`, `--unassigned` and `--subscribed` filter visible results; combine `--owner all --subscribed` to include tasks you follow that are assigned to others. A principal ID or `user:USERNAME` can disambiguate reserved owner names. `--project ID|NAME|ALIAS` matches a visible project ID, exact name or normalized alias (optionally prefixed with `#`); each filter includes visible descendants, and repeated filters require a matching tag in every selected subtree. A qualified milestone display name can disambiguate repeated names. Hidden and missing project filters fail alike. `--status closed|all` (closed includes resolved tasks and duplicates), `--order priority|created|modified`, `--limit N` and `--json` are supported. `arc show T123` prints the task detail and first history page. The server URL preserves configured path prefixes, and password workspaces require a scoped environment token. Full Arcanist/Conduit compatibility remains unfinished.

## Upstream evidence and remaining work

The pinned upstream [task detail controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/controller/ManiphestTaskDetailController.php) exposes task details, comments, a transaction timeline and a graph. The [dependency edge type](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/edge/ManiphestTaskDependsOnTaskEdgeType.php) defines inverse edges and cycle prevention. The [description transaction](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/xaction/ManiphestTaskDescriptionTransaction.php) retains old/new text; the [transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/editor/ManiphestTransactionEditor.php) records subtask status changes on parents. Source-edit/destination-view authorization follows the [relationship contract](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/search/relationship/PhabricatorObjectRelationship.php).

Owner access and automatic following are defined by the upstream [task object](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/storage/ManiphestTask.php). The [subscription editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/subscriptions/editor/PhabricatorSubscriptionsEditor.php) distinguishes explicit subscriptions from implicit following and preserved opt-outs.

The duplicate workflows follow the pinned [merge helpers](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/relationship/ManiphestTaskRelationship.php), [close-as-duplicate action](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/relationship/ManiphestTaskCloseAsDuplicateRelationship.php), [merge-in action](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/relationship/ManiphestTaskMergeInRelationship.php), and [duplicate edge](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/edge/ManiphestTaskIsDuplicateOfTaskEdgeType.php). Configurable duplicate-status identities, closure timestamps/historical reporting and Conduit interoperability remain gaps.

Project tags follow the pinned [project edit extension](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/engineextension/PhabricatorProjectsEditEngineExtension.php) and [ordinary form delta semantics](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editfield/PhabricatorPHIDListEditField.php). The upstream [transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php) replaces the complete stored edge set for an explicit set operation. This implementation deliberately requires visibility of submitted projects, whereas upstream can accept raw PHIDs without a project-view check; it also omits hidden tag transactions instead of showing upstream's restricted placeholders and counts. Project profiles and membership are implemented as a separate [project slice](projects.md). Ancestor/descendant and same-parent milestone tag conflicts follow upstream transaction order. [Workboard moves](workboards.md) change tags and positions atomically and record column snapshots in task history. Project-driven policies/subscriptions on tagged objects, remaining bulk relationship operations and Conduit compatibility remain unfinished.

TASK-01, TASK-02, TASK-04 and P302 remain partial. Remaining workboard capabilities, bulk relationship/comment operations, comment revisions/removal, edit/comment locks, historical reporting, attachments, mentions outside comments, collective project subscribers, mail/push delivery, auto-claim on closure, full graph browsing and import/export compatibility are not established by this slice. Upstream [comment editing](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/controller/PhabricatorApplicationTransactionCommentEditController.php) is a separate workflow; the current append-only comments do not implement it.

Task configuration follows the pinned [status constants](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/constants/ManiphestTaskStatus.php), [priority constants](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/constants/ManiphestTaskPriority.php), [configured custom fields](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/field/ManiphestConfiguredCustomField.php), and [edit engine](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/editor/ManiphestEditEngine.php). This implements the core configurable field/form workflow; upstream custom field extensions, fine-grained per-form policies, task templates, and transaction-specific edit/comment locks remain gaps.
