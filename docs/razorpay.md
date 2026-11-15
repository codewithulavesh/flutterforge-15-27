# Razorpay Standard Web Checkout

Server-authoritative integration. The browser never sees `RAZORPAY_KEY_SECRET`,
and prices are resolved on the server from `PLAN_PRICES` in `server/razorpay.ts`.

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `RAZORPAY_KEY_ID` | server only (`.env.local`) | Test key id (`rzp_test_…`) |
| `RAZORPAY_KEY_SECRET` | server only (`.env.local`) | Test key secret — never shipped to the browser |
| `VITE_RAZORPAY_KEY_ID` | browser (Vite bundle) | Publishable key for `checkout.js` |

`server/env.ts` loads `.env` + `.env.local` into the server process before any
other import — previously missing keys answered 503 even with the file present.
`.env.local` is git-ignored.

## Endpoints (server, native Node `http`)

- `POST /api/create-order` — body `{ plan: 'pro'|'team', period?: 'monthly'|'yearly' }`
  (or a raw `amount` in paise, floor 100). Returns `{ order_id, amount, currency }`.
- `POST /api/verify-payment` — body `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`.
  HMAC-SHA256 over `order_id|payment_id` with the secret, hex compare with
  `crypto.timingSafeEqual`. Signature mismatch → `400`, payment **not** marked paid.

## Frontend

`src/lib/razorpay.ts` — lazy-loads `checkout.js`, calls `/api/create-order`, opens
the modal, verifies at `/api/verify-payment`. Used by `src/components/blocks/pricing.tsx`
(Pro ₹1,999/mo · ₹1,599 yearly billed; Team ₹4,999/mo · ₹3,999 yearly billed).

## Testing manually

1. `npm run server` then `npm run dev` (or use the Vite proxy).
2. Open the landing page, Pricing → **Choose Pro**.
3. Pay with Razorpay's test card: `4111 1111 1111 1111`, any expiry/CVV/OTP 411111.
4. Checkout returns to your account on payment.success; the app verifies and
   shows the payment id banner.

Until plan entitlements are wired server-side, a successful payment does not
auto-upgrade the account — it only proves the commerce flow.

## Not included (deliberately)

- No database tables / subscription state — plan entitlement unlock is a separate feature.
- No rate limiting on payment endpoints (localhost-trusted engine); add a limiter before any hosted exposure.
- Disputes, refunds, captured-payment webhooks (`payment.captured` / `order.paid`) — add when entitlements land.
