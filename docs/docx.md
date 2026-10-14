# Word document review

Word documents use the existing document revision IDs (`L1`, `L2`, …). The DOCX
package is the authoritative source. Its structural reading view is stored with
each immutable version; it is never treated as editable Markdown or LaTeX.

In Drafts, choose **Import Word Document**, upload or select a File, inspect its
contents, and choose the document's audience. Sharing the source File with that
audience is a separate explicit choice, disabled by default. A reader must be
able to view the revision and every original source File in its history.
Restricting or detaching an earlier source also restricts later derived versions.
The File's Space remains an upper limit on sharing.

The reading view includes paragraphs, structural headings, table-cell text,
footnotes and endnotes, imported comment text, and a tracked-change inventory.
Word author names and dates are imported metadata, not authenticated application
accounts, reviews, or acceptance evidence. This is a structural view, not Word
pagination or a complete rendering of every field, object, or formatting rule.
Warnings identify preserved content whose interpretation is incomplete.

Editors can replace a supported passage in an ordinary text run. The preview
shows the exact original and proposed text before **Save Tracked Edit**.
The package records a tracked deletion and insertion attributed to the signed-in
editor; unchanged text and run formatting are retained. Existing revisions,
fields, hyperlinks, content controls, and other unsupported structures are not
flattened to make them editable. Unsupported edits fail before saving.

**Edit Multiple Passages** prepares an edit set across ordinary main-document
paragraphs. Each passage can span multiple differently formatted runs within
its paragraph. Select text or use the character controls, write its replacement,
and choose **Add Passage to Edit Set**. The complete original and replacement
for every selected passage remains available in the preview, including on
mobile. **Save All … Tracked Edits** explicitly submits the entire set as one
new immutable Word version. There is no fixed passage-count limit. The JSON
selection is limited to 512 KiB, and each quotation and replacement to 20,000
UTF-16 code units, alongside the package processing bounds below.

Every source quotation is checked against the same original projection and
package before any output is written. Overlapping selections, unchanged
replacements, invalid Unicode boundaries and any unsupported final passage
reject the whole set. A passage cannot cross a paragraph boundary; select
separate passages in multiple paragraphs instead. Deletions retain the original
formatting of each removed run. Replacement text inherits the first selected
run's formatting; the operation does not guess formatting for newly written
words. Empty replacement text is an explicit tracked deletion.

The batch surface conservatively requires complete ordinary paragraphs directly
inside the document body. Tables, note bodies/references, fields, bookmarks,
Word comment anchors, hyperlinks, content controls and existing tracked changes
in a selected paragraph are refused instead of flattened. Unsupported structure
may only be visible to the original package validator, which rejects the
complete request. Unrelated structures elsewhere remain untouched. A paragraph
with a newly tracked edit consequently cannot take another batch edit until its
changes are accepted outside this application and the resulting package is
explicitly reimported. The existing single-run editor and endpoint retain their
earlier supported scope.

An edit-set draft pins the original version ID, content hash (including its
projection), package digest and continuing source File identity. Moving to a
newer head never relocates it. Offline drafts and uncertain requests remain
available for export; reconnecting does not submit them. Exact retries retain
the complete ordered selection, original access epoch and idempotency key.
Recovery verifies the recorded operation digest and historical resulting
version before clearing the matching request. A newer draft typed while a
request is unresolved remains separate and is not erased by that receipt.

Download selects one immutable version, verifies its byte length and SHA-256,
and exports a DOCX. Import Next Version adds a complete replacement package and
retains the earlier source and discussion. Application discussion is separate
from imported Word comments. Editing never implicitly adds those discussions
to the Word package; a selected discussion export is an explicit operation.

## Comparing Word versions

The text comparison comes before revision management. The exact version pair, scope and Words/Lines controls remain visible; **Word comparison options** contains secondary navigation, reader actions and full projection/package details. A text-only limitation and package-equality notice remain visible with the redline, even when options are closed. Reader and discussion versions remain independent of the comparison pair.

Choose **Compare Word Versions** to inspect text changes between two immutable
packages. The first comparison starts from the selected reader version and its
predecessor; a saved comparison reopens its exact pair. Choose any forward,
reverse or equal pair, or an empty base. New document versions do not move the
chosen pair. **Read compared Word version** explicitly changes the reader and
its discussion context; comparison controls alone leave them on their original
version.

