# Core Remarkup formatting

F025 adds a bounded, portable Remarkup parser and safe browser presentation for
saved revision roots and replies, task comments, and Paste comments. This covers
code, paper, prose and Word discussion through the same reader. It is a
presentation slice; comment bodies, captured mention evidence, source versions,
review decisions, following and notification causes are unchanged.

F026 extends the same core reader to wiki content and object prose fields while
preserving source editing, historical selections and current access checks.

## Wiki and object prose

The F026 reader formats the selected immutable wiki content version, the current
task description, and current revision Summary and Test Plan. The revision
reader is shared by code, paper, prose and Word reviews. Task-list descriptions
mount their formatted reader only when the existing disclosure is opened.
Closing it or changing its object/source releases that view.

Wiki publication remains independent of editing: the default reader follows
the published pointer; explicitly selecting an older version or an unpublished
draft keeps that exact selection. Delete and move-away versions retain their
marker notices. Revision metadata is deliberately current across source
versions, including while an older source version is selected. Its existing
current-details notice remains visible. Task descriptions show the current
loaded task snapshot; history preserves exact before/after source.

These prose fields do not contain F024 discussion mention proofs. The generic
reader accepts no mention identities; `@username` syntax stays literal and
does not look up people, add followers, or send notifications. Displaying,
opening or copying prose invokes no provider, object resolver, or write API.
Already-authorized snapshots retain their existing offline and session
lifetimes; there is no additional persistence layer.

Each reader labels its exact source by field, with an explicit Copy Source
action. Empty-field and legacy missing-Test-Plan messages remain presentation
notices, never invented source. Pending clipboard status belongs to the exact
field/source context. Editors, immutable history, before/after comparisons,
source files, Word projection and passage quotations remain literal source.
Compact revision-list summaries remain plain text inside their existing links.

The portable formatting limit remains 20,000 UTF-16 code units. Valid wiki
content may reach 500,000, while task descriptions and revision metadata may
reach 100,000. Larger values remain fully readable and copyable as literal
text, with an explicit fallback notice; nothing is truncated. Formatting
larger prose, heading anchors/table of contents and full wiki Remarkup remain
separate parity work. There is no schema change, source rewrite, or migration.

## Supported reading

The native subset includes paragraphs and preserved line breaks, bold, italic,
strikethrough, underline, highlighting, inline and block code, headings, rules,
quotes and reply headers, ordered/unordered/check lists, note blocks, and safe
links. Syntax and rule precedence are compared against the pinned upstream
implementation and its semantic fixtures, including list/header ambiguity,
code whitespace, nested quotes, mixed list markers and URL punctuation.

For example, a saved comment can contain:

```text
**Main point** with //emphasis// and `literal code`.

> A quoted passage for discussion.

- [X] Checked the original source
- [ ] Compare the revised argument

[[https://example.org/paper | Supporting paper]]
```

Each comment also has a keyboard-accessible **Source** disclosure containing its
exact stored text and an explicit **Copy Source** action. The clipboard receives
the original string, including its whitespace and line endings. A clipboard
failure leaves the selectable source available. Code and source scroll inside
the comment on narrow screens. Rendering does not add a composer mutation,
network request, outbox item, or alternative copy of the comment to persistent
storage. Existing offline reads, draft recovery, voice text and session cleanup
continue to use their existing source records.

## Identity, safety and bounds

Every AST node retains end-exclusive UTF-16 source positions. Text leaves refer
to exact contiguous slices of the stored comment, including after quote/list
normalization. The frozen F024 mention scanner protects syntactic usernames from
inline formatting before optional identity enhancement. An underscore inside a
username cannot become an underline delimiter. This also applies to unresolved
and legacy text without inventing an identity proof.

The browser only enhances a complete mention span after validating its saved
body-bound proof. Captured identities are never resolved against the current
directory. Code, links and literal regions do not produce person chips. Parser
fallback preserves the whole body as literal text; raw source remains available
whether or not formatting succeeds.

The shared parser depends on neither Node nor React. Its limits are 20,000 UTF-16
code units, 32 nesting levels, 5,000 nodes and a bounded work budget. Exceeding a
limit produces whole-body literal output rather than truncated or partially
formatted content. A linear preflight bounds link-delimiter matching before
the frozen mention scanner runs; suffix whitespace is trimmed with linear
scans. Literal fallback skips unused identity verification. This prevents dense
malformed syntax from repeatedly blocking the mobile reader. The renderer
creates escaped React elements; it never
injects HTML, runs interpreters, loads remote media or fetches a link preview.

Links permit explicit HTTP, HTTPS and mailto destinations, safe origin-relative
paths and fragments. Script/data/file schemes, protocol-relative destinations,
credentials, control characters and backslash authority confusion are rejected.
Rejected and unsupported link forms remain source text. Origin-relative paths
refer to the origin root; the reader does not silently prepend the application's
mount path or resolve wiki/object names. External links have no-referrer policy.

There is no schema migration, server markup cache, backfill or comment rewrite.
The database format remains schema 34. Existing comment writes and immutable
receipt validation continue to use the exact original body.

