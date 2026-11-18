/**
 * JWS verification for the FlutterForge gateway.
 *
 * Design rules:
 *  - The caller must pass an explicit algorithm allowlist. A token never
 *    selects its own trust level.
 *  - `alg: none`, `crit`, unencoded payloads and unknown algorithms are
 *    rejected before any signature work is attempted.
 *  - Symmetric secrets are always compared with `timingSafeEqual`. PEM/DER
 *    public keys are never accepted as HMAC secrets (algorithm confusion).
 *  - Claims are validated only after the signature has been verified.
 *
 * This module verifies tokens; it deliberately does not mint them. Keep the
 * signing key on the issuer side.
 */
import {
  KeyObject,
  constants as cryptoConstants,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { Clock } from '../kernel/clock.js';

export const MAX_JWT_BYTES = 16 * 1024;

export const JWT_ALGORITHMS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
] as const;

export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

export type JwtErrorCode =
  | 'MALFORMED'
  | 'UNSUPPORTED_ALG'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'BAD_ISSUER'
  | 'BAD_AUDIENCE'
  | 'MISSING_CLAIM'
  | 'KEY_RESOLUTION_FAILED';

export interface JwtErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** Stable, machine-readable verification failure. */
export class JwtError extends Error {
  readonly code: JwtErrorCode;
  readonly statusCode = 401;
  readonly details?: Record<string, unknown>;

  constructor(code: JwtErrorCode, message: string, options: JwtErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'JwtError';
    this.code = code;
    this.details = options.details;
  }
}

export function isJwtError(error: unknown, code?: JwtErrorCode): error is JwtError {
  return error instanceof JwtError && (code === undefined || error.code === code);
}

export interface JwtHeader {
  alg: string;
  typ?: string;
  kid?: string;
  crit?: unknown;
  [parameter: string]: unknown;
}

export interface JwtRegisteredClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
}

export type JwtPayload = JwtRegisteredClaims & Record<string, unknown>;

export interface VerifiedToken {
  header: JwtHeader;
  payload: JwtPayload;
}

/**
 * Diagnostics only. Never use this result to authorise a request.
 *
 * This function performs no signature and no claim validation. It exists so
 * support tooling can inspect a token's claims while an incident is being
 * triaged. Anything gated on its output is a vulnerability.
 */
export interface UnsafeDecodedJwt {
  header: JwtHeader;
  payload: JwtPayload;
  signature: string;
  signatureVerified: false;
}

/**
 * An explicitly typed HMAC key. Bare strings and buffers are also accepted by
 * the verifier, but this wrapper prevents an RSA/EC PEM from being interpreted
 * as an HMAC secret by a future refactor.
 */
export interface Hs256Key {
  readonly kind: 'hmac-sha256';
  readonly bytes: Buffer;
}

export type JwtKeyMaterial = string | Buffer | Uint8Array | KeyObject | Hs256Key;

export type JwtKeyResolver = (
  header: Readonly<JwtHeader>,
) => JwtKeyMaterial | null | undefined | Promise<JwtKeyMaterial | null | undefined>;

export interface JwtVerifierOptions {
  /** Required. No algorithm is trusted implicitly. */
  algorithms: readonly JwtAlgorithm[];
  /** Static verification key. Ignored when `keyResolver` is supplied. */
  key?: JwtKeyMaterial;
  /** JWKS-style resolver. Called with the token's header (including `kid`, if any). */
  keyResolver?: JwtKeyResolver;
  /** Accepted issuer(s). When set, `iss` is required and must match exactly. */
  issuer?: string | readonly string[];
  /** Accepted audience(s). When set, `aud` is required and must intersect. */
  audience?: string | readonly string[];
  /** Tolerated clock difference for exp/nbf/iat. Defaults to 30 seconds. */
  clockSkewSeconds?: number;
  /** Require `exp`. Defaults to true. */
  requireExp?: boolean;
  /** Require a non-empty `sub`. Defaults to false. */
  requireSubject?: boolean;
  /** Epoch milliseconds. Takes precedence over `clock`. */
  now?: () => number;
  /** Alternative injected clock. */
  clock?: Clock;
  /** Hard limit, clamped to MAX_JWT_BYTES. */
  maxTokenBytes?: number;
}

export interface JwtVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

interface ParsedJws {
  header: JwtHeader;
  payload: JwtPayload;
  signatureSegment: string;
  signingInput: Buffer;
}

