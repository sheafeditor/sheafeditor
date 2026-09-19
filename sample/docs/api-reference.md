---
title: Ferry API — v2 Reference
version: 2.4.0
audience: integrators
---

# Ferry API — v2 Reference

Reference documentation for the (fictional) Ferry scheduling API. Dense with tables, inline code, and short code blocks — the shape most technical documentation actually takes.

**Base URL:** `https://api.ferry.invalid/v2`
**Content type:** `application/json; charset=utf-8`
**Rate limit:** 600 requests/minute per token, burst 60

---

## Authentication

Every request carries a bearer token:

```http
GET /v2/sailings?route=NW-14 HTTP/1.1
Host: api.ferry.invalid
Authorization: Bearer sk_test_00000000000000000000
Accept: application/json
```

Tokens are scoped. A token missing the required scope gets `403`, never `404` — the API does not hide the existence of a resource behind a permissions error.

| Scope | Grants | Notes |
| :--- | :--- | :--- |
| `sailings:read` | `GET /sailings`, `GET /sailings/{id}` | Default for new tokens |
| `sailings:write` | `POST`, `PATCH`, `DELETE` on sailings | Requires an approved application |
| `bookings:read` | `GET /bookings` | Returns only bookings the token's account owns |
| `bookings:write` | Create and cancel bookings | Idempotency key required |
| `webhooks:admin` | Manage webhook endpoints | One endpoint per environment |

---

## Endpoints

### `GET /sailings`

Lists scheduled sailings, newest departure first.

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :---: | :--- | :--- |
| `route` | string | yes | — | Route code, e.g. `NW-14` |
| `from` | date-time | no | now | ISO 8601. Sailings departing at or after this instant |
| `to` | date-time | no | `from` + 7d | Must be within 90 days of `from` |
| `status` | enum | no | `scheduled` | One of `scheduled`, `boarding`, `departed`, `cancelled` |
| `vessel_id` | string | no | — | Restrict to a single vessel |
| `limit` | integer | no | `50` | 1–200 |
| `cursor` | string | no | — | Opaque; from `page.next` |

**Response `200`**

```json
{
  "data": [
    {
      "id": "sail_4Kd92Lm",
      "route": "NW-14",
      "vessel_id": "ves_81",
      "departs_at": "2044-06-11T07:20:00Z",
      "arrives_at": "2044-06-11T09:05:00Z",
      "status": "scheduled",
      "capacity": { "passengers": 480, "vehicles": 96, "sold": 411 }
    }
  ],
  "page": { "next": "c3Vy...", "has_more": true }
}
```

### `POST /bookings`

Creates a booking. Supply `Idempotency-Key`; replaying the same key within 24 hours returns the original response rather than creating a second booking.

```bash
curl -X POST https://api.ferry.invalid/v2/bookings \
  -H "Authorization: Bearer $FERRY_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
        "sailing_id": "sail_4Kd92Lm",
        "passengers": 2,
        "vehicle": { "length_m": 4.6, "height_m": 2.1 },
        "contact": { "email": "traveller@example.com" }
      }'
```

**Response `201`**

```json
{
  "id": "bkg_9Zx01Qa",
  "sailing_id": "sail_4Kd92Lm",
  "state": "confirmed",
  "total": { "amount": 14250, "currency": "NOK" },
  "created_at": "2044-05-02T13:44:09Z"
}
```

### `DELETE /bookings/{id}`

Cancels a booking. Cancellation inside the sailing's cutoff window returns `409` with `code: "past_cutoff"` — refund eligibility is a billing concern and is not decided here.

---

## Errors

All errors share one envelope:

```json
{
  "error": {
    "code": "invalid_parameter",
    "message": "`to` must be within 90 days of `from`.",
    "param": "to",
    "request_id": "req_2c8f10ab"
  }
}
```

| HTTP | `code` | When | Retry? |
| ---: | :--- | :--- | :---: |
| 400 | `invalid_parameter` | Malformed or out-of-range input | No |
| 401 | `unauthenticated` | Missing or expired token | No |
| 403 | `insufficient_scope` | Token lacks the scope | No |
| 404 | `not_found` | No such resource for this account | No |
| 409 | `conflict` | State changed under you; `past_cutoff`, `sold_out` | Sometimes |
| 422 | `unprocessable` | Syntactically valid, semantically impossible | No |
| 429 | `rate_limited` | Over the per-minute limit | Yes, after `Retry-After` |
| 500 | `internal_error` | Our fault | Yes, with backoff |
| 503 | `unavailable` | Planned maintenance or overload | Yes, with backoff |

Always log `request_id`. It is the only thing support can search on.

---

## Webhooks

Events are delivered as `POST` with an `Ferry-Signature` header. Verify before trusting the body:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody: string, header: string, secret: string): boolean {
  const [tsPart, sigPart] = header.split(',');
  const timestamp = tsPart.slice(2);
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sigPart.slice(3));
  return a.length === b.length && timingSafeEqual(a, b);
}
```

| Event | Fires when | Delivery |
| :--- | :--- | :--- |
| `sailing.cancelled` | A sailing is cancelled by operations | At least once |
| `sailing.delayed` | Departure moves by more than 10 minutes | At least once |
| `booking.confirmed` | Payment settles | At least once |
| `booking.cancelled` | Traveller or operator cancels | At least once |

Endpoints must answer within 5 seconds. Anything else is a failure and is retried with exponential backoff for 24 hours.

---

## Versioning and deprecation

- v2 is current. v1 is frozen and shuts off **2045-01-31**.
- Additive changes (new fields, new enum members) ship without notice. Parse defensively.
- Removals get 180 days' notice and a `Sunset` header on every affected response.

> **Note**
> Enum members are the usual source of breakage. Treat an unrecognised `status` as "something new happened", not as an error.

## Changelog

- **2.4.0** — `capacity.sold` added to sailings.
- **2.3.1** — `429` now always carries `Retry-After`.
- **2.3.0** — Cursor pagination replaces `offset` (removed in 3.0).
- **2.2.0** — `booking.cancelled` webhook.
