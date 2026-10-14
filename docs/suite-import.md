# Import original Phabricator application data

Almanac, Conpherence, Calendar, Slowvote, Phame, and Legalpad have an explicit preview/apply importer. It reads actual `mysqldump --xml --no-create-info` exports from the pinned upstream storage schema. It does not execute PHP or SQL, connect to the old installation, infer permissions from old policies, or contact external services.

This is a migration of supported current objects plus a separate historical evidence archive, not a full-fidelity upstream database restore. A source PHID and stable installation key map to one native object. An identical repeat skips creation. Different source content or different destination configuration conflicts; it never overwrites subsequent native edits. Keep the same source key for later batches from the same installation.

## Export from the original database

Use a read-only database account and your normal secure MySQL credentials. Do not put passwords in command arguments. Run the database export tool against the original installation or a consistent backup; no Phabricator PHP process is needed. Replace the example database prefix with your installation's configured prefix.

```sh
mysqldump --xml --no-create-info --single-transaction --skip-lock-tables \
  phabricator_slowvote slowvote_poll slowvote_option slowvote_choice \
  slowvote_transaction slowvote_transactioncomment > slowvote.xml
```

Export one application database per file. Include every relevant parent and child row for the selected objects. `--where` can select batches, but each table has different relationship columns; do not apply an object-ID filter indiscriminately to all its child tables. A consistent backup is preferable when source writes continue during several exports.

| Application | Current objects and supporting data | Optional historical transactions/comments |
| --- | --- | --- |
| Almanac | `almanac_device`, `almanac_network`, `almanac_service`, `almanac_interface`, `almanac_binding`, `almanac_property` | `almanac_devicetransaction`, `almanac_networktransaction`, `almanac_servicetransaction`, `almanac_interfacetransaction`, `almanac_bindingtransaction` |
| Conpherence | `conpherence_thread`, `conpherence_participant` | `conpherence_transaction`, `conpherence_transactioncomment` |
| Calendar | `calendar_event`, `calendar_eventinvitee` | `calendar_eventtransaction`, `calendar_eventtransactioncomment` |
| Slowvote | `slowvote_poll`, `slowvote_option`, `slowvote_choice` | `slowvote_transaction`, `slowvote_transactioncomment` |
| Phame | `phame_blog`, `phame_post` | `phame_blogtransaction`, `phame_posttransaction`, `phame_posttransactioncomment` |
| Legalpad | `legalpad_document`, `legalpad_documentbody`, `legalpad_documentsignature` | `legalpad_transaction`, `legalpad_transactioncomment` |

Each file retains MySQL's `mysqldump/database/table_data/row/field` envelope. Null values use `xsi:nil="true"`. Unknown tables/columns and unassociated child rows are reported as omissions in the preview. Mail keys, signature verification secrets, transaction content-source metadata, and derived index values are discarded. Export files can still contain these secrets before parsing; keep exports private and out of version control. The service does not store raw XML. Source JSON properties and allowed historical fields can themselves contain private information, so provenance is restricted to current editors.

The importer deliberately does not pretend the upstream Conduit APIs supplied complete data: `slowvote.poll.search` contains no choices/ballots, Legalpad has no search method in the pinned baseline, and Conpherence's legacy query APIs omit current participant policy. XML uses the actual underlying storage fields instead.

## Preview and apply

Create a local manifest; its `files` entries are paths relative to the manifest:

```json
{
  "sourceKey": "old-workspace-2021",
  "files": ["almanac.xml", "conpherence.xml", "calendar.xml", "slowvote.xml", "phame.xml", "legalpad.xml"],
  "destination": {
    "spaceId": "S1",
    "visibility": "members",
    "memberIds": [],
    "editorIds": []
  },
  "roles": {}
}
```

Choose current destination IDs explicitly. `roles` is keyed by an upstream object PHID and accepts `participantIds` for a Conpherence room, `inviteeIds` for an event, or `authorIds`/`editorIds` for a blog. A mapping to a current participant is a new grant made by the importer; source participant, author, or signature rows alone grant nothing. The importing account owns native objects. The destination Space must be active and accessible, and selected people must currently be able to see it. Conpherence is always private to its current participants; Phame posts inherit their current blog's audience.

Set `PHABRICATOR_URL` and `PHABRICATOR_TOKEN` using your existing credential management. Remote requests require HTTPS. The token needs read/write scopes.

```sh
node --import tsx scripts/suite-import.ts preview manifest.json
node --import tsx scripts/suite-import.ts apply manifest.json --digest DIGEST_FROM_PREVIEW --key YOUR_STABLE_RETRY_KEY
node --import tsx scripts/suite-import.ts provenance NATIVE_RECORD_ID
```

