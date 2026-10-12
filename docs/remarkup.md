# Core discussion formatting

F025 adds a bounded, portable Remarkup parser and safe browser presentation for
saved revision roots and replies, task comments, and Paste comments. This covers
code, paper, prose and Word discussion through the same reader. It is a
presentation slice; comment bodies, captured mention evidence, source versions,
review decisions, following and notification causes are unchanged.

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
unrecognized prose syntax. Interpreter and embed forms remain inert. Wiki
bodies, task descriptions, revision
metadata, source files and AI findings are outside this presentation slice.
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

## Verification

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
