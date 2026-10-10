# Object access and Spaces

Every current project, repository record, task, wiki document, and code/paper/prose revision has an explicit policy and belongs to a Space. A Space restricts visibility across its contents. The object can restrict access further; object rules cannot widen its Space's visibility. The implementation follows the pinned upstream [policy filter](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/policy/filter/PhabricatorPolicyFilter.php) and [Space behavior tests](https://github.com/phacility/phabricator/blob/5720a38cfe95b00ca4be5016dd0d2f3195f4fa04/src/applications/spaces/__tests__/PhabricatorSpacesTestCase.php) for this bounded slice.

## Rules

Each rule permits either workspace members or an explicit list of stable principal IDs. An empty list permits nobody. The member directory is visible throughout the authenticated workspace; this is not an anonymous-user audience.

| Capability | Permitted operations |
| --- | --- |
| View | Read the object and its history, source, comments, evidence, exports and activity |
| Edit | Change content/status, add versions, restore wiki content and edit the object's access rules; also requires view |
| Interact | Add comments or record deterministic/local-model/hosted-model reviews; also requires view |
| Manage Space | Change Space settings and its view/manage rules; does not grant edit access to its contents |

Task owners automatically have view, edit and interact access, including policy editing, subject to their Space's view rule. This is upstream Maniphest behavior. Assignment can therefore grant or remove access even when explicit object rules are unchanged; it advances the workspace access epoch. Authorship and subscription membership grant no access.

New Spaces default to creator-only view and management. This is an explicit member rule, not a permanent creator bypass. Changing a rule requires retaining one's own view and edit access. Another authorized editor can later remove that access. Token scopes independently restrict operations even where an object permits them. Missing policies deny access.

Existing objects migrate to `S1`, the shared default Space, with explicit workspace-member rules. New objects use this same default unless a destination and rules are supplied. The creation dialog records the selected Space in its draft. A lost or archived destination must be changed explicitly; it never silently falls back to the shared Space. Archived Spaces remain readable and existing objects can be edited, but new objects and moves into them are rejected. The default Space cannot be archived.

## Enforcement and concurrency

Protected reads capture credential checks, policy checks and serialization in one SQLite snapshot. Mutations acquire the writer lock before revalidating authority. Current access is checked before disclosing a saved retry response, including retries of object creation. Hidden/missing objects both return `404 OBJECT_UNAVAILABLE`; a visible object without the required capability returns `403 ACTION_FORBIDDEN`. Policy and Space edits require an expected policy/Space version, independently of source content versions.

The state endpoint filters objects and activity before returning data to the browser. Current browser filtering/search and spoken summaries operate only on that filtered data. A visible task or revision referring to a hidden project/repository returns a null reference while retaining its stored relationship. Supplying a hidden or nonexistent reference produces the same generic validation error. Source text and user-authored prose are not rewritten or scanned to conceal mentions; avoid writing secrets into an otherwise shared object's content.

Reviews require view and interact access before source is read or sent to the explicitly selected provider, and again before evidence is committed. Revocation while a provider is running discards the late evidence. It cannot recall source already transmitted by an authorized request. Policy changes produce attributable activity without disclosing hidden destination names in object activity. Access edits do not rewrite immutable source history.

## Browser drafts and revocation

The browser refreshes permissions on focus, visibility, reconnect and after mutations. When it learns that view access is lost, it stops voice activity, cancels object requests, removes cached server snapshots/history, and closes that object's view. Request generations reject older responses that arrive afterward. Unsaved drafts are set aside with explicit export and discard controls; they never replay automatically. Local-mode recovery drafts are stored for that workspace across reloads. Password-mode recovery drafts stay in the same verified tab’s memory. Losing only edit/interaction access keeps readable content available and disables the affected submission controls.

If browser storage cannot save a local recovery copy, the original draft or queued change is retained and automatic submission stays blocked, including after reload. The browser warns the user to export the work or free storage and retry. Export keeps the recovery copy; only explicit discard removes it. Queue changes and discards share a browser lock where supported so another tab's unrelated changes are preserved.

Authenticated content and drafts remain in tab memory. Export work before sign-out, session expiry or closing the tab. Local-mode caches remain durable; the server still checks access when reconnecting. Already read, copied or exported content cannot be recalled, and disconnected clients cannot discover later server policy changes until reconnecting. This is not encrypted offline revocation or a trusted-device retention system.

## API

- `GET /api/spaces` and `GET /api/spaces/S1` return visible Spaces with effective policy capabilities (token operation scopes remain an independent check).
- `POST /api/spaces` accepts `name`, optional `description`, and optional `view`/`edit` audiences. `PATCH /api/spaces/S1` requires `expectedVersion` and accepts updated settings or `archived`.
- `GET /api/policies/W1` returns the policy, effective capabilities, and descriptive labels. `PUT /api/policies/W1` requires `expectedVersion`, `spaceId`, `view`, `edit`, and `interact`.
- Entity creation accepts optional `access: { spaceId, view?, edit?, interact? }`. Omitted rules grant workspace members, subject to Space visibility.
- Audiences use `{ "kind": "workspace" }` or `{ "kind": "principals", "principalIds": ["stable-account-id"] }`.

Schema 4 migration is transactional and preserves existing content, versions and replay records. It does not fabricate ownership. Older binaries must refuse this schema. Back up the database before upgrading. Before activating password mode, local-only member grants require an explicit terminal handoff to an enabled account; see [authentication](authentication.md). Local task ownership also requires an explicit handoff before password activation. This preserves selected-member privacy; there is no administrator or creator bypass.

## Remaining parity

Project membership/custom policy rules, inherited wiki hierarchy, file/attachment access, full-text indexes, subscriptions outside tasks, service/agent identity kinds and legacy policy import are not implemented. Member-directory concealment and fine-grained application creation capabilities are also absent. Wiki slugs remain globally unique: a generic unavailable-slug response hides the matching document but still reveals occupancy. The application remains loopback-only; reusable TLS/proxy hosting and authenticated durable offline storage are separate milestones in [the tracker](roadmap.md).
