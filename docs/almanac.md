# Almanac service directory

Almanac now provides native, persisted devices, networks, interfaces, custom services and bindings. It is a service directory; registering a record does not provision a machine, connect to an endpoint, launch a worker or configure a cluster.

## Implemented workflows

Register a named device and network, then add an interface with an IPv4, IPv6 or DNS address and port. Register a custom service and bind it to an interface. Names are case-normalized and unique within their record type. Interface identity is device/network/address/port; binding identity is service/interface. IPv6 spelling is normalized before duplicate checks. Opaque checks include inaccessible records and return generic conflict messages without disclosing their identity.

Descriptions and structured JSON properties are editable. Devices, networks, interfaces, services and bindings can be disabled and enabled without deleting their history. Active dependents must be disabled before a parent is disabled or an in-use interface endpoint is changed. A binding cannot be enabled while its interface, device, network or service is disabled. Links use stable object identifiers; binding service/interface identity is immutable.

Interfaces inherit their device's current audience and edit authority and also require visibility of the network. Bindings inherit their service's current audience and edit authority and additionally require visibility of the interface, device and network. Each object's own Space continues to restrict access. These checks apply on direct reads, search, mutations and retry recovery.

The `#almanac` interface provides forms, named relationship suggestions with direct identifier entry, typed properties, parent links, status, search, history and retained manual drafts. It uses the same layout on desktop and mobile.

## API

`GET /api/suite/almanac` lists the caller's visible records. Query fields are `q`, `kind`, `before` and `limit`. `GET /api/suite/almanac/<id>` returns current data, permitted actions and paginated history.

`POST /api/suite/almanac` creates `kind: device|network|interface|service|binding`. Named records use `title`; interfaces use `deviceId`, `networkId`, `address`, `port`; bindings use `serviceId`, `interfaceId`. Optional fields include `description` and `properties`. `serviceType` only accepts `custom`.

`POST /api/suite/almanac/<id>/edit`, `/properties`, `/disable`, `/enable` and the common top-level `/access` action use the current `expectedVersion` and an `Idempotency-Key`. HTTP input never supplies execution credentials or causes a network connection.

## Upstream scope and remaining gaps

The behavioral reference is the Almanac application at pinned upstream `5720a38cfe95b00ca4be5016dd0d2f3195f4fa04`. The 2021 reference and latest changes were inspected read-only, especially interface/binding policy relationships, uniqueness, custom service types and property editing. No PHP runtime or bundled dependencies are reused.

Remaining original capabilities include namespace reservations and namespace-aware naming, SSH device enrollment and trusted keys, cluster database/repository service types, Drydock pool service discovery, specialized service-property schemas/defaults, full saved queries/Conduit interchange, automatic subscription/mail delivery and upstream import. There is no claim of full Almanac parity.

## Verification

Focused domain tests cover complete device/network/interface/service/binding registration, typed properties, invisible duplicate conflicts, disabled parent/dependent transitions, inherited permissions, endpoint validation/IPv6 identity and rollback-safe rejected commands. Browser coverage exercises actual creation forms, binding/property edits, rejected parent disabling, successful lifecycle changes and responsive layouts. Authenticated integration tests additionally revoke a device editor after interface creation, restrict a linked network in another Space, retry a previously successful creation after access loss, and disable an interface hidden from its device owner. They verify that current policy intersections and opaque global dependency checks still apply. Common suite integration tests cover transactional optimistic concurrency, immutable history, current access and idempotent receipts.
