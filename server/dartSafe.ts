/**
 * Safe interpolation of external strings into a Dart single-quoted literal.
 *
 * The preview/publish pipeline splices the user's Supabase URL and anon key
 * into `app_constants.dart` inside `'...'`. A value containing `'`, `\`, `$`,
 * backtick or control characters could break out of the literal and inject
 * arbitrary Dart — which is then compiled and EXECUTED in the preview.
 *
 * These validators are deliberately allowlist-based:
 * - `dartSafeUrl`: only http(s) URLs with no userinfo/query/fragment, no
 *   quotes or control characters.
 * - `dartSafeToken`: JWT/publishable-key alphabet only.
 *
 * Anything else is rejected (returns null); callers must skip the substitution
 * rather than write it into the source.
 */

const MAX_URL_LENGTH = 512;
const MAX_TOKEN_LENGTH = 4096;

/** Reject control chars, DEL, and the characters that can break a Dart string literal. */
function hasForbiddenChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
    if (ch === "'" || ch === '"' || ch === '\\' || ch === '$' || ch === '`') return true;
  }
  return false;
}

export function dartSafeUrl(value: string): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  if (hasForbiddenChar(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  // Host must be a plain DNS name or IPv4 — no whitespace/IDN tricks beyond this.
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) && !/^\[[0-9a-f:]+\]$/i.test(url.hostname)) return null;
  return trimmed;
}

export function dartSafeToken(value: string): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.length > MAX_TOKEN_LENGTH) return null;
  // JWT (three base64url segments), legacy anon keys, or sb_publishable_* —
  // all fit the base64url alphabet plus a single leading sb_publishable_ prefix.
  if (!/^(sb_publishable_)?[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}
