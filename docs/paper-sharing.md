# Private papers and revocable links

Create Paper starts with **Private — only you**. The first save explicitly sets
View, Edit and Interact to the creator inside the selected Space. Choose
**Workspace members** only when that broader audience is intended. Existing
papers and direct API creation defaults are unchanged.

Open a saved paper, choose the version under **Viewing**, then select **Share**.
Create a link, optionally name it for your records, and copy the address before
closing the dialog. The address is shown only when it is created. The link list
retains labels, versions and revocation status; it cannot recover an address.
Create another link if the address is lost. The list is paginated without a fixed
total link limit.

Anyone holding the link can read that selected version without an account. Its
title is captured when the link is created. Later edits and versions are not
automatically shared. The reader includes local KaTeX previews, file selection,
exact source and individual source downloads. All text files in that version are
shared, including comments embedded in the source. Review discussion, other
versions, account identities, binary attachments, original PDFs, build artifacts
and related workspace objects are not included.

Choose **Revoke link** to permanently disable that address. The paper, versions
and normal permissions remain intact. Downloads or copies already made by a
recipient cannot be recalled. The ordinary `#P3` address and content APIs still
enforce sign-in and object policies; a sharing link does not grant normal
workspace access or editing permission.

## Privacy and authority

The browser generates 32 random bytes (256 bits) for each address. The credential
lives in the URL fragment. Creation sends it in the body of a same-origin POST to
`/api/revisions/Pn/share-links`; reading sends it in a POST body to
`/api/paper-shares/read`. It is not sent in a URL query, path or referrer. The
server stores only its SHA-256 digest, including in retry evidence. Custom API
clients must also generate cryptographically random tokens; validation can check
the token format but cannot prove its randomness. Operators
must not add request-body logging for either route.

A direct shared-link visit does not start a workspace session. Reader requests
omit cookies and use `no-store`; the reader has no persistent content storage,
workspace cache or offline fallback. It clears content when offline or hidden,
rechecks on return, and checks active visible links every 20 seconds. A failed
check clears the displayed paper; stale responses cannot restore it. Server
responses use `no-store` and discourage indexing. These controls do not prevent
a recipient from copying or forwarding a valid link.

Creating, listing and revoking links require current read/write credentials and
View, Edit and Manage Policy on the paper. Every anonymous read rechecks that the
creator is enabled and still has those object permissions, including restrictive
Spaces, repositories and source-file dependencies. Losing authority suspends
access; explicit revocation is permanent. Each read validates the immutable
version and its content hash. Missing, incorrect, revoked and inaccessible links
return the same unavailable response.

## API and storage

- `GET /api/revisions/Pn/share-links?before=N&limit=N` returns link metadata,
  `accessEpoch` and `nextCursor`. The default and maximum page size is 100.
- `POST /api/revisions/Pn/share-links` accepts
  `{token, versionId, contentHash, label}` and a UUID `Idempotency-Key`.
- `POST /api/revisions/Pn/share-links/:linkId/revoke` accepts `{}` and a UUID
  `Idempotency-Key`.
- `POST /api/paper-shares/read` accepts `{token}` without a workspace credential
  and returns only `{title, versionNumber, contentHash, files}`.

Management retries retain the exact request identity. An uncertain creation can
be retried without producing another link; a later retry of a revoked creation
reports its revoked status. Link identities, digest bindings and retry evidence
are immutable. Schema 47 adds link and operation tables without rewriting paper
source, history or evidence. Older binaries reject the newer schema.

## PDF ingestion

The sharing flow accepts saved LaTeX source. PDF-to-LaTeX conversion is not yet
implemented in Create Paper. Convert and review a math PDF separately, then
import its `.tex` source into a private paper. PDF text extraction alone is not
reliable recovery of mathematical notation, and no student document is sent to
an external model implicitly.

## Verification

Type checking and root/mounted production builds passed. The full suite passed
2,581 tests, with nine optional TeX tests skipped and no failures (2,590 total).
Fourteen sharing API/security tests cover ordinary access denial, discovery
filtering, exact snapshots, credential hashing, retries, permanent revocation,
restart, creator/Space/repository/historical File restrictions, pagination and
migration preservation/rollback. The browser matrix covers 112 distinct checks
across desktop/mobile at root and mounted paths. All six sharing cases passed
against the final build at both viewports and mounts, including exact source
and KaTeX, private creation, credential/storage isolation, offline clearing,
delayed-response rejection and retained workspace drafts with cross-tab sign-out.
