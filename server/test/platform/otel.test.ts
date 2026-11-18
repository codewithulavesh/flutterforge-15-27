import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spanToOtlp,
  serializeRequest,
  OtlpExporter,
  isOtlpEndpointConfigured,
  type SpanData,
} from '../../platform/observability/otel.js';

/* ---------------------------------------------------------------- helpers */

function makeSpan(overrides: Partial<SpanData> = {}): SpanData {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    name: 'test.span',
    kind: 'server',
    startTimeMs: 1_700_000_000_000,
    endTimeMs: 1_700_000_000_042,
    durationMs: 42,
    status: 'ok',
    attributes: {},
    events: [],
    ...overrides,
  };
}

interface CapturedCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function fakeFetch(handler: (call: CapturedCall, index: number) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (url: unknown, init?: unknown) => {
    const call: CapturedCall = { url: String(url), init: (init ?? {}) as CapturedCall['init'] };
    calls.push(call);
    return handler(call, calls.length);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const okJson = () => new Response('{"partialSuccess":{}}', { status: 200 });

function fakeLogger() {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  return {
    warnings,
    logger: { warn: (message: string, fields?: Record<string, unknown>) => warnings.push({ message, fields }) },
  };
}

/* ---------------------------------------------------------- spanToOtlp */

test('spanToOtlp converts typed attributes and exact nanoseconds', () => {
  const span = makeSpan({
    attributes: {
      'http.route': '/v1/runs',
      'http.status_code': 200,
      'zero': 0,
      'sample.ratio': 0.25,
      'cache.hit': false,
      'big.count': 7n,
      'meta': { nested: true },
      'missing': undefined,
      'nothing': null,
    },
  });
  const otlp = spanToOtlp(span, 'svc');

  assert.equal(otlp.traceId, 'a'.repeat(32));
  assert.equal(otlp.spanId, 'b'.repeat(16));
  assert.equal(otlp.name, 'test.span');
  assert.equal(otlp.startTimeUnixNano, '1700000000000000000');
  assert.equal(otlp.endTimeUnixNano, '1700000000042000000');
  assert.equal(String(Number(otlp.startTimeUnixNano)).length > 0, true);

  const byKey = new Map(otlp.attributes.map((kv) => [kv.key, kv.value]));
  assert.deepEqual(byKey.get('http.route'), { stringValue: '/v1/runs' });
  assert.deepEqual(byKey.get('http.status_code'), { intValue: '200' });
  assert.deepEqual(byKey.get('zero'), { intValue: '0' });
  assert.deepEqual(byKey.get('sample.ratio'), { doubleValue: 0.25 });
  assert.deepEqual(byKey.get('cache.hit'), { boolValue: false });
  assert.deepEqual(byKey.get('big.count'), { intValue: '7' });
  assert.equal(typeof byKey.get('meta')?.stringValue, 'string');
  assert.equal(byKey.has('missing'), false);
  assert.equal(byKey.has('nothing'), false);
});

test('spanToOtlp includes parentSpanId only when present and maps kind numerically', () => {
  const withParent = spanToOtlp(makeSpan({ parentSpanId: 'f'.repeat(16) }), 'svc');
  assert.equal(withParent.parentSpanId, 'f'.repeat(16));

  const withoutParent = spanToOtlp(makeSpan(), 'svc');
  assert.equal('parentSpanId' in withoutParent, false);

  const kinds: Array<[SpanData['kind'], number]> = [
    ['internal', 1],
    ['server', 2],
    ['client', 3],
    ['producer', 4],
    ['consumer', 5],
  ];
  for (const [kind, expected] of kinds) {
    assert.equal(spanToOtlp(makeSpan({ kind }), 'svc').kind, expected);
  }
});

test('spanToOtlp maps error status with message; unset/ok carry no message', () => {
  const error = spanToOtlp(
    makeSpan({ status: 'error', error: { name: 'TypeError', message: 'boom', stack: 'at x' } }),
    'svc',
  );
  assert.deepEqual(error.status, { code: 'ERROR', message: 'boom' });

  const unset = spanToOtlp(makeSpan({ status: 'unset' }), 'svc');
  assert.deepEqual(unset.status, { code: 'UNSET' });

  const ok = spanToOtlp(makeSpan({ status: 'ok' }), 'svc');
  assert.deepEqual(ok.status, { code: 'OK' });
});

test('spanToOtlp converts events to timeUnixNano + typed attributes', () => {
  const span = makeSpan({
    events: [{ name: 'exception', at: 1_700_000_000_001, attributes: { handled: true } }],
  });
  const otlp = spanToOtlp(span, 'svc');
  assert.equal(otlp.events.length, 1);
  assert.equal(otlp.events[0].name, 'exception');
  assert.equal(otlp.events[0].timeUnixNano, '1700000000001000000');
  assert.deepEqual(otlp.events[0].attributes, [{ key: 'handled', value: { boolValue: true } }]);
});

test('spanToOtlp exports unfinished spans as zero-duration (end === start)', () => {
  const otlp = spanToOtlp(makeSpan({ endTimeMs: undefined, durationMs: undefined }), 'svc');
  assert.equal(otlp.endTimeUnixNano, otlp.startTimeUnixNano);
});

/* ------------------------------------------------------- serializeRequest */

test('serializeRequest builds the resourceSpans envelope with config version/environment', () => {
  const request = serializeRequest('checkout', [makeSpan()], { serviceVersion: '3.1.4', environment: 'staging' });

  assert.equal(request.resourceSpans.length, 1);
  const resource = request.resourceSpans[0];
  const attrs = new Map(resource.resource.attributes.map((kv) => [kv.key, kv.value]));
  assert.deepEqual(attrs.get('service.name'), { stringValue: 'checkout' });
  assert.deepEqual(attrs.get('service.version'), { stringValue: '3.1.4' });
  assert.deepEqual(attrs.get('telemetry.sdk.name'), { stringValue: 'flutterforge' });
  assert.deepEqual(attrs.get('deployment.environment'), { stringValue: 'staging' });

  assert.equal(resource.scopeSpans.length, 1);
  assert.equal(resource.scopeSpans[0].scope.name, 'flutterforge');
  assert.equal(resource.scopeSpans[0].scope.version, '3.1.4');
  assert.equal(resource.scopeSpans[0].spans.length, 1);
  assert.equal(resource.scopeSpans[0].spans[0].name, 'test.span');
});

test('serializeRequest defaults service.version to 2.0.0 and omits deployment.environment', () => {
  const request = serializeRequest('svc', [makeSpan()]);
  const attrs = new Map(request.resourceSpans[0].resource.attributes.map((kv) => [kv.key, kv.value]));
  assert.deepEqual(attrs.get('service.version'), { stringValue: '2.0.0' });
  assert.equal(attrs.has('deployment.environment'), false);
  assert.equal(request.resourceSpans[0].scopeSpans[0].scope.version, '2.0.0');
});

/* ---------------------------------------------------------------- exporter */

test('exporter happy path: 3 spans → one POST to <endpoint>/v1/traces', async () => {
  const { fetchFn, calls } = fakeFetch(okJson);
  const exporter = new OtlpExporter({
    endpoint: 'http://collector.local:4318/',
    serviceName: 'checkout',
    headers: { Authorization: 'Bearer token-123' },
    fetchFn,
    environment: 'production',
  });

  exporter.export([makeSpan(), makeSpan({ spanId: 'c'.repeat(16) }), makeSpan({ spanId: 'd'.repeat(16) })]);
  await exporter.flush();

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'http://collector.local:4318/v1/traces');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers?.['Content-Type'], 'application/json');
  assert.equal(call.init.headers?.['Authorization'], 'Bearer token-123');

  const body = JSON.parse(call.init.body ?? '{}') as {
    resourceSpans: Array<{
      resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
      scopeSpans: Array<{ spans: unknown[] }>;
    }>;
  };
  assert.equal(body.resourceSpans.length, 1);
  assert.equal(body.resourceSpans[0].scopeSpans[0].spans.length, 3);
  const resAttrs = new Map(body.resourceSpans[0].resource.attributes.map((kv) => [kv.key, kv.value]));
  assert.deepEqual(resAttrs.get('service.name'), { stringValue: 'checkout' });
  assert.deepEqual(resAttrs.get('deployment.environment'), { stringValue: 'production' });

  assert.equal(exporter.pendingCount, 0);
  assert.equal(exporter.failedExports, 0);
});

