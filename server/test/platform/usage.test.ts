import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from '../../platform/storage/database.js';
import { PLATFORM_MIGRATIONS } from '../../platform/storage/schema.js';
import { AuditLog } from '../../platform/audit/auditLog.js';
import { ManualClock } from '../../platform/kernel/clock.js';
import {
  COST_MICROS_PER_USD,
  MeteringService,
  PROVIDER_PRICE_TABLE,
  estimateCostMicros,
  type UsageRecordInput,
} from '../../platform/metering/index.js';

const T0 = 1_700_000_000_000; // deterministic epoch ms

async function tempDb(): Promise<{ db: Database; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flutterforge-metering-'));
  const db = await Database.open({ file: path.join(dir, 'test.sqlite') });
  await db.migrate(PLATFORM_MIGRATIONS);
  return {
    db,
    cleanup: async () => {
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function makeInput(overrides: Partial<UsageRecordInput> = {}): UsageRecordInput {
  return {
    tenantId: 'tenant-1',
    provider: 'deepseek',
    model: 'deepseek-chat',
    promptTokens: 1000,
    completionTokens: 500,
    ...overrides,
  };
}

async function assertMeteringInvalid(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string })?.code, 'METERING_INVALID', `expected METERING_INVALID, got ${(error as Error)?.stack ?? error}`);
    return true;
  });
}

async function rowCount(db: Database, tenantId: string): Promise<number> {
  const row = await db.get<{ n: number | bigint }>('SELECT COUNT(*) AS n FROM token_usage WHERE tenant_id = ?', tenantId);
  return Number(row?.n ?? 0);
}

test('unit contract: 1_000_000 micros = $1', () => {
  assert.equal(COST_MICROS_PER_USD, 1_000_000);
});

test('record + summary roundtrip with exact token and cost math', async () => {
  const { db, cleanup } = await tempDb();
  const clock = new ManualClock(T0);
  try {
    const metering = new MeteringService({ db, clock });

    const first = await metering.record(makeInput({
      tenantId: 'roundtrip',
      promptTokens: 2000,
      completionTokens: 1000,
    }));
    assert.ok(first.id > 0);
    clock.advance(5_000);
    const second = await metering.record(makeInput({
      tenantId: 'roundtrip',
      promptTokens: 1000,
      completionTokens: 500,
      cachedTokens: 500,
    }));
    assert.ok(second.id > first.id);

    // deepseek-chat: 140 micros/1k prompt, 280 completion, 14 cached.
    // call 2: billable prompt 500*140/1000 = 70; cached 500*14/1000 = 7; completion 500*280/1000 = 140 → 217.
    const summary = await metering.summary({ tenantId: 'roundtrip' });
    assert.equal(summary.callCount, 2);
    assert.equal(summary.totalPromptTokens, 3000);
    assert.equal(summary.totalCompletionTokens, 1500);
    assert.equal(summary.totalCachedTokens, 500);
    assert.equal(summary.totalCostMicros, 560 + 217); // 777, exact integer micros
    assert.equal(summary.windowStartMs, 0);   // no reset yet, no sinceMs
    assert.equal(summary.windowEndMs, T0 + 5_000);

    // Recorded rows carry the same arithmetic as the summary.
    const rows = await db.all<{ cost_micros: number }>('SELECT cost_micros FROM token_usage WHERE tenant_id = ? ORDER BY id', 'roundtrip');
    assert.deepEqual(rows.map((r) => r.cost_micros), [560, 217]);
  } finally {
    await cleanup();
  }
});

