# Paste

Paste stores editable text snippets with a title, highlighting language, author, active/archive state, discussion and immutable history. It uses `PA` identifiers because this implementation already uses `P` for paper revisions. Upstream Paste uses `P`; import and URL compatibility must preserve that distinction explicitly.

## Content and history

Create a Paste with nonempty UTF-8 text, an optional title and optional language. A blank title displays as an untitled paste. Content preserves its exact byte representation, including a UTF-8 BOM, CRLF, lone CR, trailing newlines and whitespace-only content. NUL and unpaired Unicode surrogates are rejected. Text is limited to 1 MiB; titles to 255 characters and language names to 64. Title and language surrounding whitespace is trimmed; `null` selects no explicit language.

The object has two version counters. `version` advances when title, language, status or content actually changes. `contentVersion` advances only when the exact text changes. Every content version retains its SHA-256, byte length, line count, timestamp and actor attribution. Line count includes a trailing empty line. Edits must supply the exact expected object version; a no-op still checks that version but creates no new transaction. Concurrent stale edits fail without replacing newer text.

Comments name the content version they discuss. They append to history without changing either counter. Editing the snippet never silently moves a comment to new text. Comments are bounded to 10,000 characters. Archive removes a Paste from the default active list, while preserving direct access, editing, comments and history. Reactivation is a version-checked status edit. This slice does not destructively delete content.

## Access

Pastes use the workspace's view, edit and interact rules and restrictive Spaces. The original author automatically has all three capabilities while the Space permits viewing. Other viewers require the corresponding explicit rules. Commenting requires interact access; changing content or metadata requires edit access. Creation uses the same explicit access controls as other workspace objects, and password-mode installations require authentication.

Current visibility gates lists and snippets, global search inputs, source versions, history, raw downloads and saved mutation replays. List filtering applies before visible results are returned. Changing a Paste's policies applies to all its historical content; version IDs and hashes are not download credentials. A File can be explicitly attached to a Paste through the existing Files controls; that deliberate grant remains bounded by the File's Space. Paste content is stored as immutable text under the Paste's policy rather than as separately addressable upload objects.

Every mutation requires an `Idempotency-Key`. Exact retries recheck current permission and return the original saved result, with a refreshed access epoch. They do not return a newer editing baseline. Creation/edit receipts are `PasteRecord` values, and comments return their original transaction. Clients fetch the current detail after a successful save. Reusing a request key with different input fails.

## Interface and offline work

The Paste application provides list filters, creation and editing, source versions, line selection, exact text download, comparisons, comments, history and archive/reactivate controls. Supported syntax coloring, including LaTeX, is bundled locally; unknown language names remain valid metadata and fall back to plain text. Highlighting is presentation only and never executes a snippet. The worker limits highlighting to 100,000 UTF-16 code units and one second. Inline previews show up to 5,000 lines, while exact full-text and selected-range downloads remain available for larger snippets.

Visited source and drafts use the existing workspace storage boundaries: local mode can retain them on the device, while password mode keeps content in the verified tab. Known access loss removes server content and quarantines unsaved work for export or discard. Drafts keep their original editing version, and uncertain writes keep an exact request ID and payload. Saves and comments require an explicit online action; reconnecting does not submit Paste requests automatically.

## Following and inbox

NOTIFY-03 adds people following, automatic author delivery, human comment opt-in,
private mute and version-pinned inbox events. The controls preserve historical
content selections and exact offline request recovery. See [Wiki/Paste following](object-subscriptions.md)
for permissions, recipient rules, history, limits and remaining notification gaps.

## API

| API | Result |
| --- | --- |
| `GET /api/pastes` | Visible metadata and bounded snippets, newest object first; default active state. |
| `POST /api/pastes` | `{content, title?, language?, access?}` → original `PasteRecord` (201). |
| `GET /api/pastes/:id` | Current `PasteDetail`: metadata, current content version, first history page, access and epoch. |
| `PATCH /api/pastes/:id` | `{expectedVersion, title?, language?, content?, status?}` → saved `PasteRecord`. |
| `GET /api/pastes/:id/versions` | Immutable source summaries with `before`/`limit` paging. |
| `GET /api/pastes/:id/versions/:number` | `{version, accessEpoch}` for an exact source version. |
| `GET /api/pastes/:id/history` | Immutable attributed transactions with `before`/`limit` paging. |
| `POST /api/pastes/:id/comments` | `{contentVersion, body}` → immutable comment transaction (201). |
| `GET /api/pastes/:id/raw?version=N` | Exact UTF-8 bytes; an explicit source version is required. |

List filters are `query` (title or current content), `authorId`, `language`, `status` (`active`, `archived`, `all`), `createdAfter`, `createdBefore`, `before` and `limit`. Queries use literal substring matching after JavaScript's locale-independent Unicode lowercasing. An empty `language` selects records without an explicit language. Creation dates use UTC timestamps. Pages default to 25, with maximum 100. Each page scans at most 1,000 metadata candidates and 16 MiB of visible source; permissions are checked before reading source. An empty visible page can still have a continuation, including when a search reaches its work limit. Source and history cursors are exclusive. Unsupported or duplicate query parameters fail explicitly.

Raw downloads use `text/plain; charset=utf-8`, attachment disposition, restrictive CSP and private/no-store caching. `X-Content-SHA256`, `X-Content-Version` and `X-Access-Epoch` identify the returned source. Create/update request bodies allow JSON escaping overhead; the decoded source remains bounded to 1 MiB.

The CLI exposes `pastes`, `paste`, `create-paste`, `edit-paste`, `paste-version`, `paste-versions`, `paste-history`, `comment-paste`, `archive-paste` and `download-paste`. `arc --help` supplies exact arguments. Source input uses bounded regular UTF-8 files, rejects symlinks and preserves BOM/newline bytes. Downloads verify the selected version's digest and size and create a new output file without overwriting an existing one. Retain the input and request ID when retrying an uncertain write.

Schema 18 widens the existing entity constraint to admit Paste and adds immutable source/history tables. Migration preserves prior entity row IDs, child foreign keys, indexes, triggers and stored evidence.

## Upstream comparison and remaining parity

The implementation is based on the latest pinned archived source, especially [Paste's storage and automatic author policies](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/paste/storage/PhabricatorPaste.php), [editable fields](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/paste/editor/PhabricatorPasteEditEngine.php), [content transactions](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/paste/xaction/PhabricatorPasteContentTransaction.php), [search filters](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/paste/query/PhabricatorPasteSearchEngine.php), and [view actions](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/paste/controller/PhabricatorPasteViewController.php). Syntax presentation uses a pinned local [highlight.js](https://github.com/highlightjs/highlight.js) dependency.

PASTE-01 remains an initial application slice, not full parity. Project tags, mail creation/replies, Herald rules, tokens/flags, addressable line-range URLs, embedded Remarkup ranges, document rendering, configurable forms and default policies, full-text ranking and saved queries, title-inferred languages and the complete upstream highlighting catalog, parent/fork interoperability, Conduit compatibility, historical data migration and complete review-packet export remain open. Anonymous public Paste viewing is intentionally not enabled merely because this project's source repository is public.
