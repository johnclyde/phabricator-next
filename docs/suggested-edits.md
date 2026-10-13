# Suggested edits

A passage review thread can propose up to 20 exact replacements across files in one immutable text revision, including empty replacements that delete passages. The proposal belongs to its immutable root comment and original source version. The root comment explains the first replacement; each additional passage has its own required explanation. Replies cannot carry proposals. Editing a published proposal means creating a new comment. Source, explanations and replacements are plain text, not executable instructions or markup to interpret.

## Reviewing and applying

The browser shows every original quotation, file, explanation, replacement or deletion, and a complete bounded comparison. After choosing the root passage, the author can add another passage from any file in the same original version. Native text selection and explicit source offsets both retain the original quotation, including Unicode and line endings. Overlapping ranges cannot be added. An editor opens the application preview, checks the complete set and exact source version, then explicitly applies all passages as one new version. Application requires a live connection. Merely creating, viewing or reading a suggestion never changes source or invokes an AI provider.

**Read thread** announces the number of proposed passages and affected files, then directs the reader to the complete edit preview. It does not narrate every original quotation or replacement and does not provide a voice command for applying this proposal. The explicit visual preview remains the complete review of the proposed set.

The server checks all of the following under the writer lock:

- Current view and edit permissions, plus token write scope where applicable.
- The proposal is an unapplied root comment of this revision and has a validated passage anchor.
- Current source version number, version ID and recomputed snapshot hash match the request and the proposal's original version.
- Every stored file, offset range, exact quotation and surrounding context still matches the original source.
- All passages use that same version ID and hash, and no two ranges overlap within a file. Touching non-overlapping ranges are allowed.
- The caller's expected thread version is current, so an unseen reply or state change cannot be skipped.

Any newer source version requires a fresh proposal. A uniquely relocated quotation can explain where a thread belongs, but it does not authorize applying a replacement to another version. Stale proposals remain readable. Applications reject unchanged replacements, malformed Unicode, null bytes and text above the proposal limits; resulting files also pass the ordinary source size and path checks. Each original quotation, replacement and explanation is limited to 20,000 UTF-16 code units. The complete set is limited to 100,000 code units across those texts, including the root explanation. Replacement text preserves whitespace, line endings and Unicode exactly.

Applying produces one new immutable revision version, with all other files and surrounding text preserved. Every anchor is validated before any edit is applied. Replacements are then applied from the end of each original file toward its beginning, so changing the length of an earlier passage cannot shift another edit. A failed check rejects the complete set; no subset is published or applied. An immutable application record links the proposal and thread to the old/new source IDs and hashes, acting principal and resulting thread version. Application increments the thread version without resolving or reopening it. The new version invalidates acceptance and follows the [source-change lifecycle rules](revision-lifecycle.md#drafts-and-source-changes), preserving Closed and Draft. Historical review runs remain available but cannot accept the changed source.

The source version, application record, thread update and activity commit together. A suggestion can be applied once. An identical idempotent retry returns its original result; a second key cannot apply it again. The browser reloads current detail after a successful operation. Old successful responses are historical evidence, not permission to change current content.

## Drafts and offline work

Proposal drafts retain the complete set of exact passages, replacements and explanations, including deletions and empty explanations still being composed. A published proposal requires every explanation. Retargeting or removing the root passage must explicitly discard the existing proposal; removing an additional passage explicitly discards only that passage and its replacement. The editor never silently moves an edit to a different passage. Local-mode proposal comments can use the ordinary offline comment outbox, while applying is always online-only. Password-mode drafts remain in the verified tab's memory, with export before leaving. Saved private review entries preserve all edits through editing, export, complete-set preview and explicit publication. Editing the first replacement does not remove the remaining passages. A local edit that exceeds the aggregate publication budget remains available as a raw draft for revision or export; publication stays disabled until the complete proposal fits its limits. Permission changes preserve drafts through the existing export/discard recovery flow.

## API and storage

`POST /api/revisions/:id/comments` accepts `suggestion: { replacement: string, additionalEdits?: SuggestedPassageEdit[] }` only with a valid root `passage` and nonempty comment body. Existing single-passage requests remain valid. Each additional edit contains `{ anchor: PassageAnchor, replacement: string, explanation: string }`. Its full anchor includes `versionId`, `contentHash`, `filePath`, `start`, `end`, `quote`, `prefix` and `suffix`; the server rechecks all fields against the original source. Up to 19 additional edits may accompany the root. A replacement may be empty but must differ from its original quotation. The same complete proposal format is accepted by private review drafts and their CLI JSON requests.

`POST /api/revisions/:id/suggestions/:commentId/apply` accepts `{ expectedVersion, expectedVersionId, expectedContentHash, expectedThreadVersion }` and returns `201 RevisionDetail`. Patch text and offsets are derived from the stored proposal, never from this request. Details include `suggestionApplications`. A missing/foreign proposal returns a child-specific 404; denied access to its parent follows the ordinary object policy contract.

Schema 6 adds immutable application records with one application per proposal, preserving comments, versions, review evidence and existing thread history. Earlier binaries refuse the newer schema. Historical schema-4/5 detail retries receive an empty application list when their snapshot contains no suggestions; stored replay data stays unchanged and no current application state is mixed into it. D106c uses the existing immutable comment JSON and application records without changing schema 36 or rewriting historical single-passage comments. Back up an existing database before upgrading.

## Verification

D106c passed type checking, root and mounted production builds, and the full suite (1,948 total: 1,939 passed, nine optional TeX integrations skipped). The verified builds passed 168 desktop/mobile browser checks covering multi-file edits, complete previews, exact selection across CRLF and Unicode, deletion, overlap rejection, stale source/discussion, lost responses, offline drafts and existing Word/voice flows. Existing preview rows and schema 36 remained unchanged. Mobile checks use Chromium touch emulation, not physical devices.

## Upstream and remaining work

Pinned upstream Phabricator stores suggested replacement text in [inline comment content state](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/diff/inline/PhabricatorDiffInlineCommentContentState.php), prepares suggestions and restricts them to roots in the [inline controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/diff/PhabricatorInlineCommentController.php), and renders a [contextual suggestion diff](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/diff/view/PHUIDiffInlineCommentDetailView.php). Atomic application into this application's immutable source history is a new capability; the inspected upstream paths did not establish an equivalent source-application operation.

D106b permits suggestions on exact removed/base passages and deleted files; they remain historical proposals when their original source is no longer current. D106c adds bounded multi-passage and multi-file proposals for plain-text, code and LaTeX sources. Word package patches, automatic rebasing, upstream unpublished-draft semantics, model-generated proposal provenance, Git patch/landing integration and trusted automation policies remain unfinished. D106 is still partial and this does not establish full Differential parity.
