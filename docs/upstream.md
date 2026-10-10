# Upstream reference sources

These are reference checkouts for feature research and migration design. The new application does not load or run their PHP code. Run `sh scripts/fetch-upstream.sh` from a checkout to reproduce the downloads; exact inputs are in [upstream-lock.tsv](upstream-lock.tsv). The script refuses dirty checkouts and unexpected origins, disables Git hooks during checkout, and pins detached commits rather than following moving branches. It needs Git and network access. The large `reference/` checkouts are intentionally excluded from the new application's Git history.

## Active target: latest upstream source

On **October 10, 2026**, GitHub's repository and commit APIs reported `master` as the default branch for each of the three Phacility repositories. The immutable heads below are the active Phabricator and Arcanist parity target. All three repositories reported `archived: false`; inactivity must not be described as GitHub archival. Repository `pushed_at` timestamps are not the date of the last default-branch commit.

| Source | Origin | Latest default-branch commit | Commit time (UTC) | Research checkout |
| --- | --- | --- | --- | --- |
| Phabricator | [phacility/phabricator](https://github.com/phacility/phabricator) | [`5720a38cfe95b00ca4be5016dd0d2f3195f4fa04`](https://github.com/phacility/phabricator/commit/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04) | November 13, 2023, 19:04:04 | Latest head. |
| Arcanist | [phacility/arcanist](https://github.com/phacility/arcanist) | [`e50d1bc4eabac9c37e3220e9f3fb8e37ae20b957`](https://github.com/phacility/arcanist/commit/e50d1bc4eabac9c37e3220e9f3fb8e37ae20b957) | May 30, 2023, 16:39:23 | Latest head. |
| libphutil | [phacility/libphutil](https://github.com/phacility/libphutil) | [`720c8116845bb9dc19334170e6c0702aa0210c78`](https://github.com/phacility/libphutil/commit/720c8116845bb9dc19334170e6c0702aa0210c78) | February 12, 2020, 23:16:07 | Last source-bearing parent, described below. |

libphutil's final commit removed its source after functionality moved into Arcanist and Phabricator. Checking out its final HEAD gives only a deprecation README. Its lock entry deliberately remains [`ce63d5b45049a0c3d634e338a701fe750a1e8cea`](https://github.com/phacility/libphutil/commit/ce63d5b45049a0c3d634e338a701fe750a1e8cea), dated February 12, 2020, 21:13:13 UTC. This is historical library context, not a third runtime dependency of the current upstream pair.

The [latest-source comparison](latest-upstream.md) records the differences from the original 2021 baseline, including removed prototypes, API changes, authorization fixes and file attachment semantics. Latest Phabricator has **76 application directories**. Phragment and Releeph were subsequently removed upstream; their historical capabilities remain separate carry-forward targets in [parity.md](parity.md), rather than silently disappearing from this project's original scope.

## Preserved 2021 baseline

Phacility announced its wind-down on May 29, 2021. New hosted instances and support pacts stopped after June 1; existing hosting continued, with very limited support expected after August 31. Upstream was no longer to be regularly updated. This was not a single switch-off of all services. [Primary announcement](https://blog.phacility.com/post/11/phacility_is_winding_down_operations/).

The project's original cutoff was **2021-06-01 23:59:59 UTC**. The last `master` commits at or before that committer-time cutoff remain useful for migration fixtures and capabilities later removed:

| Historical source | Exact commit | Commit time (UTC) |
| --- | --- | --- |
| Phabricator | [`51cb7a3db9e8e510d564f6b37297111f7a690c91`](https://github.com/phacility/phabricator/commit/51cb7a3db9e8e510d564f6b37297111f7a690c91) | June 1, 2021, 15:29:54 |
| Arcanist | [`246e604a070f7539838fd246c0405db2752da8d2`](https://github.com/phacility/arcanist/commit/246e604a070f7539838fd246c0405db2752da8d2) | June 1, 2021, 06:10:36 |

Existing historical worktrees need not be moved to inspect newer sources: use `git show <commit>:<path>` or a separate ignored checkout. Running the fetch script deliberately aligns `reference/phabricator` and `reference/arcanist` with the active lock; it never runs the PHP software. Updating this lock is an explicit research decision, not an automatic dependency upgrade.

## Licenses and attribution

Each repository's top-level `LICENSE` is Apache License 2.0 and each has its own `NOTICE`. The checkouts preserve those files. Third-party packages under `externals/` and Phabricator's `webroot/rsrc/externals/` have separate licenses and notices; copying a dependency or asset requires preserving its own applicable notices. The upstream NOTICE also identifies Phabricator and Phacility as trademarks. The working title “Phabricator Next” expresses the project's reference point and does not claim upstream affiliation.

| Repository | License evidence | Notice evidence |
| --- | --- | --- |
| Phabricator | [LICENSE](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/LICENSE) | [NOTICE](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/NOTICE) |
| Arcanist | [LICENSE](https://github.com/phacility/arcanist/blob/e50d1bc4eabac9c37e3220e9f3fb8e37ae20b957/LICENSE) | [NOTICE](https://github.com/phacility/arcanist/blob/e50d1bc4eabac9c37e3220e9f3fb8e37ae20b957/NOTICE) |
| libphutil | [LICENSE](https://github.com/phacility/libphutil/blob/ce63d5b45049a0c3d634e338a701fe750a1e8cea/LICENSE) | [NOTICE](https://github.com/phacility/libphutil/blob/ce63d5b45049a0c3d634e338a701fe750a1e8cea/NOTICE) |

## Research entry points

- [Application inventory](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications): 76 directories at the active commit. This includes internal infrastructure and optional prototypes, not 78 finished products. [Parity matrix](parity.md) accounts for every directory.
- [User guides](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/docs/user/userguide): source documentation for workflows, limitations, and user expectations. Treat behavior demonstrated by code and fixtures as stronger evidence than aspirational prose in old guides.
- [Application transactions](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions): reusable edit operations, history, comments, and validation across different object types.
- [Policies](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/policy) and [Spaces](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/docs/user/userguide/spaces.diviner): object access is checked in addition to a space's visibility; Spaces can only reduce access. Preserve this model when adding AI and search.
- [Differential](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential): durable revisions and successive immutable diffs; comments attach to specific versions and locations.
- [Repository layer](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/repository) and [Diffusion guide](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/docs/user/userguide/diffusion.diviner): hosted and observed repositories, Git/Hg/SVN integration, cross-application references and commit discovery.
- [Conduit](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/conduit): API search/edit patterns; important for imports and CLI compatibility.
- [Arcanist](https://github.com/phacility/arcanist/tree/e50d1bc4eabac9c37e3220e9f3fb8e37ae20b957/src): working-copy workflows, commit ranges, lint/unit protocols, patch and land semantics. Copying its command names alone is not compatibility.

## Visual reference

Familiar Phabricator appearance is a requirement. The new interface should preserve the compact hierarchy, application names, object identifiers, navigation, status colors, property panels, and transaction timelines while supporting touch and narrow screens.

The source records these defaults in [CelerityDefaultPostprocessor.php](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/celerity/postprocessor/CelerityDefaultPostprocessor.php):

| Token | Historical value |
| --- | --- |
| Page background | `#f3f5f7` |
| Side navigation | `#eaedf1` |
| Content cards | `#fff` |
| Dark blue text | `#464C5C` |
| Muted blue text | `#6B748C` |
| Light blue border | `#BFCFDA` |
| Blue button | `#2980b9`, gradient from `#3498db` |
| Green button | `#139543`, gradient from `#23BB5B` |
| Main menu height | `44px` |

The [main menu stylesheet](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/webroot/rsrc/css/application/base/main-menu-view.css) describes the top bar, global search, and mobile menu expansion. The [basic navigation stylesheet](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/webroot/rsrc/css/phui/phui-basic-nav-view.css) uses a 205px application sidebar, uppercase section labels, selected row shading, and compact links. [PHUI styles](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/webroot/rsrc/css/phui) are the reference for lists, properties, timelines, comments, workboards, and status colors. Preserve recognizable structure, but increase touch targets and reflow the page rather than shrinking desktop controls.
