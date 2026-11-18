/**
 * Encrypted secret vault (AES-256-GCM + scrypt KDF).
 *
 * Secrets stored in the vault are:
 *   - sealed at rest with a per-vault key derived from a caller-supplied
 *    master secret via scrypt;
 *   - encrypted with a fresh random IV per secret;
 *   - authenticated with the GCM tag, so tampering, truncation or
 *     substitution of any field is detected before the plaintext is
 *     returned;
 *   - never returned for list/lookup calls — only names come back;
 *   - never logged or emitted as events.
 *
 * The vault file is written with mode 0o600 and owned by the process user.
 * Master-key material is supplied by the caller from the environment; it is
 * never persisted, never committed to the repo, and never serialized into a
 * response.
 *
 * API keys for third-party model/SSH/cloud providers should be stored here
 * instead of in `.env` when the platform is deployed as a service. For the
 * desktop-first shape, callers may choose `.env` for developer convenience;
 * the vault is the supported production boundary and is what
 * `docs/PLATFORM_CONTROL_PLANE.md` directs reviewers to.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { PlatformError } from '../kernel/errors.js';
import { sha256Hex } from '../kernel/hash.js';

export interface VaultSealResult {
  id: string;
  name: string;
  ciphertext: string;
  iv: string;
  tag: string;
  aad: string;
  createdAt: number;
}

export interface VaultRecord extends VaultSealResult {
  version: 1;
}

interface VaultFile {
  version: 1;
  kdf: { salt: string; n: number; r: number; p: number; keylen: number };
  secrets: Record<string, VaultRecord>;
}

export interface VaultOptions {
  /** File path; created if missing. Mode 0o600 enforced on every write. */
  file: string;
  /** 32-byte hex or raw utf8 master secret. Never persisted by this module. */
  masterKey: string;
  now?: () => number;
}

const VERSION = 1;
const DEFAULT_KDF = { n: 2 ** 14, r: 8 as const, p: 1 as const, keylen: 32 as const } as const;
const MIN_KEY_BYTES = 32;

function normalizeMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < MIN_KEY_BYTES) {
    throw new PlatformError({
      code: 'VAULT_MASTER_KEY_WEAK',
      message: 'Master key must be at least 32 bytes of entropy.',
      statusCode: 500,
    });
  }
  // Accept 64-char hex as raw bytes; otherwise use utf8 bytes.
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  return Buffer.from(trimmed, 'utf8');
}

function deriveVaultKey(masterKey: Buffer, salt: Buffer, kdf: { n: number; r: number; p: number; keylen: number }): Buffer {
  return scryptSync(masterKey, salt, kdf.keylen, {
    N: kdf.n,
    r: kdf.r,
    p: kdf.p,
    maxmem: 1 << 29,
  });
}

function encrypt(plaintext: string, vaultKey: Buffer, name: string, now: number): VaultSealResult {
  const iv = randomBytes(12);
  const aad = Buffer.from(`vault/${VERSION}/${name}`, 'utf8');
  const cipher = createCipheriv('aes-256-gcm', vaultKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    id: `${name}-${sha256Hex(name).slice(0, 8)}`,
    name,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    aad: aad.toString('base64'),
    createdAt: now,
  };
}

function decrypt(record: VaultRecord, vaultKey: Buffer): string {
  const ciphertext = Buffer.from(record.ciphertext, 'base64');
  const iv = Buffer.from(record.iv, 'base64');
  const tag = Buffer.from(record.tag, 'base64');
  const aad = Buffer.from(record.aad, 'base64');
  try {
    const decipher = createDecipheriv('aes-256-gcm', vaultKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Do not leak which field was corrupted; a GCM tag mismatch covers it.
    throw new PlatformError({
      code: 'VAULT_DECRYPT_FAILED',
      message: `Secret "${record.name}" failed integrity verification.`,
      statusCode: 500,
    });
  }
}

async function readVaultFile(file: string): Promise<VaultFile | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as VaultFile;
    if (parsed?.version !== VERSION || !parsed.kdf || typeof parsed.secrets !== 'object' || !parsed.secrets) {
      throw new PlatformError({
        code: 'VAULT_CORRUPT',
        message: `Vault file ${file} is malformed or was written by a different platform version.`,
        statusCode: 500,
      });
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    if (error instanceof PlatformError) throw error;
    throw new PlatformError({
      code: 'VAULT_CORRUPT',
      message: `Vault file ${file} is not readable.`,
      statusCode: 500,
      cause: error,
    });
  }
}