test('unknown model records cost_micros 0; priced models come from the table; explicit costMicros overrides', async () => {
  const { db, cleanup } = await tempDb();
  const clock = new ManualClock(T0);
  try {
    const metering = new MeteringService({ db, clock });

    await metering.record(makeInput({ tenantId: 'pricing', model: 'no-such-model', promptTokens: 9_999_999, completionTokens: 9_999_999 }));
    await metering.record(makeInput({ tenantId: 'pricing', provider: 'openai', model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 500 }));
    await metering.record(makeInput({ tenantId: 'pricing', model: 'deepseek-chat', promptTokens: 1000, completionTokens: 500, costMicros: 7 }));

    const rows = await db.all<{ model: string; cost_micros: number }>(
      'SELECT model, cost_micros FROM token_usage WHERE tenant_id = ? ORDER BY id',
      'pricing',
    );
    // gpt-4o-mini: prompt 1000*150/1000 = 150; completion 500*600/1000 = 300 → 450.
    assert.deepEqual(rows, [
      { model: 'no-such-model', cost_micros: 0 },
      { model: 'gpt-4o-mini', cost_micros: 450 },
      { model: 'deepseek-chat', cost_micros: 7 },
    ]);

    // estimateCostMicros agrees with the persisted rows, including table shape.
    assert.equal(estimateCostMicros('deepseek', 'deepseek-chat', 2000, 1000, 0), 560);
    assert.equal(estimateCostMicros('openai', 'openrouter-free', 10_000, 10_000, 0), 0);
    assert.equal(estimateCostMicros('openai', 'definitely-unknown-xyz', 10_000, 10_000, 0), 0);
    assert.ok(PROVIDER_PRICE_TABLE['deepseek-chat']);

    // Half-up rounding at the whole-micro boundary: gemini-2.0-flash bills 100 micros/1k
    // prompt → 5 prompt tokens = exactly 500 numerator → rounds UP to 1 micro.
    assert.equal(estimateCostMicros('google', 'gemini-2.0-flash', 5, 0, 0), 1);
  } finally {
    await cleanup();
  }
});

test('checkQuota: under limit allowed; exact token limit denied; empty tenant allowed', async () => {
  const { db, cleanup } = await tempDb();
  const clock = new ManualClock(T0);
  try {
    const metering = new MeteringService({ db, clock });

    // No quota configured at all → allowed with the documented reason.
    const unconfigured = await metering.checkQuota('no-quota-tenant');
    assert.equal(unconfigured.allowed, true);
    assert.equal(unconfigured.reason, 'no-quota-configured');

    // Quota configured, zero usage → allowed with full headroom.
    await metering.setQuota({ tenantId: 'empty-tenant', windowMs: 60_000, limitTokens: 3000, costBasis: 'tokens' });
    const emptyUsed = await metering.checkQuota('empty-tenant');
    assert.equal(emptyUsed.allowed, true);
    assert.equal(emptyUsed.usedTokens, 0);
    assert.equal(emptyUsed.remainingTokens, 3000);

    // Under the limit → allowed.
    await metering.setQuota({ tenantId: 'under-tenant', windowMs: 60_000, limitTokens: 3000, costBasis: 'tokens' });
    await metering.record(makeInput({ tenantId: 'under-tenant', promptTokens: 2000, completionTokens: 500 }));
    const under = await metering.checkQuota('under-tenant');
    assert.equal(under.allowed, true);
    assert.equal(under.reason, undefined);
    assert.equal(under.usedTokens, 2500);
    assert.equal(under.remainingTokens, 500);
    assert.equal(under.limitTokens, 3000);
    assert.equal(under.costBasis, 'tokens');

    // Exactly at the limit → denied (limits are inclusive).
    await metering.setQuota({ tenantId: 'exact-tenant', windowMs: 60_000, limitTokens: 3000, costBasis: 'tokens' });
    await metering.record(makeInput({ tenantId: 'exact-tenant', promptTokens: 2000, completionTokens: 1000 }));
    const atLimit = await metering.checkQuota('exact-tenant');
    assert.equal(atLimit.allowed, false);
    assert.equal(atLimit.reason, 'QUOTA_EXCEEDED');
    assert.equal(atLimit.usedTokens, 3000);
    assert.equal(atLimit.remainingTokens, 0);
  } finally {
    await cleanup();
  }
});

test('checkQuota: micros basis denies at the exact cost limit and infers costBasis', async () => {
  const { db, cleanup } = await tempDb();
  const clock = new ManualClock(T0);
  try {
    const metering = new MeteringService({ db, clock });

    // costBasis inferred as 'micros' when only limitMicros is provided.
    await metering.setQuota({ tenantId: 'micros-tenant', windowMs: 60_000, limitMicros: 560 });
    const rule = await metering.getQuota('micros-tenant');
    assert.equal(rule?.costBasis, 'micros');
    assert.equal(rule?.limitMicros, 560);
    assert.equal(COST_MICROS_PER_USD, 1_000_000);

    // 2000 prompt @140 + 1000 completion @280 = exactly 560 micros.
    await metering.record(makeInput({ tenantId: 'micros-tenant', promptTokens: 2000, completionTokens: 1000 }));
    const atLimit = await metering.checkQuota('micros-tenant');
    assert.equal(atLimit.allowed, false);
    assert.equal(atLimit.reason, 'QUOTA_EXCEEDED');
    assert.equal(atLimit.costBasis, 'micros');
    assert.equal(atLimit.usedMicros, 560);
    assert.equal(atLimit.remainingMicros, 0);
    assert.equal(atLimit.limitMicros, 560);
  } finally {
    await cleanup();
  }
});

