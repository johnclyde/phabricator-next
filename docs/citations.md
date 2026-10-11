# References and source-inspection records

The References tab inventories the exact selected manuscript version. It shows literal BibTeX entries, LaTeX bibliography items, citation uses, raw fields and source locations. Selecting a reference opens its original source in the comparison view. This is a document-workflow extension to the Phabricator model, not a claim of an upstream application reaching parity.

## What the inventory establishes

The portable TypeScript analyzer reads supplied `.bib`, `.tex`, `.ltx` and `.bbl` files without executing TeX or making network requests. It recognizes nested BibTeX values, quoted and numeric values, string concatenation, `@string` declarations, literal `\bibitem` bodies, and common LaTeX, natbib and biblatex citation commands. Comments and supported verbatim environments are excluded. Fields retain their raw source alongside a resolved value when one can be determined.

An occurrence is `resolved` when exactly one matching entry exists in the supplied snapshot, `ambiguous` when there are multiple matches, `missing` when a complete literal inventory has no match, or `unknown` when unsupported syntax, dynamic keys or resource limits prevent that conclusion. A wildcard such as `\nocite{*}` is not one cited source. Diagnostics and uncertainty remain visible; key existence never establishes that a claim is supported.

This is a snapshot inventory. It does not follow active include or bibliography paths, expand commands, evaluate conditionals, execute bibliography styles, or establish the bibliography that a compiler will render. Literal commands inside macro or conditional bodies can appear in the inventory. A unique string declaration may resolve a forward or cross-file reference; this is not ordered BibTeX execution. Duplicate declarations, undefined style/month macros and cycles remain uncertain. A `\bibitem` outside a literal bibliography environment is explicitly uncertain.

Locations use UTF-16 offsets into the unmodified source and one-based line numbers. Entry and occurrence identities include their file, span and key. The inventory is bounded to 200 files, 4 million source characters total, 1 million per file, 10,000 entries, 20,000 citation uses, 100,000 fields/tokens, nesting depth 64 and 1,000 diagnostics. A resolved field is bounded to 262,144 characters and resolved values total 4 million characters. Entry links are bounded to 100,000 links and 4 million characters of serialized identities. Exceeding a bound makes the result incomplete rather than silently declaring unresolved citations missing.

Local review uses this analyzer under the `text-checks-v2` identifier. Existing stored reviews retain their original identifiers and findings. The References tab and local checks work from retained source while offline.

## Recording an inspected source

A reviewer can choose a concrete bibliography entry or literal citation use, select an uploaded File, and record a verbatim quote, page or other locator, explanatory note and `supports`, `contradicts` or `inconclusive` verdict. The reviewer must explicitly attest that they inspected the source. Literal missing or ambiguous keys can receive a record; dynamic keys and collection wildcards cannot.

Each record pins the manuscript version ID and content hash, exact target identity/location, and supporting File ID, SHA-256, byte length and media type. The server recomputes the target from the immutable source and verifies the File bytes. An older selected version can receive a record, but records never transfer to a later version or to the current head. The quote is retained verbatim; locator and note surrounding whitespace is trimmed. Quote and note are limited to 10,000 characters each and locator to 1,000.

The record is a **reviewer attestation**, not automatic verification or AI output. The quote is supplied by the reviewer; this slice does not extract or match PDF text, verify source identity against a publisher, resolve a DOI, establish scientific validity, or check whether a legal authority remains good law. Recording or retracting an attestation does not change manuscript acceptance.

Records are immutable. The original author or a current manuscript editor, with current interact and source-view access, may append one retraction with a reason. This changes the exposed record version from 1 to 2 while retaining the original statement and attribution. Corrections require a new record. Retraction reasons are limited to 10,000 characters.

## Visibility and recovery

Reading a record requires current access to both the manuscript and its supporting File. Lists filter hidden records before returning visible results. Attestation creation requires manuscript interact access, source view and the current access epoch. Neither operation grants File access. A source File used only as evidence does not become a manuscript source dependency: losing its visibility hides the evidence while leaving the manuscript available under its own policies. Figure dependencies continue to follow the separate [Files contract](files.md).

