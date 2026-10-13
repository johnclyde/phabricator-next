# Revision patches and landing

Git-backed code, paper/LaTeX and legal-text revisions can supply Drydock working copies and Harbormaster working-copy steps. An accepted revision can also be prepared and explicitly landed as one squash commit into an operator-configured local bare repository. This implements a native subset of upstream Drydock repository operations; it does not establish complete Arcanist or Drydock parity.

## Exact revision working copies

The selected immutable version is the complete desired text tree. Its nearest preceding Git import in the same revision supplies the verified baseline commit, tree, manifest and file modes. Existing files retain executable modes, new files use `100644`, and removed files are deleted. A rename is represented by deletion and addition. Source bytes, including line endings, are preserved. The worker constructs the target tree and staged index over a detached baseline HEAD, verifies both object identity and a SHA-256 patch digest, and never executes source, hooks, filters, submodules or remote commands. Both SHA-1 and SHA-256 Git repositories are supported.

The lease records revision/version/content hash, baseline version and commit/tree, target tree and patch digest. Provisioning claims include the verified source payload only for an authorized worker; cleanup claims do not contain source. Holder and worker authority must cover both revision and repository. Source changes cannot mutate an existing lease. Revocation fences provisioning, dependent steps and exact retries while retaining cleanup behavior.

Drydock's allocation form supports either an observed commit or an exact revision version. A revision page can launch a Harbormaster plan for the selected version; working-copy steps obtain that same revision patch. An imported version with no text changes can still provide a working copy. This uses the existing complete-text-tree import limits (100 files and 1.5 MB), rejects partial trees, assets/DOCX, symlinks, submodules and unsafe paths, and never silently drops unsupported content. Ordinary commit working copies keep their separate, larger provider limits.

## Landing a revision

1. Accept the current version with applicable review evidence. Resolve blocking findings and reviewer decisions, and close or land prerequisite revisions.
2. Choose a configured destination branch, the exact baseline commit, and pin the branch's current head. The baseline must equal that head. Preparing an imported commit normally starts from its first parent; an edited version normally starts from its imported baseline.
3. Prepare the squash commit. Inspect its source hash, target tree, destination, parent and commit message. Preparation writes unreferenced Git objects but does not move a branch.
4. Explicitly land the prepared commit. Current source, acceptance/evidence, lifecycle, authorship, reviewers, metadata, configuration, access and repository permissions must still match. Herald's native pre-receive rules run before an atomic compare-and-swap branch update. Successful landing records post-receive commit automation and closes the same accepted version.

The committed tree is the **complete reviewed tree**. Choosing a different baseline does not merge unrelated branch content into it. Branch movement requires a new preparation and any source integration requires a new reviewed version; no fuzzy patching, automatic rebasing, forced update or stale acceptance is used. Zero-change landings are rejected. Only the account which prepared a landing may execute, cancel or recover it, and it must retain revision and repository Edit authority. The current author may prepare; the existing `alwaysAllowClose` configuration also applies.

The commit message uses the pinned revision title and summary. Git attribution uses the acting account's display name and a stable private-workspace-derived `users.invalid` address; it does not expose the account's login email. The immutable operation records the account attribution and exact review identities.

An atomic Git marker and companion proof blob accompany the branch update. If Git succeeds but SQLite finalization fails, an explicit retry/recovery verifies these markers and records the historical success without updating the branch again. A newer revision version is never closed by this recovery. The Git proof contains only the allowed receipt ID and a hash binding the original gate decision; private Herald transcripts are not copied into Git. If the database transaction rolled back, those original full transcripts may be absent, so recovery retains the original proof rather than claiming to have re-evaluated the historical rules. Changing/removing a repository binding fences recovery until the original configuration is restored.

Desktop and mobile controls retain drafts and unconfirmed requests for explicit exact retry/export. Reconnecting never prepares, lands, or allocates resources. Policy loss quarantines retained intent. The two-step operation remains online-only.

## Operator configuration

Landing is disabled until the operator supplies an explicit allowlist. Configure local bare repositories owned by the server operator, with the ordinary observer mapping for repository browsing:

```dotenv
APP_GIT_REPOSITORIES='{"R1":"/srv/git/research.git"}'
APP_LANDING_BINDINGS='[{"key":"research-main","repositoryId":"R1","repositoryPath":"/srv/git/research.git","branches":["refs/heads/main"]}]'
```

Restart after configuration changes. Browser requests select a binding key and branch; they cannot supply filesystem paths, Git configuration, arbitrary commands or remotes. No binding is enabled by installation. The local adapter writes Git objects and refs directly and invokes the application's native Herald rules; it does not execute repository hook scripts. Operators needing other receive-hook enforcement or remote Git hosting must integrate that explicitly. Drydock worker allocation separately requires the blueprints, authorizations and worker configuration described in [Drydock](drydock.md).

## Native API

All writes require authentication, write scope, current policies and an `Idempotency-Key`. Historical receipts are validated against immutable operation history before return, with current authorization and capabilities.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/drydock/revision-patches/:revisionId?versionId=...&contentHash=...` | Resolve an authorized exact-version patch identity without returning source. |
| `POST /api/drydock/leases` | Accept `{revisionId, versionId, contentHash, blueprintId, blueprintVersion, durationSeconds?}` for a revision patch. |
| `POST /api/harbormaster/builds` | Existing `{revisionId, versionId, contentHash, planId, planVersion}` also supports working-copy plans. |
| `GET /api/revisions/:id/landings` | Current eligibility, exact review/metadata pins, public bindings and visible operation history. |
| `POST /api/revisions/:id/landings` | Prepare using those pins plus `binding`, `branch`, `baseCommitId`, `expectedTargetCommitId`. |
| `GET /api/landings/:id` | Inspect immutable candidate/history and current capabilities. |
| `POST /api/landings/:id/commands` | Explicit `{command: "land" | "cancel", expectedVersion}`; a verified completed Git marker reconciles historical success. |

Schema 39 adds landing operation, immutable preparation and event tables without rewriting previous workspace data. Migration tests exercise preservation, collision rollback and reopen behavior.

## Upstream comparison and remaining work

Read-only research uses the pinned checkouts in [upstream.md](upstream.md), especially `DrydockLandRepositoryOperation.php`, `DrydockWorkingCopyBlueprintImplementation.php`, and Arcanist's Git land/patch engines. Upstream fetches staged refs, squash-merges them into a working copy, commits and pushes. This adapter materializes a verified complete revision tree and performs a local atomic ref update with native rule enforcement.

Remote staging/push, SSH/Passphrase, cloud/Almanac hosts, pooled resources, arbitrary remote commands, stack/range landing, merge/rebase conflict resolution, user-configurable VCS identities, signed commits, binary/DOCX patches, edited mode controls, upstream Conduit/import interoperability, Mercurial/Subversion and full `arc patch`/`arc land` compatibility remain gaps. No production worker fleet or landing destination is provisioned merely by enabling the UI.

## Verification

`npm run check`, `npm test`, and root/subpath production builds pass. The full core suite has 2,092 passes, nine optional TeX-runtime skips and no failures. Real Git fixtures verify SHA-1/SHA-256 materialization and landing, installed receive hooks, blocking Herald decisions, exact review/source/mode pins, current permissions, saved-receipt integrity, and recovery after Git succeeds but SQLite rolls back. Migration checks preserve old rows and reject schema collisions atomically. All 276 affected browser checks pass across desktop/mobile and root/subpath deployments, with no failures or skips. They cover prepare/inspect/land, stale source, exact retry, offline drafts, patch builds, source imports, review lifecycle, authentication and policy isolation.
