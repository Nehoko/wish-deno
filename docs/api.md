# HTTP API

The browser UI and API share one origin. JSON requests use
`Content-Type: application/json`. Responses use JSON unless noted.

Authenticated mutation requests need both the session cookie and CSRF token returned
during authentication. Public reservation cancellation uses its private cancellation
token instead.

## System

| Method | Path      | Auth | Purpose                       |
| ------ | --------- | ---: | ----------------------------- |
| `GET`  | `/health` |   no | Liveness                      |
| `GET`  | `/ready`  |   no | Readiness and database access |

## Authentication

| Method | Path                 |           Auth | Purpose                   |
| ------ | -------------------- | -------------: | ------------------------- |
| `POST` | `/api/auth/register` |             no | Create owner and session  |
| `POST` | `/api/auth/login`    |             no | Create session            |
| `GET`  | `/api/auth/session`  |        session | Read owner and CSRF state |
| `POST` | `/api/auth/logout`   | session + CSRF | Revoke session            |

## Owner wishlists and gifts

| Method   | Path                         |           Auth | Purpose                |
| -------- | ---------------------------- | -------------: | ---------------------- |
| `GET`    | `/api/wishlists`             |        session | List owned wishlists   |
| `POST`   | `/api/wishlists`             | session + CSRF | Create wishlist        |
| `GET`    | `/api/wishlists/:id`         |        session | Read owned wishlist    |
| `PATCH`  | `/api/wishlists/:id`         | session + CSRF | Update or publish      |
| `DELETE` | `/api/wishlists/:id`         | session + CSRF | Delete wishlist        |
| `POST`   | `/api/wishlists/:id/items`   | session + CSRF | Add gift               |
| `POST`   | `/api/wishlists/:id/reorder` | session + CSRF | Reorder all gifts      |
| `PATCH`  | `/api/items/:id`             | session + CSRF | Update or archive gift |
| `DELETE` | `/api/items/:id`             | session + CSRF | Delete gift            |

## Public list and reservations

| Method | Path                                      | Auth          | Purpose                 |
| ------ | ----------------------------------------- | ------------- | ----------------------- |
| `GET`  | `/api/public/:slug`                       | no            | Read published wishlist |
| `POST` | `/api/public/:slug/items/:itemId/reserve` | no            | Atomically reserve gift |
| `POST` | `/api/public/:slug/items/:itemId/cancel`  | token in JSON | Cancel reservation      |
| `POST` | `/api/reservations/cancel`                | token in JSON | Cancel by token         |

Treat reservation cancellation tokens as credentials. Do not log, publish, or send them
to another origin.

## Errors

Error responses use:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Human-readable summary"
  }
}
```

Typical statuses are `400` invalid input, `401` missing/expired session, `403` missing
CSRF or forbidden action, `404` absent/inaccessible resource, `409` conflict such as an
already-reserved gift, and `429` rate limited.
