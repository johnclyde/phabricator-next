# Project profiles, membership and watching

Projects have stable `PROJ` identities, versioned profiles, globally unique aliases, members, watchers and an immutable transaction history. Their task lists use the existing many-to-many project tags. Archiving is reversible: an archived project remains readable, editable and usable as a tag, with an archived label and muted color. Archiving is distinct from deleting a project or restricting access.

## Profile and identity

Names, descriptions, status, icons, colors and aliases are editable with the profile's `expectedVersion`. An actual edit advances this version once and records old/new values. An unchanged request still checks access and the submitted version, but creates no event. Policy versions, membership versions and watch preferences are separate, so joining a project does not make an otherwise current description draft stale.

The initial catalog includes the 16 ordinary upstream icons and 10 colors. Existing custom hexadecimal colors are retained. A request may select either `colorKey` or a custom `color`, not both. The special milestone icon is reserved for the future milestone model.

Names generate a primary hashtag using upstream normalization: lowercase, separators become underscores, Unicode and hyphens remain, and the special names `.` and `..` become `dot` and `dotdot`. Aliases use the same normalization, are deduplicated, and have a 128-code-point limit. Rename retains the old primary hashtag as an alias, including when the same edit submits a replacement alias list. A later explicit alias edit can remove that old alias. Slugs are globally unique; collision errors do not identify an inaccessible project.

Schema 11 adds profiles and relationships without rewriting existing project entity bytes, historical evidence or saved mutation responses. Old projects retain their names and custom colors. Their authors and timestamps remain unknown. A legacy transaction retains only the fields that actually existed. Migration reserves valid name slugs before assigning deterministic `legacy-proj…` slugs to conflicting or invalid legacy names, so no existing display name is silently changed.

## Membership and access

Project members automatically have **view** access to their own project, subject to the containing Space's visibility. Membership does not automatically grant edit or interact access, and never grants access to tagged tasks. Projects have a separate **join** rule. Viewers may join when that rule permits them; project editors may join automatically. Existing members may leave. Editors may explicitly add, remove or replace the member list. Creation does not make the author a member unless the initial member list explicitly includes them.

Project rules can permit workspace members, selected principals, or members of that project. The last option is project-specific; it cannot be used as a Space rule or as an arbitrary project's access grant on another object. Every operation still requires the appropriate token scope. A Space remains an outer restriction, without an administrator or creator bypass.

Self join/leave uses the caller's membership-row version, initially zero. An editor's add/remove/set operation uses the collection's version. Every actual membership change increments the collection once and advances the workspace access epoch atomically. Unrelated self joins may coexist; stale collection replacements fail as a whole. New membership grants require enabled accounts; existing disabled members may be retained or removed. No-op requests still check their versions.

Leaving or removing oneself can voluntarily remove access. A fresh authorized operation which removes the caller's view returns only `{id,saved:true,accessLost:true,accessEpoch}`. Saved retries recheck current authority and never restore an old view. Policy edits themselves continue to require retaining the editor's access.

The model preserves the upstream membership-lock flag, but this slice does not expose a lock toggle: upstream uses an application capability which is not implemented yet. It does not pretend that every project editor has that global authority.

## Watching and silence

Watching is independent of membership, grants no access and does not create individual task subscription records. Upstream watching requests notifications about tagged objects, including descendants; that notification delivery and hierarchy behavior remain planned. Any viewer may watch or unwatch themselves. An editor may remove another watcher; adding another watcher is not supported. Each watch relationship has its own optimistic version.

Members can silence automatic project notifications without leaving. Silence is private to the member and is stored in a separate audit stream, outside public project history and activity. Watching can independently request notifications even when membership is silenced: the eventual recipient set is `(members − silenced members) ∪ watchers`, further constrained by the delivery system's access checks. This implementation persists preferences; it does **not** deliver notifications or email yet.

## Browser, offline and command line

Project profiles expose overview, tagged tasks, people and history. The project directory includes active/all, joined and watched views. Joined/watched views default to active projects. Archived tags remain selectable and clearly labeled.

