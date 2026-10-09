# First milestone API contract

JSON API, same origin; errors `{ error: string }` with 400/404/409/500 status. Exact shared types in `shared/types.ts`. GET returns objects directly; mutation returns created/updated object, except revision creation and version creation return `RevisionDetail`. Revision IDs `D1` for code and `P1` for papers, `L1` for prose/legal drafts (shared numeric sequence allowed), tasks `T1`, projects `PROJ1`, repositories `R1`, wiki `W1`.

- `GET /api/health` → `{ok:true}`
- `GET /api/state` → AppState; includes all simple objects and recent activity
- `POST /api/tasks` TaskInput → Task; `PATCH /api/tasks/:id` partial TaskInput → Task
- `POST /api/projects` `{name,description?,color?}` → Project
- `POST /api/repositories` `{name,remoteUrl,description?,defaultBranch?}` → Repository (registry only; no remote fetch)
- `POST /api/documents` DocumentInput → WikiDocument; `PUT /api/documents/:id` DocumentInput (expectedVersion required) → WikiDocument
- `POST /api/revisions` CreateRevisionInput → RevisionDetail
- `GET /api/revisions/:id` → RevisionDetail
- `POST /api/revisions/:id/versions` CreateVersionInput → RevisionDetail; append immutable version; always reset to needs_review; reject stale expectedVersion
- `PATCH /api/revisions/:id` `{status,expectedVersion}` → Revision; version required for every transition. Acceptance requires current-version local/AI review with no error findings. Do not allow accepted state on stale evidence. Closing is an explicit manual action, never automatic merge.
- `POST /api/revisions/:id/comments` CreateCommentInput → ReviewComment
- `POST /api/revisions/:id/reviews` ReviewInput → ReviewRun; hosted review explicit; errors never fall back to simulated AI. Reject stale input or revision changes during review.
- `GET /api/revisions/:id/export?version=N` → JSON snapshot `{revision,version}` (paper .tex downloaded from version.files in UI/CLI)

Local single-user mode, loopback bind only; strict origin/host checks on server; no authentication yet, no execution of source or TeX. Include `Idempotency-Key` on client queued POST/PATCH/PUT; server persists successful mutation responses and rejects reuse for different bodies. This permits offline outbox replay without duplicates. All writes and activity log events transactional. Client offline outbox can support tasks/documents/comments/versions; don't queue hosted reviews or acceptance.

Root owns shared/review.ts (`analyzeLocally(kind, files): ReviewAnalysis`) and server/ai.ts (`analyzeWithAI(kind, files, provider?: 'openai' | 'ollama'): Promise<ReviewAnalysis>`, `aiConfiguration(): {configured:boolean,model:string|null,localConfigured?:boolean,localModel?:string|null}`). Backend may import these; root supplies shortly. Local review has real deterministic checks and is labelled local, not AI. Default fixtures are explicit demo content, seeded only for fresh DB unless disabled.

RevisionKind supports code, paper and document (general prose/legal draft). Local model review uses provider `ollama`, is explicit and requires OLLAMA_MODEL; no model downloads or implicit remote fallback.
