# Revision following and mute preferences

Code, paper and Word revisions use the same following model. The current author
and every reviewer who has not resigned follow automatically. Explicit
subscriptions are separate: removing one does not cancel an author or reviewer
role. The Following view includes only revisions the current person can view.
Following never grants access, changes source, records a review decision or
alters acceptance.

## Authority and preferences

An explicit subscription can be absent, subscribed or unsubscribed. Unsubscribed
is a durable opt-out. A new attributed comment or reply can opt a person in only
when no preference exists and they do not already follow automatically. Historical
comments are not replayed to manufacture subscription events. The current native
account model has no separate service-account kind; implicit following recognizes
enabled workspace accounts and the exact local workspace identity, rather than
assuming an arbitrary attributed name is a person.

Self subscribe/unsubscribe requires current View and a write-scoped credential.
Adding another person requires Interact or Edit; removing another requires Edit.
Self subscribe/unsubscribe is unavailable while an author or reviewer role
already supplies automatic following. An editor may change another person's
explicit preference without canceling that person's automatic role. Subscription
records can name people who cannot currently view the revision; these records
do not give them visibility.

Mute and unmute are self-only operations with a separate version and private
history. They do not unsubscribe the person, remove an automatic role or publish
an activity event. Notification delivery is not implemented: the interface must
describe mute as a saved preference, not promise that messages are sent or stopped.

Current object, Space, repository and historical File restrictions apply to
reads, mutations and receipt recovery. Cookie writes also require CSRF. An
idempotency key and exact intent identify a saved operation. The immutable
operation also records an internal digest of the scoped retry key, so two valid
same-input requests cannot have their saved receipts exchanged. Current authority
is checked again before a fresh write and before returning a saved result.

## API

All paths are relative to the configured application mount.

- `GET /api/revisions/:id/subscriptions` returns a bounded page of explicit and
  automatic followers, the caller's subscription and private mute state, current
  role versions, access and permission epoch.
- `GET /api/revisions/:id/subscriptions/person?principalId=...` returns one
  person's public preference and automatic roles, including the version of an
  existing opt-out. It never returns that person's mute preference.
- `GET /api/revisions/:id/subscriptions/history` returns public preference
  history. Automatic role changes remain in authorship/reviewer history.
- `GET /api/revisions/:id/subscriptions/mute-history` returns only the caller's
  private mute history; it does not accept a different principal selector.
- `POST /api/revisions/:id/subscriptions` accepts `subscribe`, `unsubscribe`,
  `mute` or `unmute` and returns an immutable changed/no-effect receipt.

The exact input includes `principalId`, `expectedAccessEpoch`,
`expectedAuthorVersion`, `expectedReviewerVersion`, and either
`expectedSubscriptionVersion` or `expectedMuteVersion`. It does not pin immutable
source: following belongs to the revision, not to one draft. A reviewer counter
advance that preserves the same non-resigned reviewer identities does not alone
invalidate a pending subscription change. No-effect requests retain receipts
without adding a history entry or advancing preference versions.

Subscription pages accept an exclusive `after` principal cursor, `limit` from
1 to 100 (default 25), and optional `expectedSubscriptionVersion`,
`expectedAuthorVersion` and `expectedReviewerVersion` for consistent traversal.
Public history uses an exclusive `before` subscription sequence and optional
`expectedSubscriptionVersion`; private history uses the caller's mute version
and `expectedMuteVersion`. Both histories use the same page limits.

```sh
npm run arc -- revision-subscriptions P2
npm run arc -- revision-subscription-status P2 --principal PERSON_ID
npm run arc -- revision-subscription-history P2 --subscription-version 3
npm run arc -- revision-mute-history P2 --mute-version 1
npm run arc -- edit-revision-subscriptions P2 --intent following.json --request-id follow-1
```

Inspect the relevant person's status before creating an intent. A person absent
from the follower list may have a versioned opt-out; never assume version zero.
Retain the exact intent file and request ID after an uncertain response. The CLI
does not refresh versions or silently resubmit a different action.

