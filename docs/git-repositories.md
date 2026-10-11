# Observing local Git repositories

Diffusion can browse an operator-configured bare Git repository. Register the repository in the application, then bind its ID to an absolute path on the server. The registered remote URL and default branch remain descriptive metadata: creating or opening a repository never clones, fetches, pushes, checks out files, or contacts that remote.

Configure the reusable server with a JSON mapping in its environment, for example:

```dotenv
APP_GIT_REPOSITORIES='{"R1":"/srv/git/example.git","R2":"/srv/git/research.git"}'
```

Restart the server after changing this mapping. Omit it, or use `{}`, to leave all repositories unconfigured. The IDs must identify registered repositories; the application does not create registry entries from configuration. Only the server operator selects paths. No API accepts a host filesystem path, and paths from this mapping are absent from browser responses.

Use repositories that the operator controls. The observer requires a supported Git executable and a complete bare repository. Working checkouts, shallow or partial/promisor repositories, external object alternates, replacement objects, grafts, and unsupported repository configuration are rejected. Git runs with a restricted environment, a fixed set of operations, isolated patch verification, output limits, timeouts, and a bounded queue. It does not run hooks, filters, text conversion, or network operations. Detailed repository availability is visible only to readers who retain both repository and Space access.

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

History defaults to 25 commits per page, allows 1–100, and uses a nonnegative numeric `after` offset up to 100,000; use the returned `nextAfter` with the same commit/path. Reference and directory results are bounded to 1,000 entries; ordinary command output is bounded to 2 MB. Comparison and blame verification admit larger object reads under their dedicated limits below. Text blobs are limited to 256,000 bytes. Binary, oversized, unsupported-encoding, symlink, and submodule files have explicit states instead of fabricated empty contents. Commit messages are bounded to 16,000 bytes with an explicit truncation indicator. Limit errors are not empty result sets.

Responses include a current `accessEpoch` and are served with `Cache-Control: no-store`. A missing or hidden repository has the same `OBJECT_UNAVAILABLE` response. Missing Git objects use `GIT_OBJECT_UNAVAILABLE`, which does not imply that the repository itself became hidden. Invalid inputs use `GIT_INVALID_QUERY`; limit, queue, availability, and cancellation failures have distinct `GIT_*` codes. Errors do not disclose configured host paths.

Repository browsing is read-only. It never changes Git objects or references, and viewing source does not create review evidence. Repository hosting, clone/fetch orchestration, SSH or HTTP serving, push policy, commit-record import and commit review remain separate work. Explicit source import into a revision is described below.

## Compare exact committed trees

**Show Commit Changes** opens the pinned commit against its first parent. An
initial commit uses an explicit empty tree. The comparison shows both complete
commit IDs; select another merge parent, enter a different exact base/target,
or swap two commits explicitly. Refreshing branches never changes this pair.
Merge parents are individual comparisons, not a combined merge diff. Equal,
reverse and unrelated commit pairs are supported. This is a source comparison,
not a branch reachability or commit-range history report.

The inventory includes additions, deletions, modified paths, mode/type changes,
renames and copies, with both paths, modes, object types and IDs. Directory
changes are explicit, including empty trees and file-to-directory transitions;
their changed children remain separate entries. Git's 50% rename/copy heuristic
aligns paths (`-M50% -C50%`). Similarity is an inference from the installed Git
implementation, not an identity recorded in a commit. Copies from unchanged
files are not exhaustively detected; `--find-copies-harder` is not used.

Select a changed path to load its exact sides and a literal line comparison.
An absent side and an existing empty file are distinct. BOMs, CRLF and missing
final newlines are preserved. Binary, invalid UTF-8, oversized, symlink, gitlink
and directory sides have explicit states. Links and submodules are never
followed, fetched or executed. Nontext sides are never substituted with empty
strings. The browser compares text locally within the existing deterministic
display budgets; a limit shows an explicit message and links to exact source.
Viewing a comparison creates no review, acceptance or AI evidence.

These native read endpoints use the existing repository/session/Space checks
before and after asynchronous Git work, with current access epochs and
`Cache-Control: no-store`:

| Endpoint | Meaning |
| --- | --- |
| `GET /api/repositories/R1/compare?base=<full-id-or-empty>&target=<full-id>` | Complete bounded inventory for an explicit ordered pair. |
| `GET /api/repositories/R1/compare/file?base=<full-id-or-empty>&target=<full-id>&beforePath=<path>&afterPath=<path>` | Exact sides of one inventory entry. Omit a path only when that side is absent. |

