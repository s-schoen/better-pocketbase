# ADR 0003: Auth Record API Tokens

Status: Accepted
Date: 2026-07-08

## Context

ADR 0001 introduced user-owned API tokens. We now need the same API-key mechanism to work for superusers and custom PocketBase auth collections.

PocketBase treats auth record ids as unique across all auth collections and cross-checks duplicate ids during auth record saves. That lets this feature store a single owner id without storing a separate owner collection field.

## Decision

Generalize API token ownership from `users` records to any PocketBase auth collection record.

- Store the owner as `authRecordId`.
- Do not store `ownerCollection` or a separate owner model.
- Resolve `authRecordId` by scanning all auth collections and loading the matching record.
- Reject token authentication if no auth record is found.
- Reject token authentication if duplicate auth record ids are found across auth collections.
- Continue enforcing the owning auth collection's current `AuthRule` during API-key authentication.
- Set `e.Auth` to the resolved auth record after successful API-key authentication.
- Keep API-token management endpoints JWT-only; API-key-authenticated requests cannot manage API keys.
- Let normal auth records manage only their own tokens.
- Let superusers create, list, filter, and revoke tokens for any auth record.
- Use `authRecordId` for create bodies, list responses, and superuser list filters.
- Delete API tokens when any owning auth record is deleted.
- Do not provide compatibility or migration behavior for existing `userId` token records.

## Consequences

- API keys now work for `users`, `_superusers`, and custom auth collections.
- A superuser-owned API key is a full superuser credential and can access routes guarded by PocketBase superuser auth.
- The schema remains small because no collection discriminator is stored.
- Authentication does a small scan across auth collections to resolve the owner id.
- The implementation fails closed if the database ever contains duplicate auth record ids across auth collections.
