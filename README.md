# Phabricator Next

[![CI](https://github.com/johnclyde/phabricator-next/actions/workflows/ci.yml/badge.svg)](https://github.com/johnclyde/phabricator-next/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

A working, local-first foundation for a modern Phabricator. The familiar interface is intentional. The central new workflow is **iterating on papers, arguments, and legal drafts**: inspect meaningful changes, discuss a precise version, and keep review evidence attached to the content it actually examined. Code review remains part of the historical parity target.

This is a new implementation in **strict TypeScript**, with React, a Node.js server, SQLite, and an initial `arc` CLI. It is an early single-user application, **not full Phabricator parity**. The public source is licensed under **Apache 2.0**. The historical Phabricator, Arcanist, and libphutil sources can be downloaded separately for research; they are not runtime dependencies and their PHP is not executed.

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

The first launch creates `.data/phabricator.sqlite` with clearly labeled sample work: a code revision, a LaTeX paper, and a fictional prose motion with two versions. Set `SEED_DEMO=false` before first launch for an empty workspace. `DATABASE_PATH` selects another database. Restarting preserves your work. To back up a database, stop the app and copy the database together with any SQLite WAL/SHM sidecars; do not delete `.data` to update the application.

The server intentionally binds to loopback. This is a responsive mobile interface, but authenticated access from a physical phone or other computer is a future deployment milestone. Do not expose this prototype through a public proxy: authentication, object policies and multi-user isolation are not implemented yet.

## What works

- Code, paper and prose/legal revisions with immutable source snapshots, version comparisons, file/line comments, content hashes and activity history. Prose supports word differences; source supports line differences.
- New versions reset acceptance. Review evidence records its exact version, provider and model. Acceptance requires current-version review evidence without blocking errors and is a deliberate action; it never merges or files anything.
- Tasks, projects, repository registration, wiki documents with edit counters, filtering, and a shared activity feed, backed by SQLite transactions. Repository registration stores metadata; it does not yet host or browse Git. Wiki pages currently retain the latest content and edit counter, not historical content; use paper/prose revisions for immutable draft history.
- Deterministic checks that run without internet: LaTeX labels/citations across supplied `.tex`/`.bib` files, drafting placeholders, conflict markers and a few source checks. These are explicitly labeled **local checks**, not AI or verification of scientific/legal claims.
- Explicit AI review adapters for hosted OpenAI and an installed local Ollama model, with source-anchor validation and no silent fallback.
- Responsive navigation, touch controls, cached visited revisions, persistent local drafts, and a retryable offline outbox. Acceptance and AI jobs are never queued as ordinary offline edits.
- Voice/typed commands for navigation, search, task drafting and summaries, with optional spoken responses. Actual recognition depends on browser support and permission. The browser may use an external speech service; offline speech recognition is **not** implemented.
- An initial CLI for offline checks, explicit-file snapshot submission, review and export.

No TeX, uploaded code, or document macros are executed. Paper iteration currently means source/structure review, comparison and source export; reproducible sandboxed PDF builds, SyncTeX and DOCX round-tripping are planned.

## AI configuration

Copy `.env.example` to `.env` and fill in only the providers you want. `npm start` and `npm run dev` load it. The browser never receives API keys.

For hosted review, set both `OPENAI_API_KEY` and `OPENAI_MODEL` to a model available to your account that supports Responses structured outputs. Clicking **Hosted AI** sends the selected complete snapshot to OpenAI and may incur usage costs. It does not run implicitly when you save a revision. Responses use `store: false`; that does not imply zero retention across all provider systems.

For local model review, run Ollama separately with an already downloaded local model and set `OLLAMA_MODEL`; `OLLAMA_URL` defaults to `http://127.0.0.1:11434`. Run the Ollama daemon with `OLLAMA_NO_CLOUD=1` for private/offline work ([Ollama configuration](https://docs.ollama.com/faq)). The adapter permits only a loopback HTTP origin, rejects redirects and cloud-backed model metadata before transmitting source, never downloads models, and never falls back to hosted AI. A configured adapter is not proof the local model is running. Local AI needs the server and model runtime; browser text checks also work when the server is unavailable. Large snapshots are rejected with explicit limits, not silently truncated.

AI output is review evidence, not an authority. Structured output cannot establish factual, scientific or legal correctness. Provider adapters have deterministic contract tests; live model quality and latency need separate evaluation with the chosen models. [OpenAI structured output documentation](https://developers.openai.com/api/docs/guides/structured-outputs) and [Ollama chat API](https://docs.ollama.com/api/chat).

## CLI

```sh
# No server or internet needed. Pass every referenced source/bibliography file.
npm run arc -- check --kind paper paper/main.tex paper/references.bib
npm run arc -- check --kind document drafts/motion.md

# Send explicit files as the entire source snapshot. Omitted files are removed.
npm run arc -- diff --kind paper --title "A clearer argument" paper/main.tex
npm run arc -- diff --revision P2 --message "Clarify assumptions" paper/main.tex
npm run arc -- review P2 --provider local
npm run arc -- list
npm run arc -- show P2
npm run arc -- export P2 --version 1
```

Use actual revision IDs from your workspace. `--server` or `PHABRICATOR_URL` selects the API. `check` exits nonzero on error findings. For machine-readable export use `npm run --silent arc -- export P2 > snapshot.json`. `arc` does not yet implement Arcanist Git ranges, patch/land, lint engines or Conduit compatibility.

## Verify and continue

```sh
npm run check
npm test
npm run build
npm run test:e2e
```

Local browser tests use Playwright with Chrome (or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed Chromium binary). To use Playwright's bundled browser instead, run `npx playwright install chromium` followed by `CI=true npm run test:e2e`. Browser tests run against a temporary seeded database and never touch the normal workspace database. Coverage includes desktop and 390px touch emulation, first-visit offline reload, outbox replay across tabs, storage quota failures, comment anchor recovery and invalidation of acceptance. Physical iOS/Android devices, microphone recognition and real model calls have not been exercised yet.

[GitHub Actions](https://github.com/johnclyde/phabricator-next/actions/workflows/ci.yml) runs type checks, core tests, the build, and desktop/mobile browser tests on pushes and pull requests. It uses Node 22 and standard Ubuntu runners, which are [free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions). The workflow needs no secrets, makes no model calls, and uses no paid actions, artifact uploads, or caches. Hosted AI is optional and has separate provider costs; it is not needed to build, test, or run the application.

For historical feature research, optionally run `sh scripts/fetch-upstream.sh`. This downloads the three upstream repositories into ignored `reference/` directories at the exact commits in [upstream-lock.tsv](docs/upstream-lock.tsv). A normal source clone does not include these checkouts.

- [Architecture decisions](docs/architecture.md)
- [Implementation roadmap and internal tracker](docs/roadmap.md)
- [2021 parity inventory: all 78 application directories](docs/parity.md)
- [Upstream provenance, exact commits, licenses, and visual reference](docs/upstream.md)
- [API contract](docs/api-contract.md)

Work is tracked here and in the application's own tracker; GitHub Issues are disabled. See [contribution guidance](CONTRIBUTING.md) for sending changes. “Phabricator Next” is a working name, with no claim of upstream affiliation.

## License

Copyright 2026 John Clyde and contributors. Released under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) and [upstream provenance](docs/upstream.md) for attribution. Dependencies retain their own licenses.
