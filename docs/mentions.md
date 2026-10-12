# People mentions in discussion

F024 adds `@username` mentions to new code, paper, prose and Word revision comments and
replies, task comments, and Paste comments. A mention records who the name meant
when the comment was saved. It can explicitly subscribe that person and include
them in the comment's ordinary inbox delivery. It never grants object access,
changes source, changes a review decision or overrides private mute.

## Resolution and immutable evidence

The bounded scanner follows the pinned core Remarkup mention boundaries and
code/literal exclusions. Names use ASCII letters, digits, periods, underscores
and hyphens; a terminal period is excluded. Matching is case-insensitive while
the original spelling remains intact. `mail@example` and `@@person` are not
mentions. Recognized code, literal and link constructs suppress mentions; quoted
prose and list text can still contain them. This is extraction, not a general
Remarkup renderer or an interpreter for custom markup. F025 adds a separate
[core discussion reader](remarkup.md), preserving this scanner and saved proofs.

Resolution happens inside the original writer transaction. Only enabled people
who can currently view the target are resolved. Local mode also recognizes its
exact local identity; an ambiguous local/account spelling is left unresolved.
Application actors and arbitrary attributed names do not manufacture human
following. Current object, Space, repository and historical File restrictions
apply. Missing, disabled, ambiguous or inaccessible people all remain unresolved;
the response does not distinguish these cases.

New comment records contain optional `mentions` evidence:

```ts
{
  format: 'phabricator.mentions.v1',
  bodySha256: string,
  requestSha256?: string,
  tokens: [{ start, end, username, spelling, principalId, displayName }]
}
```

Offsets are end-exclusive UTF-16 positions in the exact stored body, including
the `@`. Every occurrence is retained, including repeated and unresolved tokens;
unresolved identity and display name are both `null`. Revision and task comments
preserve whitespace. Paste uses its existing trimmed comment body, so its offsets
and SHA-256 describe that stored text. Mention evidence is not accepted from a
client. Reads render captured identities only after validating the proof and
body hash; they never reinterpret old text against today's account directory.

For API writes, `requestSha256` binds resolution to the original scoped retry key
and request fingerprint. The fingerprint covers method, path and submitted
input; the digest hashes the UTF-8 encoding of
`JSON.stringify([scopedKey ?? null, fingerprint])`. Raw keys are not included in
the proof. Direct Store writes without request context omit this field; older
records keep their original shape. Exact API retries recheck current authority
and compare the saved receipt with its immutable comment and request binding.
They neither resolve names again nor apply following again. Two otherwise equal
requests under different keys cannot exchange their mention-bearing receipts.

## Following and delivery

Each resolved person is considered once per comment. Existing explicit followers
and automatic revision authors/reviewers, task owners or Paste authors need no
new edge. Other resolved people become explicit followers, including people who
previously opted out. This intentional explicit-subscribe behavior differs from
the comment author's incidental opt-in, which respects an existing opt-out.

The following effect names its immutable comment, actor and timestamp. Revision
and Paste history uses `reason: 'mention'` with `mentionCommentId`; task history
uses `reason: 'mentioned'` with `subscription.commentId`. Revision historical role
pins and task historical ownership keep this evidence interpretable after later
handoffs. These effects do not advance source versions or invalidate acceptance.

The comment, mention proof, all following changes and its notification cause
commit together. A failure rolls them all back. There is one grouped comment
event, not a second event for each mention or subscription. Existing recipient
policy, actor suppression, private mute and revision draft broadcast rules still
apply. A mention does not force delivery to someone who cannot view the object,
has muted it, or is otherwise excluded by those rules. No old comment is replayed
to create followers or notifications after an account or policy change.

## API, mobile and offline use

The existing comment endpoints accept plain body text and their existing source
pins; there is no separate mention mutation endpoint:

- `POST /api/revisions/:id/comments`
- `POST /api/revisions/:id/threads/:threadId/replies`
- `POST /api/tasks/:id/comments`
- `POST /api/pastes/:id/comments`

