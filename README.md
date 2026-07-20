# House Lights

House Lights is a dashboard-first session and availability watcher for IMAX Melbourne. It serves the dashboard, API, scheduler, in-memory state, and optional email delivery from one Node 22 process and one container. It has no database or companion service.

The supported film IDs are `HO00000546` and `HO00000547`. `FILM_IDS` can select either or both, but other IDs fail startup validation. All session times and alert filters are interpreted in `Australia/Melbourne`.

## Live Session And Seat Boundary

The default provider makes one bounded, non-redirecting request per polling interval to IMAX Melbourne's public unchallenged HTML session listing at `https://prod.imaxmelbourne.com.au/html/movie_sessions/`. Every 3xx response is rejected without following `Location`. It parses only the exact Odyssey 4K Laser and IMAX 70mm section slugs and titles. A booking link is retained only when it is exactly an HTTPS `web.imaxmelbourne.com.au/order/showtimes/IMAX-{number}/seats` URL without credentials, query, or fragment; all other links and source IDs are dropped.

Rows J-M use Vista's official queue-free, read-only Lumos preview flow. For upcoming sessions with a proven `IMAX-xxxxx` source ID, House Lights loads one configured direct public film page, reads its short-lived guest `CXM_JourneyViewer` token and CMS API URL from `script#__NEXT_DATA__`, discovers the tenant Digital API from the CMS web configuration, and calls only:

- `GET /ocapi/v1/showtimes/{showtimeId}/seat-layout`
- `GET /ocapi/v1/showtimes/{showtimeId}/seat-availability?preview=true`

The discovered CMS and Digital API URLs must be allowed HTTPS hosts with a root base path and no credentials, query, or fragment. Before every API request, the provider revalidates the complete URL as exactly the CMS configuration path, the seat-layout path, or the seat-availability path with only `preview=true`. The provider never creates an order, selects tickets or seats, starts guest checkout, uses Queue-it, or accepts a static bearer token. If Cloudflare blocks any part of the direct read-only flow, a bounded Scrapling browser fallback runs the film bootstrap, CMS discovery, and selected seat previews in one browser context, optionally through `CF_ACQUIRE_PROXY`; this preserves one network and TLS identity without requiring `cf_clearance`. Browser requests are restricted to public addresses on the configured Lumos host allowlist plus Cloudflare's challenge host. The discovered guest token is used only inside that browser session and is never logged, persisted, or returned by the API. Layouts are cached in memory per showtime; availability is refreshed at the normal low-frequency poll interval with bounded concurrency and a per-pass session budget. Session attempts, including failures, rotate least-recently-attempted first so a failing early session cannot monopolize that budget.

Only standard seats in Rows J-M are normalized; Vista seats typed `Wheelchair` or `Companion` are excluded from availability counts and alerts. Numeric physical seat labels are authoritative. When a seat has a non-numeric label, the deterministic fallback is its zero-based Vista `position.columnIndex` plus one, or its one-based position in that layout row when no column index exists. Duplicate IDs or row-number collisions fail that session rather than publishing a corrupted map. `Available` maps to available, `Sold` to sold, and `Broken`, `House`, or a missing availability entry to held/unknown.

Cloudflare can still block the read-only Lumos flow from a server IP. On a 403 or 429 from the bootstrap, CMS configuration, layout, or availability endpoint, the provider makes one bounded Scrapling batch attempt for the selected sessions. If that fallback also fails, the result is reported as blocked and receives exponential cooldown with jitter, honoring any upstream `Retry-After` hint. If blocks persist continuously for `LUMOS_PREVIEW_PARK_AFTER_MS` (default 48 hours), exact preview parking stops probing for `LUMOS_PREVIEW_PARK_DURATION_MS` (default 12 hours) at a time — one probe per park window — and the dashboard reports `J-M PARKED`. Session discovery remains healthy, last-known exact seats are preserved, other sessions continue after an isolated malformed response, and signed manual ingest remains available. Exact seats are bound to the Vista source showtime ID: a changed source starts a new no-alert baseline, while a missing source retains the prior map only as explicitly last-known until the same source is captured again. Listing-level `filling` never becomes a seat count and a failed exact preview never implies availability.

