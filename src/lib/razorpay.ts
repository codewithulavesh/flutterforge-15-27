/**
 * Razorpay Standard Web Checkout — frontend helper.
 *
 * The publishable KEY_ID goes to the browser. The KEY_SECRET never does.
 * Flow: create order on the server → open Razorpay modal → verify signature
 * server-side → surface the result to the caller.
 */
import { useAuthStore } from '@/stores/auth.store';

const RAZORPAY_KEY_ID = (import.meta.env.VITE_RAZORPAY_KEY_ID as string | undefined)?.trim() ?? '';
const CHECKOUT_JS_URL = 'https://checkout.razorpay.com/v1/checkout.js';

let scriptPromise: Promise<void> | null = null;

function loadRazorpayScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Razorpay checkout is browser-only.'));
  }
  if (window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_JS_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Could not load checkout.razorpay.com — check your network connection.'));
    };
    document.body.appendChild(script);
  });
  return scriptPromise;
}

export interface CheckoutPlan {
  plan: 'pro' | 'team';
  period: 'monthly' | 'yearly';
}

export interface PaymentSuccess {
  payment_id: string;
  order_id: string;
  /** Passed through so the caller can activate the plan server-side. */
  signature: string;
}

export interface CheckoutHandlers {
  onSuccess(result: PaymentSuccess): void;
  onFailure(message: string): void;
  onDismiss?(): void;
}

interface CreateOrderResponse {
  order_id?: string;
  amount?: number;
  currency?: string;
  error?: string;
}

interface VerifyResponse {
  success?: boolean;
  payment_id?: string;
  error?: string;
}

export async function startRazorpayCheckout(plan: CheckoutPlan, handlers: CheckoutHandlers): Promise<void> {
  if (!RAZORPAY_KEY_ID) {
    handlers.onFailure('Razorpay is not configured for this deployment (VITE_RAZORPAY_KEY_ID missing).');
    return;
  }

  // Plan orders are bound to the signed-in user — the server needs the id to
  // grant credits to the right account after checkout.
  const { session } = useAuthStore.getState();
  const user = session?.user;
  if (!user?.id) {
    handlers.onFailure('Sign in before upgrading so we can attach the plan to your account.');
    return;
  }

  // 1. Create the order server-side (server holds the secret price table).
  let createRes: Response;
  try {
    createRes = await fetch('/api/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: plan.plan, period: plan.period, userId: user.id }),
    });
  } catch {
    handlers.onFailure('Could not reach the payment service. Is the engine running (npm run server)?');
    return;
  }

  const created = (await createRes.json().catch(() => ({}))) as CreateOrderResponse;
  if (!createRes.ok || !created.order_id) {
    handlers.onFailure(created.error || `Could not create the order (HTTP ${createRes.status}).`);
    return;
  }

  // 2. Open the Razorpay modal.
  try {
    await loadRazorpayScript();
  } catch (error) {
    handlers.onFailure(error instanceof Error ? error.message : 'Failed to load Razorpay.');
    return;
  }

  const RazorpayConstructor = window.Razorpay as new (options: Record<string, unknown>) => { open(): void };
  const modal = new RazorpayConstructor({
    key: RAZORPAY_KEY_ID,
    name: 'FlutterForge',
    description: `${plan.plan === 'team' ? 'Team' : 'Pro'} plan — ${plan.period === 'yearly' ? 'yearly billing' : 'monthly billing'}`,
    order_id: created.order_id,
    amount: created.amount,
    currency: created.currency || 'INR',
    prefill: {
      name: (user?.user_metadata?.full_name as string | undefined) || undefined,
      email: user?.email || undefined,
    },
    theme: { color: '#adff02' },
    modal: {
      ondismiss: () => handlers.onDismiss?.(),
    },
    handler: async (response: {
      razorpay_payment_id: string;
      razorpay_order_id: string;
      razorpay_signature: string;
    }) => {
      // 3. Verify the signature server-side before trusting anything.
      try {
        const verifyRes = await fetch('/api/verify-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(response),
        });
        const verified = (await verifyRes.json().catch(() => ({}))) as VerifyResponse;
        if (verifyRes.ok && verified.success) {
          handlers.onSuccess({
            payment_id: verified.payment_id || response.razorpay_payment_id,
            order_id: response.razorpay_order_id,
            signature: response.razorpay_signature,
          });
        } else {
          handlers.onFailure(verified.error || 'Payment could not be verified. If the amount was deducted, contact support.');
        }
      } catch {
        handlers.onFailure('Payment received but verification failed. Contact support if the amount was deducted.');
      }
    },
  });

  modal.open();
}

declare global {
  interface Window {
    Razorpay?: unknown;
  }
}
