/**
 * ULID-based identifiers.
 *
 * ULIDs are lexicographically sortable, URL-safe, and collision-resistant
 * (80 bits of entropy per millisecond). The generator is monotonic within a
 * process: two IDs created in the same millisecond increment the random tail
 * so database indexes never see an out-of-order insert.
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const TIME_LEN = 10;
const RANDOM_LEN = 16;
export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  if (!Number.isFinite(time) || time < 0) throw new RangeError('ULID time must be a non-negative number.');
  if (time > 0xffffffffffff) throw new RangeError('ULID time exceeds 48 bits.');
  let remaining = Math.floor(time);
  const out = new Array<string>(TIME_LEN);
  for (let index = TIME_LEN - 1; index >= 0; index -= 1) {
    out[index] = ENCODING[remaining % 32];
    remaining = Math.floor(remaining / 32);
  }
  return out.join('');
}

function randomDigits(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  const digits = new Array<number>(RANDOM_LEN);
  for (let index = 0; index < RANDOM_LEN; index += 1) digits[index] = bytes[index] % 32;
  return digits;
}

function incrementRandom(digits: number[]): number[] {
  const next = digits.slice();
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index] < 31) {
      next[index] += 1;
      return next;
    }
    next[index] = 0;
  }
  // Overflow in the same millisecond: fall back to fresh entropy.
  return randomDigits();
}

function encodeRandom(digits: number[]): string {
  return digits.map((digit) => ENCODING[digit]).join('');
}

export function ulid(now = Date.now()): string {
  const time = Math.floor(now);
  if (time === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else if (time > lastTime) {
    lastTime = time;
    lastRandom = randomDigits();
  } else {
    // Clock moved backwards. Keep ordering honest by staying on the last
    // observed tick rather than emitting a smaller ULID.
    const previous = lastTime;
    lastRandom = incrementRandom(lastRandom);
    return encodeTime(previous) + encodeRandom(lastRandom);
  }
  return encodeTime(time) + encodeRandom(lastRandom);
}

const ID_PATTERN = /^[a-z][a-z0-9]{1,15}_[0-9A-HJKMNP-TV-Z]{26}$/i;

/** `run_01JB...` — prefixed for readability in logs and URLs. */
export function prefixedId(prefix: string, now = Date.now()): string {
  const clean = prefix.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!clean) throw new RangeError('Identifier prefix must contain letters or digits.');
  return `${clean.slice(0, 16)}_${ulid(now)}`;
}

export function isPrefixedId(value: unknown, prefix?: string): value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) return false;
  if (!prefix) return true;
  return value.startsWith(`${prefix.toLowerCase()}_`);
}

export function parseUlidTime(value: string): number | null {
  const body = value.includes('_') ? value.slice(value.indexOf('_') + 1) : value;
  if (body.length !== ULID_LENGTH) return null;
  let time = 0;
  for (let index = 0; index < TIME_LEN; index += 1) {
    const digit = ENCODING.indexOf(body[index].toUpperCase());
    if (digit < 0) return null;
    time = time * 32 + digit;
  }
  return time;
}
