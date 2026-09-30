# Current implementation notes

The earlier code audit fixes remain in place: route-safe product lookup, guarded browser storage, empty-cart handling, duplicate demo payment protection, expiring boosts and safer image/object URL handling.

The Verified Stores expansion adds a hard checkout gate (`verification.status === "verified"`), generic merchant settlement naming, merchant-order storage, legacy Food route redirects and a merchant verification application flow.


The identity-verification expansion adds an Identity Center, role-specific NIN/BVN rules, merchant identity gating, safe masked verification records, and a backend-provider boundary that avoids storing raw NIN/BVN in browser persistence. The visible verification action is explicitly demo-only until a licensed/official provider is connected server-side.