type PreparedKey =
  | { readonly kind: 'secret'; readonly key: Buffer | KeyObject; readonly hs256Only: boolean }
  | { readonly kind: 'public'; readonly key: KeyObject };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const OWN = Object.prototype.hasOwnProperty;

const HMAC_HASH: Readonly<Record<'HS256' | 'HS384' | 'HS512', string>> = Object.freeze({
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
});

const DIGEST_BYTES: Readonly<Record<JwtAlgorithm, number>> = Object.freeze({
  HS256: 32,
  HS384: 48,
  HS512: 64,
  RS256: 32,
  RS384: 48,
  RS512: 64,
  PS256: 32,
  PS384: 48,
  PS512: 64,
  ES256: 32,
  ES384: 48,
  ES512: 66,
});

const EC_CURVES: Readonly<Record<'ES256' | 'ES384' | 'ES512', ReadonlySet<string>>> = Object.freeze({
  ES256: new Set(['prime256v1', 'secp256r1', 'P-256']),
  ES384: new Set(['secp384r1', 'P-384']),
  ES512: new Set(['secp521r1', 'P-521']),
});

function hasOwn(object: object, key: string): boolean {
  return OWN.call(object, key);
}

function malformed(message: string, details?: Record<string, unknown>): never {
  throw new JwtError('MALFORMED', message, { details });
}

function unsupported(message: string, details?: Record<string, unknown>): never {
  throw new JwtError('UNSUPPORTED_ALG', message, { details });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64Url(segment: string, label: string): Buffer {
  if (segment.length === 0) malformed(`JWS ${label} segment is empty.`, { segment: label });
  if (segment.length % 4 === 1 || !BASE64URL.test(segment)) {
    malformed(`JWS ${label} segment is not valid base64url.`, { segment: label });
  }
  const padding = (4 - (segment.length % 4)) % 4;
  const encoded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding);
  const bytes = Buffer.from(encoded, 'base64');
  // Reject non-canonical encodings instead of silently accepting changed bits.
  if (bytes.toString('base64url') !== segment) {
    malformed(`JWS ${label} segment is not canonical base64url.`, { segment: label });
  }
  return bytes;
}

function decodeJsonObject(segment: string, label: 'header' | 'payload'): Record<string, unknown> {
  const bytes = decodeBase64Url(segment, label);
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    malformed(`JWS ${label} is not valid UTF-8.`, { segment: label });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    malformed(`JWS ${label} is not valid JSON.`, { segment: label });
  }
  if (!isPlainObject(value)) malformed(`JWS ${label} must be a JSON object.`, { segment: label });
  return value;
}

