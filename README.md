# tiny-otel

> Zero-dependency **OTLP/HTTP observability exporter** for AI agents and small services.
> Ships OpenTelemetry-compatible JSON traces, logs, and metrics to Honeycomb,
> Grafana Tempo / Loki, SigNoz, Datadog (via otel-collector), Jaeger, or any
> OTLP/HTTP endpoint. ~900 LOC, no deps, 1 µs per span creation.

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

## What's new in v0.2.0

### Log signal — `LogEmitter`

Emit OTLP-compatible log records with full trace/span correlation:

```js
const { logEmitter } = require('tiny-otel');

const logger = logEmitter({
  endpoint: 'http://localhost:4318/v1/logs',
  serviceName: 'my-agent',
});

// With trace correlation (pass span.context() from an active span)
logger.info('User authenticated', { userId: 42 }, span.context());
logger.warn('Rate limit approaching', { remaining: 5 });
logger.error('Database connection failed', { host: 'db.local' });

// Shortcut methods
logger.log('DEBUG', 'detailed debugging info');
```

The `LogEmitter` batches records and ships them as OTLP/JSON
`ExportLogsServiceRequest` envelopes — compatible with any OTLP collector
(Tempo, SigNoz, Honeycomb, etc.). Severity numbers follow the OTel spec
(DEBUG=5, INFO=9, WARN=13, ERROR=17, FATAL=21).

### Metric signal — `MetricReader`

In-process aggregation with a Prometheus `/metrics` endpoint AND OTLP
Metrics export, zero deps:

```js
const { metricReader } = require('tiny-otel');

const mr = metricReader({ prometheusPort: 9464 });

// Instruments
const counter = mr.createCounter('http_requests_total', { description: 'Total HTTP requests' });
const updown  = mr.createUpDownCounter('active_connections', {});
const hist    = mr.createHistogram('http_request_duration_ms', {
  boundaries: [5, 10, 25, 50, 100, 250, 500, 1000],
});

// Recording
mr.addCounter('http_requests_total', 1, { method: 'GET', status: '200' });
mr.addUpDownCounter('active_connections', +1, { path: '/api/users' });
mr.recordHistogram('http_request_duration_ms', 47.3, { method: 'GET' });

// Start Prometheus scrape endpoint (GET /metrics)
mr.startServer();

// OTLP metrics export (batched, interval-based)
// Flush manually or rely on automatic flush
setInterval(() => mr.flush(), 15_000);

// Shutdown
await mr.shutdown();
```

Prometheus output example:
```
# TYPE my_agent_http_requests_total gauge
my_agent_http_requests_total{method="GET",status="200"} 1
# TYPE my_agent_http_request_duration_ms histogram
my_agent_http_request_duration_ms_bucket{le="50",method="GET"} 1
my_agent_http_request_duration_ms_count{method="GET"} 1
my_agent_http_request_duration_ms_sum{method="GET"} 47.3
```

### Multi-exporter

Fan out to multiple backends simultaneously (e.g. Honeycomb + Grafana Tempo):

```js
const { MultiExporter } = require('tiny-otel');

const mx = new MultiExporter([
  { endpoint: 'https://api.honeycomb.io/',   headers: { 'x-honeycomb-team': 'abc' } },
  { endpoint: 'http://tempo:4318/' },
]);

// Ship the same payload to all targets
await mx.send('traces', exportTracePayload);
await mx.send('logs',   exportLogsPayload);
await mx.send('metrics', exportMetricsPayload);
```

### Grafana Loki — `LokiLogHandler`

Structured log push directly to Loki with stream labels:

```js
const { lokiLogHandler } = require('tiny-otel');

const loki = lokiLogHandler({
  url:      'https://logs-prod-us-central1.grafana.net/loki/api/v1/push',
  user:     'your-instance-id',
  password: process.env.LOKI_API_KEY,
  panelId:  'my-panel-123',          // forwarded as X-Panel-Id header
  labels:   'app=tiny-otel,env=prod',
});

// Standard shortcut methods
loki.info('Agent started', { agentId: 'agent-7' });
loki.warn('Budget alert', { budgetUsed: 0.85 });
loki.error('LLM call failed', { error: err.message }, span.context());

// Shutdown flushes remaining records
await loki.shutdown();
```

Loki stream labels (`app`, `env`) are set statically; per-record labels
(`trace_id`, `span_id`, `level`) are added automatically.

### Resource detection

All signals now auto-detect and attach these resource attributes:

| Attribute | Source |
| --------- | ------ |
| `host.name` | `os.hostname()` |
| `process.pid` | `process.pid` |
| `telemetry.sdk.version` | tiny-otel version (`0.2.0`) |
| `telemetry.sdk.name` | `"tiny-otel"` |
| `process.runtime.version` | `process.version` (Node version) |
| `container.id` | `/proc/self/cgroup` or `/proc/1/cgroup` (Docker/K8s) |

These are included in every trace, log, and metric export — no config
needed.

### Backward compatibility

v0.1.0 API is 100% preserved. `tracer()`, `Tracer`, and `Span` work
exactly as before; just `require('tiny-otel')` and upgrade.

## License

MIT