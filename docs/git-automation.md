# Commit and push rules

Herald supports three Git subjects: observed commits, proposed ref changes, and proposed commit content. Operators connect an actual bare Git receive service to the authenticated API. Opening Diffusion remains read-only and never creates commit observations.

Push ref rules inspect repository, pusher, full ref name, branch/tag type, create/update/delete operation, and force status. Push content and observed commit rules inspect full commit ID, message, raw author/committer identity, merge status, affected branches, changed paths, literal per-path patches, and added/removed lines. “Affected branches” means branches in this receive containing the newly introduced commit; it is not a query of every branch containing that commit. Merge changes are compared with the first parent. These Git-specific fields do not change revision rules into changed-line rules.

Global and repository-scoped push rules can block with a reason. Commit rules can start Harbormaster plans against the exact commit and tree. Every evaluation has an immutable transcript, and every receive observation has a durable receipt. **Allowed** on a pre-receive receipt is a policy decision, not proof that Git accepted the refs. The post-receive hook records acceptance. Repeated discovery of the same immutable commit does not start its build again. Ref/content decisions remain distinct for each receive attempt.

Rule owners retain the same current-authority checks as other Herald rules. Disabled rules and rules whose owner is inactive or cannot view their source do not enforce actions. Git rules with effects also require the owner to retain repository Edit permission before evaluation; otherwise they are skipped. Matched actions require current repository Edit permission. Evaluation failures, invalid expressions, and forbidden matched actions reject the push. A reader without access to a rule's referenced private objects receives a generic rejection explanation; hook responses are projected for both receiver and pusher. Rules cannot bypass repository or Space policy.

The mobile Herald interface authors these rules, lists receive decisions, opens their transcripts, and repeats a dry run on stored evidence. Dry runs evaluate current rules against the original immutable snapshot without rejecting a new push, starting builds, or consuming repetition state. They accept a stored object/transcript ID, never browser-supplied Git source.

## Operator setup

The receive service is a trust boundary. Configure a dedicated account with a read/write API token and repository Edit access. Bind that account explicitly on the web server:

```dotenv
APP_GIT_RECEIVERS='{"R1":["git-receiver"]}'
```

No receivers are enabled by default. Local single-user installations must explicitly list `local` or their exact local principal ID. A receiver may submit facts only for its configured repositories, and the selected pusher must be an active principal with current repository Edit access. The receiving host is trusted to inspect Git honestly; ordinary user credentials cannot submit source facts.

Create a private JSON file (mode `0600`) on the receiving host:

```json
{
  "serverUrl": "https://workspace.example.org/",
  "repositoryId": "R1",
  "repositoryPath": "/srv/git/example.git",
  "tokenFile": "/etc/workspace/git-receiver.token",
  "pusherId": "ACCOUNT_ID_FROM_PROVISIONING",
  "spoolDirectory": "/var/lib/workspace/receive-retries"
}
```

The token file must also be a private regular file, and the spool directory must be private (`0700`). HTTPS is required except for explicit loopback development URLs. A mount such as `/phabricator/` is supported. The configuration, credentials, receiver paths, and hosting service belong in the operator's infrastructure repository, outside the public application source.

Install executable `pre-receive` and `post-receive` hooks in the operator-controlled bare repository. Preserve their Git-supplied working directory and standard input. For example, the pre-receive wrapper is:

```sh
#!/bin/sh
export PHABRICATOR_RECEIVE_CONFIG=/etc/workspace/git-receive.json
exec /usr/bin/node --import /opt/phabricator-next/node_modules/tsx/dist/loader.mjs \
  /opt/phabricator-next/scripts/git-receive-hook.ts pre
```

The post-receive wrapper is identical with the final argument `post`. Use the actual installed Node/application paths. Do not replace other required hooks without composing their checks. Your SSH/HTTP receiving service remains responsible for authenticating the transport and mapping it to the application's canonical pusher account. `PHABRICATOR_PUSHER_ID` may override the fixed configured pusher only when set by that trusted launcher. Never accept this value from SSH `AcceptEnv`, Git push options, a client request parameter, or another unauthenticated source. Users must not have filesystem permission to bypass or edit the server hooks.