function parseJws(token: string, maxTokenBytes: number): ParsedJws {
  if (typeof token !== 'string') malformed('JWT must be a string.');
  if (token.length === 0) malformed('JWT is empty.');
  if (Buffer.byteLength(token, 'utf8') > maxTokenBytes) {
    malformed(`JWT exceeds the ${maxTokenBytes}-byte limit.`, { maxTokenBytes });
  }

  const segments = token.split('.');
  if (segments.length !== 3) {
    malformed('JWT must contain exactly three dot-separated segments.', { segments: segments.length });
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (headerSegment.length === 0) malformed('JWS header segment is empty.');
  if (payloadSegment.length === 0) malformed('JWS payload segment is empty.');

  const header = decodeJsonObject(headerSegment, 'header') as JwtHeader;
  const payload = decodeJsonObject(payloadSegment, 'payload') as JwtPayload;

  return {
    header,
    payload,
    signatureSegment,
    signingInput: Buffer.from(`${headerSegment}.${payloadSegment}`, 'ascii'),
  };
}

function inspectHeader(header: JwtHeader): void {
  if (!hasOwn(header, 'alg') || typeof header.alg !== 'string' || header.alg.length === 0) {
    malformed('JWS header is missing a string "alg" parameter.');
  }
  if (hasOwn(header, 'crit')) {
    unsupported('JWS "crit" header parameters are not supported.');
  }
  if (hasOwn(header, 'b64') && header.b64 !== true) {
    unsupported('JWS unencoded payloads (b64:false) are not supported.');
  }
  if (hasOwn(header, 'kid') && (typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > 512)) {
    malformed('JWS "kid" header must be a non-empty string of at most 512 characters.');
  }
  if (hasOwn(header, 'typ') && typeof header.typ !== 'string') {
    malformed('JWS "typ" header must be a string.');
  }
}

function isJwtAlgorithm(value: unknown): value is JwtAlgorithm {
  return typeof value === 'string' && (JWT_ALGORITHMS as readonly string[]).includes(value);
}

function looksLikePem(bytes: Buffer): boolean {
  return /^\s*-----BEGIN [A-Z0-9 ]+-----/.test(bytes.subarray(0, 96).toString('utf8'));
}

function inspectKeyObject(key: KeyObject): PreparedKey {
  if (key.type === 'secret') {
    return { kind: 'secret', key, hs256Only: false };
  }
  if (key.type === 'public') {
    return { kind: 'public', key };
  }
  // A private key is signing material. Accepting it here would encourage
  // verifiers to hold keys that can also mint tokens.
  unsupported('Private keys cannot be used to verify JWTs; supply the public key.');
}

function prepareRawKey(bytes: Buffer): PreparedKey {
  if (bytes.length === 0) unsupported('JWT verification key must not be empty.');

  const pem = looksLikePem(bytes);
  if (pem && /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(bytes.subarray(0, 96).toString('utf8'))) {
    unsupported('Private keys cannot be used to verify JWTs; supply the public key.');
  }

  let publicKey: KeyObject | null = null;
  try {
    publicKey = createPublicKey(bytes);
  } catch {
    publicKey = null;
  }

  if (publicKey) return { kind: 'public', key: publicKey };
  if (pem) unsupported('PEM verification key could not be parsed.');
  return { kind: 'secret', key: Buffer.from(bytes), hs256Only: false };
}

function isHs256Key(value: unknown): value is Hs256Key {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'hmac-sha256'
    && (value as { bytes?: unknown }).bytes instanceof Uint8Array
  );
}

function prepareKey(material: unknown): PreparedKey {
  if (isHs256Key(material)) {
    const bytes = Buffer.from(material.bytes);
    if (bytes.length === 0) unsupported('JWT verification key must not be empty.');
    return { kind: 'secret', key: bytes, hs256Only: true };
  }
  if (typeof material === 'string') {
    return prepareRawKey(Buffer.from(material, 'utf8'));
  }
  if (material instanceof KeyObject) {
    return inspectKeyObject(material);
  }
  if (material instanceof Uint8Array) {
    return prepareRawKey(Buffer.from(material));
  }
  unsupported('Unsupported JWT verification key material.');
}

function signatureMismatch(algorithm: JwtAlgorithm): never {
  unsupported(`Verification key type is not compatible with ${algorithm}.`, { algorithm });
}

function verifyHmac(algorithm: 'HS256' | 'HS384' | 'HS512', prepared: PreparedKey, signingInput: Buffer, signature: Buffer): boolean {
  if (prepared.kind !== 'secret') signatureMismatch(algorithm);
  if (prepared.hs256Only && algorithm !== 'HS256') signatureMismatch(algorithm);

  const expected = createHmac(HMAC_HASH[algorithm], prepared.key).update(signingInput).digest();
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(signature, expected);
}