## Mobile, offline and voice

The shared text/Word panel distinguishes explicit subscriptions from author and
reviewer roles. The Following list filter applies only to visible revisions and
can be combined with existing search and status filters. Voice and typed commands
such as “show papers I follow”, “show followed drafts” and “show all revisions”
open the corresponding list; they do not change anyone's subscription.

Authorized snapshots, drafts and exact uncertain requests are partitioned by
workspace and person. Local mode can retain them on the device; password mode
keeps them only in the current tab. Writes require an explicit online action and
are never automatically replayed by the offline outbox. Losing View retires
cached reads and holds drafts for export. Losing the capability needed for an
action also holds the draft without making a different action or person inherit
it.

## Storage and bounds

Schema 29 adds five tables: current subscription and mute preferences, public
subscription transactions, private mute transactions, and immutable operations.
Migration creates no preference or history rows. Existing entity, source,
discussion, evidence, policy and receipt rows retain their bytes and constraints.
Automatic following is derived from the existing author/reviewer records.

Each revision supports 1,000 stored explicit person preferences, including opt-out
tombstones. Automatic roles are additional. At that bound, existing preferences
can still change and personal mute remains available. A new comment still saves,
but it does not implicitly add another preference. New explicit preferences
return a capacity error. This native bound is a recorded difference from the
upstream edge store, not a claim of unlimited subscription parity.

## Upstream behavior

The archived baseline is Phabricator
[`5720a38`](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04).
Its [revision subscription interface](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/storage/DifferentialRevision.php#L947-L979)
derives automatic following from current author and reviewer roles. The
[subscriber query](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/subscriptions/query/PhabricatorSubscribersQuery.php)
reads explicit edges separately.

The [subscription editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/subscriptions/editor/PhabricatorSubscriptionsEditor.php)
records an opt-out when someone unsubscribes. A later comment respects that
choice; an explicit subscribe overrides it. The
[self-action controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/subscriptions/controller/PhabricatorSubscriptionsEditController.php)
disallows self subscribe/unsubscribe while automatic following applies.

The [transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php#L1909-L1952)
allows self subscription with View, requires Interact or Edit to add another
person, and requires Edit to remove another person. Its
[implicit comment rule](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php#L3304-L3388)
skips automatic followers, existing subscribers, prior opt-outs, application
actors and system agents.

The [mute controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/subscriptions/controller/PhabricatorSubscriptionsMuteController.php)
maintains an independent self-only preference. Upstream hides these changes from
ordinary transaction history. Native mute preferences must remain private and
must not be presented as working notification delivery before delivery exists.

## Implementation boundary

D112 implements native people following and private mute preferences. It does
not establish completed subscription or notification parity. Explicit retry
receipts, independent preference versions, current authority checks, mobile
controls and retained offline intents extend the archived behavior. Historical
comments are not backfilled into invented subscription history.

Notification delivery, activity-feed publication, inbound/outbound mail, service account kinds,
project/package subscribers, mentions, Herald, subscription-driven policies,
Conduit subscription edits, bulk set/import and upstream history import remain
separate parity gaps. See [the internal tracker](roadmap.md) and
[parity inventory](parity.md).

## Verification

Core tests cover author/reviewer handoffs and resignation, opt-outs, source-only
updates, independent private mute, changed/no-effect receipt reconstruction,
human comment/reply attribution and atomic rollback. Migration tests compare all
prior tables, schemas, row IDs, sequences and foreign keys and exercise collision
rollback. API/CLI tests exercise root and mounted paths, action-specific
permissions, cookie CSRF, credential revocation under the writer lock, current
repository/File/Space restrictions, exact page cursors and cross-key receipt
substitution.

Client tests cover private viewer identity, cached pages, distinct public/private
history, late reads, quota failures, session replacement, action-specific draft
holds and exact request cleanup. Browser scenarios exercise text and Word,
Following filters and voice commands, offline drafts, permission loss and lost
responses while preserving a newer action draft. These checks do not test or
claim notification delivery.