No default base is chosen by the API. `empty` selects a synthetic empty tree
whose ID is computed for the repository's hash format without writing an
object. Both commit selectors otherwise require complete lowercase IDs of the
same object format. Duplicate/unknown parameters and empty supplied paths fail.
The file endpoint recomputes the bounded inventory and requires the exact
before/after path tuple; it cannot invent a rename between arbitrary files.
Responses include `baseCommit`, `targetCommit`, `baseTreeId`, `targetTreeId`
and repository identity. Each change has a pair-bound ID, status, optional
similarity score and exact `before`/`after` metadata. File responses bind both
source states to that entry and ordered pair.

The observer verifies raw tree and admitted blob hashes before invoking Git's
fixed diff operation with external diff, text conversion and submodule
traversal disabled. It reuses one operation deadline and queue permit. Limits
are 2,000 examined tree entries, 1,000 changes, 1,000 source/destination
candidates, 250,000 candidate pairs, 8 MiB per changed blob and 64 MiB across
changed sides. The inventory contains no file bodies. The normal 256,000-byte
text preview limit applies to each selected side, and serialized responses are
bounded to 2 MB. Exceeding traversal, source, heuristic, result or time budgets
fails the whole operation; results are never silently truncated and rename
detection is never silently disabled. Large changed blobs beyond the admission
limit remain readable through the existing metadata/blob workflow, but their
full comparison is explicitly unavailable.

Visited comparison inventories and selected source pairs share the repository's
16-entry/2 MB cache. Local mode can reopen those exact pairs offline; password
mode retains them only in the verified tab. Pair/path, response identities,
current epoch and session lifetime are checked before displaying or retaining
source. Selecting another pair or path retires earlier responses. Access loss
removes visible and cached comparison source through the repository boundary.

The CLI exposes the same explicit read:

```sh
npm run arc -- compare-commits R1 --base BASE_ID --commit TARGET_ID
npm run arc -- compare-commits R1 --base BASE_ID --commit TARGET_ID \
  --before-path old/paper.tex --after-path paper.tex
npm run arc -- compare-commits R1 --base empty --commit TARGET_ID --json
```

Omit both path options to list changes. Use the listed path tuple for a selected
change, omitting an absent side. Each invocation makes one read, never follows a
branch or chooses a newer base, and works with a read-only token. Human output
escapes terminal controls; `--json` preserves the bounded exact source response.
This does not change the CLI's separate review-creation `diff` command.

## Download an exact Git patch

In a committed-tree comparison, **Prepare Exact Patch** collects the complete
patch for the displayed ordered pair. **Download Exact Patch** then saves the
verified bytes. Preparation is explicit: opening a comparison, changing a file,
refreshing a branch or reconnecting never starts an export. Changing the commit
pair retires a pending export; selecting a different file in the same pair does
not change the patch's scope. The patch always covers the whole comparison.

The export preserves binary data, invalid UTF-8 source bytes, BOMs, CRLF, missing
final newlines, executable bits, renames/copies, symbolic-link contents and
submodule object IDs. It never follows links or fetches submodules. Git patch
syntax cannot represent explicit empty directory entries: a non-root empty
tree on either side fails the export. Equal trees produce a valid zero-byte
patch, distinct from a failed or truncated export.

To undo a comparison, swap the exact commits and prepare that inverse patch.
Git's reverse application of a copy-containing patch can fail even when its
forward application is valid; each export guarantees its selected direction.

```sh
npm run arc -- download-patch R1 --base FULL_BASE_ID --commit FULL_TARGET_ID --output change.patch
npm run arc -- download-patch R1 --base empty --commit FULL_TARGET_ID --output initial.patch --json
```

The CLI verifies the entire response before writing. It stages a private file
in the output directory and publishes it only after the write completes,
without overwriting an existing file or symbolic link. It prints a receipt
with the exact commit/tree identities, byte count and SHA-256; patch contents
are never sent to the terminal. This command exports changes; it does not
apply them to a working copy, update refs or create review evidence.

`GET /api/repositories/R1/compare/patch?base=<full-id-or-empty>&target=<full-id>`
returns the native `git-binary-patch-v1` envelope: repository/object format,
`baseCommit`, `targetCommit`, both tree IDs, current `accessEpoch`, `bytes`,
`sha256` and `dataBase64`. Base64 preserves raw bytes that cannot be represented
by a UTF-8 JSON string. Unknown/duplicate parameters and mutable selectors are
rejected. The existing repository/Space/session/read-token checks run before
and after collection, including failures; responses use `no-store`.

