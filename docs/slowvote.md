# Slowvote polls

Slowvote provides durable single-choice (plurality) and multiple-choice (approval) polls. Create a question, description and two to 100 distinct choices. Any currently authorized reader with a write credential can vote, replace their response, withdraw it while voting is open, and comment. Only the poll author manages its question, description, response visibility and close/reopen state. Choices and voting method remain fixed after creation so an existing ballot never changes meaning.

The original response-visibility modes are implemented: everyone who can view the poll, only people who have voted, or only the poll author. In after-voting mode the author must also vote before seeing results, matching upstream. A native fourth mode reveals results after the poll closes. This fourth mode is an explicit extension, not an upstream equivalence. Closed polls reject votes and withdrawals. Reopening a closed-results poll hides results again. The explicit withdrawal action is also a native extension.

Visible results show counts and identified voters, as upstream does; these are not anonymous ballots. Each viewer can always see their own current selected choices. When results are restricted, the server removes other ballots, counts and identities from every record projection and filters other people's vote/withdraw events. List, detail and retry responses use current visibility. Poll revisions and timestamps remain activity metadata; they are not a claim of secret-ballot participation anonymity. Comment authors and voluntarily written comment content remain visible to poll readers.

Polls share the workspace's current object and Space policy, version conflicts, immutable event history and exact retry keys. Ballots are stored only on the server; clients cannot submit another person's identity or override counts. Changing result visibility changes current disclosure without rewriting past events. Comments have server-owned authors and timestamps. The mobile screen offers vote/update/withdraw, result inspection and comments alongside author controls.

## Native API

- `POST /api/suite/slowvote`: `{kind:"poll", title, description?, choices, method?, responseVisibility?}`. Choices are an array of labels or one label per line; method is `single` or `multiple`; visibility is `always`, `aftervote`, `owner` or `closed`.
- `GET /api/suite/slowvote` and `GET /api/suite/slowvote/:id`: currently authorized and projected records, with policy-safe history on detail.
- `POST /api/suite/slowvote/:id/vote`: `expectedVersion` and `choiceIds` (array; a single string is accepted for a single-choice poll).
- `POST /api/suite/slowvote/:id/withdraw`, `/close`, `/reopen`: `expectedVersion`.
- `POST /api/suite/slowvote/:id/edit`: `expectedVersion`, `title`, `description`, `responseVisibility`.
- `POST /api/suite/slowvote/:id/comment`: `expectedVersion`, `body`.

Mutations require a write credential and `Idempotency-Key`. The shared suite API handles current access, concurrency, persistence and retry receipts; a retry never recovers older visibility of ballot data.

## Upstream comparison and remaining work

Read-only evidence is the pinned `reference/phabricator/src/applications/slowvote/storage/PhabricatorSlowvotePoll.php`, `controller/PhabricatorSlowvoteVoteController.php` and `view/SlowvoteEmbedView.php`. Their method constraints, author edit rights, named results and response-visibility behavior anchor this implementation.

This is a usable native poll workflow, not full Slowvote parity. Shuffle/display ordering, Remarkup poll embedding, subscriptions/mail, project tags, full saved queries, Conduit identity compatibility and historical imports remain open. Shared generic listing does not implement every upstream poll query. Permissions deliberately remain bounded by current Spaces even for the author.

Focused module tests verify plurality and approval counting, response replacement/withdrawal, all four visibility modes, no special after-vote owner bypass, closed-state enforcement, author-only administration, event redaction, immutable choice meanings, identity attribution and invalid inputs. End-to-end persistence, authentication and responsive verification belong to the shared suite release checks.

The shared suite currently stores at most 2 MB per object, including accumulated responses, discussion and content revisions. Operations that would exceed this bound fail explicitly; larger histories and storage separation remain follow-up work.