async function writeVaultFile(file: string, payload: VaultFile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fs.open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(payload, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const dirHandle = await fs.open(path.dirname(file), 'r');
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
  await fs.rename(temporary, file);
}

export interface Vault {
  /** Create or update a secret. Returns the redacted record (never plaintext). */
  set(name: string, value: string): Promise<VaultSealResult>;
  /** Fetch and decrypt a secret. Throws when missing or on integrity failure. */
  get(name: string): Promise<string>;
  /** Redacted list of names only. */
  list(): Promise<string[]>;
  /** Remove a secret; returns true when it existed. */
  delete(name: string): Promise<boolean>;
  /** Re-encrypt all secrets under a new master key; atomic. */
  rotate(newMasterKey: string): Promise<void>;
}

export async function createVault(options: VaultOptions): Promise<Vault> {
  const file = path.resolve(options.file);
  const masterKey = normalizeMasterKey(options.masterKey);
  const now = options.now ?? Date.now;

  const existing = await readVaultFile(file);
  const salt = existing?.kdf?.salt ? Buffer.from(existing.kdf.salt, 'base64') : randomBytes(16);
  const kdf = existing?.kdf ? existing.kdf : { ...DEFAULT_KDF, salt: salt.toString('base64') };
  const vaultKey = deriveVaultKey(masterKey, salt, kdf);

  if (!existing) {
    const fresh: VaultFile = { version: VERSION, kdf, secrets: {} };
    await writeVaultFile(file, fresh);
  }

  const vault: Vault = {
    async set(name, value) {
      if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) {
        throw new PlatformError({
          code: 'VAULT_NAME_INVALID',
          message: 'Secret names must match /^[A-Za-z0-9._-]{1,120}$/.',
          statusCode: 400,
        });
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new PlatformError({
          code: 'VAULT_VALUE_INVALID',
          message: 'Secret value must be a non-empty string.',
          statusCode: 400,
        });
      }
      const sealed = encrypt(value, vaultKey, name, now());
      const current = await readVaultFile(file);
      if (!current) {
        throw new PlatformError({ code: 'VAULT_CORRUPT', message: 'Vault vanished between read and write.', statusCode: 500 });
      }
      current.secrets[name] = { ...sealed, version: VERSION };
      await writeVaultFile(file, current);
      return sealed;
    },
    async get(name) {
      const current = await readVaultFile(file);
      const record = current?.secrets?.[name];
      if (!record) {
        throw new PlatformError({
          code: 'VAULT_SECRET_NOT_FOUND',
          message: `Secret "${name}" is not present in the vault.`,
          statusCode: 404,
        });
      }
      return decrypt(record, vaultKey);
    },
    async list() {
      const current = await readVaultFile(file);
      return Object.keys(current?.secrets ?? {}).sort();
    },
    async delete(name) {
      const current = await readVaultFile(file);
      if (!current?.secrets[name]) return false;
      delete current.secrets[name];
      await writeVaultFile(file, current);
      return true;
    },
    async rotate(newMasterKey) {
      const next = normalizeMasterKey(newMasterKey);
      if (timingSafeEqual(next, masterKey)) {
        throw new PlatformError({
          code: 'VAULT_ROTATE_NOOP',
          message: 'The provided new master key is identical to the current one; rotation would be a no-op.',
          statusCode: 400,
        });
      }
      const current = await readVaultFile(file);
      if (!current) {
        throw new PlatformError({ code: 'VAULT_CORRUPT', message: 'Vault vanished before rotation.', statusCode: 500 });
      }
      const nextSalt = randomBytes(16);
      const nextKdf = { ...DEFAULT_KDF, salt: nextSalt.toString('base64') };
      const nextVaultKey = deriveVaultKey(next, nextSalt, nextKdf);
      const secrets: Record<string, VaultRecord> = {};
      for (const [name, record] of Object.entries(current.secrets)) {
        const clear = decrypt(record, vaultKey);
        const resealed = encrypt(clear, nextVaultKey, name, now());
        secrets[name] = { ...resealed, version: VERSION };
      }
      await writeVaultFile(file, { version: VERSION, kdf: nextKdf, secrets });
    },
  };

  return vault;
}

/**
 * Construct a vault from environment configuration. Returns null when no
 * master key is configured so callers can branch honestly instead of mocking
 * encryption.
 */
export async function createVaultFromEnv(env: NodeJS.ProcessEnv = process.env, dataDir?: string): Promise<Vault | null> {
  const masterKey =
    env.FLUTTERFORGE_VAULT_KEY?.trim()
    || env.FLUTTERFORGE_MASTER_KEY?.trim()
    || '';
  if (!masterKey) return null;
  const file = path.join(dataDir ?? env.FLUTTERFORGE_DATA_DIR ?? path.join(process.cwd(), '.flutterforge'), 'vault.json');
  return createVault({ file, masterKey });
}