The main document, footnotes and endnotes are separate scopes. Word and line
differences retain literal whitespace. The optional space/tab-only navigation
filter skips those passages without hiding their text. Touch buttons, `j`/`k`
and read-only voice commands share the current change cursor; `Shift+J`/`Shift+K`
and next/previous-file commands move between Word scopes. Narration identifies
the selected versions and scope; its context also pins the package hashes.
Changing that context, closing
the comparison, or losing source/session access cancels it.

This compares the **stored text projection**, not Word's complete accepted or
final document. It traverses the full stored blocks and runs, excluding runs
marked deleted or move-from and retaining ordinary, inserted and move-to runs.
It never uses the reader's visible slice or `block.text`, which includes deleted
text. Projection v1 does not fully represent revisions around whole paragraphs
or rows, paragraph-mark revisions, fields, objects, formatting or pagination.
Imported comment bodies are outside these scopes. Existing parser warnings
remain available alongside the comparison.

One LF separates stored blocks; two LFs separate notes. Note-ID headers and
note-reference markers are synthetic and explicitly disclosed. IDs and stored
order are compared literally; this does not infer note renumbering, semantic
matching, paragraph moves or table structure. Comparison offsets and line
numbers refer to this synthetic text and cannot create passage comments or
edits. Original DOCX packages, source hashes, discussion anchors and acceptance
evidence remain unchanged. Equal projected text does not establish equal
packages; the UI reports package digest equality separately.

The portable projection adapter bounds total traversal to 8,000 blocks, 40,000
runs, 4,000 notes, 200 warnings, two million source UTF-16 code units, and two
million metadata code units. Metadata strings are individually limited to 4,000
code units. Combined output across the scopes is limited to 200,000 code units.
Malformed, unsupported or oversized projections produce no partial comparison;
the existing [bounded comparison limits](comparisons.md) apply afterward.

Saved choices contain only immutable version IDs, content hashes, package hashes
and presentation preferences. Missing or mismatched pins show an unavailable
state rather than selecting a newer version. Local mode can reopen cached,
authorized source offline; password mode keeps it in the verified session's
memory. Historical source File access remains a condition of viewing every
derived version. Losing that access clears the saved comparison as well as
the source cache. Comparison is read-only: it never queues a mutation, invokes
AI, accepts imported changes or exports a new package.

## Passage discussion and Word comment export

Choose **Discuss passage** in the main document to discuss a supported
ordinary text run. Select text or use the character controls, inspect the exact
quotation, then write a review comment. The thread records its original version
ID, content hash, package part, block, range, UTF-16 offsets, quotation and bounded
context. Replies inherit that anchor. Opening another version never relocates
a Word thread by matching similar wording. Open its original version to inspect
the evidence it addressed. Existing general discussion remains supported.

Passage drafts use the same retention and recovery rules as other review
comments: local-mode drafts can enter the explicit comment outbox; authenticated
drafts remain in the verified tab. Source File and revision access continue to
apply. Quota failures retain drafts in memory with an export warning. Posting a
comment, replying, or resolving discussion does not alter the Word package or
accept its content.

Select threads anchored to the inspected original Word version and explicitly
prepare an export. Download becomes available after checking the source and
thread identities, byte length and SHA-256. The resulting DOCX contains one
classic Word comment per selected application thread, with its root message,
all replies, message authors and dates, viewed-version context, and the recorded
application status. Imported Word comments stay intact. Application resolved
state is described in the comment text; this does not invent Word's modern
threaded-comment state or identity mapping.

Export binds an immutable Word version and every selected thread's current
version, and checks them again after package processing. An intervening reply,
resolution, changed access, or invalid source rejects the entire export. A newer
document head does not prevent an explicit export of an older pinned version.
Exports do not create revision versions, Files or acceptance evidence. The
original version's ordinary download remains byte-identical. Reimporting an
export is a separate new-version operation with the usual source policies.

The browser keeps prepared bytes in memory and retires them when the selected
source, selected thread snapshots, session or access changes. Preparation
requires a connection and never enters the outbox or runs on reconnect.

The current anchor surface covers the parser's supported ordinary runs in the
main story, including supported table cells. Cross-run ranges, notes, existing
tracked-change runs, fields and unsupported structures are not flattened into
editable text. Exports support overlapping selections in one run. They preserve
run formatting and untouched XML around the inserted markers, append to or
create the comments part and its package relationships, and preserve every
unrelated ZIP entry's uncompressed bytes. Signed packages and malformed or
ambiguous comment relationships/anchors are rejected. Export is bounded to
64 selected threads and 500,000 UTF-16 code units of complete generated comment
text in total, in addition to the package and projection limits. Nothing is
silently omitted or truncated to fit.

