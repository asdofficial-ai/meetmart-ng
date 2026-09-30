# MeetMart API

The backend uses Node 22 built-in `node:sqlite`, server-side sessions, HTTP/SSE endpoints, encrypted delivery-address storage, audit events, notifications, marketplace/store persistence and provider adapters.

## Development

```bash
npm run api
npm run api:test
```

## Production/staging mode

The current infrastructure supports a **single-instance durable staging deployment** when the database, uploads and backups are placed on a persistent disk. The API can serve the Vite `dist/` directory directly so browser sessions remain same-origin.

Required production safeguards are checked at startup, including strong, different delivery-PIN and delivery-address secrets and persistent storage mode. `/health/ready` checks database access, writable storage, runtime configuration and the frontend build when frontend serving is enabled.

### Provider boundary

- `IDENTITY_PROVIDER_MODE=demo` is not NIMC/NIBSS/bank verification.
- `ASD_PAY_MODE=demo` does not move money.
- Set `ALLOW_DEMO_PROVIDERS=true` only for staging/controlled testing.

Before real money and larger scale, migrate to managed Postgres and managed object storage, add shared rate limiting/off-site backups, and connect authorized production identity/payment providers.

### Backups

`npm run api:backup` creates a consistent SQLite snapshot with `VACUUM INTO`. Scheduled snapshots can be enabled with `BACKUP_ENABLED=true`. Same-disk snapshots are useful for local corruption/operator recovery but are not a replacement for off-site backups.
