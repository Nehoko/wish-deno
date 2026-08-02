# Wish Deno

Self-hosted wish lists with polished public sharing, private owner management, and
anonymous gift reservations. Inspired by Followish, built from scratch with Deno and
SQLite.

## Features

- Multiple owner-managed wishlists with stable public share links
- Gift images, notes, prices, currencies, priorities, and store URLs
- Public search, filters, and sorting
- Anonymous, atomic gift reservations
- Private reservation cancellation tokens; owner sees state, not visitor identity
- Password sessions, CSRF protection, ownership checks, and security headers
- Responsive accessible UI
- One non-root OCI image for AMD64 and ARM64

## Run with Docker

```sh
docker volume create wish-data
docker run -d \
  --name wish-deno \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:size=16m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -p 127.0.0.1:8000:8000 \
  -e COOKIE_SECURE=true \
  -v wish-data:/data \
  ghcr.io/nehoko/wish-deno:1.0.5
```

Tags `1`, `1.0`, `1.0.5`, and `latest` are published for a `v1.0.5` release. Production
deployments should pin a full version or image digest.

For Compose, select the wanted `image` tag in [`compose.yaml`](compose.yaml), then:

```sh
docker compose up -d
```

Open the configured public origin, register an owner, create a list, add gifts, publish
it, and copy its share URL.

Image runs as UID/GID `1000`. Docker named volumes inherit prepared `/data` permissions.
For runtimes that create a root-owned empty volume, initialize it once:

```sh
docker run --rm --user 0 \
  -v wish-data:/data \
  --entrypoint chown \
  ghcr.io/nehoko/wish-deno:1.0.5 \
  1000:1000 /data
```

## Configuration

| Variable              | Default                      | Meaning                                |
| --------------------- | ---------------------------- | -------------------------------------- |
| `HOST`                | `0.0.0.0`                    | Listen address                         |
| `PORT`                | `8000`                       | Listen port                            |
| `DATA_DIR`            | `/data`                      | Persistent data directory              |
| `DATABASE_PATH`       | `$DATA_DIR/wish-deno.sqlite` | Explicit SQLite path override          |
| `PUBLIC_DIR`          | `public`                     | Browser asset directory                |
| `APP_ORIGIN`          | empty                        | External origin; drives cookie default |
| `COOKIE_SECURE`       | derived from origin          | Mark owner session cookie HTTPS-only   |
| `SESSION_TTL_SECONDS` | `2592000`                    | Owner session lifetime                 |

Set `COOKIE_SECURE=false` only for local HTTP development. Production should keep its
container default of `true`. Session lifetime is 30 days.

## Reverse proxy

Expose only the proxy publicly. Keep port 8000 on a loopback/private network and forward
the original host and scheme.

Example Caddyfile:

```caddyfile
wish.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8000
}
```

Example nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Keep `COOKIE_SECURE=true`. Add proxy-level durable rate limiting and TLS policy suitable
for your environment.

## Upgrade

Back up `/data`, pull the new tag, and recreate the container:

```sh
docker compose pull
docker compose up -d
docker compose ps
```

Startup migrations are forward-only. Rollback across a schema migration needs both the
older image and the pre-upgrade backup. Full backup instructions:
[`docs/operations.md`](docs/operations.md).

## API and health

- `GET /health` — liveness
- `GET /ready` — readiness, including database access
- `/api/auth/*` — owner registration, login, session, logout
- `/api/wishlists/*` and `/api/items/*` — authenticated owner management
- `/api/public/*` and `/api/reservations/*` — public lists and reservations

Exact routes, authentication rules, statuses, and error shape are documented in
[`docs/api.md`](docs/api.md). Architecture and security boundaries:
[`docs/architecture.md`](docs/architecture.md).

## Local development

Requires Deno 2.9.x (CI and image use 2.9.4):

```sh
mkdir -p .data
DATABASE_PATH="$PWD/.data/wish-deno.sqlite" COOKIE_SECURE=false deno task dev
```

Quality checks:

```sh
deno fmt --check
deno lint
deno check src/main.ts tests/*.ts
deno test --allow-net --allow-read --allow-write --allow-env
docker build -t wish-deno:dev .
```

## Releases and supply chain

CI runs formatting, lint, type checks, tests, an image build, and a container readiness
smoke test. A `v*` tag publishes multi-platform images to GHCR with BuildKit provenance
and an SPDX SBOM, adds a GitHub artifact attestation, then creates release notes.

Verify an image attestation with GitHub CLI:

```sh
gh attestation verify \
  oci://ghcr.io/nehoko/wish-deno:1.0.0 \
  --repo Nehoko/wish-deno
```

## Security and license

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md). Wish Deno
is available under the [`MIT License`](LICENSE).