## Ephemeral State

All sessions, baselines, subscriptions, confirmation tokens, transitions, pending email outbox entries, and dedupe keys live only in process memory. Every restart, crash, or Railway redeploy clears them. Subscribers must opt in again after a reset. This is intentional for the initial single-container deployment.

## Local Use

Requires Node.js 22 and npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

The dashboard and API listen on `http://localhost:3000` by default. The dev and start scripts load `.env` when it exists.

Run the quality gates with:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port supplied by the host. |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` outside production email | Origin-only URL used in confirmation, manage, and unsubscribe links; production email requires a public HTTPS origin. |
| `FILM_IDS` | both supported IDs | Comma-separated subset of `HO00000546,HO00000547`. |
| `INGEST_TOKEN` | unset | Bearer token for `POST /api/ingest`; the route returns `503` when unset. |
| `POLL_INTERVAL_MS` | `900000` | Scheduler tick interval. |
| `POLL_COOLDOWN_MS` | `900000` | Minimum successful-poll cooldown and initial error backoff. |
| `PROVIDER_TIMEOUT_MS` | `30000` | Public listing request deadline. |
| `LUMOS_FILM_URL` | 70mm film page | Direct public Lumos film page used for tenant bootstrap. |
| `CF_ACQUIRE_PROXY` | unset | Optional HTTP proxy URL (`http://user:pass@host:port`) used by the protected Scrapling preview fallback. |
| `LUMOS_PREVIEW_CONCURRENCY` | `2` | Maximum concurrent showtime preview workers, from 1 through 8. |
| `LUMOS_PREVIEW_SESSION_BUDGET` | `12` | Maximum upcoming linked sessions previewed per polling pass. |
| `LUMOS_PREVIEW_COOLDOWN_MS` | `900000` | Minimum exact-preview cooldown and initial blocked/error backoff. |
| `LUMOS_PREVIEW_TIMEOUT_MS` | `60000` | Whole exact-preview pass deadline, including a protected browser batch. |
| `LUMOS_PREVIEW_PARK_AFTER_MS` | `172800000` | Continuous upstream-block duration after which exact preview parks instead of backing off further. Set very high to disable parking. |
| `LUMOS_PREVIEW_PARK_DURATION_MS` | `43200000` | How long one park window lasts; a single probe is allowed when each window expires. |
| `LUMOS_ALLOWED_HOSTS` | unset | Optional comma-separated HTTPS host suffixes added to the built-in IMAX Melbourne and Vista allowlist. |
| `RESEND_API_KEY` | unset | Resend API key. |
| `ALERT_FROM` | unset | Verified Resend sender, for example `House Lights <alerts@example.com>`. |
| `EMAIL_DELIVERY_TIMEOUT_MS` | `30000` | Scheduler deadline for one outbox delivery batch. |
| `OUTBOX_BATCH_SIZE` | `25` | Maximum pending alert emails attempted per scheduler pass, from 1 through 100. |
| `CONFIRMATION_COOLDOWN_MS` | `900000` | Minimum interval before an unverified exact subscription can receive a replacement confirmation. |
| `PENDING_SUBSCRIPTIONS_PER_EMAIL` | `3` | Maximum active, unverified filter variants for one normalized email address. |
| `TRUST_PROXY` | `false` | Accept `X-Real-IP` for subscription rate limiting only when exactly `true` in production behind a trusted proxy such as Railway. `X-Forwarded-For` is never trusted. |
| `DEV_SAMPLE_DATA` | `false` | Seeds prominently labeled sample data only when exactly `true` and `NODE_ENV` is not `production`. |

Resend is optional. Missing or partial Resend configuration keeps the process healthy, disables subscriptions, and returns `email_not_configured`. When both Resend variables are set in production, startup fails unless `PUBLIC_BASE_URL` is a public HTTPS origin with no path, query, or fragment. Alert and confirmation sends use stable idempotency keys. Successful IDs in a partial batch are acknowledged; timed-out, failed, and not-yet-attempted IDs remain in the rotating in-memory outbox for a later pass, but are still lost on process restart. Repeating an exact pending subscription during its cooldown neither rotates its token nor extends expiry nor sends another email. Pending filter variants are capped per normalized recipient.

