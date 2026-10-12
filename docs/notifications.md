# Notifications

NOTIFY-01 through NOTIFY-03 implement the native revision, task, Wiki and Paste inbox described here. Broader
notification parity remains tracked in [the roadmap](roadmap.md).

The notification inbox is private to the current workspace person. Revision, task, Wiki and Paste
changes create durable events and recipient records in the same transaction as
the change. A failed source or policy write cannot leave a notification behind.
Exact retries reuse the original change rather than sending it again.

New [people mentions](mentions.md) in revision/task/Paste comments add eligible
explicit followers before the same grouped comment event. They can override a
following opt-out, but cannot bypass current access, private mute, acting-person
suppression or revision draft broadcast rules. Stored comments are never replayed
to deliver a mention retrospectively.

## Revision delivery

Code, paper and Word revisions share the inbox. Notification events name a
logical change and immutable source identity, with an actor and time. Comments
pin the commented version; replies pin the original thread version, which may
differ from the version the person was viewing. Other events pin the head when
the cause occurs. Opening the notification navigates to the current revision
without replacing a saved source comparison. Events do not
copy source text, comment bodies, hidden project names or related revision IDs
into the notification record. Current visible revision titles are resolved when
reading the inbox.

Recipients come from current revision following: the author, non-resigned people
reviewers and explicit subscribers. Existing people watching tagged projects or
their ancestors are included. Membership alone is not this watcher path. Each
recipient must be an eligible workspace person who can currently view the
revision, including its Space, repository and historical source Files. Requested
creation policies apply before delivery is finalized.

The acting person is not notified of their own action. A revision's private mute
suppresses every routing path. Project watching overrides project silence in the
pinned upstream behavior; silencing a project does not cancel an explicit watch.
A revision mute is the way to suppress this revision's inbox delivery.

Draft changes remain quiet until the revision has started review. A withdrawn
or subsequently abandoned review does not become a never-published draft again.
Source, public discussion, metadata, lifecycle, reviewer, authorship and project
tag changes are notification causes. Logical side effects are grouped with
their cause instead of creating duplicate alerts. No-effect saves, private mute
changes, self subscription changes, dependency-only changes and discussion
resolution alone remain quiet, following the relevant upstream transaction
visibility rules.

## Task delivery

Task changes share the inbox with code, papers and Word. Events pin task versions;
current owners, explicit followers and tagged-project/ancestor watchers receive
visible changes. Private task mute suppresses all routes. Dependency, merge and
workboard causes follow Maniphest's transaction rules. See [task notification
contracts](task-notifications.md) for the precise delivery matrix, private mute
API, recovery behavior and upstream evidence.

## Wiki and Paste delivery

Wiki/Paste following and private mute share this inbox. Wiki authors are not
automatic followers; Paste authors are. Body-only Wiki drafts and ordinary moves
stay quiet. Paste comments pin their exact historical source. Wiki path openings
capture a read boundary before resolving the page identity. See [Wiki/Paste
following](object-subscriptions.md) for the complete event, access, recovery and
migration contract.

## Inbox and access

The bell menu shows recent notifications and an unread badge. The full inbox has
All, Unread and Read filters, newest first, with bounded pagination. Counts and
rows include only objects the viewer can currently read. An inaccessible
notification does not become an anonymous placeholder or contribute to a hidden
count. Regaining access can make a previously delivered notification visible
again; losing access does not rewrite its historical delivery.

Cursor and horizon tokens are opaque and belong to the current person and
access epoch. A page cursor also pins its filter, observed delivery boundary and
private read-state revision. New deliveries do not slip into an older page;
read-state changes require reloading pages. Pages scan at most 1,000 delivery
rows and return at most 100 visible items (25 by default). A sparse page can
contain no visible items while still offering an older-page cursor. Ordering
follows durable delivery sequence, not the actor timestamp. Equivalent encrypted
horizons need not have equal token text. Unread counts cover at most 10,000
distinct candidate objects; read-through actions consider at most 10,000
unread delivery rows. Exceeding these complete-operation limits returns an
explicit error. An unread count is never presented as complete after truncation.

## Read state and recovery

Mark Read and Mark Unread change only the viewer's own notification. They require
current View and write-scoped authority, not permission to edit the object.
Each row has independent read-state concurrency protection.

Mark All Read uses the observed delivery boundary. It marks accessible unread
notifications through that boundary and leaves later arrivals alone. Opening a
successfully loaded revision, task, Wiki page or Paste online can mark that object's observed notifications
read through the same boundary. Passive background fetching does not mark
objects read, and opening a cached object offline does not queue this action.

Every write retains an exact intent and request ID. An immutable operation binds
the recipient, original input, scoped retry identity and affected read states.
Recovering a completed action verifies this proof and current access, without
reapplying an earlier state over a newer read/unread choice. Receipts contain no
stale object title or affected-object list.

## API and CLI

Paths are relative to the configured application mount.

- `GET /api/notifications` accepts `filter=all|unread|read`, `before` and `limit`.
- `GET /api/notifications/count` reads the current visible unread count and an
  observed horizon.
