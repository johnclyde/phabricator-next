# Collaboration and service-directory applications

Almanac, Conpherence, Calendar, Slowvote, Phame and Legalpad have native authenticated workflows. They share durable identities, current Space restrictions, object audiences, attributed history, optimistic versions, exact-request recovery and a responsive interface. They are working application implementations, not claims of complete upstream parity.

| Application | Native workflow | Contract and remaining gaps |
| --- | --- | --- |
| Almanac | Devices, networks, interfaces, custom services, bindings, properties and dependency-safe disabling | [Almanac](almanac.md) |
| Conpherence | Private participant conversations, messages, membership, read boundaries and personal archives | [Conpherence](conpherence.md) |
| Calendar | Timed/all-day events, invitations, RSVP, month/agenda views, bounded daily/weekly series and occurrence exceptions | [Calendar](calendar.md) |
| Slowvote | Single/multiple choice, response visibility, changing/withdrawing responses, close/reopen and discussion | [Slowvote](slowvote.md) |
| Phame | Blogs, author/editor roles, drafts, published posts, publication history and comments | [Phame](phame.md) |
| Legalpad | Immutable agreement versions, exact-version signatures, corporate signatories, exemptions and preserved receipts | [Legalpad](legalpad.md) |

## Identity and authority

These applications use server-owned UUID-backed IDs, not upstream PHIDs or imported numeric monograms. Reads and mutations require the workspace's normal authenticated session or scoped token. Personal Legalpad signing/withdrawal additionally requires an interactive session or local workspace; a bearer token cannot sign as a person. Public source-code distribution does not enable anonymous conversations, blog reading or agreement signatures.

Creation selects a currently visible, nonarchived Space. Objects have either a Space-wide audience or selected readers and editors; the creator normally retains access within the Space. Application rules can be stricter. Conversations require current participation, polls retain author-only administration, Phame posts inherit the current blog audience, and Almanac interfaces/bindings inherit their current parent policies. Dependencies can impose additional Space restrictions. Changing access does not rewrite history, permit inaccessible referenced objects, or disclose stored private ballots/signatures. A policy epoch retires stale in-session reads after application changes.

## Native API and recovery

- `GET /api/suite/:application`: permission-filtered listing, literal title `q`, optional `kind`, exclusive `before` cursor and `limit` up to 100.
- `POST /api/suite/:application`: create with application-specific `kind` and fields, optionally `access: {spaceId, visibility, memberIds, editorIds}`.
- `GET /api/suite/:application/:id`: current projected object, capabilities and paged immutable history; optional `before` and `limit` select older history.
- `POST /api/suite/:application/:id/:action`: application-specific command with `expectedVersion` and its documented fields.
- `POST /api/suite/:application/:id/access`: version-checked object access change. Inherited objects must change access on the parent.

All mutations require an `Idempotency-Key`. Its identity binds the account, workspace, method, path and complete request body. Repeating a successful request acknowledges the original operation version while returning the **current authorized projection**, explicitly marked as a replay. It never repeats a vote, message or signature. Loss of access prevents replay disclosure. A successful action which revokes the caller's access returns a minimal acknowledgment instead of private content.

Editors retain the original object/version and request. They never silently rebase or submit on reconnection. An uncertain outcome offers exact retry, export or explicit forgetting. Retrying an older operation must not discard later edits. Record-bound drafts require returning to their source object before submission; an old agreement draft still needs the exact current document hash, even after adopting a newer general object version.

Protected workspaces keep drafts in the authenticated tab; local mode uses the existing retained-draft mechanism. Loaded records are session reads, not an offline replica. Navigation has spoken aliases for all six applications; application editing, voting and signing are not silently voice-authorized.

## Storage and implementation limits

Schema 41 adds `suite_records` and append-only `suite_history`, including exact internal snapshots. Migration validates owned schema definitions, preserves all earlier rows and fails transactionally on incompatible tables/indexes/triggers. Snapshots are internal evidence, not an unrestricted historical-content API: a private old ballot or draft cannot be recovered through generic history.

Each current object, including accumulated messages/comments/content versions, is limited to 2 MB of serialized storage. Admission rejects the entire write before history changes; it does not trim content. List responses page by count, a 4 MB content budget and a bounded permission scan. Stored historical snapshots increase total database usage. Large-room storage, retention controls and attachment workflows remain future work.

This release does not provide full upstream Conduit/import compatibility, cross-application notifications/Herald adapters for the new applications, general workspace search integration, external mail, public blog domains, external signing, or automatic service provisioning. Application-specific differences and original source references are recorded in the six contracts above. Operator-specific configuration belongs in a separate infrastructure repository.