With `TRUST_PROXY=false`, rate limiting uses the direct connection address and falls back to one shared key when the runtime cannot provide it; forwarded headers cannot split that key. Set `TRUST_PROXY=true` only in production when the immediate proxy overwrites `X-Real-IP`. Railway documents that header for the original client address. Do not enable this mode for a directly exposed container.

## HTTP API

- `GET /health`: process health plus listing-discovery, Lumos-bootstrap, exact-seat-capture, and email state.
- `GET /api/status`: separate public-listing, Lumos-bootstrap, and exact-seat capture state/freshness, plus a bounded newest-first history of the 50 most recent per-stage status changes.
- `GET /api/sessions`: live session metadata plus explicit listing and exact-seat capture state for each session.
- `POST /api/subscriptions`: strict email and alert-filter validation with in-memory per-IP rate limiting and 24-hour double opt-in.
- `POST /api/ingest`: strict manual observation ingest protected by `Authorization: Bearer $INGEST_TOKEN`.
- `GET /confirm`: non-mutating confirmation page; `POST /confirm` activates the subscription.
- `GET /unsubscribe`: non-mutating unsubscribe confirmation page.
- `POST /unsubscribe`: tokenized unsubscribe mutation, including one-click email client requests.

Confirmation, manage, and unsubscribe responses use `Referrer-Policy: no-referrer` and `Cache-Control: no-store` so token URLs are not cached or sent as referrers.

Subscription filters support selected film IDs, `all|70mm|laser`, Melbourne weekdays, preset or custom Melbourne-local time, minimum seats from 1 through 6, and optional adjacency. Session discovery never establishes a seat baseline. The first exact Lumos preview or manual snapshot establishes the baseline without alerting; only a later exact `sold|held` to `available` transition observed by the live Lumos preview can trigger a verified matching subscription. Manual and sample snapshots update the dashboard but never emit transitions or alert email, so operator-supplied or fixture data cannot notify subscribers by accident.

## Manual Ingest

Send one normalized exact-seat observation event. Every session needs at least one seat, every seat must be in Rows J-M, session and seat identities must be unique within the event, and booking URLs must use HTTPS. Film `HO00000546` must use `laser`; `HO00000547` must use `70mm`. `listing` and `seatData` are server-managed when omitted from manual payloads.

```sh
curl --request POST http://localhost:3000/api/ingest \
  --header "Authorization: Bearer $INGEST_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "eventId": "authorized-capture-20260719-1",
    "sessions": [{
      "id": "session-1",
      "filmId": "HO00000546",
      "title": "Provider supplied title",
      "startsAt": "2026-07-19T09:00:00.000Z",
      "format": "laser",
      "bookingUrl": "https://imaxmelbourne.com.au/",
      "seats": [
        { "row": "J", "number": 10, "status": "sold" },
        { "row": "J", "number": 11, "status": "available" }
      ]
    }]
  }'
```

Reusing an `eventId` is idempotent. Lumos preview and manual exact-seat updates share the same baseline and diff pipeline, and a manual ingest drains any pending alert outbox; manual snapshots themselves never create alert deliveries. Public listing discovery only refreshes session metadata and preserves captured seats.

## Sample Data

Set `DEV_SAMPLE_DATA=true` only for local dashboard evaluation. The process logs a warning, disables the live listing scheduler so sample and live sessions cannot mix, and `/api/status` reports `sampleData: true`. The flag is ignored when `NODE_ENV=production`, including the Docker image.

## Later Railway Deployment

`Dockerfile` and `railway.json` define one Dockerfile-built service with `/health` deployment checks. No Railway project, database, or service has been provisioned by this repository.

When ready to deploy later:

1. Create one Railway service from this repository.
2. Configure `INGEST_TOKEN` and `PUBLIC_BASE_URL`; add both Resend variables only when email is ready.
3. Leave `DEV_SAMPLE_DATA` unset or `false` in production.
4. Deploy and verify `/health`, `/api/status`, and freshness before describing the dashboard as live.

Railway supplies `PORT`. The image runs as the non-root `node` user and starts the built Hono server directly.
