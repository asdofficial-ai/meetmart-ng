# Frontend ↔ Backend Integration Status

## Completed in this milestone

The Verified Stores commerce flow no longer reads merchant, product or order records from the old frontend demo store array.

- `/stores` loads checkout-enabled verified merchants from `GET /merchants`.
- `/stores/:id` loads the merchant catalog from `GET /merchants/:id`.
- `/stores/checkout` creates the authoritative order through `POST /checkout/create` and confirms demo ASD Pay through the backend demo-confirm route.
- `/stores/orders` loads the signed-in customer's orders from `GET /orders/me`.
- `/store-dashboard` loads the authenticated merchant, products and order queue from backend APIs; merchants can create products, change delivery fees and perform valid fulfilment transitions.
- `/stores/apply` loads and submits real merchant applications.
- `/admin` loads the merchant application queue from the backend and sends review decisions through the admin API.

## Trust boundaries

- Client-submitted product prices and delivery fees are not authoritative.
- ASD Pay settlement values are calculated on the server during checkout.
- Merchant checkout is possible only for server-approved, checkout-enabled merchants.
- BVN eligibility is determined server-side.
- Raw NIN/BVN values are not persisted in normal application records.
- Demo identity status is intentionally insufficient for production merchant approval.

## Still intentionally demo / pending

- ASD Pay uses the demo provider adapter; no real money moves.
- NIN/BVN uses a demo provider adapter until official provider credentials and agreements exist.
- General person-to-person marketplace listings, chat, wanted requests and moderation examples are still UI-demo data and are outside this commerce-integration milestone.
- Product image upload/storage is not yet implemented for merchant catalog products.

## Checks

- Backend smoke test passes, including merchant approval, public merchant APIs, merchant-self API, server-authoritative checkout, duplicate payment rejection, customer order history and fulfilment transition rules.
- `tsc` parsed the JSX/JavaScript integration files with no syntax diagnostics.
- Full Vite production build was not completed because `npm install` timed out in this execution environment.
