# Phame blogs and posts

Phame provides internal blogs with authors, editors, drafts, published posts, archives, exact content history and discussion. Publishing makes a post readable to the blog's currently authorized audience. It never enables anonymous access or publishes to an external domain.

Blog owners and editors manage the blog's title, subtitle, description, author/editor membership and active/archive state. Authors can create posts; an author may edit their own posts, while current blog editors may edit every post. Removing a blog editor removes their rights to other people's drafts and posts immediately. The blog owner remains an editor. Drafts and archived posts are visible only to their author and current blog editors, additionally bounded by current blog and Space access. Published posts inherit the blog's current audience, including later access changes. A post cannot independently widen its policy.

A post begins as a draft. Its author or a blog editor explicitly publishes it, returns it to draft, archives it or restores it as a draft. Publication requires a nonempty body. Archival and unpublishing clear the current publication date. Editing published content updates the published post immediately and creates a new exact content revision. Revisions record the title, subtitle, body, state, actor and timestamp. Ordinary readers can see published snapshots; unpublished draft snapshots remain visible only to editors. Restoring an archive does not republish it.

Published posts support attributed comments from authorized readers with write credentials. Archiving a blog preserves the readability of already published posts but stops new posts, publication, content editing and new discussion until the blog is restored. This native archival constraint is explicit; broader upstream editing behavior is not assumed.

The desktop/mobile application exposes blog and post creation, editorial roles, exact source reading, content history, publication controls and comments. Form requests bind their selected object version. The shared suite persistence, object policies, current access checks, immutable event history and retry contracts apply to every operation.

## Native API

- `POST /api/suite/phame` with `{kind:"blog", title, subtitle?, description?, authorIds?, editorIds?}` creates an active blog. The creator is its owner; authors default to the creator.
- `POST /api/suite/phame` with `{kind:"post", blogId, title, subtitle?, body?}` creates a draft in a currently accessible active blog.
- `GET /api/suite/phame` and `GET /api/suite/phame/:id` return currently authorized records. Draft/archive visibility and current parent access apply to lists, details and retries.
- `POST /api/suite/phame/:id/edit` updates title/subtitle plus blog `description` or post `body`.
- Blog `/members` accepts `authorIds` and `editorIds`; `/archive` and `/restore` manage blog status.
- Post `/publish`, `/unpublish`, `/archive` and `/restore` perform explicit lifecycle transitions; `/comment` accepts `body`.

Every command requires `expectedVersion`, a write credential and `Idempotency-Key`. Clients cannot assert authorship, timestamps, historical content or publication status directly. External-domain configuration is not accepted.

## Upstream comparison and remaining work

Primary read-only evidence is the pinned `reference/phabricator/src/applications/phame/storage/PhameBlog.php`, `storage/PhamePost.php`, their query, controller and transaction implementations. Upstream distinguishes blog activity from draft/published/archived post visibility, grants post authors edit rights and permits blog editors to view drafts. These are recovered as native workflows; current parent/Space restrictions remain mandatory. Dedicated author membership is a native editorial capability alongside blog editor membership.

This is partial Phame parity. Public/custom-domain publishing, live-site themes, header/profile images, RSS/Atom, scheduling, post moves, subscriptions and mail, richer search/saved queries, complete Remarkup embedding, Conduit compatibility and historical import/export remain open. No external publishing or infrastructure is created by installing this module.

Focused module tests verify editorial roles, private draft/archive views, current parent and editor revocation, exact source history with unpublished snapshots removed for readers, publication/unpublication/restore transitions, archived-blog restrictions, discussion attribution and input validation. End-to-end persistence, authentication and responsive checks belong to the shared suite release verification.

The shared suite currently stores at most 2 MB per object, including accumulated responses, discussion and content revisions. Operations that would exceed this bound fail explicitly; larger histories and storage separation remain follow-up work.
