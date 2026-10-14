# Dashboards

Dashboards provide a configurable workspace home with text and query panels. A dashboard has a stable link, an owner, a version, and an explicit choice between private and workspace visibility. Workspace visibility requires a signed-in member; it does not make the application public. Only the owner can edit or delete the dashboard.

The editor supports the original dashboard's four column arrangements: one column, equal columns, a wider left column, or a wider right column. Panels can be moved with labeled buttons and column selectors, including on touch screens and with a keyboard. On a narrow screen, columns stack in reading order. Text uses the existing safe Remarkup reader. Query panels use workspace full-text search, its typed filters and sort order, and a configurable result count. Selecting a saved query copies its filters into the panel. Updating or deleting the saved query later does not silently alter the dashboard.

Query results always execute as the current viewer. No result list, snippet, or count from the creator is copied into a shared dashboard. Sharing makes the dashboard's text and search filters visible to workspace members, so the editor explains that boundary. Private query definitions cannot be referenced indirectly to obtain their owner's results. Results are kept in the current verified session and are not cached on disk. Access changes, session locking, and newer object snapshots retire loaded results.

Each person can install a visible dashboard as their own home without changing anyone else's choice. The preference is stored on the server and works across devices. If its dashboard is deleted or made private, that person returns to the built-in home. The unavailable dashboard identifier is omitted from the preference response. Restoring the built-in home is an explicit option.

Dashboard writes require exact expected dashboard and access versions. Home preferences have their own concurrency version. A retained request includes its original request ID and payload, allowing a lost response to be recovered without creating a duplicate or overwriting a newer edit. A retry acknowledges the original operation while presenting only currently authorized dashboard content and current home preferences. Reconnection never submits a request automatically. Local editor drafts can be exported, retained, resumed, or explicitly discarded. Protected workspace sessions retain their existing storage and sign-out rules.

## API and storage

- `GET /api/dashboards` lists currently visible definitions and the caller's home preference.
- `POST /api/dashboards` creates a private or explicitly shared dashboard.
- `GET /api/dashboards/:id` reads a visible dashboard.
- `PUT /api/dashboards/:id` replaces an owned definition using its expected version.
- `POST /api/dashboards/:id/delete` records a terminal tombstone.
- `GET /api/dashboard-home` resolves the caller's home preference under current access.
- `POST /api/dashboard-home` changes that preference using its expected version.

All writes require an `Idempotency-Key`. Definitions, immutable history, private home preferences, and immutable request receipts live in separate SQLite tables introduced in schema 44. Data includes no operator-specific hostname or deployment configuration. Dashboard deletion preserves history and prevents resurrection through stale requests.

The current resource bounds are 100 panels per dashboard, 100 results per query panel, 100,000 characters per text panel, and 500,000 characters for a whole definition. These are payload and rendering bounds, not limits on review suggestions.

## Historical comparison and remaining gaps

The reference implementation is the pinned Phabricator checkout at `reference/phabricator`, particularly the dashboard `layoutconfig`, `paneltype`, and `install` directories. This release implements configurable definitions, text/query panels, the four layouts, owner edits, explicit workspace sharing, and personal home installation.

It does not claim complete Dashboards application parity. Standalone reusable panel objects with separate policies, tab and chart panel types, dashboard portals, installation into project or application menus, favorites, transaction browsing/restoration, drag-and-drop editing, the complete upstream Conduit API, and upstream import compatibility remain gaps. The current query panel intentionally stores copied typed filters rather than a live reference to someone else's saved query.

Service tests cover ownership, private discovery, workspace sharing and withdrawal, personal home isolation, access and version conflicts, exact replay, credential revocation, terminal deletion, immutable evidence, and incompatible schema rejection. Browser tests cover panel composition, keyboard-accessible reorder controls, mobile sizing, persisted layouts and home installation, lost-response recovery, and per-viewer search privacy.
