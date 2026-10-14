# Owners

Owners organizes responsibility for repository paths into named packages. Packages can include individual workspace members and projects, cover several repositories, exclude nested paths, and be archived and restored. The Owners screen includes current package definitions, version history, and a path lookup that explains which visible packages control a selection of paths.

## Path rules

Paths are literal directory-component prefixes, not wildcard patterns. The root path covers the repository. A path such as /src covers that path and its descendants, but not /src-old. Leading and trailing separators are normalized. An exact path may appear only once within a package and repository. Dot and parent-directory components are rejected in configured rules.

Within a package, the most specific matching rule wins. A package can include the root, exclude /vendor, then include /vendor/local again. Exclusions affect their own package only. Inspected Git names remain literal; unusual names containing tabs or newlines still match their parent packages.

Strong dominion keeps ownership even when a more specific package also owns the path. Weak dominion yields to a more specific claim. At the same specificity, strong packages displace weak packages; several equally specific weak packages may share a path. Archived packages do not participate. These rules follow the final upstream Owners implementation and its matching examples.

## Access and authority

All Owners endpoints require authentication in a hosted workspace. Private packages are visible to their creator and current owners. Workspace packages are visible to workspace members. Both are further limited by view access to **every** referenced repository and owner project; package visibility never grants access to source or project membership information.

A creator or current owner can edit a package only while able to edit every attached repository. Creating a path claim also requires repository edit access. This prevents a repository reader from introducing automatic review or audit rules. Empty packages can be prepared before paths are attached.

Project ownership follows effective membership, including descendant and milestone membership rules. Disabled accounts are excluded. Automatic routing additionally requires that the member who saved the current package definition remains enabled and retains package editing authority, repository edit access and visibility of owner projects. A later authorized edit can restore a suspended package's routing authority.

Every mutation pins the package version and workspace access epoch and requires an idempotency key. Histories and mutation receipts are immutable. Retries acknowledge the original operation and return the current visible package rather than replaying stale content. If access has been lost, a successful retry returns only the operation receipt. Historical definitions are checked against both current package access and each snapshot's repository, project, and private visibility rules.

## Automatic review and audit

Automatic review may be disabled, add subscriptions, or request ordinary nonblocking review. Subscription and review modes can apply only to changes by non-owners or to all authors. Ownership is evaluated against immutable revision versions or inspected commits. Routing recipients must remain enabled and able to view both the package and source; ownership never supplies an access grant. Project membership is evaluated when routing occurs.

Audit choices mirror upstream: no auditing, all commits, unreviewed commits, commits without owner involvement, or either unreviewed commits or commits without owner involvement. Audit requests belong to the package collectively; they do not require every owner to accept individually. Source evidence and package versions remain attached to routing records.

Blocking collective revision reviewers are not implemented. Requests for the upstream block and block-always settings are rejected explicitly. They are never silently converted into unanimous individual reviews. The old primary-owner setting was already deprecated in the final upstream package model and is not recreated.

## API

- GET /api/owners lists currently visible active and archived packages.
- POST /api/owners creates a definition with expectedAccessEpoch and an Idempotency-Key header.
- GET /api/owners/:id returns the current definition and canEdit.
- PUT /api/owners/:id replaces a definition with expectedVersion, expectedAccessEpoch, and an idempotency key. Set status to archived or active to archive or restore.
- GET /api/owners/:id/history returns visible immutable package snapshots, newest first.
- GET /api/owners/resolve accepts repositoryId and paths, a JSON array of repository paths. Encode the JSON query value normally.
- GET /api/owners-routing/:objectId returns authorized immutable routing records, with optional before and limit pagination. Reading never reruns automation.

Package IDs use the OWN- prefix. Owners definitions are portable TypeScript values; matching does not depend on Node, React, network access, or an AI provider.

## Remaining gaps

Collective blocking revision reviews, generated-file attributes, custom package fields, per-package arbitrary policy audiences, and original Conduit compatibility remain open. Current ordinary reviewer requests use the application's existing individual reviewer mechanism; audit obligations preserve collective package semantics. Owners does not imply anonymous repository browsing or change the workspace's sign-in requirements.

## Command line

The same authenticated API is available through arc:

- npm run arc -- owners lists packages; add an OWN package ID for its definition.
- npm run arc -- owners-history OWN-ID reads visible immutable snapshots.
- npm run arc -- resolve-owners R1 /src/file.ts /tests/file.ts resolves literal paths.
- npm run arc -- owners-routing D1 reads a revision's routing history. A GC commit identifier reads inspected-commit routing. The command accepts --before and --limit.
- npm run arc -- create-owners --intent REQUEST.json --request-id KEY creates a package.
- npm run arc -- edit-owners OWN-ID --intent REQUEST.json --request-id KEY updates or archives a package.

Mutation files contain the complete definition and observed access epoch, plus the package version for edits. The CLI validates the response against those pins. It prints the request ID and an input digest before submission, omits package text from recovery diagnostics, and never silently refreshes versions. Retain the file and request ID for an uncertain-result retry. Read and write commands honor the configured server subpath.

## Switching a local workspace to sign-in

Password activation refuses current local-only Owners grants or routing authority. The existing terminal command, npm run accounts -- transfer-local USERNAME, explicitly hands these packages to the chosen enabled account in the same transaction as other local grants.

The transfer records the terminal operator, adds the chosen account as an owner, and advances each affected package version. It transfers creator access without rewriting the original creator attribution or old package snapshots. Routing authority belongs to the chosen account and must still satisfy current package and repository permissions. Archived definitions stay archived. Existing routing evidence, audit decisions, exact request receipts, source versions, and other owners are preserved. A missing callback, unavailable repository authority, or failed history write rolls the entire handoff back. The command reports the package count and does not activate sign-in itself.

## Historical reference

This slice uses the read-only pinned upstream checkout at `51cb7a3db9e8e510d564f6b37297111f7a690c91`: the [package model and review settings](https://github.com/phacility/phabricator/blob/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/applications/owners/storage/PhabricatorOwnersPackage.php), [path/dominion matching fixtures](https://github.com/phacility/phabricator/blob/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/applications/owners/storage/__tests__/PhabricatorOwnersPackageTestCase.php), and [audit modes](https://github.com/phacility/phabricator/blob/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/applications/owners/constants/PhabricatorOwnersAuditRule.php). No PHP runtime or vendored dependencies are used.
