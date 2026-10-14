# Private AI edit proposals

AI proposals are an explicit authoring workflow for text, LaTeX and supported Word paragraphs. They are separate from published review comments and deterministic checks. The operator selects the hosted or local model; opening a revision never calls a model.

1. Choose the exact current source version and an editing instruction. Optionally select a source passage. A passage request submits only that passage, its file path, absolute offsets and source identity; a whole-version request submits the text files or supported Word paragraph projections. Binary figures and Word ZIP bytes are never submitted.
2. Confirm the provider and, for hosted generation, external processing. The result is private to the requesting account and remains subject to current revision, source, account and credential access.
3. Inspect the complete diff, each explanation, the model’s limitations, source identity and generation provenance. An empty edit set is a valid no-change result.
4. Explicitly apply the complete proposal. The server applies the saved edits to the exact original current source and creates one new version. It preserves binary figure bindings and previous immutable source, discussion and review evidence. Acceptance of an older version does not carry forward. The public version message identifies AI assistance, provider and configured model; the private instruction and unapplied proposal do not become public history.

Edits require exact UTF-16 source offsets, quotation and surrounding context. Repeated quotations are distinguished by their original position. Wrong quotes, overlapping edits, edits outside the selected scope, unchanged replacements, incomplete Unicode and incomplete responses reject the entire result. The server never fuzzy-matches or partially applies an AI proposal. Text application uses the same portable replacement validator as suggested edits and the existing atomic source-version writer. Word application additionally uses the complete tracked-passage batch validator and isolated package editor.

There is no fixed passage-count limit. Source payloads are bounded to 200,000 UTF-8 bytes for hosted generation and 60,000 for local generation, including serialized request metadata. The complete proposal is bounded to 1,000,000 UTF-8 bytes; raw provider responses are bounded to 2,000,000 bytes. Existing exact-passage/replacement limits are 20,000 UTF-16 code units per edit. These are whole-request resource bounds, not permission to silently truncate edits. Large requests can be divided into explicit passage requests. Applying one proposal changes the source version, so other proposals against the previous version need fresh generation and review.

## Word documents

Word requests use ordinary editable paragraphs in the main document story. The portable source projection uses `docx/paragraph-N.txt`, where N is the original block position, and retains the exact original version identity and package content hash. It excludes notes, comments, tables, field results and paragraphs with existing tracked changes or comment/note references. The provider receives only the selected paragraph text, or this supported paragraph collection; it never receives the ZIP package or omitted content. A document with no supported paragraphs is unavailable for generation.

Every proposed passage must match the original paragraph exactly. Replacements are single-line text, support styled runs within a paragraph, and preserve styles through tracked deletions and insertions. The full Word edit batch is bounded to 512 KiB with no fixed passage-count cap. A complete proposal can contain edits in many paragraphs. Application verifies all passages before preparing one new package and one new immutable source version. The isolated worker preserves all other ZIP entries, including figures, notes and comments. Existing review acceptance is invalidated, while historical decisions remain attached to their original version.

The portable projection does not prove that all original XML is editable. Hidden bookmark or complex package markup, signed packages and unsupported paragraph properties can still cause the package worker to reject the entire proposal at application. Nothing is partially applied. Paragraphs with the new tracked edits are excluded from another generation until those revisions are explicitly resolved through the separate Word workflow.

Package processing is cancellable and happens outside the database lock. Before committing, the service checks current credentials, permission, exact source, access epoch and the reviewed proposal again. It verifies the exact accepted and rejected paragraph text, tracked-change author and timestamp, preserved source-file binding and operation hash. Source writing, activity, notifications and the private application receipt commit together. Reads and retries revalidate the saved package digest and application evidence; an exact successful retry does not process the package again. Text and LaTeX evidence from schema 43 remain compatible; this extension adds no schema migration.

## Voice review

After explicitly opening a proposal, use **next AI edit**, **previous AI edit**,
**read AI edit** and **read AI explanation** to review every edit, including edits
on later display pages. Narration identifies the original version and location.
Long spoken excerpts announce their shortening; the complete text stays in the
preview. **Set AI instruction to …** changes only the instruction draft through
the selected, consented voice-input channel. It never starts generation.

**Prepare AI proposal** pins the complete proposal, source and current access
context. **Confirm AI proposal** then applies that exact proposal; **cancel AI
proposal** clears the prepared action. Changing the source, proposal, comparison,
account or access context retires confirmation and private narration. Going
offline also retires confirmation, and reconnecting never submits an action.
Generation and consent to external processing remain explicit screen controls.

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

The proposal workflow does not execute suggested code, compile LaTeX, publish review comments, resolve Word tracked changes, land revisions or push repository changes. Those are separate operations. It does not automatically rewrite stale proposals onto a newer version or apply a selected subset of edits.


## Explicit live evaluation

Normal unit and browser suites use synthetic provider responses and never call a model. An operator can explicitly evaluate six small synthetic text, LaTeX and Word examples with the configured hosted model:

```sh
OPENAI_MODEL=<model> node --env-file-if-exists=.env --import tsx scripts/evaluate-ai-proposals.ts --run --allow-hosted --output /private/path/proposal-report.json
```

This uses the server credential and may incur API usage. It reads the public Word test fixture, never the workspace database or user documents. The output path must be new. Cases check literal spelling corrections, preserved LaTeX/citation keys, unchanged quoted text/numbers, abstention without evidence, no unrequested rewrites, and Word paragraph mapping. The report retains complete synthetic input, output, provider provenance and elapsed time. A provider failure stops the run; there is no automatic retry. Passing these examples is a limited smoke result, not a representative accuracy benchmark or verification of factual, scientific or legal correctness. Usage cost is not measured.
