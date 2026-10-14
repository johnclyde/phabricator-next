# Notification email

The six collaboration applications feed the existing authenticated notification inbox. Each object offers following, ignoring, muting and email preferences. Object ownership, conversation participants, event invitations, blog roles, poll participation and requested agreement signers supply application-specific defaults. The server checks current account, Space, parent and object access when publishing and reading notifications. Private ballot and agreement events have additional audience checks; a notification never exposes a historical draft or confidential receipt.

## Explicit outbound delivery

Email is disabled by default. An operator must configure SMTP and associate a current account ID with a single mailbox. The person then enables delivery in **Notifications → Email settings** and selects email on the objects they follow. The UI identifies the address as operator-configured; this is not email verification or proof of ownership. Tokens cannot change personal mail preferences. Importing historical objects does not publish notifications or send email.

Generic messages say that a workspace notification is available and link to the authenticated inbox at the configured mount. They contain no object title, source text, chat message, ballot, signature or participant identity. Current account and event visibility, current following/mute/email preferences, and the configured address are checked before delivery. An SMTP operation already in flight cannot be recalled; its generic content deliberately contains no protected object data.

Enabling delivery starts after the current notification sequence. Enabling an object's email preference also starts after its current sequence. Neither sends a historical backlog. Changing the configured mailbox requires a fresh global opt-in. Disabling global delivery suppresses pending jobs. Losing access or muting/ignoring an object suppresses unsent mail; later access does not revive skipped deliveries.

## Configuration

Keep actual settings and credentials in the operator's infrastructure repository or secret store. The application accepts these generic environment variables:

| Variable | Meaning |
| --- | --- |
| `APP_SMTP_HOST` | SMTP hostname; absent means disabled |
| `APP_SMTP_PORT` | Port, default 465 for direct TLS or 587 for STARTTLS |
| `APP_SMTP_SECURE` | `true` for direct TLS (default), `false` for required STARTTLS |
| `APP_SMTP_USERNAME`, `APP_SMTP_PASSWORD` | Optional authentication pair |
| `APP_MAIL_FROM` | Single sender mailbox |
| `APP_MAIL_RECIPIENTS` | JSON object mapping account IDs to single mailboxes |
| `APP_PUBLIC_ORIGIN` | Existing HTTPS public origin |

Certificate verification and TLS 1.2 or newer are mandatory. Display-name mailboxes, address lists, comments, quoted local parts and header injection are rejected. The transport cannot load files or URLs from message fields. Messages include the existing `APP_BASE_PATH` in their inbox link. No mail service, address or credential is inferred from Google sign-in.

## Durable delivery and limits

Schema 42 adds `mail_preferences` and `mail_outbox`. A five-second worker scans at most 100 principals with new deliveries, at most 100 deliveries each, and sends at most ten messages per pass. Atomic claims prevent simultaneous workers from sending the same pending job. The notification identity is unique and the message ID remains stable. Restart recovery marks expired in-flight claims as unconfirmed.

The personal email settings show pending, accepted, rejected and unconfirmed totals. SMTP acceptance means the server accepted the message, not that it reached an inbox. A definitive SMTP rejection is recorded as failed; socket errors and process interruption may happen after acceptance and are recorded as uncertain. Neither is automatically resent. Operators can inspect terminal delivery rows without message bodies or credentials in the database; a later notification can still deliver normally. Automated retry/backoff, manual resend controls, bounce handling and delivery webhooks remain gaps.

Inbound email/reply parsing, calendar invitations over email, digests, external push notifications, delivery to arbitrary public signers and workspace-wide email support for older applications are not implemented by this slice. The six apps' inbox notifications and opt-in generic outbound messages are the verified contract, not full upstream mail parity.
