/**
 * Server-side LLM provider — public surface.
 *
 * The security/retry/metering contract lives in ./provider.ts; in short:
 * credentials never leave the server, every success is metered exactly once,
 * retries are bounded, and errors are typed without leaking keys.
 */
export * from './provider.js';
