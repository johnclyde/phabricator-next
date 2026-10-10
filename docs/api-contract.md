# First milestone API contract

JSON API, same origin; errors `{ error: string }` with 400/404/409/500 status. Exact shared types in `shared/types.ts`. GET returns objects directly; mutation returns created/updated object, except revision creation and version creation return `RevisionDetail`. Revision IDs `D1` for code and `P1` for papers, `L1` for prose/legal drafts (shared numeric sequence allowed), tasks `T1`, projects `PROJ1`, repositories `R1`, wiki `W1`.

Paths below are relative to the configured `APP_BASE_PATH` (default `/`). For example, `/workspace/` places the health route at `/workspace/api/health`; requests outside the configured mount return 404. The bare mount redirects GET/HEAD to its canonical trailing slash. Frontend build and server mount must agree; a mismatch returns 503 with rebuild guidance. Mount support preserves the local-only security boundary.

- `GET /api/health` → `{ok:true}`
- `GET /api/state` → AppState; includes all simple objects and recent activity
- `POST /api/tasks` TaskInput → Task; `PATCH /api/tasks/:id` partial TaskInput → Task
- `POST /api/projects` `{name,description?,color?}` → Project
- `POST /api/repositories` `{name,remoteUrl,description?,defaultBranch?}` → Repository (registry only; no remote fetch)
- `POST /api/documents` DocumentInput → WikiDocument; `PUT /api/documents/:id` DocumentInput (expectedVersion required) → WikiDocument. Optional `message` records an edit summary; every edit appends immutable content history.
- `GET /api/documents/:id` → WikiDetail: current document, first 20 history summaries and activity.
- `GET /api/documents/:id/history?before=N&limit=N` → WikiHistory: summaries descending by version, exclusive `before` cursor, limit 1–100 (default 20), `nextBefore` and `firstAvailableVersion`. Missing versions and malformed cursors fail explicitly.
- `GET /api/documents/:id/versions/:number` → WikiVersion: immutable title, slug, content, author, timestamp, edit summary, kind and restored-from version.
- `POST /api/documents/:id/restore` `{version,expectedVersion,message?}` → WikiDocument: append selected historical title/content as a new version, retain the current slug and all historical records. Never queued offline; this is not upstream draft/publication-pointer behavior.
- `POST /api/revisions` CreateRevisionInput → RevisionDetail
- `GET /api/revisions/:id` → RevisionDetail
- `POST /api/revisions/:id/versions` CreateVersionInput → RevisionDetail; append immutable version; always reset to needs_review; reject stale expectedVersion
- `PATCH /api/revisions/:id` `{status,expectedVersion}` → Revision; version required for every transition. Acceptance requires current-version local/AI review with no error findings. Do not allow accepted state on stale evidence. Closing is an explicit manual action, never automatic merge.
- `POST /api/revisions/:id/comments` CreateCommentInput → ReviewComment
- `POST /api/revisions/:id/reviews` ReviewInput → ReviewRun; hosted review explicit; errors never fall back to simulated AI. Reject stale input or revision changes during review.
- `GET /api/revisions/:id/export?version=N` → JSON snapshot `{revision,version}` (paper .tex downloaded from version.files in UI/CLI)

Both local and password modes bind to loopback with strict origin/host checks; no source or TeX execution. Password mode requires account membership for all content APIs; every member currently shares the workspace. See [authentication](authentication.md) for the credential and offline contracts. Include `Idempotency-Key` on client queued POST/PATCH/PUT; server persists successful mutation responses and rejects reuse for different bodies. This permits offline outbox replay without duplicates. All writes and activity log events transactional. Client offline outbox can support tasks/documents/comments/versions; don't queue hosted reviews or acceptance.

`shared/review.ts` supplies `analyzeLocally(kind, files): ReviewAnalysis`; `server/ai.ts` supplies `analyzeWithAI(kind, files, provider?: 'openai' | 'ollama'): Promise<ReviewAnalysis>` and `aiConfiguration()`. Local review has real deterministic checks and is labelled local, not AI. Default fixtures are explicit demo content, seeded only for fresh DB unless disabled.

RevisionKind supports code, paper and document (general prose/legal draft). Local model review uses provider `ollama`, is explicit and requires OLLAMA_MODEL; no model downloads or implicit remote fallback.

Schema 2 migrates each pre-history wiki document into one `legacy` snapshot at its actual current version, with unknown author (`null`) and its existing last-edit timestamp. Earlier unavailable versions are not synthesized. New writes record an `attribution` containing principal ID, display name, credential ID and request ID; legacy records are not backfilled with fabricated verified authorship. Read/compare can use individually cached wiki versions offline, but restoring requires a live current document.

## Authentication endpoints

- `GET /api/session` → `SessionState` (mode, workspace identity, optional account, session context, CSRF token, expiry). Anonymous password requests receive a pre-login challenge cookie/token; no content is returned.
- `POST /api/login` `{username,password}` → `SessionState`, after exact-origin and pre-login `X-CSRF-Token` checks; rotates the session cookie.
- `POST /api/logout` `{}` → anonymous `SessionState`; revokes the authenticated browser session and clears its cookie.

All protected cookie requests, including GETs, require `X-Session-Context`; mutations also require `X-CSRF-Token` and an exact matching Origin. CLI requests use `Authorization: Bearer …` with independent read/write/review scopes. Authentication and scopes are evaluated before any idempotency replay. Authenticated replay keys include workspace and principal; asynchronous reviews revalidate the credential before committing. Session and token secrets are never content-API fields. Auth responses are no-store.

Schema 3 marks activation of password mode. The durable authentication latch prevents a local-mode downgrade; previous schema-2 binaries refuse the newer database. Account/session/token metadata is persisted separately from immutable document records.
