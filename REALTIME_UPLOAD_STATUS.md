# Photo Upload + Realtime Stage Status

## Implemented

- Authenticated marketplace image upload endpoint.
- JPEG, PNG and WebP only; SVG is intentionally rejected.
- 5 MB default upload limit, configurable with `MAX_IMAGE_BYTES`.
- Server-side magic-byte validation instead of trusting a filename extension.
- Random server-generated filenames and `X-Content-Type-Options: nosniff` when images are served.
- Upload ownership records in SQLite. A pending upload can only be claimed by the account that uploaded it and only once.
- Listing image URLs returned by the API are usable by the frontend.
- Persistent notifications in SQLite with unread count, mark-one-read and mark-all-read APIs.
- Authenticated Server-Sent Events (`/events`) for live notification/message delivery.
- New-message notifications for the other conversation participant.
- Wanted Request response notifications.
- Meetup proposal/status notifications.
- Marketplace review notifications.
- Bell dropdown with unread badge on desktop and mobile.
- Open chat threads append incoming messages live without a page refresh.

## Tests passed

The API smoke test now proves:

1. A PNG is uploaded to backend storage.
2. The file is served back as `image/png`.
3. The upload is claimed by exactly one listing.
4. A buyer message creates a persistent seller notification.
5. The seller's authenticated SSE stream receives `notification.created` and `message.created` live.
6. Notifications can be marked read.
7. Wanted Request responses create buyer notifications.
8. Existing authentication, merchant KYC gates, checkout, settlement math, orders, city-locking, meetup safety and review tests still pass.

Frontend `App.jsx` and `api.js` were also parsed with TypeScript's JSX/JS parser with zero parse diagnostics.

## Production caveat

The current media provider writes files to `MEETMART_UPLOAD_DIR`. This is a real backend upload flow and is suitable for local development or a host with durable attached storage, but it should **not** be treated as production-durable on an ephemeral filesystem. Before public launch, point media storage at durable object storage or a persistent volume and add lifecycle cleanup for abandoned pending uploads.

SSE is appropriate for the current single API instance. If MeetMart later runs several API instances, realtime fan-out should move to shared infrastructure (for example Redis/pub-sub or a managed realtime service) so events can reach users regardless of which instance they are connected to.
