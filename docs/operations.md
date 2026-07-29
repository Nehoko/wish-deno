# Operations

## Production checklist

1. Pin a release tag or immutable image digest.
2. Mount a persistent volume at `/data`.
3. Set `COOKIE_SECURE=true`.
4. Publish the app only through a TLS reverse proxy.
5. Preserve `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto`.
6. Add proxy rate limits and request-size limits.
7. Back up `/data` and test restoration.

Image process uses UID/GID `1000`. If a container runtime does not copy image directory
ownership into a new named volume, initialize `/data` ownership once using the command
in the README before starting the service.

## Health

- `GET /health` is a liveness probe.
- `GET /ready` verifies that the process can serve traffic and access its database.

Both endpoints are unauthenticated and return no sensitive data.

## Backup and restore

Stop the container before copying SQLite files. This gives a simple, transactionally
consistent backup:

```sh
docker compose stop wish-deno
docker run --rm \
  -v wish-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine:3.22 \
  tar -C /data -czf /backup/wish-deno-$(date +%F).tgz .
docker compose start wish-deno
```

Restore into an empty volume using the inverse operation, then start the same
application version that produced the backup. Upgrade only after verifying the restored
service.

## Upgrade

```sh
docker compose pull
docker compose up -d
docker compose ps
```

Migrations run at startup and are forward-only. Take a backup first. To roll back across
a schema change, restore the pre-upgrade backup as well as the old image.

## Logs

Container logs go to standard output. Requests are structured and exclude passwords,
session cookies, CSRF values, and reservation cancellation tokens. Configure retention
in the Docker logging driver or your platform.