Review every warning and error before copying the digest into apply. Preview runs the same native create/command validators inside a rolled-back savepoint: native objects, histories, policy epochs, and notifications are not retained. The digest pins source content, destination roles/policy, current mapped object versions, and the access epoch. Apply repeats validation under the writer transaction and revalidates the credential after obtaining the lock. A stale preview requires another preview. Any failure rolls back the entire batch, including source mappings.

Reuse the same key and unchanged apply body after a network failure. The saved receipt contains mapping IDs, not historical content. Retries and provenance reads recheck current object, Space, inherited-parent, and edit authority. Someone who loses access cannot recover data from an old successful receipt. Source mappings and historical evidence are immutable.

## What becomes native data

| Application | Native result | Preserved separately as historical evidence |
| --- | --- | --- |
| Almanac | Names, custom service types, interfaces, bindings, properties, disabled states | Transactions, original policies/identities/dates. Disabled parents also disable dependent imported endpoints to satisfy native invariants. |
| Conpherence | Title/topic and explicitly selected current participants | Original messages, author PHIDs, participant rows, read state, transactions, comment revisions. Historical messages are not replayed as current messages. |
| Calendar | Supported one-off schedules, timezone, description, cancellation, supported bounded daily/weekly recurrence, new explicit invitations. Native upstream all-day inclusive end dates become exclusive; previously imported events already have exclusive ends | Original host, attendance, transaction/comment history. Old RSVP assertions do not become present decisions. |
| Slowvote | Question, options, single/multiple selection method, result visibility, closed state | Original ballots, comments, author and shuffle setting. Polls with old ballots import closed and have no native ballots; reopening starts new responses. |
| Phame | Blogs, post body/subtitle, draft/published/archived state, inherited audience | Original author, publication dates, slug/domain configuration, comments and transactions. Publishing uses the selected destination audience. |
| Legalpad | Current text, title, preamble, signature type as a fresh unsigned agreement version 1 | All included body versions, signatures, exemptions, signer details, verification flags, requirements, comments/transactions. None satisfy a current signature or approval requirement. |

Current editors can select **Inspect Imported History** on an object to read the source rows and download a freshly authorized JSON export. This history stays in memory in the current tab and is not saved into offline storage. History is also available through the provenance API/CLI. It is marked `historical-unverified`: importing a database claim does not authenticate a past author or validate a signature. Historical evidence is editor-only even when the current object is widely readable. Live module histories record the current import operator's actual creation/status actions, not forged past actions. No historical email or notification replay occurs.

## API contract

- `POST /api/suite-import/preview`: `{sourceKey, files: [{name, xml}], destination, roles?}`. Returns `{sourceKey, digest, destination, items, warnings, errors, canApply}`. Each item includes source PHID/digest, native app/kind, `create|skip|conflict`, native record ID when mapped, history row count, and its warnings.
- `POST /api/suite-import/apply`: `{request: <same request>, previewDigest}` with `Idempotency-Key`. Returns `{sourceKey, digest, replayed, records: [{sourcePHID, recordId, created}]}`.
- `GET /api/suite-import/provenance/:recordId`: returns source key/PHID/digest, original dates/author PHID, sanitized source rows, warnings, current import attribution, and `assertionStatus: "historical-unverified"`. Requires current view and edit authority.

## Remaining import limits

Batches accept at most 32 files, 12 MB of XML, 20,000 rows, and 500 current objects. A field is limited to 1 MB and one object's stored provenance to 2 MB. These bounds apply to migration batches, not a quota on the workspace; split exports by complete source objects. Current native object size/validation limits still apply.

Almanac namespaces and cluster service types, external calendars/invitee records, arbitrary recurrence rules, Calendar child/stub overrides, binary attachments/images, Phame external publishing, authentication/account migration, old policy engines, full-text/index/cache tables, and ongoing upstream synchronization are not implemented. Unsupported cluster services and recurrence structures are blocking preview errors; they are not silently approximated. Other unknown tables/columns are explicit warnings. Source transactions and message/comment history remain inspectable evidence rather than a native searchable conversation timeline. Deleted comment source, if supplied, remains in the private evidence archive; it is not republished. Source-current objects have usable native workflows after migration.

The contract follows the pinned upstream commit `51cb7a3db9e8e510d564f6b37297111f7a690c91`: `PhabricatorLiskDAO::getTableName`, the six application's `storage/` classes, Calendar absolute-datetime/recurrence dictionaries, `PhameConstants`, and Slowvote/Legalpad constants. Tests use synthetic data in those actual XML/table formats; this does not claim validation against a production user's database backup.
