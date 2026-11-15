# Credits — model & operations

Lovable-style credit-based subscriptions. Per LLM call, weighted by model.
Client meters every LLM call and spends credits against the caller's wallet; balance resets to the plan allowance on the 1st of each cycle (UTC).

## Weights (see `src/stores/credits.store.ts`)

| Model tier | Credits per call | Detection (substring of model id) |
|---|---|---|
| Economy / fast | 1 | anything not matching below |
| Frontier (ultra / 70B / deepseek-chat / qwen) | 4 | `ultra`, `70b`, `deepseek-chat`, `qwen` |

Override per call with `options.creditWeight` in `callLLM`.

## Plan allowances

| Plan | Monthly credits | Price |
|---|---|---|
| free | 100 | ₹0 |
| pro | 1,000 | ₹1,999/mo (₹1,599 yearly-billed) |
| team | 5,000 | ₹4,999/mo (₹3,999 yearly-billed) |

Numbers live in the `plan_allowances` table (see 002) — change them there, not in code.

## Enforcement points

- `src/agents/llmClient.ts` → `assertCreditsFor()` (pre-check) and `meterLlmCall()` (post-call deduction, fire-and-forget).
- If Supabase / the wallet RPC is down the gate fails open (logged) — never strand a user behind infrastructure; a hard paywall is a product decision, not an accident.
- Purchases flow: Razorpay → `/api/payments/fulfill` (server re-verifies HMAC + re-fetches the order, then calls `record_payment`, which atomically inserts the payment row, activates/renews the subscription and grants credits).
- Webhooks: `RAZORPAY_WEBHOOK_SECRET` env + Razorpay dashboard → `POST {engine}/api/razorpay/webhook` with `payment.captured`.

## Troubleshooting

- "Insufficient credits": the user is on free and the meter deducts — upgrade CTA runs through the pricing buttons.
- Balance resets: `ensure_cycle()` is idempotent and runs on wallet read.
- Check what got deducted: `select * from usage_events order by created_at desc limit 50;`