The observer verifies source commit/tree/blob identities and copies the
required objects into a private temporary Git database. Patch generation uses
fixed three-line context, full object IDs, binary hunks, `a/` and `b/` prefixes,
Myers differences and the existing 50% rename/copy heuristics. Operator,
system, global and source-tree attributes cannot change those settings. It
then applies the patch to a temporary index and requires the resulting tree ID
to equal the exact target. No checkout is created, no source files execute,
and the operator's repository is never written. Temporary objects and index
are removed after success, failure or cancellation.

The raw patch limit is 8 MiB; changed blob and similarity budgets are those of
the comparison above. Complete-tree verification admits 20,000 visited entries,
10,000 distinct tree objects and 8 MiB of tree metadata, retaining the existing
1,000-entry per-directory limit. Reused subtrees still count their entries at
each path. All work shares the existing deadline and queue permit. An output, source,
tree, time or representability failure returns no partial patch. Large-tree
and larger-patch exports remain future work.

Prepared envelopes share the existing 16-entry/2 MB repository cache. A local
snapshot that fits can be reopened offline and is rehashed before download.
Larger exports remain in the current tab with an explicit retention notice.
Password workspaces keep patch bytes in verified-session memory only. Access,
session and repository-snapshot retirement invalidate pending and prepared
downloads. A saved patch is an immutable exported copy; later access changes
cannot recall a file the user already downloaded.

## Trace a source line to its origin

Open an exact file and select **Blame** to inspect its line provenance. Git
attributes each line to an origin commit and original path; whole-file renames
are followed by Git's standard blame behavior. The pinned file stays fixed when
branches move. Select a line to see the full origin commit, original line/path,
author, date and commit message. **Open Origin Source** opens that exact historical
file; **Show Origin Commit Changes** compares the origin with its first parent
or the empty tree. Merge parents remain selectable in the comparison view.

The reader displays 100 lines at a time, with previous/next pages and direct
line navigation. Empty files have zero attributed lines. Source preserves BOM,
CRLF, blank lines and an unterminated final line. Binary, invalid UTF-8,
oversized, symlink and submodule entries have explicit unavailable states,
never invented line origins or substituted text. The attributed Git author is
commit metadata, not a verified workspace identity or an authorship attestation.
This operation creates no review or acceptance evidence and uses no AI provider.

**Blame Parent at Same Path** explicitly opens the origin's path in a selected
parent. The path may not exist there, and no old filename is inferred by that
action. This is not upstream's skip-past behavior. Imported commit identities,
Differential revision links, age coloring and the full upstream skip-past
workflow remain separate work.

```sh
npm run arc -- blame R1 --commit FULL_ID --path paper.tex
npm run arc -- blame R1 --commit FULL_ID --path paper.tex --json
```

The CLI makes one exact read and works with a read-only token at root or a
configured path prefix. Human output escapes terminal and directional controls
in source, paths, commit messages and author metadata. JSON preserves exact
source text. The native endpoint is:

`GET /api/repositories/R1/blame?commit=<full-id>&path=<exact-path>`

Both selectors are required. Mutable refs, short IDs, empty paths and duplicate
or unknown parameters fail. The response includes the selected commit, exact
`blob` identity/content or nontext state, the `git-blame-root` algorithm marker,
complete `lines` and unique origin `commits`. Each line has a one-based
`lineNumber`, `commitId`, `originalLine` and original `path`. Nontext states use
`lines: null` and no origin commits; empty text uses an empty line list.

The observer uses a fixed `git blame --root --line-porcelain --no-textconv`
operation. Whitespace ignoring and extra moved/copied-line detection are not
enabled. C-quoted filenames are decoded as bytes before strict UTF-8 validation.
The selected commit/tree/blob is hash-verified. Before attributing nonempty
text, every commit, tree and blob reachable from that exact commit is also
verified. The verified parent/tree edges must form the complete enumerated
graph. This includes ancestors which Git does not report as line origins:
damage there can otherwise make Git assign a line to a different valid commit.
Objects reachable only from other refs and unreachable objects are excluded;
gitlinks are not followed. Each attributed original source line is additionally
checked against the selected literal line, including its final LF. Links,
submodules, external diff/text conversion, network fetches and Git writes are
never executed.

