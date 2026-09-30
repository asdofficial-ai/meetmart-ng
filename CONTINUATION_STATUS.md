# Continuation status — 2026-09-30

This build resumes the backend-foundation work shown in the user's screenshots.

## Completed in this continuation

- BVN eligibility is now server-authoritative via `GET /identity/eligibility`.
- Ordinary marketplace users cannot verify BVN merely by sending a client-side merchant role.
- A merchant application or server-issued merchant role is required before BVN verification is allowed.
- Duplicate active merchant applications are rejected with HTTP 409.
- Smoke tests verify raw NIN/BVN never appears in API responses or persisted identity rows.
- Backend checkout now supports demo payment confirmation for local testing only.
- Customer order history endpoint added.
- Merchant paid-order queue endpoint added.
- Merchant fulfilment transitions are constrained server-side.
- Invalid payment confirmation and invalid fulfilment transitions return HTTP 409.
- API client methods for eligibility, payment confirmation, customer orders and merchant order status were added.

## Passed checks

- `npm run api:test`
- Node syntax checks for backend/provider/API client files
- JSX/JS parser check with TypeScript CLI

## Deliberately still not production-enabled

- NIN/BVN adapter is demo-only until an approved identity provider and credentials are configured.
- ASD Pay payment confirmation is demo-only; production confirmation must come from real payment rails/signed webhooks.
- SQLite is the local runnable database foundation; production should use managed Postgres with migrations/backups.
- Merchant document uploads, object storage/scanning, password reset, OTP and rate limiting still need production implementation.
