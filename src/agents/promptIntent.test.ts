import { describe, expect, it } from 'vitest';
import {
  analyzeBackendIntent,
  detectDomain,
  extractDarkTheme,
  extractExplicitAppName,
  extractPlatforms,
  extractStateManagement,
} from './promptIntent';

const LOCAL_ONLY_BRIEF = `Build a production-grade Flutter Admin Dashboard app called "ApexAdmin".
Platform: web
Backend: None — local only (no auth, no database, no SQL)
State Management: provider
Theme Mode: dark
Do NOT use Supabase or any backend. Keep state local. No SQL, no auth screens, no service layer.`;

describe('analyzeBackendIntent', () => {
  it('treats negated backend words as a local-only request', () => {
    const intent = analyzeBackendIntent(LOCAL_ONLY_BRIEF);
    expect(intent.localOnly).toBe(true);
    expect(intent.wantsSupabase).toBe(false);
  });

  it('does not turn "production-grade" into ecommerce or a Supabase request', () => {
    const intent = analyzeBackendIntent('Build a production-grade reporting tool with charts');
    expect(intent.wantsSupabase).toBe(false);
    expect(detectDomain('Build a production-grade admin dashboard')).toBe('general');
  });

  it('still honors a genuine Supabase request', () => {
    const intent = analyzeBackendIntent('Build a chat app using Supabase auth and a database');
    expect(intent.localOnly).toBe(false);
    expect(intent.wantsSupabase).toBe(true);
  });

  it('handles "without a database" and "offline-first"', () => {
    expect(analyzeBackendIntent('A todo app without a database').localOnly).toBe(true);
    expect(analyzeBackendIntent('An offline-first notes app').localOnly).toBe(true);
  });
});

describe('explicit field extraction', () => {
  it('reads the app name from a declared Project field', () => {
    expect(extractExplicitAppName('Project: ApexAdmin\nTemplate: dashboard')).toBe('ApexAdmin');
    expect(extractExplicitAppName('Build an app called "My Admin Tool"')).toBe('MyAdminTool');
    expect(extractExplicitAppName('Build a production-grade dashboard')).toBeNull();
  });

  it('reads platform, state management and theme from explicit fields', () => {
    expect(extractPlatforms(LOCAL_ONLY_BRIEF)).toEqual(['web']);
    expect(extractStateManagement(LOCAL_ONLY_BRIEF)).toBe('provider');
    expect(extractDarkTheme(LOCAL_ONLY_BRIEF)).toBe(true);
  });

  it('does not confuse product words with the ecommerce domain', () => {
    expect(detectDomain('Project: ApexAdmin — user management and audit logs')).toBe('general');
    expect(detectDomain('An ecommerce store with a cart')).toBe('ecommerce');
  });
});
