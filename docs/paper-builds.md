# Paper builds and exact source versions

Paper compilation is an explicit operation on a saved paper revision. Each request identifies the immutable version ID, its SHA-256 content hash, a `.tex` entrypoint in that snapshot, and the operator's compiler configuration ID. Saving another version never retargets a submitted build. Building an older version is supported and remains visibly associated with that version.

The compiler runs in a separate, isolated container. The application has no fallback that executes TeX on the API host, downloads packages during compilation, sends manuscripts to an external service, or reports a simulated PDF as a successful build. See [the worker configuration](tex-worker.md) for the pinned engine, package bundle, container image and resource limits. An unconfigured compiler is explicitly unavailable; a configured runtime that cannot execute a job reports a failed build.

## Jobs, attempts and artifacts

Accepted requests are persisted before compilation starts. The job continues after its HTTP request or CLI process ends. Jobs move from `queued` to `running`, then `succeeded`, `failed` or `canceled`. At most two jobs hold active worker leases, with a bounded pending queue. Leases and attempt identities fence publication: a late result from an interrupted attempt cannot become the current result. Server restart recovers unfinished work with a new attempt, subject to the attempt limit and a fresh authority check.

Explicit retry creates another job for the original source and toolchain. It does not follow a new manuscript version or silently adopt an upgraded compiler. A changed compiler configuration requires a new, explicitly selected compilation. Cancellation applies to the selected job and stops its active attempt. It neither cancels another job nor alters any source or review evidence.

All mutation requests require an idempotency key. Repeating the same key, operation and body returns the original saved receipt after current authorization checks. The receipt can say `queued` even when the job has since finished; read the job again for its current state. Reusing a key for different inputs is a conflict. Browser requests retain the exact submitted intent for explicit recovery after a lost response. Compilation requests are never ordinary offline-outbox entries and never submit merely because the connection returns.

A successful job publishes its PDF, bounded compiler log, manifest, compressed SyncTeX and normalized source map atomically with its terminal state. Each artifact records its SHA-256 and byte length and belongs to one job attempt. Failed or canceled jobs cannot inherit a previous successful PDF. Earlier successful jobs remain separate entries in build history. Source snapshots, comments, acceptance and local/AI review evidence are unchanged by compilation.

Artifacts are currently stored in the same SQLite database as their job records, so the application's consistent database backup preserves both. Artifact bytes are immutable after publication. General external storage engines, retention policies and garbage collection remain future work.

## Permissions and private viewing

Submitting, retrying and canceling require the token's write scope and current edit access to the paper. The original submitting credential, account and source access are rechecked at claim, during execution and before publication. Revocation, expiry or account disablement prevents later publication. This includes the paper's restrictive Space and the continuing repository visibility requirement of an imported paper.

Build history, diagnostics, mappings and artifact downloads require current read authority and paper visibility. Possession of a build ID or artifact digest does not grant access. Artifacts have private, no-store responses; download routes are authenticated and do not create public sharing links. A public source-code repository does not make workspace manuscripts public.

The browser verifies artifact size and digest before opening the PDF. PDF rendering uses a locally bundled PDF.js worker rather than an external viewer. Loaded artifact bytes remain in component memory. Account changes and known source-access loss retire pending reads and rendered private content. Local-mode pending request metadata can survive reload; password-mode pending intents remain in the verified session's tab memory, consistent with the existing authenticated offline boundary.

## API

Paths are relative to `APP_BASE_PATH`. Shared contracts are in `shared/paper-builds.ts`.

| Operation | Contract |
| --- | --- |
| `GET /api/revisions/:id/paper-builds?before=N&limit=N` | `PaperBuildPage`: newest-first history, exclusive sequence cursor, default 25 and maximum 100, compiler configuration and current access epoch. |
| `POST /api/revisions/:id/paper-builds` | `PaperBuildInput` with `versionId`, `contentHash`, `entrypoint`, `toolchainId`; returns the queued `PaperBuild` receipt. |
| `GET /api/revisions/:id/paper-builds/:buildId` | `PaperBuildDetail`: current job and access epoch. |
| `POST /api/revisions/:id/paper-builds/:buildId/cancel` | Empty object; returns the selected job's cancellation receipt. |
| `POST /api/revisions/:id/paper-builds/:buildId/retry` | Empty object; creates a new job for a terminal job's exact source and toolchain. |
| `GET /api/revisions/:id/paper-builds/:buildId/artifacts/:kind` | Private artifact bytes with recorded media type, download filename, length and `X-Access-Epoch`. Kinds: `pdf`, `log`, `manifest`, `synctex`, `mapping`. |
| `GET /api/revisions/:id/paper-builds/:buildId/synctex` | Normalized map plus immutable version ID, content hash and access epoch. Page coordinates use points with a top-left origin. |

Missing compiler configuration returns `503`; stale source/toolchain pins return `409`. Hidden objects and artifacts remain unavailable even on idempotent retries. Validation and permission errors are not successful jobs.

## CLI

Use actual IDs and hashes from your workspace. The commands honor `PHABRICATOR_URL`, an application path prefix and authenticated `PHABRICATOR_TOKEN` requests.

```sh
# Inspect source pins and the operator's current toolchain ID.
npm run arc -- export P2 --version 1
npm run arc -- builds P2 --json

# Submit the exact inspected source; the request ID is printed before submission.
npm run arc -- compile P2 --version-id VERSION_ID --content-hash SOURCE_SHA256 \
  --entrypoint paper/main.tex --toolchain-id TOOLCHAIN_SHA256 --request-id REQUEST_ID

# Read durable progress, cancel, or explicitly retry a finished build.
npm run arc -- build P2 BUILD_ID
npm run arc -- cancel-build P2 BUILD_ID --request-id CANCEL_REQUEST_ID
npm run arc -- retry-build P2 BUILD_ID --request-id RETRY_REQUEST_ID

# Download an artifact to a new file after checking its recorded size and hash.
npm run arc -- download-build P2 BUILD_ID --artifact pdf --output paper.pdf
npm run arc -- download-build P2 BUILD_ID --artifact manifest --output manifest.json
```

The CLI never chooses the latest source version for compilation. Artifact downloads refuse existing files and symbolic links at the output filename, and server-provided artifact names never choose local paths. Text summaries escape terminal control characters; JSON preserves source strings as JSON data.

## Historical behavior and remaining scope

The pinned upstream Harbormaster creates a new generation when a build restarts, incorporates that generation into artifact identity, and checks artifact visibility. This implementation preserves those principles for paper jobs; it is not a complete Harbormaster build-plan engine or Files application. References: `HarbormasterBuildTarget.php`'s `buildGeneration` contract, `HarbormasterBuildArtifact::getArtifactIndex`, and `HarbormasterFileArtifact::loadArtifactFile` in the read-only upstream source pinned by `upstream-lock.tsv`.

This workflow currently starts from the application's UTF-8 text snapshots. Multi-file TeX and bibliography support does not imply support for binary figures, arbitrary packages or executable document configuration. Binary assets need versioned attachment storage. Rendered PDF comparison, DOCX round trips, generic build plans/steps, external build-result reporting, signed export packets and remote worker fleets remain tracked gaps. SyncTeX describes compiler locations; it is not semantic paragraph identity or proof that a scientific or legal claim is correct.
