# Wiki and Paste following

NOTIFY-03 adds native people following, private mute and inbox delivery to Wiki
documents (`W`) and Paste snippets (`PA`). Following belongs to an object identity;
it never grants access, changes source, chooses a content version or records an
acceptance decision. The existing revision and task preference formats remain
unchanged.

## People and private preferences

Wiki has no automatic author or editor following. Creating, drafting, publishing
or editing a page does not subscribe that person. Native Wiki edit summaries are
not discussion comments. Wiki discussion is still a separate gap.

The original Paste author follows automatically. An explicit preference can be
absent, subscribed or unsubscribed; unsubscribed is a durable opt-out. A new human
Paste comment opts its author in only when no preference exists and automatic
following does not already apply. Existing comments are never replayed to create
new subscriptions. Enabled workspace accounts and the exact local identity are
recognized as people; arbitrary attributed actors do not opt in implicitly. New
[Paste comment mentions](mentions.md) are a separate explicit addition: eligible
mentioned people can be subscribed despite a prior opt-out, while the automatic
author and private mute remain unchanged.

Self follow/unfollow requires View and a write-scoped credential. Adding another
person requires Interact or Edit; removing another person requires Edit. A Paste
author cannot self follow/unfollow while automatic following applies. Editors
can change another person's explicit preference, but that does not remove their
automatic role. Adding a follower never grants source visibility.

Mute and unmute are self-only, require View and a write-scoped credential, and
have their own counter and private history. Mute suppresses all delivery for
that object without removing following. Public subscriber lists, person lookup,
public history and source activity never expose another person's mute state.
Personal preference changes and no-effect requests do not generate inbox events;
effective additions/removals of other people may notify the remaining recipients.

## Delivery

Recipients are current followers who are eligible workspace people and can view
the object under its current policy, Space and (for Wiki) ancestor restrictions.
The actor is suppressed. Creation and move policies are finalized before delivery.
Source changes, implicit subscriptions and notification causes commit atomically;
a failed write or retry presentation cannot leave partial delivery behind.

Wiki create, effective published edits, publication, deletion and restoration can
notify followers. Body-only saved drafts remain quiet. A draft title is compared
with the published title, matching upstream transaction effects, even when that
same unpublished title was saved previously. Ordinary moves are quiet at both
identities and do not transfer followers. Reusing a destination can notify its
followers when the move changes its copied View or Edit policy. No new-destination
creation event is invented for a move. Native authored saves may retain a new
immutable source version while their no-effect broadcast stays quiet.

Paste creation, effective content/metadata edits, archive/reactivate and comments
have immutable causes. A comment names the exact historical content version and
hash it discusses, even when the snippet has newer content. Wiki causes pin the
publication revision and exact head/published version identities. Events contain
no source text, draft titles, comment bodies, private preference state or related
object identifiers. Current permitted titles are resolved when reading the inbox.

Native Wiki/Paste project tags are not implemented, so this slice does not invent
project watcher routing. Standalone policy-change events, mail, live push, Wiki
body mentions, Herald, service/group
subscribers, configurable notification settings and upstream interchange remain
separate gaps.

## API and recovery

Paths are relative to the configured application mount. `:id` accepts only a Wiki
or Paste identity.

| Endpoint | Contract |
| --- | --- |
| `GET /api/objects/:id/subscriptions` | Followers, caller's following and private mute, access and epoch. |
| `GET /api/objects/:id/subscriptions/person?principalId=...` | One person's public preference and automatic role, including an existing opt-out. |
| `GET /api/objects/:id/subscriptions/history` | Public explicit/implicit following history. |
| `GET /api/objects/:id/subscriptions/mute-history` | Only the caller's private mute history. No principal selector. |
| `POST /api/objects/:id/subscriptions` | Exact `subscribe`, `unsubscribe`, `mute` or `unmute` intent with an `Idempotency-Key`. |

