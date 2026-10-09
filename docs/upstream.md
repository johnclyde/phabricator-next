# Upstream reference sources

These are reference checkouts for feature research and migration design. The new application does not load or run their PHP code. Run `sh scripts/fetch-upstream.sh` from a checkout to reproduce the downloads; exact inputs are in [upstream-lock.tsv](upstream-lock.tsv). The script refuses dirty checkouts and unexpected origins, disables Git hooks during checkout, and pins detached commits rather than following moving branches. It needs Git and network access. The large `reference/` checkouts are intentionally excluded from the new application's Git history.

## Why this baseline

Phacility announced its wind-down on May 29, 2021. New hosted instances and support pacts stopped after June 1; existing hosting continued, with very limited support expected after August 31. Upstream was no longer to be regularly updated. This was not a single switch-off of all services. We use **2021-06-01 23:59:59 UTC** as a reproducible feature baseline, rather than claiming current upstream HEAD is the 2021 product. [Primary announcement](https://blog.phacility.com/post/11/phacility_is_winding_down_operations/).

The Phabricator and Arcanist pins below are the last commits on their upstream `master` history with committer timestamps at or before the cutoff. A few upstream changes continued later; they are outside this historical parity target.

| Source | Origin | Exact commit | Commit time | Reason |
| --- | --- | --- | --- | --- |
| Phabricator | [phacility/phabricator](https://github.com/phacility/phabricator) | [`51cb7a3db9e8e510d564f6b37297111f7a690c91`](https://github.com/phacility/phabricator/commit/51cb7a3db9e8e510d564f6b37297111f7a690c91) | June 1, 2021, 15:29:54 UTC | Last commit before cutoff; repository maintenance lock. |
| Arcanist | [phacility/arcanist](https://github.com/phacility/arcanist) | [`246e604a070f7539838fd246c0405db2752da8d2`](https://github.com/phacility/arcanist/commit/246e604a070f7539838fd246c0405db2752da8d2) | June 1, 2021, 06:10:36 UTC | Last commit before cutoff. |
| libphutil | [phacility/libphutil](https://github.com/phacility/libphutil) | [`ce63d5b45049a0c3d634e338a701fe750a1e8cea`](https://github.com/phacility/libphutil/commit/ce63d5b45049a0c3d634e338a701fe750a1e8cea) | February 12, 2020, 21:13:13 UTC | Last source-bearing commit before final deprecation. |

libphutil's final commit, [`720c8116845bb9dc19334170e6c0702aa0210c78`](https://github.com/phacility/libphutil/commit/720c8116845bb9dc19334170e6c0702aa0210c78), removed its source after functionality moved into Arcanist and Phabricator. Checking out its final HEAD would give only a deprecation README. Its full history is retained, but the reference worktree deliberately shows the preceding commit. libphutil is historical context, not a third runtime dependency for the 2021 pair.

## Licenses and attribution

Each repository's top-level `LICENSE` is Apache License 2.0 and each has its own `NOTICE`. The checkouts preserve those files. Third-party packages under `externals/` and Phabricator's `webroot/rsrc/externals/` have separate licenses and notices; copying a dependency or asset requires preserving its own applicable notices. The upstream NOTICE also identifies Phabricator and Phacility as trademarks. The working title “Phabricator Next” expresses the project's reference point and does not claim upstream affiliation.

| Repository | License evidence | Notice evidence |
| --- | --- | --- |
| Phabricator | [LICENSE](https://github.com/phacility/phabricator/blob/51cb7a3db9e8e510d564f6b37297111f7a690c91/LICENSE) | [NOTICE](https://github.com/phacility/phabricator/blob/51cb7a3db9e8e510d564f6b37297111f7a690c91/NOTICE) |
| Arcanist | [LICENSE](https://github.com/phacility/arcanist/blob/246e604a070f7539838fd246c0405db2752da8d2/LICENSE) | [NOTICE](https://github.com/phacility/arcanist/blob/246e604a070f7539838fd246c0405db2752da8d2/NOTICE) |
| libphutil | [LICENSE](https://github.com/phacility/libphutil/blob/ce63d5b45049a0c3d634e338a701fe750a1e8cea/LICENSE) | [NOTICE](https://github.com/phacility/libphutil/blob/ce63d5b45049a0c3d634e338a701fe750a1e8cea/NOTICE) |

## Research entry points

- [Application inventory](https://github.com/phacility/phabricator/tree/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/applications): 78 directories at the pinned commit. This includes internal infrastructure and optional prototypes, not 78 finished products. [Parity matrix](parity.md) accounts for every directory.
- [User guides](https://github.com/phacility/phabricator/tree/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/docs/user/userguide): source documentation for workflows, limitations, and user expectations. Treat behavior demonstrated by code and fixtures as stronger evidence than aspirational prose in old guides.
- [Application transactions](https://github.com/phacility/phabricator/tree/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/applications/transactions): reusable edit operations, history, comments, and validation across different object types.
- [Policies](https://github.com/phacility/phabricator/tree/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/applications/policy) and [Spaces](https://github.com/phacility/phabricator/blob/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/docs/user/userguide/spaces.diviner): object access is checked in addition to a space's visibility; Spaces can only reduce access. Preserve this model when adding AI and search.
- [Differential](https://github.com/phacility/phabricator/tree/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/applications/differential): durable revisions and successive immutable diffs; comments attach to specific versions and locations.
- [Repository layer](https://github.com/phacility/phabricator/tree/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/applications/repository) and [Diffusion guide](https://github.com/phacility/phabricator/blob/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/docs/user/userguide/diffusion.diviner): hosted and observed repositories, Git/Hg/SVN integration, cross-application references and commit discovery.
- [Conduit](https://github.com/phacility/phabricator/tree/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/applications/conduit): API search/edit patterns; important for imports and CLI compatibility.
- [Arcanist](https://github.com/phacility/arcanist/tree/246e604a070f7539838fd246c0405db2752da8d2/src): working-copy workflows, commit ranges, lint/unit protocols, patch and land semantics. Copying its command names alone is not compatibility.

## Visual reference

Familiar Phabricator appearance is a requirement. The new interface should preserve the compact hierarchy, application names, object identifiers, navigation, status colors, property panels, and transaction timelines while supporting touch and narrow screens.

The source records these defaults in [CelerityDefaultPostprocessor.php](https://github.com/phacility/phabricator/blob/51cb7a3db9e8e510d564f6b37297111f7a690c91/src/applications/celerity/postprocessor/CelerityDefaultPostprocessor.php):

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

The [main menu stylesheet](https://github.com/phacility/phabricator/blob/51cb7a3db9e8e510d564f6b37297111f7a690c91/webroot/rsrc/css/application/base/main-menu-view.css) describes the top bar, global search, and mobile menu expansion. The [basic navigation stylesheet](https://github.com/phacility/phabricator/blob/51cb7a3db9e8e510d564f6b37297111f7a690c91/webroot/rsrc/css/phui/phui-basic-nav-view.css) uses a 205px application sidebar, uppercase section labels, selected row shading, and compact links. [PHUI styles](https://github.com/phacility/phabricator/tree/51cb7a3db9e8e510d564f6b37297111f7a690c91/webroot/rsrc/css/phui) are the reference for lists, properties, timelines, comments, workboards, and status colors. Preserve recognizable structure, but increase touch targets and reflow the page rather than shrinking desktop controls.
