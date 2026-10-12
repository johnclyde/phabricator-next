# Transcript source edits

This native writing workflow connects the [local audio inbox](audio.md) to immutable source versions. It applies a reviewed, literal replacement to one selected passage in a code revision, paper, prose draft or supported Word document. It does not interpret a spoken instruction, invoke a review model, or execute commands embedded in a transcript.

## Use

1. Record and transcribe in Audio, then correct the separate transcript draft. A saved or still-retained unsaved result is usable; the original result and its exact audio must remain available when selecting it.
2. Open the destination revision and its current source. Select a passage, or use the mobile line-range inputs, then choose **Replace with transcript** or **Replace line range with transcript**. For Word, open the tracked editor, choose an editable run and optionally select a substring, then choose **Replace with transcript**.
3. Choose a local recording and **Use transcript draft**. This explicitly reads the local audio, verifies its SHA-256 and the draft's original run, and copies the exact draft into the replacement. It does not overwrite any manual source or Word draft. The replacement can be edited independently.
4. Describe the change, choose **Preview transcript edit**, inspect the exact original and replacement, then **Save transcript edit**. Preparing confirmation and saving require current source/access pins and a connection. Selecting and correcting a transcript draft can use cached source while offline. The server derives a new source version; the previous version remains available and previous acceptance no longer applies.

The explicit voice commands are **preview transcript edit**, **read transcript edit**, **confirm transcript edit**, and **cancel transcript edit**. Confirmation requires a current prepared preview. Cancel keeps the draft and any uncertain request. It cannot undo or abort a save already submitted; recover its exact request because it may have committed. Reading uses the authorized selected preview, names significant whitespace and explicitly shortens long speech; the on-screen replacement remains complete. Browser command recognition retains its separate provider disclosure and opt-in. It is distinct from offline local audio transcription.

The replacement must be nonempty, valid Unicode and at most 20,000 UTF-16 code units. Whitespace, CRLF, LaTeX commands and literal command-like text are preserved; nothing is silently truncated or summarized. Word retains the existing supported single-run, main-document, single-line replacement limits, producing tracked deletion and insertion in a new package. It does not support signed packages, arbitrary Word fields, notes, multiple runs or full document-layout editing.

## Exact source and provenance

`POST /api/revisions/:id/transcript-edits` requires an `Idempotency-Key`. The canonical `phabricator.transcript-edit.v1` input includes the revision ID, immutable version ID, version number, source hash, access epoch, exact text anchor or Word range, replacement, message and compact client-reported transcript provenance. The server recomputes the replacement hash and canonical request hash. Under the writer lock it checks current authority, head, source hash and exact quotation/context before deriving the next version. Word processing runs in a bounded worker and rechecks these conditions before committing; disconnect and shutdown cancel pending processing.

The request sends no audio or separate copy of the original model transcript. It sends the selected original source quotation, reviewed replacement and provenance to the workspace server; the replacement includes whatever transcript text the user explicitly approves. Provenance includes the clip/run identities, audio hash and byte count, pinned model/revision/manifest, runtime version, and separate original/edited text hashes. `RevisionVersion.transcriptEdit` records this metadata with the exact source and operation hash at version creation. The version's normal authenticated attribution records who saved it and when. These are **client-reported claims**, not server proof of speech recognition, trusted attestation or AI review evidence. Source acceptance and review records remain separate.

The server derives text changes from the stored source and preserves unrelated files and figure bindings. It never accepts a client-supplied replacement file tree or Word projection. Every response is checked against the immutable stored operation; historical exact retries remain possible after another source version has been saved, subject to current permissions and source access. Reusing a request ID with different content fails.

## Retention and recovery

Drafts and uncertain requests are separate from manual source drafts. Local mode saves them under the mount/workspace storage boundary; password mode retains them only in the current authenticated tab session. Storage failures and competing-tab conflicts retain a separate memory copy for explicit export before reload or session lock. Audio and original transcript retention continue to follow the audio inbox rules.

These source edits never enter the automatic outbox. Reconnecting does not save or retry them. If the server response is lost, **Retry exact transcript edit** resends the same request ID and body, even if the originating local recording or model was subsequently removed. Export the request before forgetting it: a source version may already exist. A newer source requires a new passage selection and preview; drafts are never automatically rebased.

Source, route, permission, session and selection changes retire confirmation and stale speech. Losing edit access, repository access, a source Word file or a preserved figure holds dependent work for export or discard; restoring access does not silently revive a held request. Session lock clears password-session private memory. A later receipt cannot replace another view's newer draft.

## Verification

`npm run check`, `npm test` and production builds at `/` and `/workspace/` passed. The full local suite reported **1,742 tests: 1,733 passed, nine optional TeX tests skipped, zero failures**. The targeted Chromium matrix passed **144 cases**, split across desktop/mobile viewports and both mounts: 28 seeded transcript-edit cases, four actual offline-ASR-to-paper cases and 112 affected authentication, Word, discussion voice, comparison, finding and mounting regressions. Physical phones remain a separate qualification target.

The actual-ASR cases install the pinned public model, transcribe the public audio fixture offline, correct an unsaved transcript, choose a cached paper passage and save exactly one reviewed replacement after reconnecting. They verify exact CRLF/Unicode/LaTeX, original versions, unrelated files, compact provenance, no automatic reconnect save, and no audio or separate original-transcript upload. Seeded fixtures test UI and provenance handling; they are explicitly separate from actual model inference.

Server and portable tests cover malformed/oversized/no-op input, whole-source rehashing, stale pins, current account/source permissions, exact historical replay, concurrent writers, receipt substitution, transactional rollback and acceptance invalidation. Word checks use real tracked packages and preserve original bytes; worker cancellation, shutdown and HTTP disconnect cannot commit a late version. Retention checks cover quota failures, competing tabs, lock absence, late writers, cleanup under the corresponding writer lock and session/access retirement.

Browser checks cover exact preview and explicit confirmation, voice cancellation, same-version passage changes, a lost receipt across offline reload, discovery of the saved head before its replay response, and changing source before a late receipt. Earlier builds reproduced the stale-preview, displaced-draft and replay/head defects; the corrected builds pass those checks. Mobile text previews and tracked Word changes were inspected visually, with horizontal-overflow assertions. The served root build matches the tested assets, and the existing local preview's complete schema, records, row identities, foreign keys, integrity and health/document responses were preserved. Schema remains 34; no migration or new runtime dependency was added.

## Remaining scope

Full hands-free destination selection and dictation, multi-passage proposals, natural-language transformations, multilingual transcription, Word edits beyond the supported range, durable authenticated offline storage, cross-device synchronization and physical-phone performance qualification remain open. This capability extends the archived upstream feature set; it does not establish full Phabricator parity.
