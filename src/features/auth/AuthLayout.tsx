import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import './auth-landing.css';

export interface AuthLayoutProps {
  children: ReactNode;
  badge?: string;
  posterTitle?: ReactNode;
  posterSubtitle?: string;
  activeTab?: 'login' | 'signup' | 'forgot-password';
}

export function AuthLayout({
  children,
  badge = 'Local Flutter Studio',
  posterTitle,
  posterSubtitle,
  activeTab = 'login',
}: AuthLayoutProps) {
  const isLogin = activeTab === 'login';
  const isSignup = activeTab === 'signup';

  const defaultTitle = isSignup ? (
    <>
      The next app
      <br />
      is one brief away.
    </>
  ) : (
    <>
      Welcome back
      <br />
      to your studio.
    </>
  );

  const defaultSubtitle = isSignup
    ? 'Brief an app in plain language. FlutterForge writes real Dart files, runs a live web preview, repairs compile errors, and leaves the code on your machine.'
    : 'Continue crafting your Flutter applications with local agents, real-time web previews, and instant compiler diagnostics.';

  return (
    <div className="ff-auth-page flex min-h-[100dvh] flex-col justify-between">
      {/* Top Navigation Header matching Lime / Agents header */}
      <header className="w-full px-[clamp(20px,4.167vw,80px)] py-6">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4">
          <Link
            to="/"
            className="inline-flex items-center gap-3 text-[var(--lv-ink)] transition-transform hover:scale-[1.02]"
            aria-label="FlutterForge home"
          >
            <BrandLogo size={32} />
            <span className="ff-auth-display ff-auth-brand-wordmark text-[17px] font-bold tracking-[-0.05em]">
              FlutterForge
            </span>
          </Link>

          <nav aria-label="Auth navigation" className="flex items-center gap-2 sm:gap-4">
            <Link
              to="/"
              className="hidden font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--lv-ink)] transition-opacity hover:opacity-70 sm:inline-block"
            >
              Home
            </Link>
            <Link
              to="/agents"
              className="hidden font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--lv-ink)] transition-opacity hover:opacity-70 sm:inline-block"
            >
              Agents
            </Link>

            {isLogin ? (
              <Link to="/signup" className="ff-auth-pill">
                <span>Create account</span>
                <ArrowUpRight size={15} aria-hidden />
              </Link>
            ) : (
              <Link to="/login" className="ff-auth-pill">
                <span>Sign in</span>
                <ArrowUpRight size={15} aria-hidden />
              </Link>
            )}
          </nav>
        </div>
      </header>

      {/* Main Body with Editorial Left Column and Form Card Right Column */}
      <main className="w-full flex-1 px-[clamp(20px,4.167vw,80px)] py-4 sm:py-8">
        <div className="mx-auto grid max-w-[1440px] items-center gap-10 lg:grid-cols-[1.08fr_0.92fr] lg:gap-14 xl:gap-20">
          {/* Left Column: Brand Poster */}
          <aside className="hidden lg:flex flex-col justify-center">
            <div>
              <div className="inline-flex items-center gap-2.5 rounded-full border border-[var(--lv-line)] bg-[var(--lv-white)] px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--lv-ink)] shadow-sm">
                <span className="size-2 rounded-full bg-[var(--lv-lime)] ring-2 ring-[var(--lv-ink)]/20" />
                <span>{badge}</span>
              </div>

              <h1 className="ff-auth-display ff-auth-poster-headline mt-6 text-[clamp(36px,4.2vw,62px)] leading-[0.94] tracking-[-0.045em]">
                {posterTitle || defaultTitle}
              </h1>

              <p className="mt-6 max-w-lg text-[16px] leading-relaxed text-[var(--lv-text)]">
                {posterSubtitle || defaultSubtitle}
              </p>

              <div className="mt-8 flex items-center gap-6 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--lv-text)]">
                <span>13 Agent Pipeline</span>
                <span>·</span>
                <span>Zero Lock-in</span>
                <span>·</span>
                <span>Export Anytime</span>
              </div>
            </div>
          </aside>

          {/* Right Column: Form Container */}
          <div className="mx-auto w-full max-w-[480px]">
            {children}
          </div>
        </div>
      </main>

      {/* Bottom Footer */}
      <footer className="w-full px-[clamp(20px,4.167vw,80px)] py-6 text-[var(--lv-text)]">
        <div className="mx-auto flex max-w-[1440px] flex-col items-center justify-between gap-4 border-t border-[var(--lv-line)] pt-5 text-center font-mono text-[10px] uppercase tracking-[0.14em] sm:flex-row sm:text-left">
          <span>© 2026 FlutterForge · Local AI Studio</span>
          <div className="flex flex-wrap items-center justify-center gap-5">
            <Link to="/legal/terms" className="transition-colors hover:text-[var(--lv-ink)]">
              Terms
            </Link>
            <Link to="/legal/privacy" className="transition-colors hover:text-[var(--lv-ink)]">
              Privacy
            </Link>
            <Link to="/legal/permissions" className="transition-colors hover:text-[var(--lv-ink)]">
              Permissions
            </Link>
            <a
              href="https://github.com/flutter/flutter"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-[var(--lv-ink)]"
            >
              <span>Flutter</span>
              <ArrowUpRight size={11} aria-hidden />
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
