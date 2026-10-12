# Google sign-in

Google sign-in is an optional Firebase Authentication integration for an existing authenticated workspace. It creates the same workspace sessions as password sign-in. An operator explicitly maps Firebase user IDs to provisioned workspace usernames; matching email addresses never link accounts or grant membership. Password sign-in remains available.

## Configure a provider

Use a Firebase project with its Google sign-in provider enabled and a registered Web app. Add the workspace hostname to Firebase Authentication's authorized domains. Existing projects can reuse their Google provider and Web app configuration. The application's hostname still needs authorization even when a related website already uses the provider. See the [Firebase Google sign-in setup](https://firebase.google.com/docs/auth/web/google-signin).

Provision the workspace account with `npm run accounts -- create editor --name "Workspace Editor"`. Obtain the intended person's existing Firebase **user UID** from the provider's user administration; this is neither their email address nor the Google OAuth subject. Keep the following configuration in the server operator's private environment file:

```sh
APP_AUTH_MODE=password
APP_PUBLIC_ORIGIN=https://reviews.example.com
APP_GOOGLE_AUTH='{"projectId":"example-project","apiKey":"YOUR_FIREBASE_WEB_API_KEY","authDomain":"example-project.firebaseapp.com","appId":"YOUR_FIREBASE_WEB_APP_ID","accounts":{"EXISTING_FIREBASE_UID":"editor"}}'
```

`APP_GOOGLE_AUTH` must be complete valid JSON. The auth domain must be the project's standard `firebaseapp.com` domain. Each configured username must refer to an existing workspace account. Disabled accounts cannot sign in. Restart after changing the configuration. Omit the variable entirely to disable Google sign-in. It is available only with password mode and an explicit HTTPS public origin, including applications hosted at a configured subpath.

The four Firebase Web app fields are public client configuration. Account mappings stay on the server. This integration needs no Firebase service-account key or Google OAuth client secret. It does not enable public workspace registration. Google sign-in may create a Firebase identity in the configured provider project, but an unmapped identity cannot open the workspace.

## Browser and account behavior

The sign-in page offers **Continue with Google** when the server enables the provider. Pressing the button opens Google's account chooser. A successful mapped login retains the account's existing identity, permissions and history. Cancellation or denial leaves password sign-in available. The provider SDK is a separate browser bundle and is not loaded when the integration is disabled.

Provider credentials are kept in memory during the explicit sign-in attempt, exchanged for the application's HttpOnly session, and discarded. There is no provider token in the workspace origin’s localStorage, IndexedDB, application caches or the workspace database. The application's existing session-context checks, CSRF protection, account disable controls and tab-memory-only authenticated drafts still apply. Signing out of the workspace does not sign the person out of Google or another website.

The popup flow is used on desktop and mobile. Browsers must permit the user-initiated sign-in window; embedded browsers and platform restrictions may require opening the site in the system browser. Redirect-based mobile authentication and a full physical-device/browser compatibility matrix remain open work. No silent popup retry or automatic account switching occurs.

## Verification and limits

The pinned upstream `5720a38c` includes `PhabricatorGoogleAuthProvider`, its OAuth2 adapter and `/oauth/google/login/` redirect flow. This implementation replaces that provider transport with Firebase's current Google integration while preserving authenticated workspace identity. It does not yet reproduce upstream provider administration, account linking, registration configuration or the other OAuth/LDAP providers.

The server verifies RS256 signatures against Google's fixed Firebase signing-key endpoint; issuer and audience must match the configured project. Tokens require valid issuance and expiration times, a recent authentication time within five minutes, a bounded subject, verified email and the `google.com` sign-in provider. Tenant identities and tokens from password, anonymous or custom authentication are rejected. Identity lookup uses only the exact configured Firebase UID. See [Firebase ID-token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

The same-origin login request also needs the browser's one-use challenge. The account and challenge are checked again after asynchronous signature verification, before the session is created. An already authenticated browser must sign out before switching accounts. Provider errors do not expose raw credentials or account mappings.

Signed-token tests cover invalid signatures and claims, exact UID mapping, account disable/password-reset races, token expiry during verification, concurrency limits and one-use challenges. Browser checks cover Google controls and existing password sessions on desktop and mobile at both root and mounted URLs. These browser checks mock the provider transport; an operator must also verify the real provider configuration for their deployment.

Firebase revocation is not continuously synchronized with the workspace: signature verification alone does not check the provider's disabled/revoked state. The recent authentication requirement limits token reuse but does not replace revocation checking. Disable the workspace account to revoke its sessions and API tokens immediately. Removing a mapping prevents future Google logins after restart; it does not revoke existing workspace sessions. Provider-side revocation synchronization, self-service linking/unlinking, invitations, MFA, recovery and additional identity providers remain explicit parity gaps.

The browser Firebase SDK is pinned to its Node 22-compatible release for builds. Its application peers are pinned to the same compatible release family; the unused Firestore gRPC dependency is pinned to a patched version. Production servers install only the JWT verifier and other runtime dependencies, while the browser receives the built authentication chunk.
