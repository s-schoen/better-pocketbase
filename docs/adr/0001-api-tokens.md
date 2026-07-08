# ADR 0001: User API Tokens

Status: Accepted
Date: 2026-07-08

## Context

PocketBase supports normal auth tokens and static impersonation-style auth tokens, but it does not provide first-class long-lived API keys that users can create, list, and revoke for integrations.

We want API tokens that authenticate as an existing user and then rely on normal PocketBase collection rules for authorization. The first version should be small, auditable, and secure enough for machine-generated long-lived credentials without introducing a separate scope system.

OWASP guidance relevant to this feature:

- API keys must be transmitted over TLS and never in URLs.
- API keys should be revocable, expirable where possible, and auditable.
- Invalid credentials should produce generic errors and should not leak secret material in logs.
- API keys should not bypass endpoint-level authorization.
- Usage should remain visible enough for incident response.

## Decision

Implement user-owned API tokens as a Better PocketBase extension feature.

Token authentication:

- Clients send tokens in the `X-API-Key` HTTP header.
- A missing `X-API-Key` does not affect normal PocketBase authentication behavior.
- A present but invalid, revoked, or expired `X-API-Key` returns a generic `401 Unauthorized`.
- Requests containing both `Authorization` and `X-API-Key` are rejected as ambiguous credentials.
- Accepted API-token requests set `e.Auth` to the owning `users` record.
- Accepted API-token requests set `@request.context` to `apiToken`.
- API-token authentication applies to PocketBase API routes that honor request auth, except the API-token management endpoints.
- API-token management endpoints require normal PocketBase JWT auth, not API-token auth.

Token ownership and authorization:

- V1 tokens can only belong to records in the `users` auth collection.
- Tokens authenticate exactly as the associated user.
- No per-token scopes are introduced in v1.
- The owning user must still exist and satisfy the current `users` collection `AuthRule`.
- API tokens are independent credentials and are not automatically invalidated by user `tokenKey`, password, or email changes.
- Deleting a user cascade-deletes that user's API token records.

Token format:

- The serialized token format is `pb_<access>.<secret>`.
- `pb_` is a fixed unversioned prefix.
- `<access>` is 128 bits of cryptographically secure random data encoded as fixed-width lowercase base36, 25 characters.
- `<secret>` is 256 bits of cryptographically secure random data encoded as fixed-width lowercase base36, 50 characters.
- The access part is not secret and is used to find the token record efficiently.
- The secret part is the bearer secret and is only shown once at creation time.

Token storage:

- Store `accessKey` in plaintext.
- Store `secretHash` as the 64-character lowercase hex encoding of `SHA-256(secret)`.
- Do not store the raw secret part.
- Use constant-time comparison when checking the presented secret hash.

Storage rationale:

- The secret part is 256 bits of CSPRNG output, so offline guessing is infeasible after a database leak.
- Password hashing algorithms such as bcrypt or Argon2id are designed for low-entropy human passwords. They add per-request CPU or memory cost but do not materially improve protection for a 256-bit random API secret.
- A fast verifier is appropriate for high-entropy machine secrets.
- HMAC was considered, but PocketBase does not provide a stable general-purpose server secret for this feature. Reusing internal PocketBase auth token secrets would couple this feature to unrelated auth-token internals, and adding a custom pepper would introduce key-management and rotation requirements not needed for v1.
- Plain `SHA-256(secret)` keeps the feature self-contained while preserving practical database-leak resistance.

Backing schema:

- Create an internal/system `api_tokens` collection with closed direct API rules.
- Manage the collection with Go migrations, following PocketBase's recommended Go extension path.
- Expose token operations only through custom Go endpoints.
- Store the owning user as `userId` rather than a relation field so the migration can run before a `users` collection exists.
- Enforce user existence during token creation/authentication and delete a user's token records from a Go delete hook.
- Store actor audit fields separately from the owner, using strings such as `collection:id` for `createdBy` and `revokedBy`.

Management API:

- Base path is `/api/api-tokens`.
- `GET /api/api-tokens` returns a PocketBase-style paginated response.
- Normal users only list their own tokens.
- Superusers can list all tokens and use the same endpoints with broader admin semantics.
- List responses include all statuses: `active`, `expired`, and `revoked`.
- List responses may include the full `accessKey` but must never include the secret part or full token.
- `POST /api/api-tokens` creates a token.
- Token creation requires a human-readable `name`.
- Token creation accepts optional `expiresAt`; omitted expiry means no automatic expiry.
- Normal users create tokens for themselves.
- Superusers can create tokens for a target user.
- Create responses return the full raw token once plus the public metadata record.
- `DELETE /api/api-tokens/{id}` soft-revokes a token by setting revocation metadata.
- No update endpoint is included in v1.

Audit and logging:

- Store `lastUsedAt` and update it on every successful API-token-authenticated request.
- If updating `lastUsedAt` fails, the authenticated request continues and the failure is logged.
- Do not store `lastUsedIP` or user-agent in v1.
- Failed parseable API-token attempts may log the access key at warn level.
- Malformed API-token attempts may log at debug level.
- Logs must never include the secret part or full token.

Limits and rate limiting:

- V1 does not define per-token scopes, quotas, or rate limits.
- V1 does not cap the number of tokens per user.
- Existing PocketBase or deployment-level rate limiting remains responsible for request volume controls.

## Consequences

Positive consequences:

- Integrations can authenticate with durable user-owned API tokens.
- Existing PocketBase collection rules remain the source of authorization truth.
- Token storage is safe against practical offline guessing after database disclosure.
- Users and superusers can revoke tokens without deleting audit records.
- `@request.context = "apiToken"` lets future collection rules distinguish API-token traffic when needed.

Tradeoffs:

- API tokens are bearer credentials. Anyone with the full token can act as the owning user until expiry or revocation.
- Password or email changes do not automatically revoke API tokens.
- Updating `lastUsedAt` on every accepted request adds a database write to every API-token-authenticated request.
- Superuser management behavior adds authorization complexity to the shared management endpoints.
- Without per-token scopes, the least-privilege boundary is the owning user's existing PocketBase permissions.

Out of scope for v1:

- Per-token scopes.
- Per-token quotas or rate limits.
- Token rotation workflows.
- Token update or rename endpoints.
- API tokens for superusers or arbitrary auth collections.
- Server-side HMAC pepper management.
