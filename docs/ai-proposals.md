# Private AI edit proposals

AI proposals are an explicit authoring workflow for text and LaTeX revisions. They are separate from published review comments and deterministic checks. The operator selects the hosted or local model; opening a revision never calls a model.

1. Choose the exact current source version and an editing instruction. Optionally select a source passage. A passage request submits only that passage, its file path, absolute offsets and source identity; a whole-version request submits the text files. Binary figure bytes are never submitted.
2. Confirm the provider and, for hosted generation, external processing. The result is private to the requesting account and remains subject to current revision, source, account and credential access.
3. Inspect the complete diff, each explanation, the model’s limitations, source identity and generation provenance. An empty edit set is a valid no-change result.
4. Explicitly apply the complete proposal. The server applies the saved edits to the exact original current source and creates one new version. It preserves binary figure bindings and previous immutable source, discussion and review evidence. Acceptance of an older version does not carry forward. The public version message identifies AI assistance, provider and configured model; the private instruction and unapplied proposal do not become public history.

Edits require exact UTF-16 source offsets, quotation and surrounding context. Repeated quotations are distinguished by their original position. Wrong quotes, overlapping edits, edits outside the selected scope, unchanged replacements, incomplete Unicode and incomplete responses reject the entire result. The server never fuzzy-matches or partially applies an AI proposal. Application uses the same portable replacement validator as suggested edits and the existing atomic source-version writer.

There is no fixed passage-count limit. Source payloads are bounded to 200,000 UTF-8 bytes for hosted generation and 60,000 for local generation, including serialized request metadata. The complete proposal is bounded to 1,000,000 UTF-8 bytes; raw provider responses are bounded to 2,000,000 bytes. Existing exact-passage/replacement limits are 20,000 UTF-16 code units per edit. These are whole-request resource bounds, not permission to silently truncate edits. Large requests can be divided into explicit passage requests. Applying one proposal changes the source version, so other proposals against the previous version need fresh generation and review.

## Providers

Hosted generation uses the server’s `OPENAI_API_KEY` and explicit `OPENAI_MODEL`. It uses the Responses API with `store: false` and a strict JSON schema. The adapter requires a completed response, rejects refusals, truncation and unexpected output, and never invokes tools. Provider error bodies are not logged or returned. The operator controls model selection; the configured model and any model identity returned by the provider are recorded separately. API behavior follows the [official Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs).

Local generation uses `OLLAMA_MODEL` and the existing `OLLAMA_URL` loopback-only HTTP origin. It checks installed-model metadata before submitting any source and rejects remote-backed model aliases. Model installation and downloading are separate operator actions. Current credential, policy, access epoch and source identity are checked again after asynchronous model verification and immediately before source submission. Shutdown cancellation prevents further source dispatch and discards an unconfirmed result.

No provider is called in automated verification. The provider tests mock network responses. Fixed editorial fixtures cover a known spelling defect, an unsupported claim, unrequested cosmetic changes and a truthful no-change result. They verify response handling and exact application, **not live model quality**. The workflow does not establish factual, scientific or legal correctness and does not claim tests, citations, experiments or proofs were verified by the model.

## Recovery and authority

A generation request is durably reserved before the provider call and outside the provider’s transaction. Retrying the same idempotency key with the same body returns that attempt, including its pending, failed or uncertain state. It never makes another provider call. A changed body under an existing key is rejected. Concurrent retries and recovery after process interruption follow the same rule.

A pending attempt may still be running or may have been interrupted before its terminal result was recorded. There is no automatic redispatch, background retry or provider-response retrieval. A timeout or lost response may already have incurred provider usage. Starting another generation is a new explicit action with a new key and may incur additional usage. If the source or access changes during generation, the returned edits are discarded and only a content-free failed outcome is retained. Revoked accounts cannot inspect or recover the private attempt.

Generation requires current read, write and the selected `review:hosted` or `review:local` credential scopes, plus permission to interact with the revision. Applying requires current source edit permission. Listing and reading require current source visibility and account authority. Application retries also check current authority and verify their immutable application evidence. An exact application retry returns its saved result without creating another version.

Schema 43 adds immutable request, result and application evidence. The migration validates any preexisting names and definitions before adding the tables. Stored results, provenance, exact source hashes, edit anchors and application versions are revalidated on reads and retries. Source writing, application evidence, activity and notification changes commit or roll back together.

## API

- `GET /api/revisions/:id/ai-proposals` lists only the caller’s proposals, with bounded cursor pagination and current provider configuration.
- `POST /api/revisions/:id/ai-proposals` explicitly generates or recovers an exact request. It requires `Idempotency-Key`, provider/model, instruction, `expectedHead`, `expectedAccessEpoch`, optional exact passage scope, and hosted permission.
- `GET /api/revisions/:id/ai-proposals/:proposalId` returns a current-authority private result and whether it still matches the current source.
- `POST /api/revisions/:id/ai-proposals/:proposalId/apply` explicitly applies the full saved proposal using `Idempotency-Key`, exact current head, access epoch and the reviewed proposal digest.

The text proposal workflow does not modify Word packages, execute suggested code, compile LaTeX, publish review comments, land revisions or push repository changes. Those are separate operations. It does not automatically rewrite stale proposals onto a newer version or apply a selected subset of edits.