Normal write scope, Interact permission, current source restrictions and cookie
CSRF checks remain required. Replies retain their original thread anchor and
separately record the version being viewed. Paste comments retain their selected
content version. Existing CLI comment commands use the same body text and server
resolution; there is no special client-side recipient list.

The mobile-accessible person picker inserts a username into the existing draft.
It does not submit, grant access or promise delivery. It excludes disabled and
ambiguous directory entries. Draft source/version/anchor fields and uncertain
requests remain unchanged. Local-mode revision/task outbox behavior is preserved:
an offline comment resolves names only when its authorized write reaches the
server. Paste comments still require an explicit online save. Password-mode
drafts retain their existing tab-only lifetime. Reads and drafts inherit their
existing session, revocation and quota handling.

## Bounds, migration and remaining work

Extraction permits at most 20,000 UTF-16 code units, 100 mention occurrences and
32 nested quote blocks. Paste retains its smaller 10,000-character comment limit.
Exceeding extraction bounds fails the whole comment without truncation. Revision
and Paste explicit preferences retain their 1,000-person bounds; a mention that
requires a new preference at capacity rejects the whole comment. This is stricter
than incidental author opt-in, which can be skipped at capacity. Task mention
additions enforce the 10,000 active explicit follower delivery bound.

Schema 34 is a format fence only: it adds no tables, columns, indexes or triggers
and rewrites no existing comment, history, event, preference or saved receipt.
It prevents an older binary from interpreting unsupported mention history.
There is no inferred historical proof, following or delivery backfill.

Wiki bodies/edit summaries, task descriptions, revision metadata, source text,
AI findings and other applications are outside this slice. Full Remarkup,
project/group/service mentions, profile links, backlinks, editable-comment
mention deltas, mail and upstream interchange remain gaps. Existing comments are
append-only, so the upstream old-text/new-text mention subtraction workflow is
not yet needed for native comment editing.

## Upstream basis

The comparison is pinned to Phabricator
[`5720a38cfe95b00ca4be5016dd0d2f3195f4fa04`](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04).

- [Mention rule](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/people/markup/PhabricatorMentionRemarkupRule.php#L11-L84): token boundaries, original spelling and case-insensitive account resolution.
- [Markup rule ordering and extraction](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/markup/PhabricatorMarkupEngine.php#L525-L621): core block/inline processing precedes extracted mention identities.
- [Comment Remarkup blocks](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/storage/PhabricatorApplicationTransaction.php#L232-L244): comments participate in old/new text extraction.
- [Mention subscription effects](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php#L2048-L2132): new identities, duplicate/system-agent filtering, target View and automatic-role exclusions.
- [Explicit subscription application](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php#L794-L808) and [subscription authority](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php#L1925-L1948): mention additions use explicit following and adding another person permits Interact or Edit.
- [Private mute filtering](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php#L4185-L4198): mute remains independent of recipient selection.

## Verification

- `npm run check` passed. The final complete `npm test` run passed 1,508
  tests; nine optional TeX integration cases were skipped, with no failures.
- Production builds passed at the root and `/mounted/` paths. The final root
  rebuild produced the same application bundle as the browser candidate.
- All 130 unique browser checks passed: 28 new mention checks across both
  mounts and desktop/mobile, plus 102 surrounding discussion, following, inbox,
  task and Wiki checks at the root. The existing Word startup regression now
  distinguishes permitted foreground inbox read marks from source writes.
- Desktop, phone and tablet layouts were inspected, including picker insertion,
  exact Word quotations, historical Paste comments and fixed-footer clearance.
- Both migration rehearsal and the updated local preview preserved every
  existing table, schema object, row, rowid, foreign key and saved receipt across
  schema 33 to 34. Integrity checks passed; served bundle and revision, task,
  Wiki/Paste following and notification read models were verified.
