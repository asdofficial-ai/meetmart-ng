# MeetMart NG — Transaction Safety Stage

Version: 0.6.0

This stage adds the safety controls required before Verified Store delivery orders can be treated like real commerce rather than a simple demo checkout.

## Implemented

### Protected delivery addresses
- Delivery addresses are encrypted at rest with AES-256-GCM.
- The normal merchant order API never returns the full address.
- A merchant can reveal the address only when an order is `preparing` or `out_for_delivery`.
- Reveal requires the merchant to re-enter the correct MeetMart password.
- Reveal is one-time only for that order.
- Every successful reveal writes a separate audit record containing order, merchant user, access time, IP metadata and user-agent metadata.
- The admin audit screen deliberately does not display the customer address itself.
- Address reveal is blocked while the store is suspended or while an order case is active.

### Proof of delivery
- A cryptographically random 6-digit delivery PIN is generated when payment is confirmed.
- Only an HMAC-protected PIN hash and the last two digits are stored.
- The full PIN is returned to the customer when generated/reset, not persisted in plaintext.
- Customers can reset the PIN while an active paid delivery is in progress.
- Merchants cannot directly set an order to `delivered`.
- Completion requires the correct customer PIN and only works from `out_for_delivery`.
- An active dispute/case pauses delivery completion.

### Refunds, cancellations and disputes
- Unpaid `payment_pending` orders can be cancelled directly.
- Paid customer cancellations become refund-review cases instead of silently cancelling captured money.
- Merchants can request cancellation only before dispatch; this opens a refund case and pauses fulfilment.
- Customers can request refunds before dispatch.
- Customers can open general disputes and dedicated address-misuse reports.
- Open cases are visible to admins and are persistent in the database.
- In ASD Pay demo mode, admin refund approval uses the demo refund adapter and marks the order `refunded`.
- In production mode, refunds remain blocked until the real ASD Pay refund provider is configured.

### Merchant emergency suspension
- Admin can suspend a merchant immediately.
- Suspension disables new checkout and protected-address access.
- Suspended stores disappear from the public Verified Stores checkout list.
- Existing active-order customers receive a warning not to share their delivery PIN while the store is paused.
- Admin can restore a previously approved merchant after review.

### UI added
- Customer order controls for PIN reset, refund request, dispute, and address-misuse report.
- Merchant dashboard protected-address reveal and PIN-based completion.
- Merchant suspension state and reason.
- Admin merchant kill switch.
- Admin refund/dispute/privacy case review.
- Admin delivery-address access audit trail.

## Automated checks

`npm run api:test` passes and covers:
- encrypted delivery address storage
- address not exposed through merchant order list
- failed re-authentication does not reveal address
- one successful reveal only
- address reveal audit log
- delivery PIN not stored in plaintext
- incorrect PIN rejected
- direct delivered transition rejected
- active dispute pauses completion
- admin case resolution re-enables completion
- refund case + demo refund approval
- merchant suspension disables checkout
- merchant restoration
- earlier identity, merchant, marketplace, image upload, realtime chat, meetup and review checks

`tsc --allowJs --jsx react-jsx --noEmit ...` also passes for the updated frontend/API files.

## Production notes

- Set separate high-entropy `DELIVERY_PIN_SECRET` and `DELIVERY_ADDRESS_SECRET` values through a secret manager. Do not commit them.
- The current ASD Pay adapter remains demo-only. Real refunds and settlements must be implemented against the production ASD Pay/payment-provider backend.
- IP address metadata is useful for audits but must not be treated as proof of identity; production deployments should trust forwarded IP headers only from a configured reverse proxy.
- One-time address reveal reduces exposure but cannot prevent screenshots or manual copying. Operational policy, merchant agreements, access logging and enforcement remain necessary.
- Marketplace photo storage still needs durable object storage/persistent disk before production deployment.
- A full Vite production bundle was not run in this environment because the Vite dependency is not installed here. Backend tests and TypeScript/JSX parsing passed.
