# Drydock working copies

Drydock allocates an exact Git working copy through an explicitly configured worker. Blueprints define the repository, operator binding, worker label, enabled status and resource capacity. Authorizations bind a blueprint to a requesting account or Harbormaster plan. An owner/automation manager approves, denies or revokes requests. Manual allocation pins the current blueprint version and an observed full commit/tree identity; the server verifies that source through its configured Git observer.

The desktop/mobile application exposes Blueprints, Authorizations, Leases and Resources, including lifecycle logs, renewal, release and links from builds. Forms retain exact pending requests for explicit retry/export; reconnecting does not allocate resources. Worker filesystem paths and credentials never appear in browser responses.

Leases move through pending, acquired, active, releasing and released states. Expiration or lost authority initiates cleanup. Fenced worker claims and immutable report identities prevent old workers, expired attempts and duplicate reports from publishing another allocation's result. Resource capacity stays occupied until cleanup is reported. Blueprint repository/binding/worker identity cannot be changed underneath approved authorizations; create a new blueprint for those changes. Name, description, capacity and enabled status are versioned.

A Harbormaster **Drydock working copy** step allocates a lease for the build's immutable commit or revision patch. Dependent external/HTTP steps receive opaque handles only for the working-copy steps they depend on. They require current source authority, active leases and the resource's assigned worker principal. Terminal builds release their resources; aborted, expired or revoked allocations fence unfinished dependent work. Independent branches do not wait for unrelated working copies. Exact revision-source working copies stage the reviewed target tree over its verified imported baseline. See [revision patches and landing](revision-landing.md); arbitrary remote commands remain separate work.

## Operator setup

Create a dedicated worker account with a read/write API token and Edit access to the repositories it serves. The web server needs the ordinary `APP_GIT_REPOSITORIES` observer mapping, automation managers, and these explicit worker/binding settings:

```dotenv
APP_DRYDOCK_WORKERS='{"local-copy":["drydock-worker"]}'
APP_DRYDOCK_BINDINGS='[{"key":"research-copy","worker":"local-copy","repositoryIds":["R1"]}]'
```

No bindings or workers are enabled by default. These settings contain public binding labels and account names, not worker filesystem paths. Local single-user mode also requires an explicit `local` worker entry. Restart after configuration changes. Blueprint creation requires an automation manager; existing owners may manage their blueprint while retaining repository authority. Approval of a build plan allows that plan to allocate for eligible repository editors, subject to current source access.

On the worker host, save a private operator configuration:

```json
{
  "server": "https://workspace.example.org/",
  "worker": "local-copy",
  "bindings": {
    "research-copy": {
      "repositoryId": "R1",
      "repositoryPath": "/srv/git/research.git",
      "root": "/var/lib/workspace/drydock/research"
    }
  }
}
```

Each binding needs a distinct, private, owned storage root, separate from the operator's bare repository. The worker refuses unowned/nonempty roots, symlink roots, and conflicting ownership markers. Operator deployment settings and secrets belong outside this application repository.

```sh
APP_DRYDOCK_WORKER_CONFIG=/etc/workspace/drydock-worker.json \
APP_DRYDOCK_WORKER_TOKEN="$WORKER_TOKEN" npm run drydock:worker
```

Use `-- --once` for one polling cycle. The token must come from private operator secret management; never put it in a committed configuration or command transcript. HTTPS is required except for loopback development. Configure an existing mounted workspace URL directly if needed.

The worker verifies the immutable commit/tree, constructs a private shallow Git repository containing only that commit and its verified tree/blob objects, and writes raw blob bytes to a detached working copy with a matching Git index and HEAD, without copying unrelated history or remote configuration. It never executes repository code, checkout filters, hooks, inherited templates, submodules or arbitrary plan commands. It preserves binary file bytes, executable mode and line endings. Paths which cannot be represented safely, symlinks and submodules fail explicitly. This adapter is a materializer, not a sandbox for executing untrusted builds. A downstream operator-supplied worker must supply the appropriate execution isolation.

Cleanup only removes directories with matching worker/resource/lease/source ownership records. On reconnect, the worker checks the server for renewals before applying cached expiry deadlines. If API access is lost, the local reaper removes expired copies using that last confirmed deadline; an unobserved renewal during an outage may therefore clean up early. Removing an account or binding prevents new provisioning, while the same still-active worker can finish its assigned cleanup. Disabled credentials cannot publish reports, but local expiry cleanup continues while the worker runs. Stopping the worker stops its cleanup loop; operators must supervise the service and reconcile stranded resources before reclaiming capacity.

## Native API

All writes require an `Idempotency-Key`, write scope and current object/Space authority. Workers require their explicitly configured label/account binding for provisioning. No route accepts an arbitrary host path or a browser-supplied commit tree.

| Endpoint | Operation |
| --- | --- |
| `GET/POST /api/drydock/blueprints` | List visible blueprints and public bindings; create a blueprint. |
| `GET/PUT /api/drydock/blueprints/:id` | Inspect or version an existing blueprint. |
| `POST /api/drydock/blueprints/:id/authorizations` | Request an account/plan authorization. |
| `GET /api/drydock/authorizations` and `/:id` | Inspect permitted authorization records. |
| `POST /api/drydock/authorizations/:id/commands` | Approve, deny or revoke with an expected version. |
| `GET/POST /api/drydock/leases` | List visible leases; request an exact observed commit or revision patch. |
| `GET /api/drydock/leases/:id` | Inspect the lease, resource and logs. |
| `POST /api/drydock/leases/:id/commands` | Renew or release with an expected version. |
| `GET /api/drydock/resources` and `/:id` | Inspect visible allocated resources. |
| `GET /api/drydock/worker/jobs?worker=LABEL` | Poll authorized provisioning and assigned cleanup work. |
| `POST /api/drydock/leases/:id/claim` | Acquire a fenced provision/cleanup claim. |
| `POST /api/drydock/leases/:id/report` | Report ready, released, broken, or heartbeat with claim token and report ID. |

Read results carry the current access epoch. Exact retries recheck current visibility and receiver/worker authority. Lease lifetimes are at most one day per request/renewal. Local provisioning admits at most 20,000 files, 64 MiB per file, 256 MiB total and 240 seconds (or the earlier claim/lease deadline) and fails without publishing an active resource when source cannot be materialized.

## Upstream comparison

The pinned reference is recorded in [upstream.md](upstream.md). Source research includes `src/docs/user/userguide/drydock*.diviner`, `src/applications/drydock/`, and Harbormaster's working-copy build step.

Implemented here: versioned working-copy blueprints, explicit authorization decisions, durable leases/resources/logs, fenced worker claims, current-policy checks, capacity and expiry, exact local Git materialization/cleanup, Harbormaster step dependencies, and mobile lifecycle controls. Schema 38 adds tables without rewriting existing workspace rows. Schema 39 extends this with exact revision patches and local squash landing; see [contracts](revision-landing.md).

Remaining: SSH and Almanac host blueprints, cloud provisioning, shared host resource pools, reusable working-copy pools, Passphrase credentials, remote repository landing/merge operations and staging interchange, arbitrary remote commands, full Drydock Conduit compatibility, upstream object/history import, broad saved-query/policy options and production fleet recovery. Drydock is therefore partial, with a usable local Git provider. No remote fleet is provisioned by installing the application.