A result is complete or fails explicitly. Display limits are the existing
256,000-byte text preview, 10,000 lines, 200 unique origin commits, 200
commit/path pairs and a 2 MB result. The integrity preflight admits at most
1,000 reachable commits, 10,000 distinct objects, 20,000 tree entries,
8 MiB combined commit/tree metadata, 8 MiB per blob and 64 MiB distinct blob
bytes. Blobs are hash-verified while streaming, without retaining the complete
history's bodies. Reachable files unrelated to the selected path count toward
these limits. A small current file can therefore be unavailable for attribution
when its repository history exceeds this bounded verification contract; large
history support remains a gap. Objects outside the selected ancestry do not
consume these graph budgets.

Target files above 8 MiB fail before attribution; files between the text
preview and admission limits return an explicit oversized state. Nontext and
empty targets return their verified target state without traversing attribution
history. One operation uses the existing 10-second deadline and Git queue
permit. No partial successful attribution is returned when any budget is
exceeded.

Current session, read scope, repository and Space authority are checked before
and after Git work, including failures. Responses have current access epochs
and `Cache-Control: no-store`. Exact visited blame snapshots share the bounded
repository cache: durable only in local mode, memory-only in a verified
password session. Late responses cannot replace a newer selection or restore
source after access loss, session retirement or cache invalidation.

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

## Import a later review version