The hook verifies its working directory, current old/new ref, complete object IDs, raw commit hashes, and fast-forward relation. Pre-receive reads Git's genuine quarantine plus that repository's existing objects. It never updates refs, checks out source, executes source code, invokes text conversion/external diff, follows submodules, or uses Git transports. API failures and unsupported inspections fail closed. Git itself performs the final reference updates and race checks. See the primary [Git hook documentation](https://git-scm.com/docs/githooks) and [receive-pack quarantine behavior](https://git-scm.com/docs/git-receive-pack).

Successful post inspections are saved privately before transmission. A lost response or API failure leaves the exact request for retry:

```sh
PHABRICATOR_RECEIVE_CONFIG=/etc/workspace/git-receive.json \
  node --import tsx scripts/git-receive-hook.ts retry
```

Run that command from the application directory or use absolute loader/script paths. Retries preserve the original event and idempotency identities. A post hook cannot undo accepted refs. A crash before inspection/spooling, an unsupported post inspection, or a ref changed by another push before inspection requires operator reconciliation; the application does not claim exactly-once delivery from Git itself.

## API and limits

`POST /api/herald/receive` is receiver-only, requires an `Idempotency-Key`, and accepts complete `GitReceiveFacts`. The pre/post phase and inspection are trusted receiver assertions, not arbitrary user assertions. Repository and pusher authority are checked inside the write transaction and on receipt replay. Source, transcript, rule-state and receipt writes are atomic; failed build actions retain their error transcript without partial action effects.

`GET /api/herald/receives` accepts optional `repositoryId`, `before`, and `limit` (1–100). `GET /api/herald/receives/:id` returns a decision and transcript IDs. Reads inherit current repository/Space visibility. `POST /api/herald/test` accepts exactly one `objectId` or `transcriptId`.

The hook accepts branch and tag refs, at most 100 ref updates and 500 distinct newly reachable commits per receive, 1,000 changed paths per commit, a 128,000-byte raw commit limit and 60 seconds. The API envelope is capped at 24 MiB, including repeated per-ref facts and JSON escaping. A newly created branch enumerates all reachable history; large initial repositories require explicit bootstrapping or a later scalable importer. These are operational admission limits, never silent truncation. Non-UTF-8 commit metadata and filenames remain unsupported. Deletions and noncommit tags still support ref rules.

## Large and binary changes

Changed files carry exact old/new Git object IDs, modes and byte sizes. Additions and deletions have one absent side. Gitlinks record the referenced commit and mode without opening the other repository; their byte size is unavailable. Binary bytes never pass through a text decoder or appear as fabricated patch text. The hook does not follow symlinks, apply attributes, invoke conversion filters or run external diff drivers.

Each file records one inspection state: complete text, binary, non-UTF-8, too large, or Gitlink. Blob and text-diff budgets bound local work; exceeding a text budget retains the complete changed-path and object metadata with an explicit unavailable-text state. Exhausting metadata, commit, ref, path, overall time or transport limits still rejects the inspection. This is bounded text inspection with complete file metadata, not an assertion that arbitrary binary formats or arbitrarily large text have been analyzed.

The collector reads blobs up to 8 MiB per side and identifies binary data by NUL bytes; non-UTF-8 data has a separate state. Larger blobs retain metadata without guessing their encoding. Text diffing allows 100,000 input lines per side and 250 milliseconds per diff. A receive captures up to 8 MiB across patch text and added/removed text, with a separate 16 MiB JSON-encoded text budget and 8 MiB metadata budget. Budgets account for repeated commits in multiple ref updates. The 24 MiB final API envelope and 60-second collector deadline still apply. Text is kept whole for a file or marked unavailable; partial prefixes are never used for enforcement.

Herald adds four fields for push content and observed commits:

| Field | Meaning |
| --- | --- |
| Binary filenames | Changed files positively identified as binary. Oversized files whose bytes were not read are not guessed to be binary. |
| Filenames without text inspection | Files with unavailable text, including binary, non-UTF-8, oversized and Gitlink changes. |
| Diff exceeds text inspection limits | At least one file exceeded a text inspection budget. |
| Text inspection is complete | Every changed file has complete captured text. |

Filename, commit and metadata conditions work on these pushes. A text condition (`Source file content or commit diff`, `Added diff content`, or `Removed diff content`) errors if its required text is unavailable. This applies to both positive and negative matches: unavailable text cannot prove absence of a prohibited string. An evaluation error rejects a pre-receive operation and is recorded in its transcript.

A filename/content regular-expression pair first selects paths. It requires complete text only for those paths, so a rule inspecting `\.ts$` can coexist with unrelated binary images. Ordered all/any conditions retain their usual short-circuit behavior. An operator may deliberately guard a content rule with `Text inspection is complete` and separately decide how to handle uninspectable files. Such a guard is an explicit policy choice; the hook never inserts one or silently approves unavailable text.

The transcript inspector lists file states and expandable exact object metadata on mobile and desktop. Recorded evidence is immutable. Historical text-only observations remain readable and replayable, and re-observing an existing commit neither rewrites its original transcript nor starts its builds again. New push attempts are evaluated against their own newly collected evidence.

## Verification

The P305a release passed type checking, the full core suite (2,105 passed; nine optional TeX integration tests skipped), root and subpath production builds, and 100 affected browser checks across desktop/mobile and root/subpath hosting. The new inspection view also has a 768px layout check. Schema remains 39; existing evidence is not migrated or rewritten.

Real SHA-1/SHA-256 Git fixtures cover exact object metadata, quarantine, binary and non-UTF-8 source, large additions/deletions, ordinary large text edits, mode changes, symlinks, Gitlinks, hostile diff configuration, corrupt objects, cancellation and text/encoded-payload limits. Installed hooks verify actual push rejection and acceptance, post-receive API failure, private spool recovery and idempotent retry. Parser, rule and API tests cover unavailable-text guards, positive/negative conditions, selected-path matching, inconsistent metadata, current repository/Space access, historical evidence and commit-build deduplication. The browser fixture runs the collector on real disposable Git objects before submitting trusted observations; it does not fabricate production push history.

Repository project tagging and associated project-scoped Git rules, full audit actions, Owners/Legalpad/review acceptance and build gating fields, complete branch graph membership, pre-diff blocking, hosted Git SSH/HTTP services, historical commit import, arbitrary Git formats, binary-format analysis and unbounded text inspection remain open. This implementation is a working native receive adapter, not full Diffusion hosting or unchanged upstream hook compatibility.
