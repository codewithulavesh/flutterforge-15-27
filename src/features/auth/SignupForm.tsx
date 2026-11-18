import { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Mail, Lock, User, AlertCircle, CheckCircle2, ArrowRight, ArrowUpRight, Sparkles } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { HERO_PROMPT_KEY } from '@/utils/landing';
import { AuthLayout } from './AuthLayout';

export function SignupForm() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signUp, loading, error, clearError, session } = useAuthStore();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Read prompt passed from landing page or agents page
  const navPrompt = (location.state as { heroPrompt?: string } | null)?.heroPrompt;
  const [heroPrompt, setHeroPrompt] = useState<string | null>(() => {
    if (navPrompt?.trim()) return navPrompt.trim();
    try {
      return sessionStorage.getItem(HERO_PROMPT_KEY)?.trim() || null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (navPrompt?.trim()) {
      setHeroPrompt(navPrompt.trim());
    }
  }, [navPrompt]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSuccessMessage(null);
    clearError();

    if (!fullName || !email || !password) {
      setFormError('Please fill in all fields.');
      return;
    }
    if (password.length < 6) {
      setFormError('Password must be at least 6 characters.');
      return;
    }

    const { error } = await signUp(email, password, fullName);
    if (!error) {
      if (session) {
        navigate('/dashboard');
      } else {
        setSuccessMessage('Account created. Check your email to confirm your account, then sign in.');
      }
    }
  }

  return (
    <AuthLayout
      activeTab="signup"
      badge="New Builder"
      posterTitle={
        <>
          The next app
          <br />
          is one brief away.
        </>
      }
      posterSubtitle="Brief an app in plain language. FlutterForge writes real Dart files, runs a live web preview, repairs compile errors, and leaves the code on your machine."
    >
      <div className="ff-auth-card">
        {/* Card Header Bar */}
        <div className="flex items-center justify-between border-b border-[rgba(248,255,248,0.14)] px-6 py-4 sm:px-8">
          <span className="inline-flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--lv-lime)]">
            <span className="size-2 rounded-full bg-[var(--lv-lime)] ring-2 ring-[var(--lv-lime)]/30" />
            Get Started
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
            Create Account
          </h1>
          <p className="mt-2 text-[14.5px] leading-relaxed text-[rgba(248,255,248,0.72)]">
            Start building production Flutter apps with intelligent AI agents.
          </p>

          {/* Prompt banner carried from landing page */}
          {heroPrompt && (
            <div className="mt-5 rounded-2xl border border-[rgba(197,250,117,0.3)] bg-[rgba(197,250,117,0.08)] p-4 text-[var(--lv-white)]">
              <div className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--lv-lime)]">
                <Sparkles size={14} className="text-[var(--lv-lime)]" />
                <span>Your App Brief</span>
              </div>
              <p className="mt-1.5 text-[13px] font-medium italic leading-snug text-[var(--lv-white)]">
                &ldquo;{heroPrompt}&rdquo;
              </p>
              <p className="mt-1 font-mono text-[10px] text-[rgba(248,255,248,0.65)]">
                This brief will be ready in your studio workspace.
              </p>
            </div>
          )}

          {(error || formError) && (
            <div
              role="alert"
              className="mt-5 flex items-start gap-3 rounded-2xl border border-red-400/40 bg-red-500/20 p-4 text-[13px] leading-relaxed text-red-200"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" aria-hidden />
              <span>{formError || error}</span>
            </div>
          )}
          {successMessage && (
            <div
              role="status"
              className="mt-5 flex items-start gap-3 rounded-2xl border border-[rgba(197,250,117,0.4)] bg-[rgba(197,250,117,0.15)] p-4 text-[13px] leading-relaxed text-[var(--lv-lime)]"
            >
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[var(--lv-lime)]" aria-hidden />
              <span>{successMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="ff-auth-input-group">
              <label htmlFor="signup-name">Full name</label>
              <div className="relative">
                <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--lv-lime)]">
                  <User size={17} />
                </div>
                <input
                  id="signup-name"
                  type="text"
                  name="fullName"
                  placeholder="Jane Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoComplete="name"
                  className="ff-auth-input"
                />
              </div>
            </div>

            <div className="ff-auth-input-group">
              <label htmlFor="signup-email">Email address</label>
              <div className="relative">
                <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--lv-lime)]">
                  <Mail size={17} />
                </div>
                <input
                  id="signup-email"
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
              <label htmlFor="signup-password">Password</label>
              <div className="relative">
                <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--lv-lime)]">
                  <Lock size={17} />
                </div>
                <input
                  id="signup-password"
                  type="password"
                  name="password"
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
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
                  <span>Creating account…</span>
                </span>
              ) : (
                <>
                  <span>Create Account</span>
                  <ArrowRight size={16} aria-hidden />
                </>
              )}
            </button>
          </form>
        </div>

        {/* Card Footer Bar */}
        <div className="flex items-center justify-between border-t border-[rgba(248,255,248,0.14)] bg-black/20 px-6 py-4 sm:px-8">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[rgba(248,255,248,0.6)]">
            Already have an account?
          </span>
          <Link
            to="/login"
            className="group inline-flex items-center gap-1.5 text-[13px] font-bold text-[var(--lv-lime)] transition-colors hover:text-[var(--lv-white)]"
          >
            <span>Sign in</span>
            <ArrowRight size={14} className="transition-transform group-hover:translate-x-1" aria-hidden />
          </Link>
        </div>
      </div>
    </AuthLayout>
  );
}
