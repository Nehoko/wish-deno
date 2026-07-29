# Wish Deno — project plan

## Goal

Self-hosted wish-list web app inspired by Followish: polished public lists, private
owner management, and privacy-preserving gift reservations. Distributed as a versioned
OCI/Docker image through GitHub Container Registry.

## Product scope

### Visitor

- Open public list by stable share slug.
- See event title, date, description, gift image, priority, price, currency, note, and
  store link.
- Search gifts; filter by availability and priority; sort by added date, price, or
  priority.
- Reserve an available gift without account.
- Receive a private cancellation token. Owner never sees reservation identity.
- Cancel own reservation from same browser/token.
- Responsive, accessible UI for phone and desktop.

### Owner

- Register and sign in with email/password.
- Create, edit, publish/unpublish, and delete own wishlists.
- Add, edit, reorder, archive, and delete gift ideas.
- Copy public share URL.
- See reservation state but not visitor secret.
- Sign out and revoke session.

### Operations

- Health and readiness endpoints.
- Persistent SQLite database stored in `/data`.
- Structured request logs without secrets.
- Config through environment variables.
- One non-root, read-only-capable container image.
- CI checks formatting, lint, type safety, unit/integration tests, and container build.
- Tagged releases publish multi-platform images to GHCR with provenance and SBOM.

## Authorization and security

- Passwords: PBKDF2-SHA-256 with per-user 128-bit salt and high iteration count.
- Sessions: opaque 256-bit bearer token; only SHA-256 digest stored; `HttpOnly`,
  `SameSite=Lax`, configurable `Secure` cookie; expiry and explicit revocation.
- CSRF: synchronizer token required on authenticated mutations.
- Object authorization: every owner mutation includes authenticated `owner_id`
  constraint.
- Public IDs: unguessable slugs; unpublished lists return `404`.
- Reservations: atomic claim; random cancellation token stored only as digest.
- Validation: bounded lengths, URL protocol allow-list, normalized email, finite numeric
  prices.
- Headers: CSP, frame denial, MIME sniffing denial, strict referrer policy.
- Basic in-memory auth rate limit. Reverse proxy should add durable rate limiting and
  TLS.

## Stack

- Runtime: Deno 2.9, TypeScript, `Deno.serve`.
- Database: SQLite through Deno's built-in `node:sqlite`; WAL mode and migrations.
- Frontend: semantic HTML, modern CSS, browser-native ES modules.
- Tests: `Deno.test`, temporary SQLite databases, HTTP integration tests.
- Packaging: official Deno Alpine base, OCI labels, non-root runtime.
- Automation: GitHub Actions, Buildx, GHCR, GitHub release notes.

## Work breakdown

1. Domain/database: migrations, typed repositories, atomic reservations.
2. Security/auth: password derivation, sessions, cookies, CSRF, rate limits.
3. HTTP API/server: validation, routes, static assets, errors, health checks.
4. Frontend: auth, dashboard/editor, public list, responsive design.
5. Quality: unit/integration tests, lint/format/type tasks, smoke test.
6. Delivery: Dockerfile, Compose example, CI, release workflow, README.
7. Release: push public repository, tag `v1.0.0`, verify workflow and GHCR image.

## Deferred

- OAuth/social login, transactional email/password reset.
- Collaborative list ownership.
- Server-side product metadata/image scraping.
- Object storage for uploads; v1 accepts HTTPS image URLs.
- Localization UI and email notifications.
