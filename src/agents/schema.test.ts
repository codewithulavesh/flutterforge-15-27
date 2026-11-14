import { afterEach, describe, expect, it, vi } from 'vitest';
import { validate, assertValid, s } from './schema';
import { callLLMJsonStrict, AgentSchemaError, AGENT_ROLES } from './llmClient';

const schema = s.object({
  name: s.string(1),
  domain: s.strEnum('ecommerce', 'fitness', 'general'),
  needsSupabase: s.boolean(),
  retryCount: s.int(0, 10),
  tags: s.strings(1, 10),
  config: s.record(s.string()),
});

describe('schema validator', () => {
  it('accepts a valid payload untouched', () => {
    const ok = validate<Record<string, unknown>>(schema, {
      name: 'demo',
      domain: 'ecommerce',
      needsSupabase: true,
      retryCount: 2,
      tags: ['a', 'b'],
      config: { theme: 'dark' },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value).toEqual({
        name: 'demo',
        domain: 'ecommerce',
        needsSupabase: true,
        retryCount: 2,
        tags: ['a', 'b'],
        config: { theme: 'dark' },
      });
    }
  });

  it('coerces LLMs favorite sins: string booleans, numeric strings, scalar in array, wrong-case enum', () => {
    const ok = validate<Record<string, unknown>>(schema, {
      name: 'demo',
      domain: 'ECOMMERCE',
      needsSupabase: 'yes',
      retryCount: '3',
      tags: 'solo',
      config: { theme: 'dark' },
    } as never);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value).toMatchObject({ domain: 'ecommerce', needsSupabase: true, retryCount: 3, tags: ['solo'] });
    }
  });

  it('reports missing keys with path', () => {
    const bad = validate(schema, { name: 'x' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.some((e) => e.includes('$.domain'))).toBe(true);
      expect(bad.errors.some((e) => e.includes('$.tags'))).toBe(true);
    }
  });

  it('reports nested object path errors', () => {
    const deep = s.object({
      tables: s.array(
        s.object({
          name: s.string(1),
          columns: s.array(s.object({ name: s.string(1), type: s.string(1) }), 1),
        }),
        1,
      ),
    });
    const bad = validate(deep, { tables: [{ name: 't', columns: [{ name: '', type: 'uuid' }] }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors[0]).toMatch(/\$\.tables\[0\]\.columns\[0\]\.name/);
    }
  });

  it('assertValid throws with a readable error list', () => {
    expect(() => assertValid(schema, { name: '' })).toThrow(/schema validation/i);
  });
});

function mockLLMSequence(contents: Array<string | null>) {
  let calls = 0;
  const fetchMock = vi.fn().mockImplementation(() => {
    const content = contents[calls];
    calls += 1;
    if (content === null) {
      return Promise.resolve(new Response('upstream exploded', { status: 500 }));
    }
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content } }],
      model: 'mock/model',
    }), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('callLLMJsonStrict', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns parsed+validated output on first try', async () => {
    mockLLMSequence([JSON.stringify({ appName: 'ShopFlow', oneLiner: 'A shop for everyone' })]);
    const result = await callLLMJsonStrict<{ appName: string; oneLiner: string }>(
      [{ role: 'user', content: 'build' }],
      (data) => validate(s.object({ appName: s.string(1), oneLiner: s.string(1) }), data),
    );
    expect(result).toEqual({ appName: 'ShopFlow', oneLiner: 'A shop for everyone' });
  });

  it('retries once with corrective feedback when the model emits junk, then succeeds', async () => {
    const fetchMock = mockLLMSequence([
      'this is not json at all',
      JSON.stringify({ appName: 'ShopFlow', oneLiner: 'fixed' }),
    ]);
    const result = await callLLMJsonStrict<{ appName: string; oneLiner: string }>(
      [{ role: 'user', content: 'build' }],
      (data) => validate(s.object({ appName: s.string(1), oneLiner: s.string(1) }), data),
    );
    expect(result.appName).toBe('ShopFlow');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchMock.mock.calls[1] as [string, { body?: string }])[1].body as string);
    const secondUser = secondBody.messages[secondBody.messages.length - 1].content as string;
    expect(secondUser).toContain('failed schema validation');
  });

  it('throws AgentSchemaError with all errors when the retry is also invalid', async () => {
    mockLLMSequence([
      'garbage one',
      'garbage two',
    ]);
    await expect(
      callLLMJsonStrict(
        [{ role: 'user', content: 'build' }],
        (data) => validate(s.object({ appName: s.string(1) }), data),
      ),
    ).rejects.toThrow(AgentSchemaError);
  });
});

describe('agent model roles', () => {
  it('routes planner-tier agents to frontier', () => {
    expect(AGENT_ROLES['feature-planner']).toBe('frontier');
    expect(AGENT_ROLES['architecture']).toBe('frontier');
    expect(AGENT_ROLES['intake']).toBe('frontier');
    expect(AGENT_ROLES['ux-research']).toBe('frontier');
    expect(AGENT_ROLES['frontend-builder']).toBe('frontier');
  });

  it('routes mechanical agents to economy', () => {
    for (const id of ['design-system', 'data-model', 'data-models', 'code-gen', 'backend-api', 'integration', 'qa-validation', 'repair', 'edit'] as const) {
      expect(AGENT_ROLES[id]).toBe('economy');
    }
  });
});
