# Task notifications and private mute

NOTIFY-02 adds task events to the shared [notification inbox](notifications.md).
Task notifications follow the pinned Maniphest recipient and transaction rules.
This is a bounded in-app delivery slice; email, live push, mentions outside comments, Herald and
the remaining task workflows are still separate parity targets.

## Recipients and causes

Current owners follow automatically. Creators explicitly subscribe at creation,
former owners explicitly subscribe on reassignment, and first comments subscribe
their author only when no prior preference exists. An author who unsubscribes is
not a permanent automatic recipient. Explicit subscribers and people watching
tagged projects or their ancestors also receive eligible changes. Project
membership alone is not a watcher route, and project silence does not override
an explicit watch.

Delivery uses the final recipients and current task/Space View permission. It
does not include the mail-specific union with recipients removed by the change.
Disabled people, the acting person and people who privately muted the task are
excluded. Creation policy is applied before queued delivery commits. New
[comment mentions](mentions.md) may add explicit followers before that one event;
they do not create a separate subscriber notification or bypass mute/access.

| Change | Inbox behavior |
| --- | --- |
| Creation; effective title, description, status, priority or owner edit | One event for the logical change |
| Public comment | One event, grouping implicit author subscription and explicit mention additions |
| Another person's explicit subscription change | One event for current recipients |
| Project tag edit | One event after final tags, grouping individual tag transactions |
| Explicit dependency add/remove | One event on each endpoint |
| Existing subtask status change | One event on the subtask and each actor-visible blocked parent, including open-to-open and closed-to-closed changes |
| Duplicate merge | One event per source and destination after subscription carryover |
| Actual workboard column change | One event, grouping accompanying tag changes |
| No-effect edit, self subscribe/unsubscribe, private mute, same-column reorder | Quiet |

Merge-derived parent history stays intact without creating an extra parent
notification. Synthetic relationship side effects remain grouped with their
semantic cause. This does not add upstream subtask-creation forms or other
unimplemented task actions.

Task events pin the task field version when the cause occurs. A comment can have
the same task version as earlier comments; its cause identifies its immutable
transaction. Events contain neither comment/description text nor related hidden
task/project identifiers. The inbox resolves the current authorized task title
and opens its task page. Deliberate successful online opening uses the observed
read boundary; later arrivals remain unread. Passive refresh and offline opening
do not automatically mark anything read.

## Private task mute

The Task Notifications panel lets a viewer mute a task without changing ownership
or following membership. Mute suppresses every delivery route for that person.
It does not hide already delivered notifications or grant access. Unmute restores
future eligible delivery without backfilling the muted interval.

Only the current person can inspect or change their mute preference and history.
Read operations need current View; writes also need write-scoped authority, with
no task Edit or Interact requirement. The preference has an independent version
and access-epoch pin. Changing it leaves task fields, source, public history,
activity and subscriptions unchanged.

Each changed preference appends immutable private evidence. An unchanged request
records an exact operation receipt without advancing the preference or adding a
history entry. Recovery binds task, person, normalized input and scoped request
key to that evidence and rechecks current View. Retrying an older successful
action returns its receipt without undoing a newer mute/unmute choice. Missing,
foreign or inconsistent evidence fails closed.

The mobile panel keeps private reads, drafts and uncertain requests independent
of ordinary task drafts. Local workspaces may retain them on the device;
password workspaces retain them only in the verified tab. Workspace, person,
mount and access changes invalidate private reading state. Offline changes remain
drafts. Submitting or recovering a request is explicit after reconnection; these
requests never enter automatic outbox replay.

An informational notification or preference read may discover a newer access
epoch before the workspace has refreshed its permission map. Existing-object
writes wait for that workspace verification before using cached controls; an
unavailable target or revoked permission stops submission. The existing exact
recovery path for a completed, access-losing revision authorship handoff retains
its server-verified receipt handling.

## API and CLI

Paths are relative to the configured application mount:

- `GET /api/tasks/:id/mute` returns the current person's `TaskMuteSnapshot`.
- `GET /api/tasks/:id/mute/history` accepts an exclusive integer `before`, `limit`
  (default 25, maximum 100), and optional `expectedMuteVersion`. A stale history
  pin requires reload.
- `POST /api/tasks/:id/mute` requires an `Idempotency-Key` and exact
  `{action: "mute" | "unmute", expectedMuteVersion, expectedAccessEpoch}` input.
  The authenticated request determines the person; no principal selector is
  accepted. The receipt contains task and operation IDs, input digest, changed
  flag and access epoch, without private historical content.

The CLI retains submitted pins and request identity:

```sh
npm run arc -- task-mute T123
npm run arc -- task-mute-history T123 --limit 25
npm run arc -- set-task-mute T123 --intent mute.json --request-id mute-1
```

This slice allows 10,000 distinct candidate recipients, scans at most 20,000
tagged/ancestor watcher rows, and verifies at most 10,000 stored task mute
preferences before filtering muted people. Exceeding a complete-operation limit
aborts the originating write rather than delivering partially. The client retains
at most 500 private mute-history entries. These are explicit native bounds, not
claims of unlimited upstream scale.

## Upgrade and upstream evidence

Schema 32 adds three private task mute tables and fences older applications.
Existing schema-31 revision events, delivery rows, read history, horizons and
idempotency records remain byte-for-byte intact. Legacy event and operation
shapes are strictly validated before projection to the generic inbox response.
Legacy `read_object` requests using `revisionId` keep their original normalized
input and digest during recovery. New requests use `objectId`. Migration creates
no task deliveries or mute preferences from historical activity.

The comparison uses archived Phabricator
[`5720a38`](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04):

- [Maniphest transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/editor/ManiphestTransactionEditor.php): owner recipients, grouped effects, merge and task transaction behavior.
- [Application transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php): self-subscription visibility, current notification recipients and mute filtering.
- [Task unblock transaction](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/xaction/ManiphestTaskUnblockTransaction.php): parent notification visibility for subtask status changes.
- [Maniphest task](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/storage/ManiphestTask.php): current owner as automatic subscriber.

## Verification

Store and API tests cover current recipients, actor suppression, explicit opt-out,
owner carryover, tagged/ancestor watching, private mute, final creation policies,
dependency endpoints and actor-visible parents. Board and merge tests cover
grouping, actual column changes, quiet reordering, proxy normalization, bulk
changes, hidden references, exact retries and atomic rollback.

Private preference tests cover changed/no-effect receipts, later choices,
concurrency/access pins, principal isolation, private paged history, malformed
proofs and corrupted current-state caches. Mixed-inbox tests cover opaque cursor
boundaries, current access, task versions and legacy revision event/read proof
projection. API and CLI checks run at both root and mounted paths.

Migration tests preserve prior schema, rows, row IDs, sequences, foreign keys and
literal legacy event/idempotency JSON, and reject conflicting schema objects.
A rehearsal against a local database copy retained all 91 existing records across
90 tables; schema 32 added three empty private preference tables. No deliveries
or preference history were invented.

The final full suite passed 1,428 tests, with nine optional TeX checks skipped and
no failures. Strict typecheck and root/subpath production builds passed.

The final browser matrix passed 180 unique scenarios: 106 at the root mount and
74 under a subpath, equally split between desktop and mobile. These include
mixed inbox navigation, observed task-opening boundaries, View-only and owner
mute, uncertain outcomes, later drafts, revocation, protected/local offline
reopening, initial and changed-access write gates, existing task/project/voice
workflows, and exact revision handoff recovery after View or Edit loss. Visual
checks confirmed normal touch targets, contained layouts and actions above the
mobile footer.
