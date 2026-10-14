# Phabricator Next

[![CI](https://github.com/johnclyde/phabricator-next/actions/workflows/ci.yml/badge.svg)](https://github.com/johnclyde/phabricator-next/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

A working, local-first foundation for a modern Phabricator. The familiar interface is intentional. The central new workflow is **iterating on papers, arguments, and legal drafts**: inspect meaningful changes, discuss a precise version, and keep review evidence attached to the content it actually examined. Code review remains part of the historical parity target.

This is a new implementation in **strict TypeScript**, with React, a Node.js server, SQLite, and an initial `arc` CLI. It is an early application with local and password-authenticated shared workspaces, **not full Phabricator parity**. The public source is licensed under **Apache 2.0**. The historical Phabricator, Arcanist, and libphutil sources can be downloaded separately for research; they are not runtime dependencies and their PHP is not executed.

Workspace [search and saved queries](docs/search.md), [custom dashboards](docs/dashboards.md), and [configurable Maniphest workflows](docs/tasks.md) provide shared coordination tools. Hosted operators can designate task configuration administrators with `APP_MANIPHEST_ADMIN_PRINCIPAL_IDS`; ordinary workspace access does not grant configuration rights.

## Run

Requires Node **22.13 or newer** and npm. This milestone uses Node's built-in SQLite module, which is experimental in Node 22 and emits a warning.

```sh
git clone https://github.com/johnclyde/phabricator-next.git
cd phabricator-next
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4310**. The production build supports the offline app shell. `npm run dev` starts the API on 4310 and the browser development server on 5173; the service worker is intentionally disabled in development.

To run under a path prefix, use the same `APP_BASE_PATH` when building and starting (or set it in `.env`):

```sh
APP_BASE_PATH=/workspace/ npm run build
APP_BASE_PATH=/workspace/ npm start
```

Then open `http://127.0.0.1:4310/workspace/`. Assets, API calls, CLI server URLs, installed-app links and offline caches honor the prefix. A mismatched build and server configuration produces an explicit error. Browser drafts/outboxes are separated by mount, preserving existing root-installation data. A path prefix does not isolate untrusted applications sharing an origin. Operator-specific site configuration belongs outside this repository.

The first launch creates `.data/phabricator.sqlite` with clearly labeled sample work: a code revision, a LaTeX paper, and a fictional prose motion with two versions. Set `SEED_DEMO=false` before first launch for an empty workspace. `DATABASE_PATH` selects another database. Restarting preserves your work. To back up a database, stop the app and copy the database together with any SQLite WAL/SHM sidecars; do not delete `.data` to update the application.

The server intentionally binds to loopback. Password sign-in is available with `APP_AUTH_MODE=password` after terminal account provisioning; see [workspace authentication](docs/authentication.md). Hosted workspaces can also configure [Google sign-in](docs/google-sign-in.md) for explicitly mapped existing accounts. Object rules and restrictive Spaces control access; see [access policies](docs/policies.md). For remote browser and phone access, configure an explicit HTTPS public origin behind a same-host TLS proxy; see [hosting](docs/hosting.md). Hosted mode requires password authentication, Secure cookies and a persistent data directory.

## What works

- [Almanac, Conpherence, Calendar, Slowvote, Phame and Legalpad](docs/collaboration-applications.md) provide service-directory records, private conversations, events and recurring schedules, polls, blogs, and version-bound agreements. Desktop/mobile workflows share Space restrictions, durable history and exact retry recovery. Conpherence updates live without submitting drafts. [Upstream XML imports](docs/suite-import.md) preview native objects, preserve stable source identities and keep historical assertions in an editor-only archive. Each application's remaining upstream gaps are documented separately.

- [Git commit and push rules](docs/git-automation.md): a trusted receive hook enforces ref/content rules, verifies accepted revisions and required exact-source builds, records decisions and starts commit builds. [Drydock](docs/drydock.md) adds authorized working-copy blueprints, fenced leases, a real local Git worker and Harbormaster integration. Providers and repository hooks require explicit operator configuration.
- [Revision patches and landing](docs/revision-landing.md): build exact Git-backed code, LaTeX and legal-text revisions in Drydock; prepare, inspect and explicitly land accepted source as a squash commit with Herald rules and recovery. Local destination branches require explicit operator configuration.
- [Owners](docs/owners.md): versioned people/project ownership packages, repository paths and exclusions, automatic review routing, collective commit audits, and immutable routing history. Packages obey source permissions and are searchable from desktop and mobile. Blocking package revision review and upstream interchange remain open.
- [Audit](docs/audit.md): review immutable commits after landing, inspect their recorded changes, request auditors, raise concerns, accept or resign, and retain a complete decision history. Herald can request audits automatically.
- [Herald and Harbormaster](docs/automation.md): versioned rules with test transcripts, automatic scoped actions, immutable build plans and sources, dependent steps, external worker leases and results, configured HTTP dispatch, and mobile rule/build controls. Remaining upstream adapters and execution capabilities are tracked explicitly.

- Code, paper and prose/legal revisions with immutable source snapshots, content hashes and activity history. [Comparison controls](docs/comparisons.md) keep an exact version pair and file selected, support reverse comparisons and deleted files, and connect bounded literal word/line differences with touch, keyboard and spoken change/file navigation. An optional space/tab navigation filter retains the full literal diff and reports skipped passages. [Passage review threads](docs/review-threads.md) preserve exact source quotations, replies and resolve/reopen history across versions, with explicit uncertainty when text cannot be located uniquely.
- New versions reset acceptance. Review evidence records its exact version, provider and model. Acceptance is a deliberate action based on current-version evidence or exact-version named reviewer decisions, subject to blocking reviews and error findings; it never merges or files anything.
- [Finding navigation](docs/comparisons.md#review-finding-navigation) keeps an exact historical review selected across newer runs, with shared touch, keyboard and voice controls, original source jumps and authorized offline reading. Deterministic checks, local AI, hosted AI and unrecorded on-device results retain distinct provenance.
- [Revision dependencies](docs/revision-dependencies.md) connect code, paper and document reviews through parent/child links, with inverse history and cycle prevention. Mobile controls, authorized offline snapshots and exact CLI requests preserve source versions and acceptance. A verified Stack view shows branches, shared parents and closed revisions, with mobile/offline reading and voice navigation. Upstream Conduit interoperability and stack landing remain planned.
- [Revision authorship](docs/revision-authorship.md) separates current ownership from original source attribution, with explicit transfer and Commandeer actions, immutable handoff history, mobile/offline drafts and exact CLI recovery. Ownership respects Space and source restrictions. [Named reviewers](docs/revision-reviewers.md) can accept an exact version, request changes or resign, including on Word documents. Editor-managed required reviews and author handoffs reassess acceptance atomically. [Revision lifecycle](docs/revision-lifecycle.md) adds explicit author actions, shared text/Word history, optional drafts and exact retries. Collective reviewers and upstream interoperability remain gaps.
- [Revision details](docs/revision-metadata.md) supports titles, summaries and Test Plans across code, papers and Word, with immutable edit history, exact retries and mobile/offline drafts. Test Plans are required by default for new revisions; operators may make them optional. Metadata edits preserve source versions and review evidence.
- [Revision following](docs/revision-subscriptions.md) separates explicit subscriptions from automatic author/reviewer following. Comment authors' automatic opt-in respects prior opt-outs; private mute preferences have their own history. Mobile controls, a Following filter, voice navigation and exact CLI retries share current access checks. Revision updates now reach the private [notification inbox](docs/notifications.md).
- [People mentions](docs/mentions.md) in revision, task and Paste discussions capture the named person when saved. A touch-accessible picker preserves the existing draft and source anchor; resolved mentions restore following while respecting current access and private mute. Historical comments and exact retries never reinterpret names.
- [Private review drafts](docs/review-drafts.md) keep multiple comments, replies, suggestions and a summary visible only to their owner until explicit complete-review publication. Exact source/thread/access pins, atomic publication and idempotent CLI recovery preserve the inspected content; pending drafts produce no shared discussion or notification effects.
- [Core formatting](docs/remarkup.md) presents emphasis, quotes, lists, code, notes and safe links across discussions, wiki content, task descriptions and revision summaries/Test Plans. Exact source remains readable and copyable on mobile; formatting preserves captured discussion mentions and existing offline reads. Wiki history stays fixed to the selected version; Contents and heading share links preserve that version through publication changes, browser navigation and offline reopening. Task-list descriptions load their reader on expansion. Math, tables, embeds and full Remarkup compatibility remain planned.
- [Notifications](docs/notifications.md) deliver revision, task, Wiki, Paste and six-application updates to current followers and tagged-project watchers, with private mute, current access checks, unread counts, mobile reading and voice filters. Read actions preserve their observed boundary and exact retry request; authorized cached pages support offline reading. [Task delivery and private mute](docs/task-notifications.md) cover owners, subscriptions, dependencies, merges and board moves. [Wiki and Paste following](docs/object-subscriptions.md) includes private mute and version-bound inbox causes. [Opt-in SMTP email](docs/notification-email.md) is available for the six collaboration apps through an operator-configured service; generic messages link to the authenticated inbox. Inbound mail, push and broader application delivery remain unfinished.
- [Suggested edits](docs/suggested-edits.md) attach an exact replacement or deletion to a passage. Explicit application creates a new immutable version after checking current source, discussion and access; stale proposals cannot silently edit newer text.
- [Revision project tags](docs/revision-projects.md) organize code, papers and Word drafts with multiple tags, hierarchy-aware add/remove/replace actions and independent history. Mobile/offline editing, project filters, read-only voice navigation and exact CLI retries preserve source versions and acceptance.
- [Personal revision views](docs/revision-views.md) save named filters for code, papers and documents across devices. Current-author, following and project filters share desktop, mobile, offline and read-only voice behavior; explicit saves preserve concurrent edits and uncertain requests.
- [Active revisions](docs/revision-active.md) group code, papers and documents by author and reviewer responsibility using Phabricator’s eight action groups. Mobile, offline, voice and command-line reads share the same version-bound queue.
- [Maniphest task pages](docs/tasks.md) provide versioned field edits, multiple project tags with explicit add/remove/replace operations, assignment with Space-bounded owner access, following preferences, immutable comments and change history, and dependencies with inverse links and cycle detection. Single and batch duplicate merges preserve task histories and record follower additions atomically. History and related-task references respect current access; stale offline edits preserve their original version for conflict resolution.
- [Project profiles](docs/projects.md) provide versioned metadata, aliases, icons/colors, reversible archiving, member management, join/leave, independent watching and private silence preferences. Project-specific join rules and automatic member visibility remain bounded by Spaces. Subprojects and milestones preserve inherited membership, parent access, watching and task-tag relationships. [Workboards](docs/workboards.md) add independent column ordering, milestone columns, touch/keyboard card moves, previewed bulk moves within and across projects, reusable column setups, advisory limits, immutable history and filtered CLI reads. Project-event notifications, triggers and remaining board capabilities are still unfinished.
- [Diffusion repository browsing and import](docs/git-repositories.md) reads operator-configured local bare Git repositories: branches and tags, exact commit metadata and parents, directory trees, UTF-8 files, and paged history. Selecting a reference pins its full commit ID; later branch movement never changes the selected source. An explicit import creates a code, paper or document review from a complete supported text tree, retaining immutable commit/tree/blob identities and original file modes. A subsequent import adds a version after checking the exact current base, preserves prior discussion and resets acceptance. Every linked revision remains subject to repository visibility. Visited source supports bounded offline reopening in local mode and current-tab retention in password mode; imports stay online. Exact committed-tree comparisons add rename/copy detection, mode/type changes and explicit binary/link states, with lazy mobile source views and cached offline pairs. Line provenance follows exact Git origins and whole-file renames, with mobile source/commit navigation, bounded offline snapshots and CLI reads. Exact patch downloads preserve binary data and file modes, verify the target tree, and support mobile, bounded offline retention and CLI export. Repository hosting, working-copy ranges, combined merge diffs and remote/stack landing remain planned.
- Tasks, repository registration, filtering, and a shared activity feed, backed by SQLite transactions. Existing databases retain their known snapshots with explicit legacy history gaps; missing older versions are never fabricated.
- [Phriction wiki](docs/wiki.md) combines immutable history and comparisons with shared saved drafts, exact earlier-version publication, soft deletion and restore-as-new. Canonical paths, parent/child navigation, inherited visibility, and document moves preserve source history and child paths. Desktop/mobile Active and All views search published content with bounded, permission-aware paging and cached offline pages. Four Phriction Conduit read methods expose stable document/content identities; legacy create/edit methods and CLI commands add immediate publication with exact retry recovery. The broader API remains a parity gap. Publication conflicts and uncertain requests stay explicit.
- [Paste](docs/pastes.md) provides editable text snippets with exact source versions, language highlighting, line selection, raw downloads, comparisons, version-bound comments and archive/reactivate controls. Filtered lists, mobile views and CLI operations share current object/Space policies; drafts and exact uncertain-write requests remain recoverable.
- Deterministic checks that run without internet: LaTeX labels/citations across supplied `.tex`/`.bib` files, drafting placeholders, conflict markers and a few source checks. These are explicitly labeled **local checks**, not AI or verification of scientific/legal claims.
- [References and source inspections](docs/citations.md) inventory literal BibTeX/LaTeX citations in an exact version, retain raw source and uncertainty, and record explicit reviewer attestations against immutable uploaded Files. Quotes, locators and retractions retain attribution and source identity; visibility requires access to both manuscript and supporting File. This does not automatically verify a claim or authority.
- [Word document review](docs/docx.md) preserves imported DOCX packages, shows a mobile structural reading view with notes and imported annotations, applies supported single-passage or multi-paragraph batches as tracked changes, resolves supported text insertions/deletions for another editing round, and exports/reimports exact immutable versions. Version-bound passage threads support replies and resolution; an explicit selected-thread export adds complete attributed discussion as classic Word comments while preserving the original package. Source File permissions continue to govern every derived version and export. General rich editing, broader anchors, modern Word comment semantics, and projection-aware automated review remain planned.
- Explicit [paper compilation](docs/paper-builds.md) pins a saved source version, entrypoint and compiler. Durable jobs provide cancellation, exact retries and immutable PDF/log/manifest/SyncTeX artifacts. A mobile PDF viewer links compiler locations back to their original source. Compilation requires an operator-configured isolated container and never runs TeX on the API host.
- [Private AI edit proposals](docs/ai-proposals.md) generate exact, explained text, LaTeX or supported Word paragraph edits only after an explicit hosted/local action. Inspect the complete diff by touch or voice, then explicitly apply all edits as one version; source changes invalidate the proposal. Retry recovery never dispatches the same provider request twice.
- Explicit AI review adapters for hosted OpenAI and an installed local Ollama model, with source-anchor validation and no silent fallback.
- Responsive navigation and touch controls. Local mode has cached visited revisions, persistent drafts and a retryable offline outbox. Password mode verifies identity before opening content and keeps drafts only in the current tab, with export before sign-out. Acceptance and AI jobs are never queued as ordinary offline edits.
- [Audio inbox](docs/audio.md) records offline, preserves exact audio, and transcribes English speech on the device after explicit installation of a pinned public Whisper model. Generated text retains exact audio/model provenance; editable transcript drafts are separate and explicitly saved. Local workspaces use device storage, while protected workspaces keep audio and transcripts in the current session only. Starting a recording stops browser-provider command recognition in the same tab. Transcripts never automatically modify source or execute commands. [Transcript source edits](docs/transcript-edits.md) apply an explicitly reviewed passage replacement as a new text or tracked Word version, including voice preview and confirmation.
- Voice/typed commands for navigation, search, task drafting, summaries and reading open discussion threads, with optional spoken responses. Direct object navigation accepts commands such as “open W1”, “open wiki page 1”, “open task 123”, “open paper 2”, and “open repository 1”. Actual recognition depends on browser support and permission. Live command recognition may use an external browser speech service; offline recognition of live commands is **not** implemented. Recorded audio has the separate, browser-local transcription workflow described above.
- Password accounts, expiring browser sessions, CSRF protection, terminal account management and revocable scoped CLI tokens. New writes retain account and credential attribution. View/edit/interact policies and restrictive Spaces apply to existing objects, history, exports, activity, search inputs and review calls. Mobile access controls expose actual rules and preserve unsaved drafts when access changes.
- An initial CLI for offline checks, explicit-file snapshot submission, review, export, visible task/project queries, paged workboard reads and exact Git source/history/comparison reads and verified patch downloads; authenticated workspaces use `PHABRICATOR_TOKEN`.

Saving or reviewing a document never executes it. TeX runs only through an explicit paper-build request in the configured isolated worker; it is unavailable until the operator sets up that worker. The [Files application](docs/files.md) stores immutable uploads and versioned PNG/JPEG/PDF figures with explicit sharing. Word package processing runs in bounded workers; rendered PDF comparisons remain planned. See [the paper-build contract and limits](docs/paper-builds.md) and [Word preservation limits](docs/docx.md).

## AI configuration

Copy `.env.example` to `.env` and fill in only the providers you want. `npm start` and `npm run dev` load it. The browser never receives API keys.

For hosted review and edit proposals, set both `OPENAI_API_KEY` and `OPENAI_MODEL` to a model available to your account that supports Responses structured outputs. Clicking **Hosted AI** sends the selected complete snapshot to OpenAI and may incur usage costs. Edit proposals also support an explicitly selected passage; their control states the exact scope before generation. Neither operation runs implicitly when you save a revision. Responses use `store: false`; that does not imply zero retention across all provider systems.

For local model review, run Ollama separately with an already downloaded local model and set `OLLAMA_MODEL`; `OLLAMA_URL` defaults to `http://127.0.0.1:11434`. Run the Ollama daemon with `OLLAMA_NO_CLOUD=1` for private/offline work ([Ollama configuration](https://docs.ollama.com/faq)). The adapter permits only a loopback HTTP origin, rejects redirects and cloud-backed model metadata before transmitting source, never downloads models, and never falls back to hosted AI. A configured adapter is not proof the local model is running. Local AI needs the server and model runtime; browser text checks also work when the server is unavailable. Large snapshots are rejected with explicit limits, not silently truncated.

AI output is review evidence, not an authority. Structured output cannot establish factual, scientific or legal correctness. Provider adapters have deterministic contract tests; live model quality and latency need separate evaluation with the chosen models. [OpenAI structured output documentation](https://developers.openai.com/api/docs/guides/structured-outputs) and [Ollama chat API](https://docs.ollama.com/api/chat).

## CLI

```sh
# No server or internet needed. Pass every referenced source/bibliography file.
npm run arc -- check --kind paper paper/main.tex paper/references.bib
npm run arc -- check --kind document drafts/motion.md

# Send explicit files as the entire source snapshot. Omitted files are removed.
npm run arc -- diff --kind paper --title "A clearer argument" --test-plan "Read the argument and checked its references." paper/main.tex
npm run arc -- diff --revision P2 --message "Clarify assumptions" paper/main.tex
npm run arc -- review P2 --provider local
npm run arc -- list
npm run arc -- show P2
npm run arc -- export P2 --version 1

# Stage private discussion entries, inspect the full saved review, then publish.
npm run arc -- review-drafts
npm run arc -- review-drafts P2
npm run arc -- save-review-draft P2 DRAFT_UUID --intent entry.json --request-id save-1
npm run --silent arc -- preview-review-drafts P2 > review-preview.json
npm run arc -- publish-review-drafts P2 --intent review-preview.json --request-id publish-1

# Compile an exact saved paper version using the configured isolated worker.
npm run arc -- builds P2 --json
npm run arc -- compile P2 --version-id VERSION_ID --content-hash CONTENT_HASH \
  --entrypoint paper/main.tex --toolchain-id TOOLCHAIN_ID --request-id REQUEST_ID
npm run arc -- build P2 BUILD_ID
npm run arc -- download-build P2 BUILD_ID --artifact pdf --output paper.pdf

# Read a project's independent columns and card order.
npm run arc -- board PROJ1 --status all

# Observe configured Git references, then select one complete commit ID.
npm run arc -- repositories
npm run arc -- refs R1
npm run arc -- browse R1 --commit FULL_COMMIT_ID
npm run arc -- browse R1 --commit FULL_COMMIT_ID --path README.md --file
npm run arc -- history R1 --commit FULL_COMMIT_ID --limit 25

# Create a review from the entire committed text tree, with source access retained.
npm run arc -- import-git R1 --commit FULL_COMMIT_ID --kind paper --title "Review the paper" --test-plan "Inspect the committed source and references."

# Import another complete tree into an existing review using its current version pins.
npm run arc -- import-git-version P2 --commit FULL_COMMIT_ID --version 1 \
  --version-id VERSION_ID --content-hash CONTENT_HASH --message "Revise the argument"
```

Use actual object IDs from your workspace. `--server` or `PHABRICATOR_URL` selects the API, including a mount such as `http://127.0.0.1:4310/workspace/`. `check` exits nonzero on error findings. For machine-readable export use `npm run --silent arc -- export P2 > snapshot.json`. `arc` includes the documented Phriction create/edit compatibility commands; Arcanist Git ranges, patch/land, lint engines and broader Conduit compatibility remain gaps.

## Verify and continue

```sh
npm run check
npm test
npm run build
npm run test:e2e
```

Local browser tests use Playwright with Chrome (or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chromium binary). To use Playwright's bundled browser instead, run `npx playwright install chromium` followed by `CI=true npm run test:e2e`. Desktop and mobile runs each use a fresh temporary seeded database, preserving the application's real sign-in limits; they never touch the normal workspace database. Pass a test filename and `--project=desktop` or `--project=mobile` after `--` for a focused run. Coverage includes desktop and 390px touch emulation, first-visit offline reload, outbox replay across tabs, storage quota failures, comment anchor recovery and invalidation of acceptance. Physical iOS/Android devices, microphone recognition and real model calls have not been exercised yet.

[GitHub Actions](https://github.com/johnclyde/phabricator-next/actions/workflows/ci.yml) runs type checks, core tests, the build, and desktop/mobile browser tests at both the root and a path prefix on pushes and pull requests. It uses Node 22 and standard Ubuntu runners, which are [free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions). The workflow needs no secrets, makes no model calls, and uses no paid actions, artifact uploads, or caches. Hosted AI is optional and has separate provider costs; it is not needed to build, test, or run the application.

For historical feature research, optionally run `sh scripts/fetch-upstream.sh`. This downloads the three upstream repositories into ignored `reference/` directories at the exact commits in [upstream-lock.tsv](docs/upstream-lock.tsv). A normal source clone does not include these checkouts.

- [Architecture decisions](docs/architecture.md)
- [Implementation roadmap and internal tracker](docs/roadmap.md)
- [Latest upstream parity inventory, with historical carry-forward features](docs/parity.md)
- [Upstream provenance, exact commits, licenses, and visual reference](docs/upstream.md)
- [Workspace authentication and operator account tools](docs/authentication.md)
- [API contract](docs/api-contract.md)

Work is tracked here and in the application's own tracker; GitHub Issues are disabled. See [contribution guidance](CONTRIBUTING.md) for sending changes. “Phabricator Next” is a working name, with no claim of upstream affiliation.

## License

Copyright 2026 John Clyde and contributors. Released under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) and [upstream provenance](docs/upstream.md) for attribution. Dependencies retain their own licenses.
