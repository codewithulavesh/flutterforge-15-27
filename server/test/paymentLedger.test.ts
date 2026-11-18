import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PaymentLedger } from '../paymentLedger.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ff-ledger-'));
  file = path.join(dir, 'razorpay-ledger.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('grantOnce executes the grant exactly once per payment id', async () => {
  const ledger = new PaymentLedger(file);
  let calls = 0;
  const grant = async () => {
    calls += 1;
    return { paymentId: 'pay_1', plan: 'pro', userId: 'user_1', grantedAt: 1 };
  };

  const first = await ledger.grantOnce('pay_1', grant);
  const second = await ledger.grantOnce('pay_1', grant);

  assert.equal(calls, 1);
  assert.equal(first?.granted, true);
  assert.equal(second?.granted, false);
  assert.equal(second?.duplicate, true);
  assert.equal(second?.entry.plan, 'pro');
});

test('grantOnce dedupes concurrent in-flight grants', async () => {
  const ledger = new PaymentLedger(file);
  let calls = 0;
  const grant = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { paymentId: 'pay_race', plan: 'team', userId: 'user_9', grantedAt: 2 };
  };

  const [a, b, c] = await Promise.all([
    ledger.grantOnce('pay_race', grant),
    ledger.grantOnce('pay_race', grant),
    ledger.grantOnce('pay_race', grant),
  ]);
  assert.equal(calls, 1);
  assert.equal([a?.granted, b?.granted, c?.granted].filter(Boolean).length, 1);
});

test('a failed grant is not recorded and can be retried', async () => {
  const ledger = new PaymentLedger(file);
  const failing = await ledger.grantOnce('pay_fail', async () => null);
  assert.equal(failing, null);
  assert.equal(ledger.has('pay_fail'), false);

  const retried = await ledger.grantOnce('pay_fail', async () => ({
    paymentId: 'pay_fail', plan: 'pro', userId: 'user_1', grantedAt: 3,
  }));
  assert.equal(retried?.granted, true);
});

test('a throwing grant is not recorded', async () => {
  const ledger = new PaymentLedger(file);
  const result = await ledger.grantOnce('pay_throw', async () => {
    throw new Error('supabase down');
  });
  assert.equal(result, null);
  assert.equal(ledger.has('pay_throw'), false);
});

test('ledger persists across instances (survives restart)', async () => {
  const first = new PaymentLedger(file);
  await first.grantOnce('pay_durable', async () => ({
    paymentId: 'pay_durable', plan: 'team', userId: 'user_2', grantedAt: 4,
  }));

  const second = new PaymentLedger(file);
  assert.equal(second.has('pay_durable'), true);
  const replay = await second.grantOnce('pay_durable', async () => {
    throw new Error('must not run');
  });
  assert.equal(replay?.duplicate, true);
});

test('a corrupt ledger file is quarantined and starts empty', async () => {
  writeFileSync(file, '{not json', 'utf8');
  const ledger = new PaymentLedger(file);
  assert.equal(ledger.has('pay_any'), false);
  const result = await ledger.grantOnce('pay_any', async () => ({
    paymentId: 'pay_any', plan: 'pro', userId: 'user_3', grantedAt: 5,
  }));
  assert.equal(result?.granted, true);
  // The corrupt file was moved aside.
  assert.equal(existsSync(file), true); // new ledger written on top
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(parsed.entries));
});

test('entries from other payment ids do not collide', async () => {
  const ledger = new PaymentLedger(file);
  await ledger.grantOnce('pay_a', async () => ({ paymentId: 'pay_a', plan: 'pro', userId: 'u', grantedAt: 1 }));
  const other = await ledger.grantOnce('pay_b', async () => ({ paymentId: 'pay_b', plan: 'pro', userId: 'u', grantedAt: 2 }));
  assert.equal(other?.granted, true);
});

test('blank payment ids are refused', async () => {
  const ledger = new PaymentLedger(file);
  assert.equal(await ledger.grantOnce('', async () => null), null);
  assert.equal(await ledger.grantOnce('   ', async () => null), null);
});
