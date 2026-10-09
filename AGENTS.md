# Project instructions

- Never create, populate, or use GitHub Issues. Use `docs/parity.md` and `docs/roadmap.md`, then the application's own task tracker as it matures.
- Preserve Phabricator's recognizable information architecture and visual vocabulary. Mobile is a primary interface.
- Use strict TypeScript. Keep shared domain types and offline checks independent of Node and React.
- Treat upstream checkouts under `reference/` as read-only historical research; do not execute the PHP software or copy its vendored dependencies into the runtime.
- Never label a local deterministic check as AI. Review evidence is tied to immutable versions. Changing content invalidates acceptance.
- Never send source to an external provider implicitly. Hosted AI review is an explicit operation, configured by the server operator.
- Do not claim feature parity until it is implemented and verified. Track gaps explicitly.
- Run `npm run check`, `npm test`, and `npm run build` after meaningful implementation changes.
