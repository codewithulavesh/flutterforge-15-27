import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, AlertCircle, ArrowRight, ArrowUpRight } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { AuthLayout } from './AuthLayout';

export function LoginForm() {
  const navigate = useNavigate();
  const { signIn, loading, error, clearError } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    clearError();

    if (!email || !password) {
      setFormError('Please enter your email and password.');
      return;
    }

    const { error } = await signIn(email, password);
    if (!error) {
      navigate('/dashboard');
    }
  }

  return (
    <AuthLayout
      activeTab="login"
      badge="Studio Access"
      posterTitle={
        <>
          Welcome back
          <br />
          to your studio.
        </>
      }
      posterSubtitle="Access your projects, configured AI models, and real-time live preview workspace."
    >
      <div className="ff-auth-card">
        {/* Card Header Bar */}
        <div className="flex items-center justify-between border-b border-[rgba(248,255,248,0.14)] px-6 py-4 sm:px-8">
          <span className="inline-flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--lv-lime)]">
            <span className="size-2 rounded-full bg-[var(--lv-lime)] ring-2 ring-[var(--lv-lime)]/30" />
            Sign In
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
            Sign In
          </h1>
          <p className="mt-2 text-[14.5px] leading-relaxed text-[rgba(248,255,248,0.72)]">
            Welcome back. Access your FlutterForge projects and AI agents.
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

          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <div className="ff-auth-input-group">
              <label htmlFor="login-email">Email address</label>
              <div className="relative">
                <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--lv-lime)]">
                  <Mail size={17} />
                </div>
                <input
                  id="login-email"
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

            <div className="ff-auth-input-group">
              <div className="flex items-center justify-between mb-2">
                <label htmlFor="login-password" className="!mb-0">
                  Password
                </label>
                <Link
                  to="/forgot-password"
                  className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--lv-lime)] underline decoration-[var(--lv-lime)]/40 underline-offset-4 transition-colors hover:text-[var(--lv-white)]"
                >
                  Forgot?
                </Link>
              </div>
              <div className="relative">
                <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--lv-lime)]">
                  <Lock size={17} />
                </div>
                <input
                  id="login-password"
                  type="password"
                  name="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
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
                  <span>Signing in…</span>
                </span>
              ) : (
                <>
                  <span>Sign In</span>
                  <ArrowRight size={16} aria-hidden />
                </>
              )}
            </button>
          </form>
        </div>

        {/* Card Footer Bar */}
        <div className="flex items-center justify-between border-t border-[rgba(248,255,248,0.14)] bg-black/20 px-6 py-4 sm:px-8">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[rgba(248,255,248,0.6)]">
            New here?
          </span>
          <Link
            to="/signup"
            className="group inline-flex items-center gap-1.5 text-[13px] font-bold text-[var(--lv-lime)] transition-colors hover:text-[var(--lv-white)]"
          >
            <span>Create an account</span>
            <ArrowRight size={14} className="transition-transform group-hover:translate-x-1" aria-hidden />
          </Link>
        </div>
      </div>
    </AuthLayout>
  );
}
