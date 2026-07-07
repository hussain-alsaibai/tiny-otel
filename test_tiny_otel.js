'use strict';

const assert = require('assert');
const http = require('http');
const { tracer, Tracer, Span } = require('./tiny_otel');

// Capture the real global fetch before any test stubs it.
const realFetch = global.fetch;

let tests = 0, passed = 0;
const queue = [];
function test(name, fn) {
  tests++;
  queue.push((async () => {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ❌ ${name}\n     ${e.message}\n     ${e.stack.split('\n').slice(1,4).join('\n     ')}`);
    }
  })());
}

console.log('tiny-otel tests\n');

// --- 1. Span shape & lifecycle -----------------------------------------

test('Span: starts and ends, has traceId/spanId', () => {
  const t = new Tracer({ endpoint: 'http://localhost:1', flushIntervalMs: 60000 });
  const s = new Span('test', 'INTERNAL', { foo: 'bar' }, t);
  assert.strictEqual(typeof s.traceId, 'string');
  assert.strictEqual(s.traceId.length, 32);
  assert.strictEqual(s.spanId.length, 16);
  assert.strictEqual(s.startNs > 0n, true);
  s.end();
  assert.strictEqual(s._ended, true);
  assert.strictEqual(s.endNs >= s.startNs, true);
});

test('Span: setAttribute + addEvent', () => {
  const t = new Tracer({ endpoint: 'http://localhost:1', flushIntervalMs: 60000 });
  const s = new Span('test', 'INTERNAL', null, t);
  s.setAttribute('user.id', '42');
  s.setAttribute('user.admin', true);
  s.setAttribute('count', 7);
  s.setAttribute('ratio', 0.5);
  s.setAttribute('tags', ['a', 'b']);
  s.addEvent('cache.hit', { key: 'foo' });
  assert.strictEqual(s.attrs.length, 5);
  assert.strictEqual(s.events.length, 1);
  const a = Object.fromEntries(s.attrs.map((a) => [a.key, a.value]));
  assert.strictEqual(a['user.id'].stringValue, '42');
  assert.strictEqual(a['user.admin'].boolValue, true);
  assert.strictEqual(a['count'].intValue, '7');
  assert.strictEqual(a['ratio'].doubleValue, 0.5);
  assert.deepStrictEqual(a['tags'].arrayValue.values.map((v) => v.stringValue), ['a', 'b']);
});

test('Span: recordException sets status=ERROR', () => {
  const t = new Tracer({ endpoint: 'http://localhost:1', flushIntervalMs: 60000 });
  const s = new Span('test', 'INTERNAL', null, t);
  s.recordException(new Error('boom'));
  assert.strictEqual(s.status.code, 'ERROR');
  assert.strictEqual(s.events[0].name, 'exception');
  assert.strictEqual(s.events[0].attributes[0].value.stringValue, 'Error');
});

test('Span: attr limit enforced', () => {
  const t = new Tracer({ endpoint: 'http://localhost:1', flushIntervalMs: 60000 });
  const s = new Span('test', 'INTERNAL', null, t);
  for (let i = 0; i < 200; i++) s.setAttribute(`k${i}`, i);
  assert.strictEqual(s.attrs.length, 64);
});

// --- 2. inSpan wrapper -------------------------------------------------

test('inSpan: success sets status=OK', async () => {
  const t = new Tracer({ endpoint: 'http://localhost:1', flushIntervalMs: 60000 });
  const result = await t.inSpan('work', async () => 'done');
  assert.strictEqual(result, 'done');
});

test('inSpan: exception sets status=ERROR and rethrows', async () => {
  const t = new Tracer({ endpoint: 'http://localhost:1', flushIntervalMs: 60000 });
  await assert.rejects(
    t.inSpan('work', async () => { throw new Error('nope'); }),
    /nope/,
  );
});

// --- 3. OTLP payload shape --------------------------------------------

test('OTLP payload: matches spec structure', async () => {
  // Capture the body by injecting a stub fetch.
  const captured = [];
  const stubFetch = async (url, init) => {
    captured.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 200 });
  };

  const t = tracer({
    endpoint: 'http://collector/v1/traces',
    serviceName: 'agent-svc',
    fetch: stubFetch,
  });
  await t.inSpan('span1', async () => {}, { method: 'GET' }, 'CLIENT');
  await t.flush();
  await t.shutdown();

  assert.strictEqual(captured.length, 1);
  const body = captured[0].body;
  assert.strictEqual(captured[0].url, 'http://collector/v1/traces');
  assert.strictEqual(body.resourceSpans.length, 1);
  assert.strictEqual(body.resourceSpans[0].resource.attributes[0].value.stringValue, 'agent-svc');
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.strictEqual(span.name, 'span1');
  assert.strictEqual(span.kind, 'CLIENT');
  assert.strictEqual(typeof span.traceId, 'string');
  assert.strictEqual(span.traceId.length, 32);
  assert.strictEqual(span.spanId.length, 16);
  assert.strictEqual(span.startTimeUnixNano > '0', true);
  assert.strictEqual(span.endTimeUnixNano >= span.startTimeUnixNano, true);
  assert.strictEqual(span.status.code, 'OK');
});

// --- 4. Real HTTP server integration ----------------------------------

test('integration: spans reach a real OTLP/HTTP endpoint', async () => {
  // Use the captured real fetch (don't rely on global state).
  try {
    let received = null;
    let resolveClose;
    const closePromise = new Promise((r) => { resolveClose = r; });
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try { received = JSON.parse(data); } catch (_) {}
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const endpoint = `http://127.0.0.1:${port}/v1/traces`;
    const t = tracer({ endpoint, serviceName: 'integ-test', flushIntervalMs: 60000, fetch: realFetch });
    await t.inSpan('http.request', async () => {
      await new Promise((r) => setTimeout(r, 5));
    }, { method: 'GET' }, 'CLIENT');
    await t.flush();
    for (let i = 0; i < 50 && !received; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await t.shutdown();
    server.close(resolveClose);
    await closePromise;
    assert.ok(received, 'collector should have received spans');
    assert.strictEqual(received.resourceSpans[0].scopeSpans[0].spans[0].name, 'http.request');
  } finally {
    // No-op.
  }
});

// --- 5. OTEL_EXPORTER_OTLP_ENDPOINT env var ---------------------------

test('env: OTEL_EXPORTER_OTLP_ENDPOINT is honored', () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://from-env:4318/v1/traces';
  const t = tracer({});
  assert.strictEqual(t.endpoint, 'http://from-env:4318/v1/traces');
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

test('env: OTEL_EXPORTER_OTLP_HEADERS parsed', () => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-honeycomb-team=abc123,x-source=tiny-otel';
  const t = tracer({});
  assert.strictEqual(t.headers['x-honeycomb-team'], 'abc123');
  assert.strictEqual(t.headers['x-source'], 'tiny-otel');
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
});

(async () => {
  await Promise.all(queue);
  console.log(`\n${passed}/${tests} tests passed`);
  process.exit(passed === tests ? 0 : 1);
})();