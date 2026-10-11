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

Download selects one immutable version, verifies its byte length and SHA-256,
and exports a DOCX. Import Next Version adds a complete replacement package and
retains the earlier source and discussion. Whole-version application discussion
is separate from imported Word comments. Editing never implicitly adds those
application discussions to the Word package.

## Preservation contract

- Import and unchanged download preserve the entire original ZIP byte-for-byte.
- A supported edit rewrites one lexical XML run. XML outside that replacement
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
```

An import request contains:

```json
{
  "title": "Motion draft",
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

| Operation | Endpoint |
| --- | --- |
| Inspect an uploaded File | `GET /api/files/F1/docx` |
| Create a Word revision | `POST /api/revisions/docx` |
| Import the next package | `POST /api/revisions/L1/docx/import` |
| Apply a tracked replacement | `POST /api/revisions/L1/docx/replace` |
| Download exact version bytes | `GET /api/revisions/L1/docx/VERSION_ID/download` |

CLI downloads verify the snapshot hash and package bytes and create a new file
with private permissions. They never overwrite an existing file or follow a
destination symlink. Retain the original request JSON and request ID for an
uncertain-result retry; the CLI does not silently refresh old pins.

## Remaining work

D105 remains partial. General rich editing, cross-run replacements, paragraph or
table restructuring, accepting/rejecting imported changes, editing Word comments,
modern threaded-comment semantics, application passage discussions mapped into
Word, generated Word comment export, and complete page layout are not implemented.
Automated local/hosted review and citation indexing currently reject DOCX sources
rather than recording evidence for an empty text snapshot. They need explicit
projection scope and coverage before being enabled. Broader Word/LibreOffice
interoperability fixtures and independent schema validation remain required for
full interchange parity.

The package model follows [ECMA-376](https://ecma-international.org/publications-and-standards/standards/ecma-376/)
and Microsoft's descriptions of [WordprocessingML structure](https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document),
[comments](https://learn.microsoft.com/en-us/office/open-xml/word/how-to-retrieve-comments-from-a-word-processing-document),
and [tracked revisions](https://learn.microsoft.com/en-us/office/open-xml/word/how-to-accept-all-revisions-in-a-word-processing-document).
