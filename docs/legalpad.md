# Legalpad agreements and signatures

Legalpad now stores agreements, immutable document versions, explicit individual or company-representative signature decisions, individual exemptions, signature requests, discussion and receipts. These records do not assert independent identity verification, email ownership, certificate-backed digital signatures or legal enforceability.

## Implemented workflows

Create an agreement with a title, preamble, text and signature type (`individual`, `corporation` or `none`). Each published revision records its complete content, author, creation time and SHA-256 content fingerprint. The fingerprint includes the version, title, text, preamble and signature type. Publishing a new version preserves earlier text and receipts; earlier signatures never satisfy the new version.

Signing is an explicit interactive-account operation requiring consent, a typed name, the current agreement version and its exact content fingerprint. An API token cannot sign or withdraw a personal signature. Company signatures additionally require company name/address, a provided contact email address and an explicit statement of authority. Contact addresses are recorded as provided; they are not labeled verified. A reader with normal write capability can sign without permission to edit the agreement.

Editors can request signatures from active people in the current Space and record a reasoned individual exemption against the exact current version. Requirements show whether the person has a current signature, an exemption or an outstanding request. These are agreement-level completion records. They do not gate login, repository access or Herald actions.

A signer may record a reasoned withdrawal, and an editor may record a reasoned void. Both append a separate record while preserving the original receipt. The same person may subsequently sign the current text again. These explicit correction operations are native additions, not a claim that upstream offered the same lifecycle.

Archiving stops new signatures, exemptions, revisions and comments. Restoration reopens the agreement without changing its text or receipts. Readers can add comments while an agreement is active. Document versions and signature history remain available to authorized readers after archive.

Signature receipts include immutable signature identity, actor/signer, document identity/version/hash, signature type, company details where supplied, timestamp and a SHA-256 receipt fingerprint. The UI downloads the receipt together with the exact agreement body and any later revocation. A hash detects changed receipt contents; it is not a public-key signature.

## Privacy, concurrency and recovery

The agreement's current Space and object policies gate all reads and writes. Signature/exemption details and provided contact information are visible only to the signer and agreement editors. Other readers receive aggregate receipt counts, their own requirements and their own receipts; personal signing history is filtered to avoid disclosing other signers through the timeline. Comments are visible to the agreement's audience.

All mutations require a write credential, an idempotency key and the current record version. Signature commands additionally require the exact current content version/hash. Advancing the concurrency version on a retained stale signature draft cannot silently change which agreement the person consented to. The server rejects that draft until the current text is explicitly signed. Reconnecting never automatically submits drafts. A retained signing draft requires returning to its source agreement before submission; selecting another agreement cannot present unrelated terms alongside an enabled signing action. Exact retry recovery preserves a draft edited after the uncertain request.

## API

`GET /api/suite/legalpad` lists visible agreements, with `q`, `kind`, `before`, `limit`. `GET /api/suite/legalpad/<id>` returns the current projected agreement and paginated history.

`POST /api/suite/legalpad` creates `kind: document`, `title`, `text`, optional `preamble`, `signatureType` and `requiredSignerIds`. The native actions are `/revise`, `/sign`, `/withdraw`, `/requirements`, `/exempt`, `/void`, `/comment`, `/archive`, `/restore` and the common `/access`. Every action includes `expectedVersion`; signing and exemptions additionally use `documentVersion` and `contentHash`.

## Upstream scope and remaining gaps

The behavioral reference is Legalpad at pinned upstream `5720a38cfe95b00ca4be5016dd0d2f3195f4fa04`, compared with the original 2021 reference. Document bodies, signing forms, exemptions and signature policy were inspected without running PHP. Native agreement identifiers use `LP-…` because the existing document-review application already uses `L…`.

Missing original integrations include signature-required login gates, Legalpad signature policy rules and Herald edges, enforced high-security/MFA signing sessions, external/anonymous signing, email verification and delivery, corporate exemptions, subscriber/mail replies, complete Remarkup, saved-query and upstream migration/interchange compatibility. Agreement-level signer requests are not substitutes for these gates. No full Legalpad parity is claimed.

## Verification

Domain tests cover immutable source versions and receipt fingerprints, stale hash/version rejection, explicit consent, individual/corporate requirements, forbidden token signing, signer/editor privacy in data and history, private completion status, exemptions, preserved withdrawal/void receipts, archive lifecycle, comments and mutation rollback. Browser coverage signs and downloads a receipt, publishes changed terms, verifies earlier signatures no longer satisfy current requirements, records an exemption, discusses the agreement and rejects a stale retained signature draft. Authenticated integration tests use real interactive sessions for corporate signing, verify caller identity cannot be supplied by input, preserve the original receipt across a changed agreement and exact retry, deny recovery after policy revocation, and page past a fully hidden signature-history page. Common integration tests exercise concurrent writes, exact replay and current policy enforcement.
