# MeetMart NG

MeetMart NG is a responsive Nigeria-focused marketplace with two deliberately different transaction models:

1. **Local Marketplace** — person-to-person listings, same-city discovery, Wanted Requests, saved items, realtime chat, approved public meetups, and no online payment.
2. **MeetMart Verified Stores** — physically/document-verified merchants with product catalogs, delivery, ASD Pay checkout orchestration, order management, proof-of-delivery controls, refunds/disputes, and settlement accounting.

## Current build: v0.7 production-infrastructure stage

The codebase includes:

- real account/session persistence with scrypt password hashing and HttpOnly cookies
- backend-owned NIN/BVN eligibility and safe verification metadata (demo provider until real credentials/contracts exist)
- merchant applications, admin review, physical/document/test-order gates and emergency suspension
- server-authoritative store pricing, commissions, checkout and order state transitions
- protected delivery-address encryption, one-time audited reveal and re-authentication
- 6-digit proof-of-delivery PIN flow
- persistent refunds/disputes/privacy cases
- person-to-person listings, real image uploads, saved items, Wanted Requests, chats, notifications, meetup records and reviews
- authenticated realtime Server-Sent Events for messages/notifications
- request IDs, security headers and IP rate limiting
- liveness/readiness probes
- production startup configuration validation
- graceful shutdown
- consistent SQLite backup snapshots and retention
- same-origin frontend/API deployment support
- Render persistent-disk blueprint and Dockerfile

## Important staging boundary

The included Render-style production configuration is intended for **single-instance staging and controlled early testing**. SQLite and the persistent-disk upload adapter are now durable across normal service restarts/redeploys when mounted correctly, but they are not the final scale architecture.

Before real customer money is enabled, migrate persistence to managed Postgres, move media to managed object storage/CDN, use an external/shared rate-limit store when scaling beyond one instance, add off-site backups/restore drills, and replace the demo ASD Pay/NIN/BVN adapters with authorized production providers.

`ASD_PAY_MODE=demo` moves no money. `IDENTITY_PROVIDER_MODE=demo` performs no real NIMC/NIBSS/bank verification.

## Development

```bash
npm install
npm run dev
```

Run the API separately:

```bash
npm run api
```

Run the backend regression suite:

```bash
npm run api:test
```

Create a database snapshot:

```bash
npm run api:backup
```

## Production-style deployment

Build the frontend and run one same-origin Node service:

```bash
npm install
npm run build
NODE_ENV=production npm start
```

Use `.env.production.example` as the deployment reference. Real secrets belong only in the deployment secret manager, never in the React frontend or repository.

Health endpoints:

- `GET /health/live`
- `GET /health/ready`
- `GET /health`

See `PRODUCTION_INFRA_STATUS.md` for the exact infrastructure work and remaining go-live requirements.
