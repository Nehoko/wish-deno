# Security policy

## Supported versions

Security fixes target the newest GitHub release. Upgrade to the latest image before
reporting an issue.

## Report a vulnerability

Do not open a public issue. Use the repository's **Security → Report a vulnerability**
private advisory form. Include:

- affected version or image digest;
- reproducible steps and expected impact;
- relevant logs with tokens, cookies, email addresses, and URLs redacted;
- a suggested fix, if known.

Maintainers should acknowledge a complete report within seven days. Publication and
disclosure timing will be coordinated with the reporter after a fix exists.

## Deployment responsibilities

Wish Deno protects credentials and reservation tokens in the application, but operators
must:

- terminate TLS at a trusted reverse proxy;
- terminate TLS at a trusted reverse proxy and keep `COOKIE_SECURE=true`;
- keep the image updated and pin production deployments to a release or digest;
- back up `/data` and protect both backups and the live volume;
- add durable rate limiting at the proxy;
- never expose application logs, database files, or cancellation URLs.
