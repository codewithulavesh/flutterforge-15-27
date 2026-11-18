import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dartSafeUrl, dartSafeToken } from '../dartSafe.js';

test('dartSafeUrl accepts ordinary https supabase URLs', () => {
  assert.equal(dartSafeUrl('https://abcdefghijklmnoprstuv.supabase.co'), 'https://abcdefghijklmnoprstuv.supabase.co');
  assert.equal(dartSafeUrl('https://project-ref.supabase.co/'), 'https://project-ref.supabase.co/');
  assert.equal(dartSafeUrl('https://db.example.com'), 'https://db.example.com');
});

test('dartSafeUrl rejects Dart injection through the URL', () => {
  // Classic quote-breakout attempts must never survive.
  assert.equal(dartSafeUrl("https://x.supabase.co/'; DROP TABLE users; //"), null);
  assert.equal(dartSafeUrl("https://x/';\nprint('pwned');\n//"), null);
  assert.equal(dartSafeUrl('https://x/${evil()}'), null);
  assert.equal(dartSafeUrl('https://x/\\'), null);
  assert.equal(dartSafeUrl('https://x'), 'https://x');
});

test('dartSafeUrl rejects non-http schemes and credentials', () => {
  assert.equal(dartSafeUrl('javascript:alert(1)'), null);
  assert.equal(dartSafeUrl('file:///etc/passwd'), null);
  assert.equal(dartSafeUrl('ftp://example.com'), null);
  assert.equal(dartSafeUrl('https://user:pass@example.com'), null);
  assert.equal(dartSafeUrl('https://example.com/?q=1'), null);
  assert.equal(dartSafeUrl('https://example.com/#frag'), null);
});

test('dartSafeUrl rejects oversized and malformed input', () => {
  assert.equal(dartSafeUrl(''), null);
  assert.equal(dartSafeUrl('not a url'), null);
  assert.equal(dartSafeUrl(`https://${'a'.repeat(600)}.com`), null);
});

test('dartSafeToken accepts JWT and publishable-key shapes', () => {
  assert.equal(dartSafeToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQss5c'), 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQss5c');
  assert.equal(dartSafeToken('sb_publishable_abcDEF123-._'), 'sb_publishable_abcDEF123-._');
});

test('dartSafeToken rejects anything that could break a Dart string literal', () => {
  assert.equal(dartSafeToken("abc'; DROP TABLE users; //"), null);
  assert.equal(dartSafeToken('abc"def'), null);
  assert.equal(dartSafeToken('abc${evil()}'), null);
  assert.equal(dartSafeToken('abc\\def'), null);
  assert.equal(dartSafeToken('abc\ndef'), null);
  assert.equal(dartSafeToken('has space'), null);
  assert.equal(dartSafeToken(''), null);
  assert.equal(dartSafeToken(`${'a'.repeat(5000)}`), null);
});