Local-mode metadata drafts retain their exact project version and can queue offline. Basic local project creation can queue when it specifies no initial members or custom policy rules; the selected Space remains bound to the draft. Membership, watching, silence and policy changes require a live connection. Password-mode drafts remain in verified tab memory and require reconnection to save. Permission changes discard old rendered project/task snapshots and hold unsaved work for export or discard. Late saves cannot erase a newer draft.

`npm run arc -- projects` lists active visible projects. `--status active|archived|all`, `--joined`, `--watching`, `--limit N` and `--json` are supported. Joined and watching filters intersect when combined. `npm run arc -- show PROJ1` returns the profile, the viewer's preferences and the first history page. Task `--project` filters accept a visible ID, exact name or alias (including `#alias`), and repeated filters require every tag. Hidden and missing projects fail alike. The configured server path prefix and read-only account tokens work for these reads.

## API

Shared request and response types are in `shared/projects.ts`.

| Route | Contract |
| --- | --- |
| `POST /api/projects` | `ProjectInput` → `Project`; optional initial members and project-specific access rules |
| `GET /api/projects/:id` | `ProjectDetail`, including history, viewer preferences, membership collection version and current access |
| `PATCH /api/projects/:id` | `UpdateProjectInput` with `expectedVersion` → `ProjectDetail` |
| `GET /api/projects/resolve?slug=…` | `ProjectDetail` for a normalized primary slug or alias, with the same visibility restriction as a direct read |
| `GET /api/projects/:id/history?before=N&limit=N` | `ProjectHistory`; exclusive sequence cursor, default 50, maximum 100 |
| `GET /api/projects/:id/members?after=PRINCIPAL&limit=N` | `ProjectMembersPage`; collection version and viewer preferences; exclusive principal cursor |
| `POST /api/projects/:id/members` | `{action:"add"|"remove"|"set",principalIds,expectedCollectionVersion}` |
| `POST /api/projects/:id/membership` | `{action:"join"|"leave",expectedVersion}` for the caller |
| `GET /api/projects/:id/watchers?after=PRINCIPAL&limit=N` | `ProjectWatchersPage`; exclusive principal cursor |
| `POST /api/projects/:id/watchers` | `{principalId,action:"watch"|"unwatch",expectedVersion}` |
| `GET /api/projects/:id/preferences` | Only the caller's membership, watch and silence states |
| `POST /api/projects/:id/silence` | `{silenced,expectedVersion}` for a current member |

Relation pages default to 50 entries and allow at most 100. Successful writes participate in the ordinary principal-scoped idempotency contract. Historical responses retain their original content and are presented under current authority. An old saved creation response lacking a profile version returns a content-free `refreshRequired` acknowledgement rather than borrowing a newer profile.

## Upstream evidence and remaining work

The pinned [project object](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/storage/PhabricatorProject.php) defines automatic member visibility, editor joining and archived behavior. The [transaction editor](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/transactions/editor/PhabricatorApplicationTransactionEditor.php) distinguishes self membership operations from managing others. [Watch](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/controller/PhabricatorProjectWatchController.php) and [silence](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/controller/PhabricatorProjectSilenceController.php) are separate workflows. [Slug normalization](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/util/PhabricatorSlug.php), [rename behavior](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/xaction/PhabricatorProjectNameTransaction.php), and the [icon/color catalog](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/project/icon/PhabricatorProjectIconSet.php) ground the profile contract.

PROJECT-01 remains partial. Project images, cover images, custom fields/forms, comments, application creation and membership-lock capabilities, configurable catalogs, full search/saved queries, project mentions, notification delivery, bulk object editing and Conduit/import compatibility remain unfinished. Nested projects and milestones require inherited membership and policy behavior; they are tracked separately in PROJECT-02. Real ordered workboards, columns, card moves, triggers and WIP limits remain PROJECT-03/04. The existing task-status columns do not implement workboards.