## Deliberate gaps

This is not full Remarkup parity. Tables, math, media/macros, embeds, custom
interpreters, syntax highlighting in comment code, heading anchors/TOCs,
cross-object/wiki lookup, footnotes and upstream HTML interchange remain gaps.
Unsupported features never invoke a fallback Markdown or HTML engine. Their
source remains available; ordinary inline styles can still appear inside
unrecognized prose syntax. Interpreter and embed forms remain inert. F026 adds
wiki and object prose readers as described above; source files and AI findings
remain outside the formatting presentation.
Full upstream nesting, malformed-input recovery and custom rule behavior are
also not claimed by this bounded subset.

## Upstream basis

The comparison is pinned to Phabricator
[`5720a38cfe95b00ca4be5016dd0d2f3195f4fa04`](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04).
The inherited Phutil Remarkup implementation lives in this Phabricator tree.
No PHP code or vendored runtime is executed or included in the application.

- [Engine configuration and rule registration](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/markup/PhabricatorMarkupEngine.php): preserved line breaks and core inline/block rules.
- [Block rules](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/markup/blockrule) and [inline rules](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/markup/markuprule): syntax, precedence and explicit links.
- [Semantic fixtures](https://github.com/phacility/phabricator/tree/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/infrastructure/markup/remarkup/__tests__/remarkup): newline styles, list/header ambiguity, quotes, code, notes and URL boundaries.
- [People mention rule](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/people/markup/PhabricatorMentionRemarkupRule.php): syntactic tokenization precedes styles even when a username does not resolve.
- [Phriction content reader](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/storage/PhrictionContent.php) and [version selection](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/phriction/controller/PhrictionDocumentController.php): selected/published content and lifecycle notices. Upstream enables a table of contents, which remains a native gap.
- Differential [Summary](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/customfield/DifferentialSummaryField.php) and [Test Plan](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/differential/customfield/DifferentialTestPlanField.php), plus the [Maniphest description](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/maniphest/controller/ManiphestTaskDetailController.php): core formatted prose fields.

## F025 verification

- `npm run check` passed. The complete `npm test` run passed 1,537 tests;
  nine optional TeX integration tests were skipped, with no failures.
- Root and `/mounted/` production builds passed. A fresh root release build
  matched every file of the browser candidate.
- Independent semantic fixtures and 1,320 deterministic malformed-input cases
  verify source spans, parser bounds, mention ordering and safe element output.
  Isolated stress cases include unmatched brackets, ambiguous link whitespace,
  deep quotes and long indentation. Previously slow inputs now either retain
  ordinary formatting or return complete literal source before costly matching.
- All 126 unique browser checks passed: 102 at the root and 24 at `/mounted/`,
  across desktop and phone viewports. Twenty new formatting checks cover every
  discussion surface, captured/legacy mentions, inert markup, clipboard success
  and failure, exact raw text, code containment, offline reads and literal
  fallback. Surrounding mention, thread, voice, Word, task, Paste, sign-in and
  workspace checks preserve their source and authority assertions.
- Existing comment assertions now distinguish displayed content from the
  intentionally duplicated raw source in a closed disclosure. Exact Word
  quotations, immutable packages, reply counts and late-request retirement
  checks remain in place. Desktop, phone and tablet layouts were inspected.
- The updated local preview serves the tested bundle. Its schema 34, all 98
  tables and all 91 existing rows, schema objects, rowids and foreign keys match
  the pre-update snapshot exactly; integrity checks and saved health/document
  response hashes pass. There is no migration or historical rewrite.

## F026 verification

- `npm run check` and production builds for the root and `/mounted/` passed.
  The complete `npm test` run passed 1,544 tests, with nine optional TeX
  integration tests skipped and no failures.
- Pure rendering tests cover escaped HTML and safe destinations, complete
  500,000-unit wiki and 100,000-unit field sources, CRLF/Unicode preservation,
  proofless mentions, contextual labels and unmounted closed descriptions.
- New browser cases cover selected wiki publication/draft/history, lazy task
  descriptions, current revision metadata during historical source selection,
  Word metadata, exact source copying, offline reading, access revocation,
  complete literal fallback and empty/missing source provenance. Equal-text
  version changes retire pending clipboard feedback. Read-only presentation
  leaves immutable source, history, review and following records unchanged.
- All 164 unique browser checks passed: 124 at the root and 40 at `/mounted/`,
  across desktop and phone viewports. These include 32 new prose checks and
  existing wiki, task, metadata, discussion, mention, comparison and draft
  regressions. Twelve repeated checks additionally verified the strengthened
  guard against external/provider requests. Desktop, phone and tablet layouts
  were visually inspected. An older exact-source test now waits for the reload
  result before asserting replacement text; its equality assertion is unchanged.
- The local preview serves the exact tested JavaScript and CSS; every installed
  build file matches the candidate. Schema 34, all 98 tables and all 91 existing
  rows, schema objects, rowids and foreign keys match the pre-update snapshot.
  Integrity checks and health/document response hashes pass. No migration or
  historical rewrite was required.
