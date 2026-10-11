# Suggested edits

A passage review thread can propose one exact replacement, including an empty replacement to delete the passage. The proposal belongs to its immutable root comment and original source version. The author supplies a required explanation plus the replacement; replies cannot carry proposals. Editing a published proposal means creating a new comment. Source and replacement are plain text, not executable instructions or markup to interpret.

## Reviewing and applying

The browser shows the original passage, replacement or deletion, and a complete bounded comparison. An editor opens the application preview, checks the exact source version and file, then explicitly applies it as a new version. Application requires a live connection. Merely creating, viewing or reading a suggestion never changes source or invokes an AI provider.

The server checks all of the following under the writer lock:

- Current view and edit permissions, plus token write scope where applicable.
- The proposal is an unapplied root comment of this revision and has a validated passage anchor.
- Current source version number, version ID and recomputed snapshot hash match the request and the proposal's original version.
- The stored file, offsets, exact quotation and surrounding context still match the original source.
- The caller's expected thread version is current, so an unseen reply or state change cannot be skipped.

Any newer source version requires a fresh proposal. A uniquely relocated quotation can explain where a thread belongs, but it does not authorize applying a replacement to another version. Stale proposals remain readable. Applications reject unchanged replacements, malformed Unicode, null bytes and text above the proposal limit; resulting files also pass the ordinary source size and path checks. Replacement text preserves whitespace, line endings and Unicode exactly.

Applying produces one new immutable revision version, with all other files and surrounding text preserved. An immutable application record links the proposal and thread to the old/new source IDs and hashes, acting principal and resulting thread version. Application increments the thread version without resolving or reopening it. The new version invalidates acceptance and follows the [source-change lifecycle rules](revision-lifecycle.md#drafts-and-source-changes), preserving Closed and Draft. Historical review runs remain available but cannot accept the changed source.

The source version, application record, thread update and activity commit together. A suggestion can be applied once. An identical idempotent retry returns its original result; a second key cannot apply it again. The browser reloads current detail after a successful operation. Old successful responses are historical evidence, not permission to change current content.

## Drafts and offline work

Proposal drafts retain their exact passage and replacement, including a deletion with an empty explanation still being composed. A published proposal requires the explanation. Retargeting or removing a passage must explicitly discard its old replacement; the editor never silently applies it to a different passage. Local-mode proposal comments can use the ordinary offline comment outbox, while applying is always online-only. Password-mode drafts remain in the verified tab's memory, with export before leaving. Permission changes preserve drafts through the existing export/discard recovery flow.

## API and storage

`POST /api/revisions/:id/comments` accepts `suggestion: { replacement: string }` only with a valid `passage` and nonempty comment body. The replacement may be empty, but must differ from the original quotation and contain at most 20,000 UTF-16 code units.

`POST /api/revisions/:id/suggestions/:commentId/apply` accepts `{ expectedVersion, expectedVersionId, expectedContentHash, expectedThreadVersion }` and returns `201 RevisionDetail`. Patch text and offsets are derived from the stored proposal, never from this request. Details include `suggestionApplications`. A missing/foreign proposal returns a child-specific 404; denied access to its parent follows the ordinary object policy contract.

Schema 6 adds immutable application records with one application per proposal, preserving comments, versions, review evidence and existing thread history. Earlier binaries refuse the newer schema. Historical schema-4/5 detail retries receive an empty application list when their snapshot contains no suggestions; stored replay data stays unchanged and no current application state is mixed into it. Back up an existing database before upgrading.

## Upstream and remaining work

Pinned upstream Phabricator stores suggested replacement text in [inline comment content state](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/diff/inline/PhabricatorDiffInlineCommentContentState.php), prepares suggestions and restricts them to roots in the [inline controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/diff/PhabricatorInlineCommentController.php), and renders a [contextual suggestion diff](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/diff/view/PHUIDiffInlineCommentDetailView.php). Atomic application into this application's immutable source history is a new capability; the inspected upstream paths did not establish an equivalent source-application operation.

Multi-passage and multi-file proposals, rebasing suggestions, upstream unpublished-draft semantics, deleted-side suggestions, model-generated proposal provenance, Git patch/landing integration and trusted automation policies remain unfinished. D106 is still partial and this does not establish full Differential parity.
