# Backend implementation notes

## Main routes

- `GET /health`
- `GET /commerce/config`
- `POST /auth/signup`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/me`
- `POST /identity/verifications`
- `GET /identity/verifications`
- `GET /identity/eligibility`
- `POST /merchant-applications`
- `GET /merchant-applications/me`
- `GET /admin/merchant-applications`
- `POST /admin/merchant-applications/:id/review`
- `GET /merchants`
- `GET /merchants/:id`
- `GET /merchant/me`
- `POST /merchant/products`
- `PATCH /merchant/settings`
- `POST /checkout/create`
- `POST /checkout/:id/demo-confirm` (demo mode only)
- `GET /orders/me`
- `GET /merchant/orders`
- `PATCH /merchant/orders/:id/status`

## Checkout security

The checkout API does not accept browser prices as authoritative. It receives product IDs and quantities, loads the active products from the merchant catalog, loads the delivery fee from the merchant record, and calculates commission/settlement on the server. Demo payment confirmation is server-owned and idempotently refuses orders that are no longer payment-pending. Merchant fulfilment uses explicit server-side status transitions.

## Session security

Sessions use random opaque tokens. Only a SHA-256 hash of each session token is stored in the database. The raw token is sent only in an HttpOnly cookie. Mutation requests are restricted by configured Origin allow-list.

## Next production changes

1. Managed Postgres + migration tooling.
2. Real official identity provider adapter with consent/reference handling.
3. Real ASD Pay provider/rail integration with signed webhooks and idempotency.
4. Object storage for merchant documents and product images with malware/content scanning.
5. Rate limiting, structured security logs and alerting.
6. Email/phone verification and password reset.
