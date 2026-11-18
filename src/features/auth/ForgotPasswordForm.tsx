import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, AlertCircle, CheckCircle2, ArrowRight, ArrowUpRight } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { AuthLayout } from './AuthLayout';

export function ForgotPasswordForm() {
  const navigate = useNavigate();
  const { resetPassword, loading, error, clearError } = useAuthStore();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    clearError();

    if (!email) {
      setFormError('Please enter your email address.');
      return;
    }

    const { error } = await resetPassword(email);
    if (!error) {
      setSent(true);
    }
  }

  return (
    <AuthLayout
      activeTab="forgot-password"
      badge="Account Recovery"
      posterTitle={
        <>
          Recover your
          <br />
          studio access.
        </>
      }
      posterSubtitle="Enter your registered email address to receive secure password recovery instructions."
    >
      <div className="ff-auth-card">
        {/* Card Header Bar */}
        <div className="flex items-center justify-between border-b border-[rgba(248,255,248,0.14)] px-6 py-4 sm:px-8">
          <span className="inline-flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--lv-lime)]">
            <span className="size-2 rounded-full bg-[var(--lv-lime)] ring-2 ring-[var(--lv-lime)]/30" />
            Password Reset
          </span>
          <Link
            to="/"
            className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[rgba(248,255,248,0.6)] transition-colors hover:text-[var(--lv-white)]"
          >
            Home
            <ArrowUpRight size={13} aria-hidden />
          </Link>
        </div>

        {/* Card Main Form Content */}
        <div className="p-6 sm:p-8">
          <h1 className="ff-auth-display text-[clamp(26px,4vw,34px)] leading-[1.05] tracking-[-0.04em] text-[var(--lv-white)]">
            Reset Password
          </h1>
          <p className="mt-2 text-[14.5px] leading-relaxed text-[rgba(248,255,248,0.72)]">
            Enter your email and we&apos;ll send you a password recovery link.
          </p>

          {(error || formError) && (
            <div
              role="alert"
              className="mt-5 flex items-start gap-3 rounded-2xl border border-red-400/40 bg-red-500/20 p-4 text-[13px] leading-relaxed text-red-200"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" aria-hidden />
              <span>{formError || error}</span>
            </div>
          )}

          {sent ? (
            <div className="mt-6 space-y-5">
              <div
                role="status"
                className="flex items-start gap-3 rounded-2xl border border-[rgba(197,250,117,0.4)] bg-[rgba(197,250,117,0.15)] p-4 text-[13px] leading-relaxed text-[var(--lv-lime)]"
              >
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[var(--lv-lime)]" aria-hidden />
                <span>Check your email for a reset link.</span>
              </div>
              <button
                type="button"
                className="ff-auth-btn-primary"
                onClick={() => navigate('/login')}
              >
                <span>Return to Sign In</span>
                <ArrowRight size={16} aria-hidden />
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 space-y-5">
              <div className="ff-auth-input-group">
                <label htmlFor="reset-email">Email address</label>
                <div className="relative">
                  <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--lv-lime)]">
                    <Mail size={17} />
                  </div>
                  <input
                    id="reset-email"
                    type="email"
                    name="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    className="ff-auth-input"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="ff-auth-btn-primary mt-2"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    <span>Sending link…</span>
                  </span>
                ) : (
                  <>
                    <span>Send Reset Link</span>
                    <ArrowRight size={16} aria-hidden />
                  </>
                )}
              </button>
            </form>
          )}
        </div>

        {/* Card Footer Bar */}
        <div className="flex items-center justify-between border-t border-[rgba(248,255,248,0.14)] bg-black/20 px-6 py-4 sm:px-8">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[rgba(248,255,248,0.6)]">
            Remembered it?
          </span>
          <Link
            to="/login"
            className="group inline-flex items-center gap-1.5 text-[13px] font-bold text-[var(--lv-lime)] transition-colors hover:text-[var(--lv-white)]"
          >
            <span>Back to sign in</span>
            <ArrowRight size={14} className="transition-transform group-hover:translate-x-1" aria-hidden />
          </Link>
        </div>
      </div>
    </AuthLayout>
  );
}
