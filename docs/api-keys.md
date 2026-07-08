# API keys

API keys let a program or integration access the PocketBase API as a regular application user without using that user's password. They are useful for automation, scripts, CI jobs, background workers, and other machine-to-machine access.

An API key authenticates as the user that owns it. It does not have separate permissions or scopes. Any request made with an API key is still checked against the normal PocketBase collection rules for that user.

## How API keys work

- API keys are sent in the `X-API-Key` HTTP header.
- API keys can belong only to records in the `users` auth collection.
- API keys can be active, expired, or revoked.
- The full key is shown only once when it is created.
- The visible `accessKey` is only an identifier. It is not enough to authenticate.
- API key usage updates the key's `lastUsedAt` timestamp.
- Deleting a user also deletes that user's API keys.

API keys are bearer credentials. Anyone who has the full key can act as the owning user until the key expires or is revoked.

## Create an API key in the Dashboard

Superusers can manage API keys from the PocketBase Dashboard:

1. Open the Dashboard.
2. Go to `Settings > Security > API tokens`.
3. Click `Create token`.
4. Select the user that should own the key.
5. Enter a clear name, such as `CI deployment` or `Reporting sync`.
6. Optionally set an expiration date.
7. Create the key.
8. Copy the full key immediately and store it securely.

The full key cannot be viewed again after you close the copy dialog. If you lose it, revoke the old key and create a new one.

## Use an API key

Send the full API key in the `X-API-Key` header:

```sh
curl "https://example.com/api/collections/tasks/records" \
  -H "X-API-Key: pb_0000000000000000000000000.00000000000000000000000000000000000000000000000000"
```

Do not put API keys in URLs, query strings, or request bodies. Only send them over HTTPS.

Do not send an API key together with an `Authorization` header. Requests that contain both credentials are rejected because the server cannot safely decide which identity should be used.

## Manage your own API keys through the API

Authenticated `users` records can list, create, and revoke their own API keys through `/api/api-tokens`. These management endpoints require a normal PocketBase login token in the `Authorization` header. They do not accept API-key authentication.

Replace `<user-jwt>` with the auth token returned by your normal user login flow.

### List your API keys

```sh
curl "https://example.com/api/api-tokens" \
  -H "Authorization: <user-jwt>"
```

The response is paginated and includes active, expired, and revoked keys:

```json
{
  "page": 1,
  "perPage": 30,
  "totalItems": 1,
  "totalPages": 1,
  "items": [
    {
      "id": "abc123",
      "userId": "user123",
      "name": "CI deployment",
      "accessKey": "0000000000000000000000000",
      "status": "active",
      "created": "2026-07-08 12:00:00.000Z",
      "updated": "2026-07-08 12:00:00.000Z",
      "expiresAt": "",
      "revokedAt": "",
      "lastUsedAt": "",
      "createdBy": "users:user123",
      "revokedBy": ""
    }
  ]
}
```

Use `page` and `perPage` query parameters to page through results. `perPage` can be at most `100`.

### Create an API key

```sh
curl "https://example.com/api/api-tokens" \
  -X POST \
  -H "Authorization: <user-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"CI deployment","expiresAt":"2026-12-31T23:59:59Z"}'
```

`name` is required and can be up to 200 characters. `expiresAt` is optional. Leave it out to create a key that does not expire automatically.

The response includes the full key once:

```json
{
  "token": "pb_0000000000000000000000000.00000000000000000000000000000000000000000000000000",
  "item": {
    "id": "abc123",
    "userId": "user123",
    "name": "CI deployment",
    "accessKey": "0000000000000000000000000",
    "status": "active"
  }
}
```

Save the `token` value immediately. Later list responses show only metadata and the public `accessKey`, not the secret part of the key.

### Revoke an API key

```sh
curl "https://example.com/api/api-tokens/abc123" \
  -X DELETE \
  -H "Authorization: <user-jwt>"
```

Revoking a key is permanent. A revoked key can no longer authenticate, but its metadata remains visible for auditing.

## Superuser management through the API

Superusers can use the same `/api/api-tokens` endpoints with a superuser `Authorization` token.

Superusers can list all keys:

```sh
curl "https://example.com/api/api-tokens" \
  -H "Authorization: <superuser-jwt>"
```

Superusers can filter by owner:

```sh
curl "https://example.com/api/api-tokens?userId=user123" \
  -H "Authorization: <superuser-jwt>"
```

Superusers can create a key for a user by passing `userId`:

```sh
curl "https://example.com/api/api-tokens" \
  -X POST \
  -H "Authorization: <superuser-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"userId":"user123","name":"Reporting sync"}'
```

## Limitations

- API keys have the same permissions as their owning user. There are no per-key scopes in this version.
- API keys are not automatically revoked when a user changes password or email.
- API keys cannot authenticate as superusers.
- API keys cannot belong to auth collections other than `users`.
- API keys cannot be renamed or updated. Revoke and recreate a key instead.
- There is no built-in key rotation workflow.
- There are no per-key quotas or rate limits. Use your normal PocketBase or deployment-level rate limiting.
- The bundled Dashboard UI is available to superusers only. Normal users can manage their own keys through the API if your application exposes that workflow.

## Security tips

- Treat API keys like passwords.
- Use HTTPS for every API-key request.
- Store keys in a secret manager or environment variable, not in source code.
- Use a separate key for each integration so you can revoke one integration without affecting others.
- Set an expiration date when practical.
- Revoke unused or suspicious keys.
- Check `lastUsedAt` to see whether a key is still active.
