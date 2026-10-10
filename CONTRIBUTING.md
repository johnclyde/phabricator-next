# Contributing

The source is public under Apache 2.0, and pull requests are welcome. Start with [the roadmap](docs/roadmap.md), [the parity inventory](docs/parity.md), and [project instructions](AGENTS.md). Work is recorded in those documents and the application's own tracker. GitHub Issues are disabled; propose a concrete change through a pull request.

Use Node 22.13 or newer and install the locked dependencies with `npm ci`. Run `npm run dev` for development. For validation:

```sh
npm run check
npm test
npm run build
npm run test:e2e
```

Local browser tests use installed Chrome by default. Alternatively, run `npx playwright install chromium` and then `CI=true npm run test:e2e`. GitHub Actions installs its browser automatically. Tests use a temporary database and mocked model responses; no model credentials are required.

Preserve the familiar Phabricator interface and make narrow touch screens part of every UI change. Keep local checks usable offline, bind review evidence to immutable versions, and make external source transmission explicit. Update the parity inventory only when behavior has been implemented and verified. The current server is loopback-only, with local mode or a password-authenticated shared workspace. Fine-grained object/Space policies and network hosting remain planned work; see [authentication boundaries](docs/authentication.md).

Describe the problem, resulting behavior, and relevant validation in each pull request. Never commit local databases, drafts, credentials, or downloaded upstream checkouts. Contributions intentionally submitted for inclusion are under Apache 2.0, as described in the license.