test('exporter splits 70 spans into two POSTs when maxBatch is 64', async () => {
  const { fetchFn, calls } = fakeFetch(okJson);
  const exporter = new OtlpExporter({
    endpoint: 'http://collector.local:4318',
    serviceName: 'svc',
    fetchFn,
    maxBatch: 64,
  });

  const spans = Array.from({ length: 70 }, (_, i) =>
    makeSpan({ spanId: i.toString(16).padStart(16, '0') }),
  );
  exporter.export(spans);
  await exporter.flush();
  await exporter.dispose(); // alias must be safe to call too

  assert.equal(calls.length, 2);
  const sizes = calls.map((call) => {
    const body = JSON.parse(call.init.body ?? '{}') as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>;
    };
    return body.resourceSpans[0].scopeSpans[0].spans.length;
  });
  assert.deepEqual(sizes, [64, 6]);
  assert.equal(exporter.failedExports, 0);
  assert.equal(exporter.pendingCount, 0);
});

test('exporter retries a 429 and succeeds on the next attempt', async () => {
  let attempt = 0;
  const { fetchFn, calls } = fakeFetch(() => {
    attempt += 1;
    return attempt === 1
      ? new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })
      : new Response('{}', { status: 200 });
  });
  const { warnings, logger } = fakeLogger();
  const exporter = new OtlpExporter({
    endpoint: 'http://collector.local:4318',
    serviceName: 'svc',
    fetchFn,
    maxRetries: 2,
    logger,
  });

  exporter.export([makeSpan()]);
  await exporter.flush();

  assert.equal(calls.length, 2);
  assert.equal(exporter.failedExports, 0);
  assert.equal(warnings.length, 0); // recovered without warnings
});

