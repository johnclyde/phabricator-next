# Observing local Git repositories

Diffusion can browse an operator-configured bare Git repository. Register the repository in the application, then bind its ID to an absolute path on the server. The registered remote URL and default branch remain descriptive metadata: creating or opening a repository never clones, fetches, pushes, checks out files, or contacts that remote.

Configure the reusable server with a JSON mapping in its environment, for example:

```dotenv
APP_GIT_REPOSITORIES='{"R1":"/srv/git/example.git","R2":"/srv/git/research.git"}'
```

Restart the server after changing this mapping. Omit it, or use `{}`, to leave all repositories unconfigured. The IDs must identify registered repositories; the application does not create registry entries from configuration. Only the server operator selects paths. No API accepts a host filesystem path, and paths from this mapping are absent from browser responses.

Use repositories that the operator controls. The observer requires a supported Git executable and a complete bare repository. Working checkouts, shallow or partial/promisor repositories, external object alternates, replacement objects, grafts, and unsupported repository configuration are rejected. Git runs with a restricted environment, a fixed set of read operations, output limits, timeouts, and a bounded queue. It does not run hooks, filters, text conversion, or network operations. Detailed repository availability is visible only to readers who retain both repository and Space access.

A registered repository can report three states: ready, unconfigured, or unavailable. An unavailable binding does not fall back to its remote URL. Correct the operator configuration or local repository and retry. The service remains loopback-only; these settings do not enable network hosting or replace authentication.

## Browser and CLI

Open a repository from Diffusion or use the typed/voice command “open repository 1”. Choose a branch or tag and select **Open Selected Reference**, or enter a complete commit ID. The view keeps that immutable commit while you browse directories, files, parents and commit history. Refreshing references only updates the available choices. Open a reference again explicitly to move to its newly observed commit.

Source is rendered as literal text. Binary files, invalid UTF-8, oversized files, symbolic links and submodules have explicit states; none is displayed as an empty text file. Empty files and empty directories are distinct. File history keeps its original path and returns to its containing directory, even after the source cache is evicted. History does not infer renames.

Local mode retains at most 16 repository response entries and 2 MB per repository in browser storage. This is a bounded cache of visited snapshots, not a complete offline clone. Password mode retains content only in the verified current tab. The commit/path selection contains no source text. Access or identity changes remove retained source; stale responses cannot restore it. Reloading or choosing a different snapshot discards pending results from the previous selection. Browser storage failures are visible, and previously loaded data is identified as cached when a network read fails.

The CLI uses the same authenticated APIs and mount path:

```sh
npm run arc -- repositories --json
npm run arc -- show R1
npm run arc -- refs R1 --json
npm run arc -- browse R1 --commit FULL_COMMIT_ID
npm run arc -- browse R1 --commit FULL_COMMIT_ID --path docs/paper.tex --file --json
npm run arc -- history R1 --commit FULL_COMMIT_ID --path docs/paper.tex --limit 25 --json
```

Replace `FULL_COMMIT_ID` with a `commitId` from the reference response. History returns one page and an optional `nextAfter`; pass that value as `--after` with the same commit and path. `--json` preserves the returned source string. Human-readable terminal output escapes control characters, preserving text line breaks and tabs in file contents. A token with only `read` scope can perform these commands. They do not import files into a review or operate on a working copy.

## Read APIs

Every endpoint requires current repository view access and, in password mode, an authenticated session or a token with `read` scope. Cookie sessions also require their session-context header. Repository and Space policies and credentials are checked before the read and again afterward, including failures. Git waits happen outside database transactions. Disconnects and application shutdown cancel pending reads.

| Endpoint | Meaning |
| --- | --- |
| `GET /api/repositories/R1` | Registry metadata, current access, and observer availability. |
| `GET /api/repositories/R1/refs` | Current branch/tag observations and observed HEAD commit. |
| `GET /api/repositories/R1/commits/<full-object-id>` | Exact commit metadata and parents. |
| `GET /api/repositories/R1/tree?commit=<full-object-id>&path=<directory>` | Entries in that commit's selected directory; omit `path` for the root. |
| `GET /api/repositories/R1/blob?commit=<full-object-id>&path=<file>` | Exact selected file, or an explicit nontext/unsupported state. |
| `GET /api/repositories/R1/history?commit=<full-object-id>&path=<optional-path>&after=0&limit=25` | Commit history from a pinned starting commit, optionally limited to a path. |