The classic comment wiring follows Microsoft's
[WordprocessingML insertion contract](https://learn.microsoft.com/en-us/office/open-xml/word/how-to-insert-a-comment-into-a-word-processing-document):
matching range-start, range-end and reference IDs link the main document to the
comments part. This is an extension of the application's immutable passage
discussion model; [upstream Differential](review-threads.md#upstream-relationship-and-gaps)
does not provide DOCX interchange.

## Preservation contract

- Import and unchanged download preserve the entire original ZIP byte-for-byte.
- A supported edit rewrites only the affected lexical XML runs. XML outside those replacements
  remains byte-for-byte identical, including unfamiliar markup. Every untouched
  package entry's uncompressed bytes remain identical. ZIP compression metadata
  may change after an edit.
- Headings, notes, comment ranges, existing tracked changes, relationships,
  media, and opaque parts remain in the package. The reading view does not claim
  to interpret every preserved feature.
- UTF-8 and UTF-16 XML, namespace-prefix variation, and Strict/Transitional Word
  namespaces are supported within the parser's documented bounds.
- Signed packages may be inspected and downloaded unchanged; editing them is
  rejected because it would invalidate the signature. Import does not verify a
  signature's authenticity.
- Reimporting an exported package derives its reading view again. Historical
  projections retain their original parser-format identifier and content hash.

The source snapshot format is `phabricator.source.v3`: the package digest and
size, immutable original File identity, filename, and canonical stored projection
are bound into the version's content hash. Earlier text-only and text/figure
snapshot hashes are unchanged. Generated packages belong to revision versions;
they do not create independently downloadable Files.

## Limits and authorization

Package processing runs in disposable workers, with at most two active workers,
a 15-second deadline, and memory limits. Inputs are limited to 16 MiB compressed,
96 MiB inflated, 4,096 entries, 8 MiB per parsed XML part, 32 MiB parsed XML in
total, and a 2 MiB reading projection. XML depth and element counts are bounded.
ZIP checksums and lengths are verified. Duplicate/aliased or unsafe part names,
invalid relationships, encryption, unsupported compression, DTDs, macros, and
ActiveX content types are rejected. External relationships are retained without
fetching their targets. No source is executed or sent to an external provider.

Mutations require an idempotency key and a current permission epoch. Existing
documents also require the exact version number, version ID, and content hash.
Permissions and source pins are checked again after asynchronous processing and
under the commit lock. Retrying an identical request returns its historical
receipt, even if the document has since advanced; it does not select a new head.
A changed request requires a new key. Revoked access cannot be restored by replay.

Reading projections and local edit drafts support offline revisits. Package
mutations require an explicit online submission; binary edits do not enter the
automatic outbox. Revocation invalidates the source File and dependent document
caches, and retires pending reads and retained intents as appropriate.

## CLI and HTTP

First upload with `arc upload-file`, then inspect the exact File:

```sh
npm run arc -- inspect-docx F1
npm run arc -- import-docx import-request.json --request-id original-import
npm run arc -- edit-docx L1 --intent edit-request.json --request-id original-edit
npm run arc -- reimport-docx L1 --intent reimport-request.json --request-id original-reimport
npm run arc -- download-docx L1 --version 2 --version-id VERSION_ID --content-hash SHA256 --output new-document.docx
npm run arc -- comment-docx L1 --intent comment-request.json --request-id original-comment
npm run arc -- export-docx-discussion L1 --intent discussion-export.json --output reviewed-document.docx
```

An import request contains:

```json
{
  "title": "Motion draft",
  "testPlan": "Compared the proposed changes with the original draft.",
  "sourceFile": { "fileId": "F1", "sha256": "SHA256_FROM_INSPECTION", "bytes": 42000 },
  "expectedAccessEpoch": 12,
  "shareSource": false
}
```

An edit request contains:

```json
{
  "expectedVersion": 1,
  "expectedVersionId": "VERSION_ID",
  "expectedContentHash": "CONTENT_HASH",
  "expectedAccessEpoch": 12,
  "rangeId": "RANGE_ID_FROM_THE_STORED_PROJECTION",
  "start": 0,
  "end": 8,
  "quote": "Original",
  "replacement": "Revised",
  "message": "Clarified the argument"
}
```

Offsets are UTF-16 code units within one inspected editable range. Replacements
are limited to 20,000 characters and single-line text; they cannot split a
Unicode surrogate pair. Reimport requests use the same version/access pins plus
`sourceFile`, `shareSource`, and `message`, without a text range. Optional import
`access` uses the application's standard new-object policy shape.

A passage comment request contains `versionId`, `body`, and
`docxPassage: { rangeId, start, end, quote }`. It cannot also specify a text-file
path, line, text passage or suggested replacement. The server derives the full
stored Word anchor from that immutable version.

A discussion export request contains:

```json
{
  "versionId": "ORIGINAL_VERSION_ID",
  "contentHash": "ORIGINAL_CONTENT_HASH",
  "expectedAccessEpoch": 12,
  "threads": [{ "threadId": "THREAD_ID", "expectedThreadVersion": 3 }]
}
```

The CLI preserves the ordered thread selection and original request pins. It
verifies the source snapshot and export bytes, then publishes a complete private
file atomically without overwriting an existing path or symlink. Its receipt
contains identifiers and digests, without printing source or comment text.
Export accepts read-scoped credentials; creating discussion requires interact
permission and token write scope. No idempotency key is needed for an export
because it does not write workspace state.

| Operation | Endpoint |
| --- | --- |
| Inspect an uploaded File | `GET /api/files/F1/docx` |
| Create a Word revision | `POST /api/revisions/docx` |
| Import the next package | `POST /api/revisions/L1/docx/import` |
| Apply a tracked replacement | `POST /api/revisions/L1/docx/replace` |
| Apply one complete tracked edit set | `POST /api/revisions/L1/docx/replace-batch` |
| Download exact version bytes | `GET /api/revisions/L1/docx/VERSION_ID/download` |
| Create an exact Word passage thread | `POST /api/revisions/L1/comments` with `docxPassage` |
| Prepare selected threads as Word comments | `POST /api/revisions/L1/docx/export-discussion` |

CLI downloads verify the snapshot hash and package bytes and create a new file
with private permissions. They never overwrite an existing file or follow a
destination symlink. Retain the original request JSON and request ID for an
uncertain-result retry; the CLI does not silently refresh old pins.

The batch endpoint takes the same `expectedVersion`, `expectedVersionId`,
`expectedContentHash`, `expectedAccessEpoch` and `message` pins, plus
`replacements: [{ blockId, start, end, quote, replacement }, ...]`. `blockId`
comes from the stored projection's main-document blocks. Its offsets refer to
the complete paragraph text, in UTF-16 code units, rather than one run. Order
is part of request identity; it is never silently reordered for replay. Batch
processing and final commit both revalidate the original source and current
authority. The browser supports this endpoint; `arc edit-docx` remains the
single-run command.

## Remaining work

D105 remains partial. General rich editing, cross-paragraph replacements, paragraph or
table restructuring, accepting/rejecting imported changes, editing imported Word
comments, modern threaded-comment semantics, cross-run/note/field discussion
anchors, cross-version mapping and complete page layout are not implemented.
Automated local/hosted review and citation indexing currently reject DOCX sources
rather than recording evidence for an empty text snapshot. They need explicit
projection scope and coverage before being enabled. Broader Word/LibreOffice
interoperability fixtures and independent schema validation remain required for
full interchange parity.

## D105c verification

The comparison core is exercised with real DOCX import and tracked-edit
fixtures, exact run/Unicode/whitespace reconstruction, note identities,
projection and diff bounds, arbitrary immutable pairs and invalid pins.
Client tests cover source-free persistence, historical File revocation,
unrelated draft preservation and password-session retirement. Narration tests
cover Word scope labels, absent scopes, bounds and limited projection coverage.

`npm run check`, `npm test` and root/subpath production builds pass. The full
suite has 1,604 tests: 1,595 pass and nine optional TeX integration cases skip
without their isolated compiler configuration. Browser verification covers 128
cases across desktop/mobile and root/subpath hosting: 28 new Word comparisons
and 100 existing comparison, navigation, Word editing/discussion and voice
regressions. An existing comment test exposed a read-after-click assertion
race; after waiting for its visible saved thread, the unchanged exact-anchor
assertion passed on all four configurations. Representative layouts were
inspected on both viewports and hosting paths. Installing the tested preview
preserved schema 34, every existing record and its row identity, foreign keys,
and the prior health/document responses; served asset digests match the build.

The package model follows [ECMA-376](https://ecma-international.org/publications-and-standards/standards/ecma-376/)
and Microsoft's descriptions of [WordprocessingML structure](https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document),
[comments](https://learn.microsoft.com/en-us/office/open-xml/word/how-to-retrieve-comments-from-a-word-processing-document),
and [tracked revisions](https://learn.microsoft.com/en-us/office/open-xml/word/how-to-accept-all-revisions-in-a-word-processing-document).
