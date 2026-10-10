# Passage review and discussion threads

Code, paper and prose revisions share an immutable review discussion model. A thread stays attached to the version where it began. Replies stay with that thread while recording the version the writer was viewing. Discussion is visible across versions, with Open, Resolved and All filters.

The typed/voice command `read discussion` reads counts and a bounded excerpt of up to three open threads, identifying their original versions and quotations. It uses already-loaded, authorized content and no model call. Existing optional speech output uses only an available on-device voice. Spoken dictation, thread navigation and spoken resolution still require further workflow support.

## Source anchors

A new passage comment records its original version ID and content hash, file path, half-open UTF-16 source offsets, exact quotation and bounded surrounding context. The server validates the submitted quotation against the immutable source and derives the stored quotation and context itself. Ranges cannot split a Unicode surrogate pair. The browser supports source selection and a line-range alternative for keyboard and touch use. General comments and existing single-line comments remain supported.

Projection into another version is a pure, local calculation; it does not rewrite the original anchor or use an AI model. A uniquely occurring exact quotation in the same file can be shown at its new position after an insertion or move. Multiple occurrences are marked ambiguous. Changed or missing passages and missing files keep the original quotation and an explicit explanation. The original source remains available through the thread's version link. Context is retained as evidence, not used to silently choose one repeated quotation over another.

These are precise source-passage anchors, not semantic paragraph identities. Renamed files, rebases, edited wording and comments on removed diff-side text still need further mapping support. Legacy line-only comments retain their original location without fabricated passage anchors.

## Replies and resolution

Messages are immutable. Each thread has its own optimistic version. A reply increments this version; resolving or reopening requires the version the caller actually saw, so a concurrent reply causes a conflict instead of silently closing unseen discussion. Successful retries with the same idempotency key do not add a second reply or event.

Resolution events retain the acting principal, credential/request attribution and exact source version being addressed. Resolving a thread does not accept a revision, produce review evidence or change source. New source versions preserve thread state and event provenance; a resolution on an older version is not a claim that later text was checked. A new reply does not implicitly reopen a resolved thread. Reopen it explicitly when further work is needed.

Replies require current view and interact permissions; resolution requires current view and edit permissions. Bearer credentials also require write scope. Reads, saved retry responses and writes under the database lock enforce current object/Space access. Resolution is online-only. Local-mode comment and reply drafts may be queued with their original anchor and version; authenticated drafts remain in tab memory. Permission loss uses the same export/discard recovery behavior as other drafts.

## API and migration

- `POST /api/revisions/:id/comments` retains existing fields and accepts optional `passage: { start, end, quote }` with a `filePath`. `versionId` selects immutable source. A supplied line must agree with the passage.
- `POST /api/revisions/:id/threads/:threadId/replies` accepts `{ body, viewedVersionId }` and returns the immutable comment. The server inherits the root comment's anchor, original version and location.
- `PATCH /api/revisions/:id/threads/:threadId` accepts `{ status: "open" | "resolved", expectedThreadVersion, versionId }` and returns the updated thread. Stale versions and redundant state changes return conflicts.
- Revision details include `threads` and `threadEvents` alongside the existing comments. Older comments without `threadId` are roots whose thread ID equals their comment ID.

Schema 5 adds threads and resolution history. Every existing comment becomes a one-message thread while its stored comment record remains unchanged, including attribution gaps. Database triggers reject updates and deletion of immutable comments and thread events. Migration and writes are transactional; earlier binaries refuse the new schema. Back up an existing workspace before upgrading.

Saved schema-4 detail responses retain their historical comments. When replayed, their response shape includes corresponding one-message open threads and no resolution events; the stored response itself is unchanged. This describes the old snapshot, not current discussion. Fetch the revision again for current replies and thread versions. Optimistic version checks prevent a historical response from resolving subsequently changed discussion.

## Upstream relationship and gaps

The pinned upstream [Differential comment model](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/storage/DifferentialTransactionComment.php) supplies the range/reply model. Its [inline controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/diff/PhabricatorInlineCommentController.php) keeps replies at the parent's original anchor, and its [adjustment engine](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/diff/engine/PhabricatorInlineCommentAdjustmentEngine.php) projects old comments without rewriting the originals.

Upstream [Done/Undone authorization](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/controller/DifferentialInlineCommentEditController.php) has revision-owner and unpublished-draft semantics. This implementation deliberately uses current edit permission for immediate resolve/reopen; formal revision ownership and upstream draft publication remain gaps. [Single-passage suggested edits](suggested-edits.md) now apply atomically to their exact original source version. Multi-passage/file proposals, semantic anchors and full cross-diff mapping remain unfinished. D101 and D106 are partial, and this slice does not establish Differential parity.