Object IDs must be complete lowercase SHA-1 or SHA-256 values, consistent with the repository's object format. Select a branch or tag's returned `commitId`, then use that immutable ID for subsequent reads. Branch names, abbreviated IDs, revision expressions, and refspecs are not accepted as commit selectors. Reference observations can change; already selected commit identities do not silently follow branch movement. An object removed by operator maintenance may become unavailable.

Query parameters must occur at most once and unknown parameters are rejected. Paths address entries within a Git tree, never the server filesystem. Empty components, `.` and `..` components, NUL bytes, and paths over 4,096 UTF-16 code units are rejected. URL-encode paths when building requests. Symbolic links and submodule entries are reported as such and are not followed.

History defaults to 25 commits per page, allows 1–100, and uses a nonnegative numeric `after` offset up to 100,000; use the returned `nextAfter` with the same commit/path. Reads are bounded to 1,000 refs or tree entries and 2 MB of command output. Text blobs are limited to 256,000 bytes. Binary, oversized, unsupported-encoding, symlink, and submodule files have explicit states instead of fabricated empty contents. Commit messages are bounded to 16,000 bytes with an explicit truncation indicator. Limit errors are not empty result sets.

Responses include a current `accessEpoch` and are served with `Cache-Control: no-store`. A missing or hidden repository has the same `OBJECT_UNAVAILABLE` response. Missing Git objects use `GIT_OBJECT_UNAVAILABLE`, which does not imply that the repository itself became hidden. Invalid inputs use `GIT_INVALID_QUERY`; limit, queue, availability, and cancellation failures have distinct `GIT_*` codes. Errors do not disclose configured host paths.

Repository browsing is read-only. It never changes Git objects or references, and viewing source does not create review evidence. Repository hosting, clone/fetch orchestration, SSH or HTTP serving, push policy, commit-record import, commit review and blame remain separate work. Explicit source import into a revision is described below.

## Import a complete text tree into review

From a pinned repository snapshot, explicitly import the entire commit as a new code, paper or document review. The browser asks for the kind and title; the CLI equivalent is:

```sh
npm run arc -- import-git R1 --commit FULL_COMMIT_ID --kind paper --title "Review the paper"
```

The server verifies the exact commit, every directory and every file before creating anything. It imports every supported tracked file; it does not apply ignore rules, select only the visible directory or silently omit unsupported entries. Both ordinary and executable text files are supported. It never checks out or executes source, runs TeX, follows links, fetches submodules or starts AI review.

The initial revision engine accepts 1–100 UTF-8 text files, each within the observer's 256,000-byte preview limit, with at most 1.5 MB of total source. Paths must satisfy the revision format: at most 240 characters, relative, without empty/dot components, backslashes, control characters or colons. The whole traversal is also bounded to 1,000 entries and the observer's single operation deadline. Binary/NUL content, invalid UTF-8, symlinks, submodules, empty trees/subtrees, unsupported paths and exceeded limits reject the whole import. No partial revision, activity or success receipt is committed. Supporting general binary trees and editable Git file modes remains separate work.

The resulting immutable version includes `gitSource`: repository, object format, commit ID, tree ID, `complete-text-tree` scope, and a manifest of exact paths, original `100644`/`100755` modes and blob IDs. UTF-8 BOMs are preserved. The normal version content hash and authenticated actor attribution remain present. Source export includes this provenance. Ordinary later edits and suggestion applications create fresh versions without copying `gitSource`; earlier versions retain it. Such edits retain the repository access dependency but do not claim a new Git tree or preserve a landing-ready mode manifest.

