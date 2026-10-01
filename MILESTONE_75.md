# MeetMart NG — 75% Beta Milestone

## Definition
This milestone means the product has a working beta core for marketplace trading, verified-store commerce scaffolding, identity/payment adapters, transaction safety, account security, moderation, and staging deployment. It does **not** mean production launch readiness.

## Included by 75%
- Same-city person-to-person marketplace with real backend listings, photos, saved items, Wanted Requests, chat, notifications, public meetup planning, reviews, and listing lifecycle controls.
- Marketplace trust profiles with join date, ratings, completed meetups, listing count, email-verification signal and identity-check state without exposing private identity data.
- User blocking that stops direct contact and cancels pending/confirmed meetups between blocked accounts.
- Private marketplace safety reports and an admin moderation queue with listing removal and account suspension actions.
- Admin management for physically reviewed public meetup venues as MeetMart expands city coverage.
- Verified Stores merchant application/review, catalogs, ASD Pay adapter checkout, delivery orders, refunds/disputes, merchant suspension and settlement calculations.
- Protected delivery address reveal, audit logging and proof-of-delivery PIN.
- NIN/BVN provider boundaries with raw identifiers excluded from stored verification records.
- Account sessions, password reset flow, email-verification groundwork, password changes and multi-session logout.
- Mobile/desktop responsive staging app, health checks, rate limits, backup hooks and CI regression/build checks.

## Final 25% before a real launch
- Replace demo ASD Pay and identity adapters with contracted production providers and signed webhooks.
- Replace staging demo email codes with real transactional email delivery.
- Move database/uploads off ephemeral free-service storage to durable production infrastructure with tested restore procedures.
- Production-grade merchant document storage/scanning, compliance review and retention policies.
- Populate approved meetup venues city-by-city only after physical verification.
- Broader device/browser accessibility QA, performance/code-splitting, observability, legal/privacy documentation and launch operations.
- Final penetration/security review and real-money pilot testing with controlled merchants.

## Safety note
MeetMart verification and safety controls reduce risk; they do not guarantee that a person, listing, merchant or meetup is safe. Production copy must not claim government approval unless the relevant regulator granted that approval.
