/**
 * Razorpay Standard Checkout — order creation and payment verification.
 *
 * Security notes:
 * - KEY_ID goes to the browser (it's the public key); KEY_SECRET never does.
 * - The amount is resolved on the SERVER from a plan table — client-supplied
 *   prices are never trusted. A raw `amount` in paise is accepted only with
 *   the same 100-paise floor enforced by the API.
 * - On signature mismatch the payment is rejected and NOT marked paid.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

export function isRazorpayConfigured(): boolean {
  return Boolean(KEY_ID && KEY_SECRET);
}

/** Server-authoritative price table, in paise. Monthly / yearly-billed price. */
const PLAN_PRICES: Record<string, { monthly: number; yearly: number; label: string }> = {
  pro: { monthly: 199900, yearly: 159900, label: 'FlutterForge Pro' },   // ₹1,999 /mo · ₹1,599 yrly
  team: { monthly: 499900, yearly: 399900, label: 'FlutterForge Team' }, // ₹4,999 /mo · ₹3,999 yrly
};

export interface CreateOrderInput {
  plan?: string;
  period?: string;
  amount?: number;
  currency?: string;
  receipt?: string;
  userId?: string;
}

export interface OrderResult {
  statusCode: number;
  body: Record<string, unknown>;
}

export async function createOrder(input: CreateOrderInput): Promise<OrderResult> {
  if (!isRazorpayConfigured()) {
    return {
      statusCode: 503,
      body: { error: 'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.local.' },
    };
  }

  // Resolve server-side pricing — never the client's claim about the price.
  let amount: number | null = null;
  let currency = 'INR';
  const plan = (input.plan || '').toLowerCase();
  const period = (input.period || 'monthly').toLowerCase() === 'yearly' ? 'yearly' : 'monthly';

  if (plan) {
    const entry = PLAN_PRICES[plan];
    if (!entry) {
      return { statusCode: 400, body: { error: `Unknown plan '${plan}'. Expected 'pro' or 'team'.` } };
    }
    amount = entry[period];
  } else if (typeof input.amount === 'number' && Number.isFinite(input.amount)) {
    amount = Math.round(input.amount);
    currency = (input.currency || 'INR').toUpperCase();
  }

  if (amount === null) {
    return { statusCode: 400, body: { error: "Provide a plan ('pro'|'team' with optional period) or an amount in paise." } };
  }
  if (amount < 100) {
    return { statusCode: 400, body: { error: 'Minimum amount is 100 paise (₹1).' } };
  }

  const receipt = (input.receipt || `rcpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`)
    .slice(0, 40);

  try {
    const razorpay = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt,
      payment_capture: 1,
      notes: {
        plan: plan || 'custom',
        period,
        user_id: input.userId?.slice(0, 64) || '',
      },
    } as never);

    return {
      statusCode: 200,
      body: {
        order_id: (order as { id: string }).id,
        amount: (order as { amount: number }).amount,
        currency: (order as { currency: string }).currency,
        plan: plan || null,
        period,
      },
    };
  } catch (error) {
    const status = Number((error as { statusCode?: number; status_code?: number })?.statusCode
      ?? (error as { status_code?: number })?.status_code
      ?? 0);
    const description = String(
      (error as { error?: { description?: string }; message?: string })?.error?.description
        ?? (error as { message?: string })?.message
        ?? '',
    );
    console.error('[razorpay] create order failed:', status, description);

    if (status === 401) {
      return { statusCode: 401, body: { error: 'Razorpay authentication failed. Check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.' } };
    }
    return { statusCode: 500, body: { error: `Could not create Razorpay order${description ? `: ${description}` : '.'}` } };
  }
}