Import requires a token with `write` scope or an authenticated browser writer, plus repository edit access. The new revision receives the repository's current Space and exact view/edit/interact rules under the final writer lock. An archived source Space rejects new imports while permitting authorized reads and retries of already saved imports. Callers cannot supply an alternative Space, broader rules, source files or provenance. Every repository-linked revision also requires continuing source-repository and source-Space visibility, including manually uploaded linked revisions and edited imported versions. Its own policy can further restrict access. See [policy semantics](policies.md).

`POST /api/repositories/R1/import-revision` accepts `{commitId, kind, title, summary?, projectId?}` and returns a `RevisionDetail`. Git collection runs outside SQLite transactions. The server revalidates credentials, source access and the destination under the writer lock, then creates the revision, first version, copied policy, activity and retry receipt atomically. Disconnects and application shutdown cancel unfinished collection. A failed collector is followed by an access check before its failure is disclosed.

Use an `Idempotency-Key` to recover an uncertain result. Repeating the same request with the same key returns the saved creation response only while current source and created-revision permissions allow it. A saved successful result does not require the original Git copy to remain available. Reusing a key with different input fails explicitly. CLI `import-git` prints its request ID before submission; retry the same input with `--request-id KEY`. Its JSON response stays on stdout. Browser imports retain the original submitted input/key for explicit retry, including across local-mode reloads; password-mode intent stays in the current tab. Imports are never queued for automatic offline replay.

A newly hidden imported revision returns `REVISION_REFERENCE_UNAVAILABLE` on an import receipt request so that it does not incorrectly revoke access to a still-visible repository. Losing the repository itself continues to use `OBJECT_UNAVAILABLE`. Known repository access loss also clears derived revision source caches, cancels their requests, and sets unsaved work aside through the existing recovery controls.

## Upstream correspondence and verification

These are the GIT-01/P303a browsing and P303b source-import subsets, based on Phabricator `5720a38cfe95b00ca4be5016dd0d2f3195f4fa04`:

- [Browse queries](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/diffusion/conduit/DiffusionBrowseQueryConduitAPIMethod.php) identify a commit and path and distinguish trees, files and submodules. Our API requires an explicit full commit and reads exact tree objects; directory pagination and upstream deleted-path recovery remain gaps.
- [Git file content](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/diffusion/query/filecontent/DiffusionGitFileContentQuery.php) reads the blob at a commit/path. Our adapter verifies raw object hashes and exposes bounded UTF-8 content with explicit unsupported states.
- [History queries](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/diffusion/conduit/DiffusionHistoryQueryConduitAPIMethod.php) use commit/path, offset/limit and parent relationships. Our initial history supports one exact starting commit and optional literal path. Two-commit ranges, direct/child change details and imported commit metadata remain gaps.
- [Differential diff creation](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/conduit/DifferentialCreateDiffConduitAPIMethod.php) records repository/VCS/base provenance. Our import records a complete immutable text-tree snapshot. It does not reproduce working-copy ranges, hunk/changeset submission or upstream Conduit request formats.

Disposable real Git fixtures exercise SHA-1 and SHA-256, merges, branches, lightweight and annotated tags, tags that do not point to commits, branch movement, Unicode and BOM preservation, literal unusual filenames, empty and special files, malformed objects, hash mismatch, rejected configurations, bounded execution and cancellation. API integration verifies permissions before and after reads, credential/session changes, disconnects and path-prefix hosting. CLI tests use a read-only token against a real mounted server. Browser tests cover desktop and mobile source/history, stale responses, offline reopening, cache eviction, interrupted paging and authenticated source removal. Browser tests use disposable repositories and databases; they never modify an operator repository.

Import verification additionally covers exact files/modes/blob IDs in both hash formats, whole-operation rejection, atomic failure, retry recovery while the Git copy is unavailable, repository/Space and credential changes during collection or review, retained import intents, derived-source invalidation, immutable exports, and dropping stale provenance on ordinary edits and suggestions.

The APIs are native TypeScript application contracts, not Conduit wire compatibility. Reimporting Git commits as later versions, general binary/attachment trees, mode-aware edited trees, Arcanist `diff`, `patch`, `land`, working-copy detection, revision ranges and rebases, plus Mercurial and Subversion adapters, remain open parity work.