Inputs contain `action`, `principalId`, `expectedAccessEpoch` and either
`expectedSubscriptionVersion` (the selected person's counter) or
`expectedMuteVersion`. Source versions are deliberately independent. Subscriber
pages use exclusive `after` person cursors, `limit` 1–100 (default 25), and an
optional aggregate `expectedSubscriptionVersion`. Public history uses exclusive
`before` sequence and the aggregate pin; private history uses `before` mute
version and `expectedMuteVersion`.

Every mutation, including a no-op, has an immutable operation binding the actor,
target, exact normalized input and scoped retry-key digest. A saved receipt is
verified against that evidence and current action authority. Exact recovery
returns the original result with the current access epoch; it never reapplies an
old preference over a newer choice. The server checks operation owner and object
before loading evidence. Disabled historical followers remain removable.

```sh
npm run arc -- object-subscriptions W1
npm run arc -- object-subscription-status PA1 --principal PERSON_ID
npm run arc -- object-subscription-history W1 --subscription-version 3
npm run arc -- object-mute-history PA1 --mute-version 1
npm run arc -- edit-object-subscriptions W1 --intent following.json --request-id follow-1
```

Inspect the exact person's preference before constructing an intent; absence from
the current follower list does not imply version zero. Preserve the intent file
and request ID after an uncertain response. The CLI never replaces the inspected
pins automatically.

## Mobile, offline and migration

Wiki and Paste share a collapsed, touch-accessible Following & Notifications panel
that keeps source reading prominent and signals retained choices. Viewing
old source, publishing, archiving or editing does not rebase preference drafts or
select a different source version. Local workspaces can retain authorized reads
and drafts on-device; password workspaces retain them within the verified tab.
Writes require an explicit online action and are never replayed on reconnect.
View loss removes cached labels/content and retains only held recovery intents;
lost Edit permission does not remove the person's own View-based controls.

Successful foreground object openings mark only notifications through the
previously observed boundary. A Wiki path opening captures that boundary before
resolving the `W` identity and consumes it once. Missing paths, cached offline
openings, background refresh and historical source selection do not mark items.
Existing revision/task read receipts and legacy `revisionId` inputs retain their
exact shape and digest; new Wiki/Paste reads use `objectId`.

Schema 33 adds five tables for preferences and immutable evidence. Existing
source, history, notification events, read operations and retry receipts remain
unchanged; migration does not backfill subscriptions or delivery. Explicit
preferences are bounded to 1,000 people per object. An incidental comment opt-in
at capacity is skipped without discarding the valid comment. An explicit mention
which needs a new person at capacity instead rejects the entire comment and all
its effects atomically. Schema 34 adds the mention format fence without changing
these tables or any historical rows.

## Upstream basis

Behavior is pinned to archived Phabricator `5720a38c`:

- [Wiki automatic subscribers](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/storage/PhrictionDocument.php#L217) and [Paste automatic author](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/paste/storage/PhabricatorPaste.php#L155).
- [Subscription permissions](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php#L1899) and [implicit comment subscriptions](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php#L3304).
- [Hidden Wiki drafts](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentDraftTransaction.php#L14), [published-title effects](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentTitleTransaction.php#L8), [hidden move destination](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentMoveToTransaction.php#L104) and [hidden move source](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/xaction/PhrictionDocumentMoveAwayTransaction.php#L60).
- [Wiki move policy copying](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/editor/PhrictionTransactionEditor.php#L139) changes only View/Edit policy at a reused destination; Interact-only differences remain quiet.
- [Paste feed publication](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/paste/editor/PhabricatorPasteEditor.php#L113) is separate from its creation-mail suppression.

## Verification

- `npm run check` passed. The complete `npm test` suite passed 1,472 tests;
  nine optional TeX integration cases were skipped.
- Production builds passed at the root and `/mounted/` paths.
- The final production candidates passed 180 unique browser checks: 88 notification
  checks across both mounts and desktop/mobile, plus 92 surrounding Wiki, Paste,
  authorship and revision-following checks at the root. The Wiki startup regression
  holds back workspace discovery, preserves an open editor and its exact draft,
  and proves a newer publication refreshes without moving the selected version.
- Desktop, phone and tablet layouts were inspected, including collapsed reading,
  expanded controls, touch-target size and fixed-footer clearance.
- Migration rehearsal and the updated local preview preserved every preexisting
  table definition and row, including immutable receipts and read proofs. Schema
  33 added only five empty preference/evidence tables. Integrity and foreign-key
  checks passed; API reads and the served production bundle were verified.