There is no general activity-feed entry containing evidence existence, quotations or source IDs. The evidence and retraction tables preserve their own history under the intersection of both objects' access rules.

Authorized evidence responses and File bytes stay in tab memory. Reopening, focus and reconnection refresh evidence; known access changes retire displayed and pending responses. Unsaved inspection drafts and exact uncertain-result requests remain exportable. Local mode can retain drafts in browser storage; password mode keeps them in the verified tab. Losing manuscript or supporting File visibility quarantines affected drafts. Writes require an explicit online action and never enter the offline outbox or run automatically after reconnecting.

Every mutation requires an `Idempotency-Key`. Exact retries recheck current authority and return the original receipt, including its historical state after a later retraction. Fresh creation checks the access epoch; an already committed exact retry does not require the old epoch to still be current. Reusing a key for different input fails. Browser and CLI receipt checks bind returned evidence to the original source, target, version and statement.

## API and command line

| API | Result |
| --- | --- |
| `GET /api/revisions/:id/citations?version=N` | Exact version identity, inventory and current access epoch; version is required. |
| `GET /api/revisions/:id/citation-evidence?versionId=ID&targetId=ID&before=N&limit=N` | Visible records for one version; target filter optional, newest first. Default 25, maximum 100; bounded scans may return a continuation with an empty page. |
| `GET /api/revisions/:id/citation-evidence/:recordId` | `{record, accessEpoch}` after checking both objects. |
| `POST /api/revisions/:id/citation-evidence` | `CitationEvidenceInput` with exact pins, statement, `attested: true` and `expectedAccessEpoch`; original record (201). |
| `POST /api/revisions/:id/citation-evidence/:recordId/retract` | `{expectedRecordVersion, reason}`; retained record with appended retraction (200). |

The portable types are in `shared/citation-evidence.ts`. Schema 17 adds the immutable evidence and retraction tables without rewriting existing records, row IDs, indexes or triggers.

```sh
npm run arc -- citations P2 --version 1 --json
npm run arc -- citation-evidence P2 --version-id VERSION_ID
npm run arc -- citation-record P2 RECORD_ID
npm run arc -- record-citation P2 --evidence inspection.json --attest-inspected --request-id REQUEST_ID
npm run arc -- retract-citation P2 RECORD_ID --version 1 --reason-file reason.txt --request-id REQUEST_ID
```

`inspection.json` contains the exact `CitationEvidenceInput`; obtain target/version identities from the inventory and source identities from Files. Inputs are bounded regular UTF-8 files; symlinks and unsupported fields are rejected. The CLI prints a source-free request ID and input digest before sending a mutation. Keep the input file and retry it unchanged with that request ID if the outcome is uncertain. Use `arc check --kind paper` with explicit local source files for offline checks.

## Syntax references and remaining work

Parser research uses the [BibTeX documentation](https://mirrors.mit.edu/CTAN/biblio/bibtex/base/btxdoc.pdf), the LaTeX kernel's [bibliography definitions](https://github.com/latex3/latex2e/blob/develop/base/ltbibl.dtx) and [verbatim definitions](https://github.com/latex3/latex2e/blob/develop/base/ltmiscen.dtx), the [natbib manual](https://mirrors.ctan.org/macros/latex/contrib/natbib/natbib.pdf), and the [biblatex manual source](https://github.com/plk/biblatex/blob/dev/doc/latex/biblatex/biblatex.tex). The analyzer deliberately reports uncertainty beyond its documented literal subset.

D104 remains partial. A claim-to-evidence graph, CSL/structured authority import, bibliography editing and faithful export, publisher metadata lookup, PDF quote anchoring, automated source verification, cross-version evidence correspondence and evidence review packets remain open. These records supply exact provenance for later tools without presenting unperformed verification as fact.
