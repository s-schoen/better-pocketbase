# ADR 0002: API Token Management UI

Status: Accepted
Date: 2026-07-08

## Context

ADR 0001 defines API tokens and exposes management operations through custom API endpoints under `/api/api-tokens`. ADR 0003 generalizes token ownership from `users` records to any PocketBase auth record.

Those endpoints are usable directly, but token management is currently inconvenient for superusers because there is no Dashboard UI. Normal authenticated `users` records can also manage their own tokens through the API, but this project does not yet have a user-facing application or shared session contract that a token-management UI can reuse.

PocketBase v0.39.6 includes an experimental admin UI extension mechanism. Extensions can be registered from Go with `core.UIExtension`, served under `/_/extensions/{name}`, and initialized by a top-level `main.js` loaded by the Dashboard before its router starts. The maintainer has stated that this UI extension surface is intentionally undocumented for now and may change before the future stabilized UI extension API.

## Decision

Implement the first API-token management UI as a PocketBase Dashboard extension for superusers only.

Superuser UI scope:

- Add a Dashboard route at `#/settings/api-tokens`.
- Add a Settings sidebar entry under `Security > API tokens`.
- Recreate the Settings sidebar using globally available Dashboard primitives and `app.store.settingsNavGroups`, instead of importing private Dashboard modules.
- Show all API tokens by default using the existing superuser behavior of `GET /api/api-tokens`.
- Support simple server-backed pagination with the existing API defaults.
- Support filtering by owner with an auth collection selector, the built-in record picker, and the `authRecordId` query parameter.
- Support creating tokens for a selected auth record with the built-in record picker.
- Leave `expiresAt` blank by default and present that as `Never expires`.
- Show the raw token only once after creation in a blocking reveal modal with copy support and a warning that it cannot be viewed again.
- Support revoking any non-revoked token, including expired tokens, after confirmation.
- Keep the main table focused on name, owner, status, access key, created time, expiry, last-used time, and actions.
- Expose full audit metadata through row details or a preview surface.
- Resolve visible owner records across auth collections where possible, falling back to raw auth record ids.
- Resolve `createdBy` and `revokedBy` actor strings best-effort across their referenced collections, falling back to the raw `collection:id` value.
- If no auth collection exists, show a setup empty state and disable token creation.

Normal-user UI scope:

- Do not ship a normal-user token-management page in the first UI implementation.
- Normal authenticated auth records continue to manage their own API tokens through the API defined in ADR 0001 and ADR 0003.
- A future normal-user UI requires a separate decision about session ownership, login flow, or host-app embedding. We explicitly avoid passing JWTs through URLs.

Implementation shape:

- Keep API-token UI registration in the `internal/apitokens` feature area.
- Keep UI assets in a dedicated subdirectory so frontend extension code does not mix with backend token logic.
- Package the extension as embedded no-build assets with Go `embed.FS`.
- Register the extension through `core.UIExtension` during the existing `apitokens.Register` setup.
- Use the existing `/api/api-tokens` endpoints for listing, creation, and revocation. Do not add server-side owner enrichment, search, filtering, or admin-only duplicate APIs for the first UI version.

Testing approach:

- Add Go tests that verify the UI extension is registered and serves `/_/extensions.js` and static extension assets.
- Continue relying on the existing API tests for list, create, and revoke behavior.
- Use manual browser QA for the no-build Dashboard UI behavior unless a frontend test stack is introduced later.

## Consequences

Positive consequences:

- Superusers get a first-class Dashboard workflow for listing, creating, and revoking API tokens.
- The first UI stays small by reusing the existing management API and Dashboard primitives.
- Token secret handling remains aligned with ADR 0001 because the raw token is only displayed once after creation.
- The feature module remains cohesive while keeping UI assets visually separated from backend code.
- The normal-user API contract remains available without inventing a premature frontend session model.

Tradeoffs:

- The UI depends on PocketBase's experimental admin UI extension API and may require maintenance when PocketBase stabilizes or changes that surface.
- Normal authenticated users still do not have a bundled self-service UI.
- Client-side owner and actor resolution adds extra Dashboard requests for visible rows.
- Using only the existing API means there is no server-side text search, status filter, or enriched owner metadata in v1.
- Manual browser QA leaves some UI regressions uncovered by automated tests.

Out of scope for this ADR:

- A normal-user login or self-service token-management page.
- Passing user JWTs through URLs or other leak-prone handoff mechanisms.
- Per-token scopes, quotas, rotation workflows, or rename/update operations.
- A frontend build pipeline or browser automation test stack.
- Forking or rebuilding the bundled PocketBase Dashboard.
