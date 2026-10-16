# Repository hosting and synchronization

Diffusion distinguishes the authority for a repository from copies of its Git data. Open a repository and inspect **Repository Operations**:

- **Observed externally:** an external upstream is authoritative. The server periodically fetches its branches and tags into the configured local repository.
- **Hosted here:** this server is authoritative. Git clients use its HTTPS clone URL, and the server publishes updates to any configured outbound mirrors.
- **Not configured:** the registry entry exists, but the operator has not enabled observation or hosting. Registering a remote URL alone does not start synchronization.

The server operator configures authority, remotes, credentials and the synchronization interval. Repository editors can request an immediate synchronization, but cannot replace those operator settings through a browser or CLI request. Public status identifies upstream and mirror names without exposing server filesystem paths or remote credentials.

## Inspect and request synchronization

The browser shows each target's last successful synchronization, last attempt, retry state, next attempt and recent attempt history. **Refresh Now** requests an upstream fetch for an observed repository. **Sync Mirrors** requests outbound synchronization for a hosted repository. **Reload Status** reads status without scheduling Git work.

The equivalent native CLI commands are:

```sh
arc repository-sync R1
arc repository-sync R1 --json
arc sync-repository R1
```

Set `PHABRICATOR_URL` to your server address, including its application path prefix. Authenticated workspaces also require `PHABRICATOR_TOKEN`. Reading status requires repository visibility and read scope. Requesting synchronization additionally requires repository edit permission and write scope.

A new `arc sync-repository` request first reads the current authorized configuration. Before scheduling work it prints an exact retry command containing the configuration fingerprint, access epoch and request ID:

```sh
arc sync-repository R1 \
  --configuration <configuration-fingerprint> \
  --access-epoch <original-access-epoch> \
  --request-id <original-request-id>
```

Use those original values after a lost response. A retry does not fetch a newer configuration or silently change an upstream refresh into a mirror push. Successful submission means the request was recorded; inspect `arc repository-sync R1` to follow the background worker's result.

The browser similarly retains an unconfirmed request and provides **Retry Exact Request** and **Export Request**. Reconnecting does not replay it. **Forget Request** only clears the browser's recovery copy; it does not cancel or erase work already recorded by the server.

## Hosted Git clients

Copy the HTTPS clone URL from Repository Operations. Git prompts for credentials: use your account username and an API token as the password. Keep tokens in a suitable credential helper; never put a token in a clone URL, shell command, repository configuration committed to source, or documentation.

Cloning and fetching require repository read access. Observed repositories also provide a read-only clone URL; push changes to their authoritative upstream. Pushing to a repository hosted here requires write scope and repository edit access, and remains subject to the configured push rules and review/build gates. A public source mirror does not make the application or its Git endpoints anonymous.

Outbound mirrors have one authority: this server. Treat a GitHub mirror as a copy, not an independent place to merge changes. Switching authority requires a deliberate operator cutover after comparing branch and tag identities and accounting for any divergent history.

## Offline and immutable source

The synchronization worker runs on the server. Closing the browser does not stop it. Offline browsers can read previously loaded source snapshots, but cannot request synchronization or assert that remote status is current. Requests are never added to an offline outbox.

Refreshing an observed repository updates its branches and tags. Existing Diffusion source selections stay pinned to their exact commit IDs. Reload references and choose a newer reference explicitly to browse a newer snapshot.

## Operator configuration

Set `APP_REPOSITORY_OPERATIONS` to a JSON array in the server's private environment. The repository record must already exist. Paths refer to complete bare repositories writable by the application service account. For example:

```json
[{"repositoryId":"R1","path":"/srv/git/example.git","mode":"observe","observe":{"url":"https://github.com/example/project.git"},"intervalSeconds":300}]
```

For primary hosting, use `"mode":"host"`, omit `observe`, and optionally add outbound mirrors:

```json
[{"repositoryId":"R1","path":"/srv/git/example.git","mode":"host","mirrors":[{"key":"github","url":"https://github.com/example/project.git","credentialFile":"/etc/workspace/github-mirror.json"}],"intervalSeconds":300}]
```

The interval defaults to five minutes (allowed range: 30 seconds to 24 hours). Public upstream fetching needs no credential. Private upstreams and writable mirrors accept a service-owned, mode `0600` JSON credential file with `username` and `token` strings. Scope the credential to the destination repository. Redirects, credentials in URLs, Git hooks from repository content and interactive credential prompts are disabled. GitHub Actions is not involved in replication.

Observation atomically updates and prunes branches and tags while retaining prior tips under internal archival references. Mirrors atomically publish only branches and tags. Divergent branches, changed tags and unexpected destination-only refs stop replication for reconciliation. Explicit `allowRewrite: true` permits replacing destination history using exact destination leases; it should only be enabled for a destination managed as a copy. Internal review, landing and archival refs are excluded, and outbound packs come from an isolated published-object snapshot.

Local landing bindings must use the same path as hosted Git. An observed repository cannot also accept local landings. Cut over by stopping writes at the previous authority, fetching and comparing every branch and tag, backing up the local repository, switching to hosting, then configuring a scoped outbound mirror credential. Never enable simultaneous upstream observation and primary writes.

## Transport and operating limits

Git smart HTTP supports authenticated clone, fetch and push at the application's root or configured path prefix. Git SSH, anonymous Git access, Git LFS, Mercurial, Subversion, repository clustering and GitHub webhooks are not implemented. Polling provides automatic refresh without a webhook.

Upload-pack reads an isolated object database containing only objects reachable from current branches and tags. Incoming pushes must be complete using published objects plus the supplied pack. Knowing an unpublished object ID does not authorize retrieving or publishing it. Native pre-receive rules inspect the authenticated pusher and actual objects before changing references; accepted pushes produce post-receive build and audit evidence.

Each Git request supports at most 128 MiB of compressed/decoded input, 512 MiB output, four concurrent requests and a two-minute processing deadline. Request-body upload must complete within the server’s 30-second request timeout. Published snapshots are bounded to 512 MiB of packed data and one million objects. Existing receive inspection limits also apply; see [Git receive inspection](git-automation.md#large-and-binary-changes). The proxy must permit these body sizes and deadlines. Large repositories require further scaling work; limits fail explicitly rather than silently truncating a push.

Keep SQLite and bare repositories in coordinated backups. Interrupted post-receive processing retains a durable pending record and blocks subsequent pushes until recovery succeeds. A successful Git ref update cannot be rolled back by a failed post hook. Repository Operations exposes the pending count; changing configuration or revoking the original pusher may require operator recovery.