/** JOSE uses raw r||s; DER needs each integer minimally encoded. */
function joseSignatureToDer(signature: Buffer, partLength: number): Buffer {
  if (signature.length !== partLength * 2) {
    throw new JwtError('BAD_SIGNATURE', 'ECDSA signature has the wrong length for the selected curve.');
  }

  const encodeInteger = (part: Buffer): Buffer => {
    let offset = 0;
    while (offset < part.length - 1 && part[offset] === 0) offset += 1;
    let value = part.subarray(offset);
    if (value.length === 0) value = Buffer.from([0]);
    if ((value[0] & 0x80) !== 0) value = Buffer.concat([Buffer.from([0]), value]);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };

  const r = encodeInteger(signature.subarray(0, partLength));
  const s = encodeInteger(signature.subarray(partLength));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function verifyAsymmetric(
  algorithm: Exclude<JwtAlgorithm, 'HS256' | 'HS384' | 'HS512'>,
  prepared: PreparedKey,
  signingInput: Buffer,
  signature: Buffer,
): boolean {
  if (prepared.kind !== 'public') signatureMismatch(algorithm);
  const key = prepared.key;
  const hash = `sha${algorithm.slice(2)}`;

  if (algorithm.startsWith('ES')) {
    if (key.asymmetricKeyType !== 'ec') signatureMismatch(algorithm);
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (!curve || !EC_CURVES[algorithm as 'ES256' | 'ES384' | 'ES512'].has(curve)) {
      signatureMismatch(algorithm);
    }
    const der = joseSignatureToDer(signature, DIGEST_BYTES[algorithm]);
    try {
      return cryptoVerify(hash, signingInput, { key, dsaEncoding: 'der' }, der);
    } catch {
      return false;
    }
  }

  if (algorithm.startsWith('RS') || algorithm.startsWith('PS')) {
    if (key.asymmetricKeyType !== 'rsa') signatureMismatch(algorithm);
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      unsupported('RSA verification keys must be at least 2048 bits.');
    }
    const pss = algorithm.startsWith('PS');
    try {
      return cryptoVerify(
        hash,
        signingInput,
        {
          key,
          padding: pss ? cryptoConstants.RSA_PKCS1_PSS_PADDING : cryptoConstants.RSA_PKCS1_PADDING,
          ...(pss ? { saltLength: DIGEST_BYTES[algorithm] } : {}),
        },
        signature,
      );
    } catch {
      return false;
    }
  }

  signatureMismatch(algorithm);
}

function verifyWithKey(
  algorithm: JwtAlgorithm,
  prepared: PreparedKey,
  signingInput: Buffer,
  signature: Buffer,
): boolean {
  if (algorithm === 'HS256' || algorithm === 'HS384' || algorithm === 'HS512') {
    return verifyHmac(algorithm, prepared, signingInput, signature);
  }
  return verifyAsymmetric(algorithm, prepared, signingInput, signature);
}

