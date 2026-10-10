# Immutable document comparisons

This is the first D102 comparison-controls slice for code revisions, papers and prose drafts. The comparison is a reading view over two immutable source snapshots. It does not change a document, record review evidence, accept a revision or invoke a model.

## Selecting what to inspect

The initial view compares the current version with its immediate predecessor, or an empty base for the first version. It resolves that choice once. Thereafter the selection records the revision ID, both exact version IDs and content hashes, the file path, literal comparison mode and source/comparison view. Background refreshes and newly arriving versions do not silently replace the selected pair. Show Current is an explicit return to the latest pair.

Either side can be any available version of the same revision. Equal and reverse comparisons are supported. Changing the inspected version preserves the chosen base; Swap reverses a nonempty pair. A missing version or mismatched content hash produces an unavailable-selection state rather than substituting another snapshot.

The file chooser uses the union of the two snapshots' exact paths. Added, deleted and existing empty files remain distinct. Selecting a deleted file shows its removed content; it does not fall back to a different current file. File renames are currently an addition and deletion, without inferred alignment.

Selection metadata follows the existing workspace and account cache boundaries. Local mode can retain it with the visited revision for offline reopening. Password mode keeps it only in the verified session's memory. Object revocation clears the metadata along with cached source; logout/account changes cannot restore another account's selection. No extra source text or spoken excerpts are stored with the selection. If browser storage fails, the current view remains usable but cannot promise restoration after reload.

## Literal changes and navigation

Words and Lines are literal modes. Both preserve whitespace, CRLF, Unicode and final-newline differences. They do not interpret LaTeX, infer semantic equivalence, suppress formatting changes or call an AI provider. Only the selected file is compared.

Adjacent additions and removals form one changed passage. Previous Change and Next Change move the same cursor used by voice commands. The view reports its current passage and total, and navigation stops at the first or last passage instead of wrapping. An unchanged file and an empty file addition/deletion have explicit states.

The pure shared comparison helper bounds combined source size, source lines, token count, edit distance, token comparisons, rendered segments and changed passages. Its hard ceilings are 200,000 UTF-16 source units, 8,000 source lines, 40,000 tokens, edit distance 1,024, 250,000 token comparisons, 2,000 segments, 1,000 passages and 120,000 rendered UTF-16 units. Callers may lower these limits, but cannot raise them. These bound computational work; they are not a wall-clock guarantee for every device.

An exceeded limit produces an explicit unavailable comparison with the selected source/download alternatives. It never reports a truncated diff as “no changes.” Raw source remains the exact snapshot; a comparison fallback does not edit or shorten it.

Source comments and the paper structure view have a separate target-only display budget of 120,000 UTF-16 units and 8,000 displayed lines. A small target remains available for source comments even when a large base prevents comparison. An oversized target remains readable as raw source or downloadable, with an explicit notice that inline comments and structure are unavailable for that file.

## Reading the selected changes aloud

Typed and spoken commands share the active review selection:

- **Read changes** names the revision, base and inspected versions, and selected file, then reads up to three changed passages.
- **Read current change** reads the passage selected by the on-screen cursor.
- **Next change** and **Previous change** move that same cursor and describe the selected passage, with explicit end-of-list feedback.

Narration distinguishes added/deleted files and names significant whitespace instead of treating it as empty text. Long filenames, source excerpts and total speech have explicit shortening notices. The response is bounded to 2,200 Unicode code points. No command independently compares the latest version or silently reads another file. Large-comparison failures are spoken as failures to compare, not empty-change summaries.

Changing the version pair, file or comparison mode, leaving the revision, losing access or ending the session cancels old comparison speech. Stale callbacks cannot restore an old comparison's source or narration. Playback uses only browser voices marked as local; it does not send document text to a remote speech voice. Browser speech recognition remains separately opt-in and may send microphone audio to its provider. Offline transcription remains unfinished.

## Comments, edits and evidence

Comments continue to refer to the exact inspected version and its source passage. The base side of a deletion cannot author a comment against nonexistent target text. Opening a thread's original source explicitly selects its immutable source version.

Creating a new version and applying a suggestion remain explicit source-changing operations. Their successful result may select the new snapshot when the original editor still owns the current view, preserving the reading mode and file when it remains in the new pair. A delayed save cannot discard a newer draft or take over a comparison that the reader selected while that save was pending.

Review runs remain bound to a version ID and content hash. Inspecting a historical or reversed comparison does not make old evidence current or re-enable acceptance for a newer snapshot. Existing server checks continue to enforce revision-owned versions, exact passage anchors and current-version acceptance.

## Upstream evidence and remaining work

The pinned [Differential revision controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/controller/DifferentialRevisionViewController.php) resolves the two requested diff IDs independently and retains files present only in the base. Its [history view](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/view/DifferentialRevisionUpdateHistoryView.php) and [radio-button behavior](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/webroot/rsrc/js/application/differential/behavior-diff-radios.js) normally restrict the base to an earlier diff. Our explicit reverse/equal-pair controls expose a broader document-reading workflow. The [changeset list](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/webroot/rsrc/js/application/diff/DiffChangesetList.js) supplies upstream change/file navigation.

D102 remains partial. Semantic move detection, formatting filters, rename alignment, file-to-file voice navigation, PDF comparison and source/PDF mapping, deleted-side comment authoring, and upstream interdiff/import compatibility remain open. The new literal comparison does not claim to distinguish rewritten meaning, validate scientific or legal claims, or complete Differential parity.
