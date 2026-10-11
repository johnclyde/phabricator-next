# Files and immutable manuscript figures

Files is an authenticated library of immutable uploads. Each upload receives a new `F` identity, even when its bytes match an existing upload. The server verifies the submitted SHA-256, byte length and canonical base64 before storing anything. Identical bytes share internal storage; knowledge of a digest never creates a File or grants access. The database backup includes the file contents, metadata history, attachments and upload receipts.

The filename and alternative text can change with a checked metadata version. The original filename, author, content type, size, digest and bytes cannot change. Replacing an image means uploading a new File and saving a new manuscript version. Archiving hides a File from the default active list and prevents new attachments; it preserves existing source versions, grants and bytes. There is no destructive deletion or garbage collection in this slice.

## Access and explicit sharing

Uploads start private to the uploader in the default Space. The File author has automatic view/edit access within the File's current Space. Its explicit policy can grant other members access. The existing Access control edits these rules and the Space.

An explicit `attach` relationship also lets current viewers of the attached object view the File, subject to the File's Space. A `reference` records a relationship without granting access. A `detach` removes that relationship's grant. Each binding has an independent optimistic version, starting at zero before its first write. Sharing requires edit access to both the File and target, plus the access epoch from the reviewed audience. A concurrent policy change requires a fresh preview. An attachment grants view access, not automatic File editing.

Visibility is checked on every metadata/history/list/download request and saved mutation replay. Invisible attachment targets are omitted from history and attachment lists. File and source IDs, artifact URLs and digests are not bearer credentials. Raw downloads use private, no-store responses, restrictive content security rules and attachment disposition.

## Exact paper versions

A source version can include up to 100 PNG, JPEG or PDF figure bindings, each at a relative source path. Each binding pins `path`, `fileId`, `sha256`, `bytes` and `mediaType`. Text and figures share one validated namespace: traversal, file/directory conflicts and case or Unicode aliases are rejected. Each upload is at most 16 MiB; a version's total figure bytes are at most 64 MiB. Other File formats remain available as downloads and ordinary attachments, but cannot enter the compiler source manifest.

Text-only content hashes retain their historical format. A nonempty figure manifest uses the portable `phabricator.source.v2` canonical format and includes both text and exact File bindings. A figure change therefore invalidates acceptance just as a text change does. Removing the last figure returns to the text-only canonical format, but produces a new version ID; old acceptance still does not transfer.

Omitting `assets` from a version write preserves the exact expected base version's figures. An explicit array replaces the whole manifest; `[]` removes it. Manifest writes require the exact reviewed version number, ID and content hash, a current access epoch, and explicit sharing of new File identities. Saving a new version never detaches the grants needed by older versions. Suggested text replacements preserve figures. A complete Git text-tree import refuses a current version containing figures; remove them explicitly in a new version before such an import.

Revision details expose historical versions, so revision visibility requires current access to every historical figure, as well as the revision, repository and Space. A direct attachment to that revision supplies the deliberate sharing grant without creating a circular policy dependency. File Space restrictions remain a hard ceiling. Detaching the only grant can make a manuscript and its derived PDFs unavailable to affected readers, including when the current version no longer contains the figure. Reattachment by an authorized editor can restore that access.

Each access decision has a shared budget of 1,024 policy nodes, active attachment edges and distinct source-File checks. Exhausting it denies the entire decision, preventing recursive attachment graphs from monopolizing the server. Historical versions are scanned for distinct File dependencies: repeated figures and ordinary text edits do not consume additional checks. A manuscript accumulating too many distinct historical Files can reach this limit.

Compilation verifies the binary identities again, places their exact bytes beside the text in the read-only source mount, and uses fixed timestamps. Figure builds publish a schema-2 manifest containing those bindings; older text-only builds retain schema 1. Current source access is rechecked throughout the durable job lifecycle and artifact reads. Neither deterministic checks nor current AI review adapters inspect figure contents; persisted review summaries disclose this limitation. Figure bytes are not sent to model providers.

## Browser and command line

The Files application provides mobile list/search, uploads, metadata/history, previews, downloads and explicit attachment controls. PNG/JPEG previews and the locally bundled PDF viewer use verified bytes in memory. Session changes and known access loss retire pending reads and previews. File bytes are excluded from service-worker storage and the offline outbox.

Before upload, the browser retains a source-free request ID, digest, size and metadata for uncertain-result recovery. Local mode can retain this record across reloads; password mode keeps it in the verified tab's memory. Check the receipt before uploading again, or reselect the exact original bytes and retry the original request. Uploads and figure manifest writes never run automatically after reconnection. Ordinary offline text edits preserve their recorded base version's figures.

`arc files`, `file`, `file-history`, `upload-file`, `upload-receipt`, `edit-file`, `attach-file`, `download-file` and `set-figures` expose the same operations. `arc --help` documents exact arguments. Downloads verify size and digest and create a new private output file without overwriting existing files. `set-figures` requires explicit source pins and a JSON manifest; it never selects a newer manuscript head.

| API | Result |
| --- | --- |
| `GET /api/files?name=TEXT&authorId=ID&status=active&before=N&limit=N` | Visibility-filtered File page; default 25, maximum 100. |
| `POST /api/files` | Upload `{name, altText?, dataBase64, sha256, bytes}`; immutable File receipt. |
| `GET /api/files/uploads/:requestId` | Current File metadata for the caller's committed upload receipt. |
| `GET /api/files/:id` | File metadata, first history/attachment pages, access and epoch. |
| `PATCH /api/files/:id` | `{expectedVersion, name?, altText?, status?}`. |
| `GET /api/files/:id/data` | Authenticated bytes with length, digest and access epoch headers. |
| `GET /api/files/:id/history` or `/attachments` | Visible records with `before`/`limit` paging. |
| `GET /api/files/:id/attachments/:objectId` | The exact binding or `null`, plus current access epoch; requires current view of both objects. |
| `POST /api/files/:id/attachments` | `{objectId, mode, expectedVersion, expectedAccessEpoch?}`; epoch required for `attach`. |

All File mutations require an `Idempotency-Key`. The upload route has a separate 24 MiB JSON limit to accommodate base64; ordinary routes retain their 2 MB limit. A saved receipt describes the original write, while ordinary GETs provide current metadata. Schema 16 widens the entity kind constraint in place, preserving old row IDs, child foreign keys, indexes, triggers and evidence.

## Upstream evidence and remaining parity

The pinned archived source distinguishes `attach`, `reference` and `detach` in `PhabricatorFileAttachment`, and automatic uploader/attached-object access in `PhabricatorFile`. `PhabricatorFileUICurtainAttachController` requires confirmation of the audience expansion. `PhabricatorFileEditEngine` supplies name and alternative-text edits. Storage engines hash actual bytes and retain immutable content identity. These sources are read from the exact commit in [upstream-lock.tsv](upstream-lock.tsv).

This is an initial Files slice. Chunked/resumable uploads, transformed thumbnails and media conversions, external storage engines, retention/deletion, email ingestion, upstream import/export compatibility and the full original file editing/comment interface remain gaps. PDF visual comparisons, figure-region review, visual AI analysis and semantic figure references remain document-workflow gaps. Previewing a file is not proof that its scientific or legal contents are correct.
