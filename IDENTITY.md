# MeetMart identity verification design

## Account rules
- Ordinary marketplace account: NIN optional; BVN not required.
- Verified Store applicant: owner/representative NIN required.
- Merchant financial/settlement onboarding: BVN only when applicable to the regulated/payment-partner flow.
- Passing an identity check does not by itself grant the MeetMart Verified Store badge.

## Privacy boundary
The frontend must never put raw NIN/BVN values in URLs, analytics, logs, localStorage, sessionStorage, crash reports, or merchant/profile objects. The demo form holds the identifier only in temporary component memory, then stores only masked digits, status, timestamp, provider/mode, name-match boolean, and a verification reference.

## Production backend contract
Recommended endpoints:

- `POST /api/identity/nin/start`
- `POST /api/identity/bvn/start`
- `GET /api/identity/verifications/:reference`
- `POST /api/merchant-applications`
- `POST /api/merchant-applications/:id/identity-link`

The browser sends the identifier only over TLS to the MeetMart/ASD Pay backend after explicit consent. The backend calls the approved identity-provider integration, strips unnecessary sensitive fields, stores the minimum auditable result, and returns a safe verification record to the frontend.

## Merchant approval gate
Merchant activation remains dependent on all required controls: identity, business documents, physical inspection, category/licence checks when applicable, settlement-account match, and a MeetMart test order. Subscription purchases and advertising cannot bypass these controls.

## Current status
The current implementation is a demo adapter only. It validates input shape and produces demo verification references. It does not contact NIMC, NIBSS, a bank, or a government identity database.