export function verifyPayment(input: {
  razorpay_order_id?: string;
  razorpay_payment_id?: string;
  razorpay_signature?: string;
}): OrderResult {
  if (!input.razorpay_order_id || !input.razorpay_payment_id || !input.razorpay_signature) {
    return {
      statusCode: 400,
      body: {
        success: false,
        error: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are all required.',
      },
    };
  }

  if (!isRazorpayConfigured()) {
    return { statusCode: 503, body: { success: false, error: 'Razorpay is not configured on this deployment.' } };
  }

  // Razorpay signs `${order_id}|${payment_id}` with HMAC-SHA256(secret), hex digest.
  const expected = createHmac('sha256', KEY_SECRET)
    .update(`${input.razorpay_order_id}|${input.razorpay_payment_id}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(String(input.razorpay_signature), 'utf8');
  const match = expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);

  if (!match) {
    return {
      statusCode: 400,
      body: { success: false, error: 'Signature verification failed — payment was NOT marked as paid.' },
    };
  }

  return { statusCode: 200, body: { success: true, payment_id: input.razorpay_payment_id } };
}

/* ─────────────────────────────────────────────────────────────
   Fulfillment + webhook — grant plan credits, server-side only
   ───────────────────────────────────────────────────────────── */

async function fetchRazorpayOrder(orderId: string): Promise<{ ok: true; order: { id: string; status: string; notes?: Record<string, string> } } | { ok: false; error: string }> {
  const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
  try {
    const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `razorpay order fetch failed: ${res.status} ${text.slice(0, 200)}` };
    }
    const order = (await res.json()) as { id: string; status: string; notes?: Record<string, string> };
    return { ok: true, order };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function grantPlanCredits(userId: string, plan: 'pro' | 'team'): Promise<{ ok: true; payload: { balance?: number } } | { ok: false; error: string }> {
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceKey) {
    return { ok: false, error: 'Server cannot grant credits: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.' };
  }
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/grant_plan_credits`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ target_user_id: userId, plan_name: plan, extra: 0 }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `grant denied: ${res.status} ${text.slice(0, 220)}` };
    return { ok: true, payload: JSON.parse(text || '{}') as { balance?: number } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface FulfillInput {
  plan?: string;
  orderId?: string;
  paymentId?: string;
  signature?: string;
}

/**
 * Server-authoritative fulfillment — re-verifies the signature locally,
 * re-fetches the order from Razorpay with Basic Auth, and only then grants
 * credits through the service-role RPC. A browser cannot abuse this as a
 * free-credit path.
 */
export async function fulfillPayment(input: FulfillInput): Promise<OrderResult> {
  const plan = (input.plan || '').toLowerCase();
  if (plan !== 'pro' && plan !== 'team') {
    return { statusCode: 400, body: { ok: false, error: "plan must be 'pro' or 'team'" } };
  }
  if (!input.orderId || !input.paymentId || !input.signature) {
    return { statusCode: 400, body: { ok: false, error: 'orderId, paymentId and signature are required' } };
  }

  const sig = verifyPayment({
    razorpay_order_id: input.orderId,
    razorpay_payment_id: input.paymentId,
    razorpay_signature: input.signature,
  });
  if (sig.statusCode !== 200) {
    return { statusCode: sig.statusCode, body: { ok: false, error: 'Signature verification failed' } };
  }

  const remote = await fetchRazorpayOrder(input.orderId);
  if (!remote.ok) {
    const reason = 'error' in remote ? remote.error : 'Could not fetch the order from Razorpay';
    return { statusCode: 502, body: { ok: false, error: reason } };
  }
  if (remote.order.status !== 'paid') {
    return { statusCode: 409, body: { ok: false, error: `Order not paid yet (status: ${remote.order.status})` } };
  }

  const notedPlan = remote.order.notes?.plan?.toLowerCase();
  const grantPlan = notedPlan === 'pro' || notedPlan === 'team' ? notedPlan : plan;
  const userId = remote.order.notes?.user_id;
  if (!userId) {
    return { statusCode: 400, body: { ok: false, error: 'Order carries no user_id — create it via FlutterForge checkout.' } };
  }

  const grant = await grantPlanCredits(userId, grantPlan);
  if (!grant.ok) {
    const reason = 'error' in grant ? grant.error : 'Could not grant plan credits';
    return { statusCode: 502, body: { ok: false, error: reason } };
  }
  return { statusCode: 200, body: { ok: true, balance: grant.payload.balance ?? null, plan: grantPlan } };
}

/* ── Webhook ───────────────────────────────────────────────────────── */

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

/**
 * Razorpay webhook (payment.captured). Verifies the signature with
 * RAZORPAY_WEBHOOK_SECRET. Configure this in the Razorpay dashboard pointed
 * at your tunnel/hosting URL — see docs/CREDITS.md.
 */
export async function handleRazorpayWebhook(rawBody: Buffer, signature: string | undefined): Promise<OrderResult> {
  if (!WEBHOOK_SECRET) {
    return { statusCode: 501, body: { error: 'RAZORPAY_WEBHOOK_SECRET is not set on this engine.' } };
  }
  if (!signature) {
    return { statusCode: 400, body: { error: 'Missing x-razorpay-signature header.' } };
  }

  const expected = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { statusCode: 400, body: { error: 'Webhook signature mismatch.' } };
  }

  let event: { event?: string; payload?: { payment?: { entity?: Record<string, unknown> } } };
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { statusCode: 400, body: { error: 'Webhook body is not valid JSON.' } };
  }

  if (event?.event !== 'payment.captured') {
    return { statusCode: 200, body: { ok: true, note: `ignored event ${event?.event}` } };
  }

  const entity = event.payload?.payment?.entity;
  if (!entity) {
    return { statusCode: 200, body: { ok: true, note: 'payment entity missing, nothing granted' } };
  }

  const notes = (entity.notes as Record<string, string> | undefined) ?? {};
  const plan = (notes.plan || '').toLowerCase();
  const userId = notes.user_id;
  if (!userId || (plan !== 'pro' && plan !== 'team')) {
    return { statusCode: 200, body: { ok: true, note: 'webhook payload lacks plan/user_id; nothing granted' } };
  }

  const grant = await grantPlanCredits(userId, plan);
  if (!grant.ok) {
    const reason = 'error' in grant ? grant.error : 'Could not grant plan credits';
    return { statusCode: 502, body: { ok: false, error: reason } };
  }
  return { statusCode: 200, body: { ok: true, balance: grant.payload.balance ?? null, plan } };
}