test('chargeFor: first call ok, later call over budget denied, denied call inserts no row', async () => {
  const { db, cleanup } = await tempDb();
  const clock = new ManualClock(T0);
  try {
    const metering = new MeteringService({ db, clock });
    await metering.setQuota({ tenantId: 'charge-micros', windowMs: 60_000, limitMicros: 600, costBasis: 'micros' });

    const first = await metering.chargeFor(makeInput({ tenantId: 'charge-micros', promptTokens: 2000, completionTokens: 1000 }));
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.usage.costMicros, 560);
      assert.equal(first.quota.usedMicros, 560); // post-call projection
    }

    const denied = await metering.chargeFor(makeInput({ tenantId: 'charge-micros', promptTokens: 2000, completionTokens: 1000 }));
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.reason, 'QUOTA_EXCEEDED');
      assert.equal(denied.quota?.usedMicros, 1120); // projection includes the incoming call
    }

    // The denied call must NOT have been recorded.
    assert.equal(await rowCount(db, 'charge-micros'), 1);
    assert.equal((await metering.summary({ tenantId: 'charge-micros' })).callCount, 1);

    // Tokens basis: a call that fits exactly is allowed; the next one is not.
    await metering.setQuota({ tenantId: 'charge-tokens', windowMs: 60_000, limitTokens: 2500, costBasis: 'tokens' });
    const exactFit = await metering.chargeFor(makeInput({ tenantId: 'charge-tokens', promptTokens: 1500, completionTokens: 1000 }));
    assert.equal(exactFit.ok, true);
    const overflow = await metering.chargeFor(makeInput({ tenantId: 'charge-tokens', promptTokens: 1, completionTokens: 0 }));
    assert.equal(overflow.ok, false);
    if (!overflow.ok) assert.equal(overflow.reason, 'QUOTA_EXCEEDED');
    assert.equal(await rowCount(db, 'charge-tokens'), 1);
  } finally {
    await cleanup();
  }
});

test('summary window honors sinceMs/untilMs and excludes pre-reset rows after resetWindow', async () => {
  const { db, cleanup } = await tempDb();
  const clock = new ManualClock(T0);
  try {
    const metering = new MeteringService({ db, clock });
    await metering.record(makeInput({ tenantId: 'window', promptTokens: 1000, completionTokens: 1000, recordedAt: T0 }));
    clock.set(T0 + 10_000);
    await metering.record(makeInput({ tenantId: 'window', promptTokens: 1000, completionTokens: 1000, recordedAt: T0 + 10_000 }));
    clock.set(T0 + 20_000);
    await metering.record(makeInput({ tenantId: 'window', promptTokens: 1000, completionTokens: 1000, recordedAt: T0 + 20_000 }));

    const all = await metering.summary({ tenantId: 'window' });
    assert.equal(all.callCount, 3);
    assert.equal(all.windowStartMs, 0);

    const sinceOnly = await metering.summary({ tenantId: 'window', sinceMs: T0 + 10_000 });
    assert.equal(sinceOnly.callCount, 2);
    assert.equal(sinceOnly.windowStartMs, T0 + 10_000);

    const exactMid = await metering.summary({ tenantId: 'window', sinceMs: T0 + 10_000, untilMs: T0 + 10_000 });
    assert.equal(exactMid.callCount, 1);
    assert.equal(exactMid.totalPromptTokens, 1000);
    assert.equal(exactMid.windowStartMs, T0 + 10_000);
    assert.equal(exactMid.windowEndMs, T0 + 10_000);

    // Inverted window is rejected.
    await assertMeteringInvalid(metering.summary({ tenantId: 'window', sinceMs: T0 + 10_000, untilMs: T0 }));

    // Reset the window boundary at T0+20_000; earlier rows must vanish from aggregates.
    const reset = await metering.resetWindow('window');
    assert.equal(reset.resetAtMs, T0 + 20_000);

    const afterReset = await metering.summary({ tenantId: 'window' });
    assert.equal(afterReset.callCount, 0);
    assert.equal(afterReset.totalPromptTokens, 0);
    assert.equal(afterReset.totalCostMicros, 0);
    assert.equal(afterReset.windowStartMs, T0 + 20_000);
    assert.equal(afterReset.windowEndMs, T0 + 20_000);

    clock.set(T0 + 21_000);
    await metering.record(makeInput({ tenantId: 'window', promptTokens: 1000, completionTokens: 1000, recordedAt: T0 + 21_000 }));
    const postReset = await metering.summary({ tenantId: 'window' });
    assert.equal(postReset.callCount, 1);
    assert.equal(postReset.totalPromptTokens, 1000);

    // Quota accounting obeys the same boundary.
    await metering.setQuota({ tenantId: 'window', windowMs: 86_400_000, limitTokens: 10_000, costBasis: 'tokens' });
    const quotaCheck = await metering.checkQuota('window');
    assert.equal(quotaCheck.usedTokens, 2000); // only the post-reset record

    // The marker also surfaced on the quota row via resetWindow.
    const rule = await metering.getQuota('window');
    assert.equal(rule?.resetAtMs, T0 + 20_000);
  } finally {
    await cleanup();
  }
});