function normalizeStringList(value: string | readonly string[] | undefined, name: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${name} must be a non-empty string or an array of non-empty strings.`);
  }
  const result: string[] = [];
  for (const item of values) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new TypeError(`${name} must contain only non-empty strings.`);
    }
    result.push(item);
  }
  return Object.freeze(result);
}

function numericDate(payload: JwtPayload, claim: 'exp' | 'nbf' | 'iat'): number | undefined {
  if (!hasOwn(payload, claim)) return undefined;
  const value = payload[claim];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    malformed(`JWT "${claim}" claim must be a finite number.`, { claim });
  }
  const milliseconds = value * 1000;
  if (!Number.isFinite(milliseconds)) {
    malformed(`JWT "${claim}" claim is outside the representable time range.`, { claim });
  }
  return milliseconds;
}

function validateClaims(
  payload: JwtPayload,
  options: {
    issuer: readonly string[] | undefined;
    audience: readonly string[] | undefined;
    requireExp: boolean;
    requireSubject: boolean;
  },
  nowMs: number,
  skewMs: number,
): void {
  const exp = numericDate(payload, 'exp');
  if (exp === undefined) {
    if (options.requireExp) {
      throw new JwtError('MISSING_CLAIM', 'JWT is missing the required "exp" claim.', { details: { claim: 'exp' } });
    }
  } else if (nowMs >= exp + skewMs) {
    throw new JwtError('EXPIRED', 'JWT has expired.', { details: { exp: exp / 1000 } });
  }

  const nbf = numericDate(payload, 'nbf');
  if (nbf !== undefined && nowMs + skewMs < nbf) {
    throw new JwtError('NOT_YET_VALID', 'JWT is not valid yet.', { details: { nbf: nbf / 1000 } });
  }

  const iat = numericDate(payload, 'iat');
  if (iat !== undefined && nowMs + skewMs < iat) {
    throw new JwtError('NOT_YET_VALID', 'JWT "iat" claim is in the future.', { details: { claim: 'iat' } });
  }

  let issuer: string | undefined;
  if (hasOwn(payload, 'iss')) {
    if (typeof payload.iss !== 'string' || payload.iss.length === 0) {
      malformed('JWT "iss" claim must be a non-empty string.', { claim: 'iss' });
    }
    issuer = payload.iss;
  }
  if (options.issuer !== undefined) {
    if (issuer === undefined) {
      throw new JwtError('MISSING_CLAIM', 'JWT is missing the required "iss" claim.', { details: { claim: 'iss' } });
    }
    if (!options.issuer.includes(issuer)) {
      throw new JwtError('BAD_ISSUER', 'JWT issuer is not trusted.', { details: { claim: 'iss' } });
    }
  }

  let audiences: string[] | undefined;
  if (hasOwn(payload, 'aud')) {
    const value = payload.aud;
    if (typeof value === 'string') {
      if (value.length === 0) malformed('JWT "aud" claim must not be empty.', { claim: 'aud' });
      audiences = [value];
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
      audiences = value as string[];
    } else {
      malformed('JWT "aud" claim must be a string or an array of non-empty strings.', { claim: 'aud' });
    }
  }
  if (options.audience !== undefined) {
    if (audiences === undefined) {
      throw new JwtError('MISSING_CLAIM', 'JWT is missing the required "aud" claim.', { details: { claim: 'aud' } });
    }
    if (!audiences.some((audience) => options.audience!.includes(audience))) {
      throw new JwtError('BAD_AUDIENCE', 'JWT audience is not accepted.', { details: { claim: 'aud' } });
    }
  }

  if (hasOwn(payload, 'sub')) {
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      malformed('JWT "sub" claim must be a non-empty string.', { claim: 'sub' });
    }
  } else if (options.requireSubject) {
    throw new JwtError('MISSING_CLAIM', 'JWT is missing the required "sub" claim.', { details: { claim: 'sub' } });
  }
}

/** Convenience constructor for HMAC keys with a clearer type. */
export function createHs256Key(secret: string | Buffer | Uint8Array): Hs256Key {
  if (typeof secret === 'string') {
    if (secret.length === 0) throw new RangeError('HMAC secret must not be empty.');
    return Object.freeze({ kind: 'hmac-sha256' as const, bytes: Buffer.from(secret, 'utf8') });
  }
  if (secret instanceof Uint8Array) {
    if (secret.byteLength === 0) throw new RangeError('HMAC secret must not be empty.');
    return Object.freeze({ kind: 'hmac-sha256' as const, bytes: Buffer.from(secret) });
  }
  throw new TypeError('HMAC secret must be a string or byte array.');
}

/** Decode a compact JWS for logging/diagnostics. No signature or claim checks.
 *
 * Not for authorization. The result proves nothing; always call
 * `createJwtVerifier().verify()` before trusting any claim.
 */
export function decodeJwtUnsafe(token: string): UnsafeDecodedJwt {
  const parsed = parseJws(token, MAX_JWT_BYTES);
  if (parsed.signatureSegment.length === 0) malformed('JWS signature segment is empty.');
  decodeBase64Url(parsed.signatureSegment, 'signature');
  return {
    header: parsed.header,
    payload: parsed.payload,
    signature: parsed.signatureSegment,
    signatureVerified: false,
  };
}

export function createJwtVerifier(options: JwtVerifierOptions): JwtVerifier {
  if (!options || typeof options !== 'object') throw new TypeError('JWT verifier options are required.');
  if (!Array.isArray(options.algorithms) || options.algorithms.length === 0) {
    throw new TypeError('JWT verifier requires a non-empty algorithm allowlist.');
  }

  const allowed = new Set<JwtAlgorithm>();
  for (const algorithm of options.algorithms) {
    if (!isJwtAlgorithm(algorithm)) unsupported(`Unsupported algorithm in allowlist: ${String(algorithm)}.`);
    allowed.add(algorithm);
  }

  const issuer = normalizeStringList(options.issuer, 'issuer');
  const audience = normalizeStringList(options.audience, 'audience');

  const clockSkewSeconds = options.clockSkewSeconds ?? 30;
  if (typeof clockSkewSeconds !== 'number' || !Number.isFinite(clockSkewSeconds) || clockSkewSeconds < 0) {
    throw new TypeError('clockSkewSeconds must be a non-negative finite number.');
  }
  const skewMs = Math.ceil(clockSkewSeconds * 1000);
  if (!Number.isFinite(skewMs)) throw new TypeError('clockSkewSeconds is too large.');

  if (options.requireExp !== undefined && typeof options.requireExp !== 'boolean') {
    throw new TypeError('requireExp must be a boolean.');
  }
  if (options.requireSubject !== undefined && typeof options.requireSubject !== 'boolean') {
    throw new TypeError('requireSubject must be a boolean.');
  }

  const maxTokenBytes = options.maxTokenBytes ?? MAX_JWT_BYTES;
  if (!Number.isSafeInteger(maxTokenBytes) || maxTokenBytes <= 0 || maxTokenBytes > MAX_JWT_BYTES) {
    throw new TypeError(`maxTokenBytes must be an integer between 1 and ${MAX_JWT_BYTES}.`);
  }

  const now = options.now ?? (options.clock ? () => options.clock!.now() : () => Date.now());
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  if (options.now !== undefined && options.clock !== undefined) {
    // `now` wins for backward compatibility; the alternative remains accepted
    // because callers often share a kernel Clock with the rest of the platform.
  }

  const resolver = options.keyResolver;
  if (resolver !== undefined && typeof resolver !== 'function') {
    throw new TypeError('keyResolver must be a function.');
  }
  if (resolver === undefined && options.key === undefined) {
    throw new TypeError('JWT verifier requires either key or keyResolver.');
  }

  const staticKey = resolver === undefined ? prepareKey(options.key) : undefined;

  return {
    async verify(token: string): Promise<VerifiedToken> {
      const parsed = parseJws(token, maxTokenBytes);
      const { header, payload } = parsed;
      inspectHeader(header);

      if (header.alg === 'none') unsupported('The "none" algorithm is not permitted.');
      if (!isJwtAlgorithm(header.alg)) unsupported('JWT uses an unsupported algorithm.', { algorithm: header.alg });
      if (!allowed.has(header.alg)) {
        unsupported('JWT algorithm is not in the verifier allowlist.', { algorithm: header.alg });
      }
      if (parsed.signatureSegment.length === 0) malformed('JWS signature segment is empty.');

      const signature = decodeBase64Url(parsed.signatureSegment, 'signature');
      const algorithm = header.alg;

      let prepared: PreparedKey;
      if (resolver !== undefined) {
        let material: JwtKeyMaterial | null | undefined;
        try {
          material = await resolver(Object.freeze({ ...header }));
        } catch (error) {
          if (error instanceof JwtError) throw error;
          throw new JwtError('KEY_RESOLUTION_FAILED', 'Could not resolve a verification key for this token.', { cause: error });
        }
        if (material === null || material === undefined) {
          throw new JwtError('KEY_RESOLUTION_FAILED', 'No verification key is available for this token.');
        }
        try {
          prepared = prepareKey(material);
        } catch (error) {
          if (error instanceof JwtError) throw error;
          if (error instanceof TypeError) {
            throw new JwtError('KEY_RESOLUTION_FAILED', 'The resolved verification key could not be used.', { cause: error });
          }
          throw error;
        }
      } else {
        prepared = staticKey!;
      }

      if (!verifyWithKey(algorithm, prepared, parsed.signingInput, signature)) {
        throw new JwtError('BAD_SIGNATURE', 'JWT signature verification failed.');
      }

      const nowMs = now();
      if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
        throw new TypeError('Injected JWT clock must return finite epoch milliseconds.');
      }
      validateClaims(
        payload,
        {
          issuer,
          audience,
          requireExp: options.requireExp ?? true,
          requireSubject: options.requireSubject ?? false,
        },
        nowMs,
        skewMs,
      );

      return { header, payload };
    },
  };
}

export interface Hs256VerifierOptions {
  /** Symmetric HMAC secret. Strings are read as UTF-8; do not pass a PEM. */
  secret: string | Buffer | Uint8Array | Hs256Key;
  issuer?: string | readonly string[];
  audience?: string | readonly string[];
  clockSkewSeconds?: number;
  requireExp?: boolean;
  requireSubject?: boolean;
  /** Epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Convenience constructor for the common HMAC case. Produces a verifier that
 * trusts only HS256; every other algorithm, including HS384/HS512 and
 * `alg: none`, is rejected with UNSUPPORTED_ALG.
 */
export function createHs256Verifier(options: Hs256VerifierOptions): JwtVerifier {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createHs256Verifier requires an options object with a secret.');
  }
  const key = isHs256Key(options.secret) ? options.secret : createHs256Key(options.secret as string | Buffer | Uint8Array);
  return createJwtVerifier({
    algorithms: ['HS256'],
    key,
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(options.clockSkewSeconds !== undefined ? { clockSkewSeconds: options.clockSkewSeconds } : {}),
    ...(options.requireExp !== undefined ? { requireExp: options.requireExp } : {}),
    ...(options.requireSubject !== undefined ? { requireSubject: options.requireSubject } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}