Open a repository-linked review and choose **Import Git as Next Version** to replace its current source with another complete text tree. Files absent from the selected commit are removed from the new version. Earlier snapshots, comments, suggestions and review evidence remain attached to their original versions. The new version records its own verified Git provenance, creates an attributed version event and invalidates acceptance, even when importing the same commit again. Status follows the [source-change lifecycle rules](revision-lifecycle.md#drafts-and-source-changes), preserving Closed and Draft. Selecting an older or unrelated commit creates a new review version; it never rewinds the revision's history.

The review must already have a source repository. Import always uses that repository and preserves the review's title, kind, project, Space and access rules. It requires `write` scope, target revision edit access and source repository view access. Editing repository settings is not required for this operation. This differs from creating a new review, which requires repository edit access and copies the repository's rules. Continuing source visibility applies to both workflows.

`POST /api/revisions/D1/import-git` accepts `{commitId, expectedVersion, expectedVersionId, expectedContentHash, message}` and returns a `RevisionDetail`. All three base-version fields must identify the current immutable version. The server collects the complete tree outside the database transaction, then rechecks credentials, permissions and the exact base under the writer lock. A stale base rejects the operation without creating a version. The same text-tree limits and whole-operation rejection rules apply as for new reviews. No client-supplied files, provenance, repository selection or policy changes are accepted.

The CLI makes these pins explicit. Read them from the current revision before starting a new import:

```sh
npm run arc -- show D1 --json
npm run arc -- import-git-version D1 --commit FULL_COMMIT_ID \
  --version 1 --version-id VERSION_ID --content-hash CONTENT_HASH \
  --message "Import the revised argument" --request-id MY_UNIQUE_REQUEST_ID
```

The CLI prints the exact normalized request and retry key to stderr before submission. Repeat that input/key to recover an uncertain result. It does not fetch a newer base automatically when retrying. Saved receipts are checked before collecting Git source or testing whether the original base is still current; an authorized exact retry therefore works after later versions are created or the Git copy becomes unavailable. Reusing the key for different input fails. Saved responses describe the original operation, so use a fresh read to inspect the latest review.

The browser retains each submitted request, its base pins and key independently of newer drafts, including after a local-mode reload. Select a submitted request explicitly to retry it unchanged. Password-mode intents remain in the verified tab. Importing never enters the offline outbox. Existing unsaved edits keep their original base and remain available through draft recovery. Starting another import from the current version requires an explicit action and a new request key; it does not silently rebase an uncertain operation. A completed import refreshes authorized data, while preserving a comparison the user selected during the request.

## Upstream correspondence and verification

These are the GIT-01/P303a browsing, P303b initial import, P303c later-version import, P303d committed-tree comparison, P303e line-provenance and P303f patch-export subsets, based on Phabricator `5720a38cfe95b00ca4be5016dd0d2f3195f4fa04`:

- [Browse queries](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/diffusion/conduit/DiffusionBrowseQueryConduitAPIMethod.php) identify a commit and path and distinguish trees, files and submodules. Our API requires an explicit full commit and reads exact tree objects; directory pagination and upstream deleted-path recovery remain gaps.
- [Git file content](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/diffusion/query/filecontent/DiffusionGitFileContentQuery.php) reads the blob at a commit/path. Our adapter verifies raw object hashes and exposes bounded UTF-8 content with explicit unsupported states.
- [History queries](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/diffusion/conduit/DiffusionHistoryQueryConduitAPIMethod.php) use commit/path, offset/limit and parent relationships. Our initial history supports one exact starting commit and optional literal path. Two-commit ranges, direct/child change details and imported commit metadata remain gaps.
- [Git raw diff](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/diffusion/query/rawdiff/DiffusionGitRawDiffQuery.php) compares explicit trees with rename/copy detection, using the first parent or empty tree by default. P303d exposes this source-comparison behavior through native inventory and selected-file endpoints. P303f adds a native binary-capable patch download with full object IDs and three-line context; upstream uses 65,535 context lines by default and does not enable binary hunks. It does not implement `diffusion.rawdiffquery`'s temporary File response, `diffusion.diffquery`'s last-modification selection, or the [Compare controller](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/diffusion/controller/DiffusionCompareController.php)'s branch reachability report. Unlike upstream's commit UI, the native inventory includes directory entries. Combined merge diffs, larger patch exports, exhaustive copy discovery and Conduit wire compatibility remain gaps.
- [Git blame](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/diffusion/query/blame/DiffusionGitBlameQuery.php) uses root-aware, whitespace-sensitive Git attribution without extra move/copy flags. P303e adds exact native file reads with verified origin source, mobile/offline navigation and CLI output. It does not implement [diffusion.blame](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/diffusion/conduit/DiffusionBlameConduitAPIMethod.php)'s multi-path map, partial-success omission, repository selectors or shared immutable cache. Imported identities/revision links, upstream skip-past controls, Mercurial/SVN blame and Conduit wire compatibility remain gaps.
- [Differential diff creation](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/conduit/DifferentialCreateDiffConduitAPIMethod.php) records repository/VCS/base provenance. Our import records a complete immutable text-tree snapshot. It does not reproduce working-copy ranges, hunk/changeset submission or upstream Conduit request formats.
- [Differential revision updates](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/conduit/DifferentialUpdateRevisionConduitAPIMethod.php) require an editable revision and visible diff. Our later-version import similarly requires target edit and source view access, and adds exact version/hash checks. The upstream [update transaction](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/xaction/DifferentialRevisionUpdateTransaction.php) can change the repository with the active diff and conditionally retain acceptance. Our repository link stays fixed and every new version invalidates acceptance. These are deliberate differences. Published/closed revision states and upstream diff publication remain separate parity work.

Disposable real Git fixtures exercise SHA-1 and SHA-256, merges, branches, lightweight and annotated tags, tags that do not point to commits, branch movement, Unicode and BOM preservation, literal unusual filenames, empty and special files, malformed objects, hash mismatch, rejected configurations, bounded execution and cancellation. API integration verifies permissions before and after reads, credential/session changes, disconnects and path-prefix hosting. CLI tests use a read-only token against a real mounted server. Browser tests cover desktop and mobile source/history, stale responses, offline reopening, cache eviction, interrupted paging and authenticated source removal. Browser tests use disposable repositories and databases; they never modify an operator repository.

Import verification additionally covers exact files/modes/blob IDs in both hash formats, whole-operation rejection, atomic failure, retry recovery while the Git copy is unavailable, repository/Space and credential changes during collection or review, retained import intents, derived-source invalidation, immutable exports, and dropping stale provenance on ordinary edits and suggestions.

Later-version tests cover stale number/ID/hash pins, competing database writers, source-view-only editors, preserved policies and prior discussion, acceptance invalidation, added/deleted files, changed modes, equal trees and older commits, canceled collection and historical retries. Browser coverage exercises local offline intent retention, explicit conflict recovery, lost responses, newer drafts, comparison changes during a request, and mobile controls. Source import remains an online operation; these tests do not establish offline Git processing or Arcanist compatibility.

The APIs are native TypeScript application contracts, not Conduit wire compatibility. General binary/attachment trees, mode-aware edited trees, Arcanist `diff`, `patch`, `land`, working-copy detection, revision ranges and rebases, plus Mercurial and Subversion adapters, remain open parity work.