test('pruneRetention deletes old rows for the tenant only', async () => {
  const { db, cleanup } = await tempDb();
  const clock = new ManualClock(T0);
  try {
    const metering = new MeteringService({ db, clock });
    // Old rows (recorded 40 days ago via explicit recordedAt).
    await metering.record(makeInput({ tenantId: 'prune', promptTokens: 10, completionTokens: 10, recordedAt: T0 }));
    await metering.record(makeInput({ tenantId: 'other-tenant', promptTokens: 10, completionTokens: 10, recordedAt: T0 }));
    // Fresh row after advancing the clock.
    clock.set(T0 + 40 * 86_400_000);
    await metering.record(makeInput({ tenantId: 'prune', promptTokens: 10, completionTokens: 10 }));

    const result = await metering.pruneRetention('prune', 30);
    assert.equal(result.deleted, 1);
    assert.equal(await rowCount(db, 'prune'), 1);
    assert.equal(await rowCount(db, 'other-tenant'), 1); // untouched

    await assertMeteringInvalid(metering.pruneRetention('prune', 0));
    await assertMeteringInvalid(metering.pruneRetention('prune', 3651));
  } finally {
    await cleanup();
  }
});

test('LLM-ish labels insert fine; invalid inputs are rejected with METERING_INVALID', async () => {
  const { db, cleanup } = await tempDb();
  const clock = new ManualClock(T0);
  try {
    const metering = new MeteringService({ db, clock });

    const labelled = await metering.record(makeInput({
      tenantId: 'labels',
      label: 'agent "nightly-build" gpt-4o 🚀 step #42 — 100% done; ratio=0.5',
    }));
    assert.ok(labelled.id > 0);
    assert.equal(await rowCount(db, 'labels'), 1);

    // Labels with control characters / overlong labels are rejected.
    await assertMeteringInvalid(metering.record(makeInput({ tenantId: 'labels', label: 'bad\nlabel' })));
    await assertMeteringInvalid(metering.record(makeInput({ tenantId: 'labels', label: 'a'.repeat(513) })));

    const badInputs: Array<Partial<UsageRecordInput>> = [
      { promptTokens: -1 },
      { promptTokens: 10_000_001 },
      { promptTokens: 1.5 },
      { promptTokens: Number.NaN },
      { completionTokens: -1 },
      { completionTokens: Number.NaN },
      { cachedTokens: 10, promptTokens: 5 }, // cached > prompt
      { costMicros: -1 },
      { costMicros: 10_000_001 },
      { costMicros: 1.5 },
      { provider: 'DeepSeek' },
      { provider: 'deepseek v3' },
      { provider: '' },
      { provider: 'x'.repeat(65) },
      { model: 'gpt 4o' },
      { model: 'GPT-4o' },
      { model: '' },
      { model: 'openrouter/free' }, // single-segment ids only; use model 'openrouter-free'
      { tenantId: '' },
      { recordedAt: -1 },
    ];
    for (const bad of badInputs) {
      await assertMeteringInvalid(metering.record(makeInput({ tenantId: 'labels', ...bad })));
    }
    assert.equal(await rowCount(db, 'labels'), 1); // only the good record landed
  } finally {
    await cleanup();
  }
});

