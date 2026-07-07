# tiny-otel

> Zero-dependency **OTLP/HTTP trace exporter** for AI agents and small services.
> Ships OpenTelemetry-compatible JSON spans to Honeycomb, Tempo, SigNoz,
> Datadog (via otel-collector), Jaeger, or any OTLP/HTTP endpoint.
> ~250 LOC, no deps, 1 µs per span creation.

```bash
npm install tiny-otel
```

## Why?

The official `@opentelemetry/exporter-trace-otlp-http` package pulls in
~6 MB of transitive deps (`@opentelemetry/core`, `@grpc/grpc-js`,
`protobufjs`, etc.) just to POST a JSON envelope over HTTP. For a tiny
agent service that wants to ship spans to its own collector, that's
overkill.

`tiny-otel` is the smallest thing that ships:

- The exact **OTLP/JSON `ExportTraceServiceRequest`** envelope from the
  v1.5.0 spec — every collector that speaks OTLP accepts it
- One-file `Tracer`, `Span`, `tracer()` API
- Batched export (configurable batch size + flush interval)
- Standard env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`)
- `inSpan(name, asyncFn)` wrapper with auto status + exception capture
- `recordException(err)` helper
- Fetch injection for testing (no monkey-patching globals)

It deliberately does NOT do:

- gRPC export (use `@opentelemetry/exporter-trace-otlp-grpc`)
- Metric / log signals (use the official `@opentelemetry/*` packages)
- Context propagation across HTTP headers (use W3C trace context if needed)
- Sampling logic (sends everything — plug your sampler in upstream)
- Auto-instrumentation (wrap your own code; auto-instrumentation is the
  OTel SDK's job)

If you need any of those, use the real thing. `tiny-otel` is the
*"fits in one cron job and one config file"* tier.

## Usage

```js
const { tracer } = require('tiny-otel');

const t = tracer({
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  serviceName: 'my-agent',
  batchSize: 50,
  flushIntervalMs: 10_000,
});

// Wrap an async function. Status auto-set to OK, exception auto-captured.
await t.inSpan('agent.run', async (span) => {
  span.setAttribute('agent.id', '42');
  span.setAttribute('input.tokens', 1234);
  const result = await callLLM();
  span.setAttribute('output.tokens', result.usage.total_tokens);
  return result;
}, undefined, 'INTERNAL');

// Manual span control
const span = t.startSpan('cache.lookup');
span.setAttribute('cache.key', 'user:42');
try {
  const v = await cache.get('user:42');
  if (v == null) span.addEvent('cache.miss');
  span.setStatus('OK');
} catch (err) {
  span.recordException(err);
  throw err;
} finally {
  span.end();
}

// On shutdown (cron, lambda, etc.)
process.on('SIGTERM', async () => {
  await t.shutdown();   // flush + clear interval
});
```

## Environment variables

Standard OTLP env vars are honored at tracer construction time:

| Variable                       | Maps to              | Example                                  |
| ------------------------------ | -------------------- | ---------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | `endpoint`           | `https://api.honeycomb.io/v1/traces`     |
| `OTEL_EXPORTER_OTLP_HEADERS`   | `headers`            | `x-honeycomb-team=abc123,x-source=agent` |
| `OTEL_SERVICE_NAME`            | `serviceName`        | `daily-bounty-work`                      |

Plus per-tracer overrides via constructor options (which take precedence
over env vars).

## Span API

```js
const span = t.startSpan('name', attrs?, kind?);

span.setAttribute('key', value);          // string | number | bool | array | object
span.setAttributes({ a: 1, b: 'x' });
span.addEvent('event.name', { key: 'value' });
span.setStatus('OK');                      // 'OK' | 'ERROR' | 'UNSET'
span.recordException(new Error('boom'));   // adds exception event + sets ERROR
span.end();                                // marks end time, queues for export
span.context();                            // { traceId, spanId }

await t.inSpan('name', async (span) => { /* ... */ }, attrs?, kind?);
```

Value types follow the OTLP spec:

- string → `stringValue`
- integer number → `intValue` (as string)
- non-integer number → `doubleValue`
- boolean → `boolValue`
- array → `arrayValue.values`
- object → `kvlistValue.values`

Values are truncated to 4 KB by default. Attributes are capped at 64 per
span (matches OTel SDK default).

## Span kinds

`INTERNAL` (default), `SERVER`, `CLIENT`, `PRODUCER`, `CONSUMER`.

## Endpoints

| Backend       | Endpoint                                                |
| ------------- | ------------------------------------------------------- |
| Honeycomb     | `https://api.honeycomb.io/v1/traces`                    |
| Grafana Tempo | `http://tempo:4318/v1/traces` (via otel-collector)      |
| SigNoz        | `http://signoz-otel-collector:4318/v1/traces`           |
| Jaeger        | `http://jaeger:4318/v1/traces` (via otel-collector)     |
| Datadog       | `http://datadog-agent:4318/v1/traces` (via otel-agent)  |
| Local debug   | `http://localhost:4318/v1/traces` (default)             |

## Testing

Inject a custom `fetch` to capture exported payloads without spinning
up a collector:

```js
const captured = [];
const t = tracer({
  endpoint: 'http://test/v1/traces',
  fetch: async (url, init) => {
    captured.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 200 });
  },
});
```

This is what the test suite does — see `test_tiny_otel.js`.

## Agent integration pattern

For cron-style agents:

```js
// In your agent entrypoint
const { tracer } = require('tiny-otel');
const t = tracer({ serviceName: process.env.AGENT_NAME });

process.on('beforeExit', () => t.shutdown().catch(() => {}));

async function runAgent() {
  await t.inSpan('agent.run', async (span) => {
    span.setAttribute('cron.id', process.env.CRON_ID);
    for (const task of tasks) {
      await t.inSpan(`task.${task.name}`, async (taskSpan) => {
        taskSpan.setAttribute('task.id', task.id);
        await processTask(task);
      });
    }
  });
}
```

Combine with **tiny-budget** for cost + trace correlation:

```js
const { Budget } = require('tiny-budget');
const { tracer } = require('tiny-otel');

await t.inSpan('llm.call', async (span) => {
  const r = await openai.chat.completions.create(...);
  span.setAttribute('llm.tokens', r.usage.total_tokens);
  span.setAttribute('llm.cost_usd', budget.chargeUsage(...));
  return r;
});
```

## License

MIT