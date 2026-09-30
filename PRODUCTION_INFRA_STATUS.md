# MeetMart NG — Production Infrastructure Stage

## Implemented

- Same-origin production deployment: one Node service serves both the Vite frontend and API.
- Production config validation blocks startup when delivery secrets are missing/weak or persistent storage is not configured.
- Render persistent-disk layout for SQLite, uploads, and database snapshots.
- Durable-upload storage adapter boundary (`local` for development, `persistent_disk` for single-instance staging).
- Health endpoints:
  - `/health/live` — process liveness
  - `/health/ready` — database, storage, and runtime configuration readiness
- Security headers: HSTS in production, CSP, nosniff, frame denial, referrer policy, permissions policy.
- Per-IP in-memory rate limits with stricter limits for auth, identity, address reveal, delivery PIN, disputes/refunds, and admin routes.
- Request IDs in responses/errors and slow-request logging.
- Graceful SIGTERM/SIGINT shutdown including active event-stream clients.
- SQLite WAL + busy timeout configuration.
- Automatic consistent SQLite snapshots using `VACUUM INTO`, with retention cleanup.
- Manual `npm run api:backup` command.
- `render.yaml`, `Dockerfile`, `.dockerignore`, and production environment template.
- Production frontend defaults to relative/same-origin API instead of localhost.

## Deliberate staging boundary

The current production template can support **controlled staging / early single-instance testing** using a Render persistent disk. It is not the final architecture for holding real customer money at scale.

Before live financial transactions:

1. Replace demo ASD Pay and identity providers with contracted/authorized providers.
2. Migrate SQLite to managed Postgres with formal migrations, connection pooling, and point-in-time backups.
3. Move product media from a single-service disk to managed object storage/CDN.
4. Add an external/shared rate-limit store before horizontal scaling.
5. Add off-site backups; snapshots on the same persistent disk are only the first recovery layer.
6. Add centralized error/metrics monitoring and alerting.
7. Run security/privacy review and disaster-recovery restore tests.

## Secret warning

`DELIVERY_ADDRESS_SECRET` encrypts delivery addresses. Losing or changing it without a migration can make existing encrypted addresses unreadable. Back it up securely in the deployment secret manager and restrict access.

## Validation performed in this stage

- Existing end-to-end API smoke suite: **passed** after infrastructure changes.
- Node syntax checks for server/config/infrastructure modules: **passed**.
- Consistent database backup creation: **passed** using an isolated temporary database.
- Production startup with weak secrets: **correctly blocked**.
- `npm install`/Vite production bundle: **not completed in the build environment because package download timed out**. This is an environment/network limitation, not a detected source-code failure. Run the production build in CI/Render where package installation is available before deployment.
