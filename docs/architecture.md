# Architecture

Wish Deno is one Deno process serving HTML, browser assets, and a JSON API. SQLite keeps
deployment small and makes backups portable.

```text
browser
  |
  | HTTPS
  v
reverse proxy (TLS, forwarding headers, durable rate limit)
  |
  | HTTP on private network
  v
Deno HTTP server
  |-- security headers and request logging
  |-- HTML/static assets
  |-- authentication, CSRF, authorization
  |-- wishlist and gift services
  `-- reservation service
           |
           v
       SQLite WAL in /data
```

## Trust boundaries

- Owners authenticate using an opaque cookie session. Only a SHA-256 session digest is
  stored.
- Authenticated state-changing requests also require a synchronizer CSRF token.
- Every owner query is constrained by the authenticated owner ID.
- Visitors need no account. A reservation returns an unguessable cancellation token;
  only its digest is stored.
- Published-list slugs are public. Unpublished lists behave as missing.

## Persistence

The database and its WAL files use `DATABASE_PATH` (default `/data/wish-deno.sqlite`).
Schema migrations run when the process starts. One application replica may write a
SQLite database at a time; do not put the database on an eventually consistent or
multi-writer network filesystem.

## Runtime

The OCI image uses an exact Deno Alpine release, runs as the image's unprivileged `deno`
user, and writes only under `/data`. Compose also drops Linux capabilities, enables
`no-new-privileges`, and makes the root filesystem read-only.

See [operations](operations.md) for proxy, backup, and upgrade guidance.
