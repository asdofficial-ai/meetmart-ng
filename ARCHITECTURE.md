# MeetMart NG architecture

## Marketplace mode
Buyer -> listing discovery -> in-app chat -> approved public meetup -> inspect -> pay in person.

## Verified Stores mode
Customer -> verified store -> server-priced cart -> delivery address -> ASD Pay backend -> licensed payment rail -> merchant fulfilment -> delivery.

## Trust boundary
A merchant cannot become a MeetMart Verified Store merely by paying for advertising/subscriptions or by submitting a document number. The backend approval gate requires all configured verification checks to pass.

Current verification checks:
- owner/representative identity
- business/CAC or relevant documents
- MeetMart physical premises inspection
- category-specific licence/product checks where required
- settlement account matching
- MeetMart test order

## Identity boundary
The browser sends NIN/BVN only to the authenticated backend request. The provider adapter uses the raw identifier only in request memory and returns a masked result/reference. The database intentionally has no raw NIN/BVN column.

`demo_verified` is distinct from `verified`. A demo identity can be used to exercise the application workflow, but admin approval requires real/production verification status.

BVN eligibility is server-authoritative. An ordinary marketplace user cannot unlock BVN by sending a client-side role flag. Eligibility begins only after a merchant application exists or the account has a server-issued merchant role.

## Payment boundary
MeetMart creates orders on its backend. Product prices, quantities, merchant eligibility and delivery fees are validated server-side. Browser-provided prices are ignored.

ASD Pay remains an adapter layer. In demo mode the backend can confirm its own pending payment intent for local testing. In production, payment confirmation must come from the real ASD Pay/provider flow and signed webhooks; provider secrets, payment verification, refunds, disputes, settlement and webhook signatures remain backend-only.

Order fulfilment is also backend-owned. Merchants can move paid orders only through allowed transitions: paid -> preparing/cancelled -> out_for_delivery/cancelled -> delivered.

## Data layer
This build uses Node 22 `node:sqlite` for a fully runnable local foundation. Before launch, move the schema to managed Postgres, add formal migrations and backups, and run the API against that managed database.