test('exporter does not retry a 400 and records the failure', async () => {
  const { fetchFn, calls } = fakeFetch(() => new Response('bad request', { status: 400 }));
  const { warnings, logger } = fakeLogger();
  const exporter = new OtlpExporter({
    endpoint: 'http://collector.local:4318',
    serviceName: 'svc',
    fetchFn,
    logger,
  });

  exporter.export([makeSpan()]);
  await exporter.flush();

  assert.equal(calls.length, 1);
  assert.equal(exporter.failedExports, 1);
  assert.match(exporter.lastError ?? '', /400/);
  assert.equal(warnings.some((w) => w.message === 'otel.export.rejected'), true);
});

test('exporter retries network errors up to maxRetries, then swallows and sets lastError', async () => {
  const { fetchFn, calls } = fakeFetch(() => {
    throw new Error('socket hang up');
  });
  const { logger } = fakeLogger();
  const exporter = new OtlpExporter({
    endpoint: 'http://collector.local:4318',
    serviceName: 'svc',
    fetchFn,
    maxRetries: 2,
    logger,
  });

  exporter.export([makeSpan()]);
  await exporter.flush(); // must resolve, never reject

  assert.equal(calls.length, 3); // 1 initial + 2 retries
  assert.equal(exporter.failedExports, 1);
  assert.match(exporter.lastError ?? '', /socket hang up/);
});

test('exporter timeout: a fetch that never settles loses after timeoutMs', async () => {
  const { fetchFn, calls } = fakeFetch(() => new Promise<Response>(() => {}));
  const { logger } = fakeLogger();
  const exporter = new OtlpExporter({
    endpoint: 'http://collector.local:4318',
    serviceName: 'svc',
    fetchFn,
    timeoutMs: 50,
    maxRetries: 2,
    logger,
  });

  const started = Date.now();
  exporter.export([makeSpan()]);
  await exporter.flush();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5_000, `flush should not hang, took ${elapsed}ms`);
  assert.equal(calls.length, 3); // timeout is retried too
  assert.equal(exporter.failedExports, 1);
  assert.match(exporter.lastError ?? '', /timed out/i);
});

test('export never throws — even on garbage input', async () => {
  const { fetchFn, calls } = fakeFetch(okJson);
  const { warnings, logger } = fakeLogger();
  const exporter = new OtlpExporter({
    endpoint: 'http://collector.local:4318',
    serviceName: 'svc',
    fetchFn,
    logger,
  });

  assert.doesNotThrow(() => {
    exporter.export(undefined as unknown as readonly SpanData[]);
    exporter.export(null as unknown as readonly SpanData[]);
    exporter.export('nope' as unknown as readonly SpanData[]);
    exporter.export([null, 42, 'x'] as unknown as readonly SpanData[]);
    exporter.export([{}] as unknown as readonly SpanData[]);
  });
  assert.equal(warnings.some((w) => w.message === 'otel.export.invalid_input'), true);
  await assert.doesNotReject(() => exporter.flush());

  assert.equal(exporter.pendingCount, 0);
  assert.equal(exporter.failedExports, 7); // 1 + 1 + 1 + 3 + 1
  assert.equal(calls.length, 0); // nothing valid to send
});

test('exporter ships the valid spans and counts the invalid ones', async () => {
  const { fetchFn, calls } = fakeFetch(okJson);
  const { warnings, logger } = fakeLogger();
  const exporter = new OtlpExporter({
    endpoint: 'http://collector.local:4318',
    serviceName: 'svc',
    fetchFn,
    logger,
  });

  assert.doesNotThrow(() => {
    exporter.export([makeSpan(), null, { traceId: 'x' }] as unknown as readonly SpanData[]);
  });
  await exporter.flush();

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body ?? '{}') as {
    resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>;
  };
  assert.equal(body.resourceSpans[0].scopeSpans[0].spans.length, 1);
  assert.equal(exporter.failedExports, 2);
  assert.equal(warnings.some((w) => w.message === 'otel.export.invalid_input'), true);
});

/* ----------------------------------------------------- endpoint helper */

test('isOtlpEndpointConfigured requires http(s) scheme and non-empty host', () => {
  assert.equal(isOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.com:4318' }), true);
  assert.equal(isOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }), true);
  assert.equal(isOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com' }), true);
  assert.equal(isOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://' }), false);
  assert.equal(isOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://' }), false);
  assert.equal(isOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://host:4318' }), false);
  assert.equal(isOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'collector:4318' }), false);
  assert.equal(isOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' }), false);
  assert.equal(isOtlpEndpointConfigured({}), false);
  assert.equal(isOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }), false);
});