test('audit fires only on QUOTA_EXCEEDED and quota rule changes', async () => {
  const { db, cleanup } = await tempDb();
  const clock = new ManualClock(T0);
  try {
    const audit = new AuditLog(db, clock);
    const metering = new MeteringService({ db, clock, audit });

    // Successful records and the ok charge call must NOT be audited.
    // Budget 1000 micros: record (140) + charge A (560) fits; charge B would
    // project 1260 > 1000 and is denied.
    await metering.setQuota({ tenantId: 'audited', windowMs: 60_000, limitMicros: 1000, actor: 'admin@example.com' });
    await metering.record(makeInput({ tenantId: 'audited', promptTokens: 1000, completionTokens: 0 }));
    const okCall = await metering.chargeFor(makeInput({ tenantId: 'audited', promptTokens: 2000, completionTokens: 1000 }));
    assert.equal(okCall.ok, true);

    // Over-budget call → denied and audited exactly once.
    const denied = await metering.chargeFor(makeInput({ tenantId: 'audited', promptTokens: 2000, completionTokens: 1000 }));
    assert.equal(denied.ok, false);

    await metering.resetWindow('audited');

    const entries = await audit.list({ tenantId: 'audited' });
    assert.deepEqual(entries.map((entry) => entry.action), [
      'metering.quota_set',
      'metering.quota_exceeded',
      'metering.quota_reset',
    ]);
    assert.equal(entries[0].actor, 'admin@example.com');
    assert.equal(entries[1].resourceType, 'tenant_quota');
  } finally {
    await cleanup();
  }
});

test('setQuota validation, getQuota roundtrip and inferred costBasis', async () => {
  const { db, cleanup } = await tempDb();
  const clock = new ManualClock(T0);
  try {
    const metering = new MeteringService({ db, clock });

    assert.equal(await metering.getQuota('unset-tenant'), null);

    await assertMeteringInvalid(metering.setQuota({ tenantId: 'v', windowMs: 60_000 }));
    await assertMeteringInvalid(metering.setQuota({ tenantId: 'v', windowMs: 60_000, costBasis: 'micros', limitTokens: 10 }));
    await assertMeteringInvalid(metering.setQuota({ tenantId: 'v', windowMs: 60_000, costBasis: 'tokens', limitMicros: 10 }));
    await assertMeteringInvalid(metering.setQuota({ tenantId: 'v', windowMs: 0, limitMicros: 10 }));
    await assertMeteringInvalid(metering.setQuota({ tenantId: 'v', windowMs: 60_000, limitTokens: -5 }));

    // Both limits set, no costBasis → defaults to micros.
    await metering.setQuota({ tenantId: 'both', windowMs: 60_000, limitMicros: 1000, limitTokens: 5000 });
    const both = await metering.getQuota('both');
    assert.equal(both?.costBasis, 'micros');
    assert.equal(both?.limitMicros, 1000);
    assert.equal(both?.limitTokens, 5000);
    assert.equal(both?.windowMs, 60_000);

    // Persisted shape matches the documented platform_settings contract.
    const raw = await db.get<{ value_json: string; updated_at: number }>(
      'SELECT value_json, updated_at FROM platform_settings WHERE key = ?',
      'quota:both',
    );
    assert.ok(raw);
    const persisted = JSON.parse(raw.value_json) as Record<string, unknown>;
    assert.equal(persisted.windowMs, 60_000);
    assert.equal(persisted.limitMicros, 1000);
    assert.equal(persisted.limitTokens, 5000);
    assert.equal(persisted.costBasis, 'micros');
    assert.equal(persisted.updatedAt, T0);
    assert.equal(raw.updated_at, T0);
  } finally {
    await cleanup();
  }
});

test('quota enforcement fails CLOSED when the database is down', async () => {
  const { db, cleanup } = await tempDb();
  const clock = new ManualClock(T0);
  try {
    const metering = new MeteringService({ db, clock });
    await metering.setQuota({ tenantId: 'down', windowMs: 60_000, limitMicros: 10_000_000 });

    // Simulate an outage/closed connection: checks must not grant access.
    db.close();
    const check = await metering.checkQuota('down');
    assert.equal(check.allowed, false);
    assert.equal(check.reason, 'QUOTA_CHECK_FAILED');

    const charged = await metering.chargeFor(makeInput({ tenantId: 'down', promptTokens: 1, completionTokens: 1 }));
    assert.equal(charged.ok, false);
    if (!charged.ok) assert.equal(charged.reason, 'QUOTA_CHECK_FAILED');
  } finally {
    await cleanup();
  }
});