- `POST /api/notifications/read` applies one explicit `read`, `unread`,
  `read_through` or `read_object` intent with an `Idempotency-Key`.

Individual actions supply `notificationId`, `expectedVersion` and
`expectedAccessEpoch`. Read-through supplies `horizon` and the access epoch;
object reading also supplies `objectId`. Legacy revision requests with
`revisionId` remain valid and retain their exact digest; the two keys are mutually
exclusive, and `revisionId` accepts only revisions. The server determines the recipient
from the authenticated request, never a caller-selected account.

The CLI preserves exact intents without fetching replacement concurrency pins:

```sh
npm run arc -- notifications --filter unread --limit 25
npm run arc -- notification-count
npm run arc -- mark-notifications --intent read.json --request-id read-1
```

There is no invented `notification.*` Conduit method: the archived `feed.query`
API is a separate parity target. Recipient routing allows at most 10,000 distinct
people and scans at most 20,000 active tagged-project/ancestor watcher rows. An
excess rolls back the originating change instead of sending a partial delivery.

## Mobile, offline and voice

The header menu and full inbox share one private reading state. Local workspaces
may cache up to 500 authorized notifications per filter on the device; password workspaces retain
pages only in the current tab. Workspace, person and mount boundaries prevent
one session from inheriting another person's inbox. Access changes retire cached
labels, counts and pending reads. An unavailable notification does not make its
still-visible source object unavailable.

Uncertain read-state writes remain explicit, recoverable requests. They are not
replayed automatically on reconnect. Voice commands such as “show unread
notifications” select the relevant inbox without changing read state. Spoken
source reading continues to use the existing authorized revision workflows.

## Historical baseline and remaining work

Schema 31 adds six notification tables and immutable delivery/read-operation
evidence without manufacturing historical
delivery. Previous activity does not establish who followed an object or could
read it at that earlier time. Existing source, policies, discussion, evidence and
saved receipts remain unchanged. Schema 32 adds private task mute storage and
generic task delivery without rewriting any schema-31 event, read proof or saved
receipt. Legacy cache rows are strictly projected while pending legacy request
bodies remain unchanged. Schema 33 adds Wiki/Paste preferences and target contexts
without rewriting existing events, operations or pending read inputs. Schema 34
is a mention-format fence with no DDL or historical-row rewrites; existing event
and read-receipt shapes remain unchanged.

Upstream comparison uses Phabricator
[`5720a38`](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04):

- [Feed story publisher](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/feed/PhabricatorFeedStoryPublisher.php): durable per-person delivery and acting-author suppression.
- [Transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php): notification recipients, mute filtering and grouped logical changes.
- [Differential editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/editor/DifferentialTransactionEditor.php): broadcast gating and author/reviewer recipients.
- [Notification query](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/notification/query/PhabricatorNotificationQuery.php): current policy filtering and private read/unread selection.
- [Panel controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/notification/controller/PhabricatorNotificationPanelController.php) and [clear controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/notification/controller/PhabricatorNotificationClearController.php): recent menu, unread count and clearing through an observed boundary.

Mail, live Aphlict-style push transport, mobile system notifications, notification
settings, project/package reviewer expansion, mentions outside the implemented
discussion surfaces, Herald, delivery for
other applications and background build jobs, global Feed/Conduit compatibility,
upstream history import and unbounded scale remain gaps. This does not establish
full Notifications, Maniphest or Differential parity.

## Verification

Engine and API tests cover current recipient routing, draft broadcast rules,
actor suppression, private mute, tagged/ancestor watchers, final creation policies,
historical comment/reply source context, logical-cause deduplication and complete
rollback. Cursor/read tests cover later arrivals, personal read generations,
current File/repository/Space restrictions, forged receipts, exact retries,
credential revocation and explicit query limits. CLI tests preserve exact inputs
and request IDs.

Migration tests compare all earlier rows, row IDs, schemas, sequences and foreign
keys; conflicting tables, indexes and triggers roll back without adoption. A
rehearsal against a copy of the local database preserved all 90 existing records
and added only the cursor secret, with no fabricated deliveries.

Desktop/mobile browser checks at root and subpath mounts exercise bell and inbox
pagination, read/unread filters and voice navigation, observed-boundary marking,
new arrivals during Word opening, lost responses, delayed stale pages, access
revocation, password-tab offline reads and full local offline reload. Read
requests never enter automatic reconnect replay. Client tests separately cover
cache ownership, session replacement, independent invalidation and exact receipt
validation.

NOTIFY-01 release validation: strict typecheck and both root/subpath production builds passed.
The full suite passed 1,382 tests, with nine optional TeX checks skipped and no
failures. The browser matrix passed 116 unique desktop/mobile cases: 28 new
notification cases and 88 surrounding workflow regressions.

NOTIFY-02 adds verified task delivery and private mute. Its final suite passed
1,428 tests with nine optional TeX checks skipped, alongside strict typecheck,
both production mounts and 180 desktop/mobile browser scenarios. Legacy
revision event, read-operation and pending-request compatibility remained intact.
See [task notification verification](task-notifications.md#verification).
