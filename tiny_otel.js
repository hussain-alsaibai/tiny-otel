'use strict';

/**
 * tiny-otel — zero-dep OTLP/HTTP exporter for AI agents and small services.
 *
 * Builds OpenTelemetry-compatible JSON, batches spans, and ships them via
 * fetch() to any OTLP/HTTP endpoint (Honeycomb, Tempo, SigNoz, Datadog
 * via the otel-collector, Jaeger, self-hosted otel-collector).
 *
 * The output is the OTLP/JSON `ExportTraceServiceRequest` envelope from
 * the v1.5.0 spec — every collector that speaks OTLP accepts it.
 *
 * Why? The official `@opentelemetry/exporter-trace-otlp-http` package pulls
 * in ~6 MB of transitive deps. For a tiny service that wants to ship
 * spans to its own collector, that's overkill.
 *
 *   const { tracer, logEmitter, metricReader } = require('tiny-otel');
 *   const t = tracer({ endpoint: process.env.OTEL_ENDPOINT });
 *   await t.inSpan('agent.run', async (span) => {
 *     span.setAttribute('agent.id', '42');
 *     await doWork();
 *   });
 *   await t.shutdown();
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');

const VERSION = '0.2.0';

// ─── Shared helpers ────────────────────────────────────────────────────────────

function rid(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

const DEFAULT_ATTR_LIMIT = 64;
const DEFAULT_ATTR_VALUE_LIMIT = 4096;

function attrToAny(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (v.length > DEFAULT_ATTR_VALUE_LIMIT) v = v.slice(0, DEFAULT_ATTR_VALUE_LIMIT);
    return { stringValue: v };
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'boolean') return { boolValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(attrToAny) } };
  if (typeof v === 'object') {
    return {
      kvlistValue: {
        values: Object.entries(v).map(([k, val]) => ({ key: k, value: attrToAny(val) })),
      },
    };
  }
  return { stringValue: String(v) };
}

function nowNanos() {
  const [sec, nano] = process.hrtime();
  return BigInt(Date.now()) * 1_000_000n + BigInt(nano);
}

function nowHrTime() {
  return process.hrtime.bigint();
}

// ─── HTTP fetch helper (stdlib only, no external deps) ────────────────────────

function stdFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request(url, {
      method: init.method || 'GET',
      headers: init.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, statusText: res.statusMessage, body });
      });
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

// ─── Resource detection ───────────────────────────────────────────────────────

const _cachedResource = Symbol('cachedResource');

function detectResource() {
  const attrs = [];

  // hostname
  const hostname = os.hostname();
  if (hostname) attrs.push({ key: 'host.name', value: { stringValue: hostname } });

  // PID
  attrs.push({ key: 'process.pid', value: { intValue: String(process.pid) } });

  // Node.js runtime version
  attrs.push({ key: 'telemetry.sdk.version', value: { stringValue: VERSION } });
  attrs.push({ key: 'telemetry.sdk.name', value: { stringValue: 'tiny-otel' } });
  attrs.push({ key: 'process.runtime.version', value: { stringValue: process.version } });

  // Container ID (Docker / K8s cgroup)
  let containerId = null;
  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const match = cgroup.match(/^\d+:(?:cpu|cpuset|memory|pids):\/.*?([a-f0-9]{64}).*$/m);
    if (match) containerId = match[1];
  } catch (_) {}
  if (!containerId) {
    try {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      const match = cgroup.match(/^\d+:?:?.*?([a-f0-9]{64}).*$/m);
      if (match) containerId = match[1];
    } catch (_) {}
  }
  if (containerId) attrs.push({ key: 'container.id', value: { stringValue: containerId } });

  return attrs;
}

function getResourceAttrs() {
  if (!getResourceAttrs[_cachedResource]) {
    getResourceAttrs[_cachedResource] = detectResource();
  }
  return getResourceAttrs[_cachedResource];
}

// ─── Span (unchanged from v0.1) ─────────────────────────────────────────────

class Span {
  constructor(name, kind, attrs, tracer) {
    this.name = name;
    this.kind = kind || 'INTERNAL';
    this.tracer = tracer;
    this.traceId = tracer._newTraceId();
    this.spanId = tracer._newSpanId();
    this.parentSpanId = null;
    this.startHr = nowHrTime();
    this.startNs = nowNanos();
    this.endNs = null;
    this.status = { code: 'UNSET', message: '' };
    this.attrs = [];
    this.events = [];
    this._ended = false;
    this.setAttributes(attrs || {});
  }

  setAttribute(k, v) {
    if (this.attrs.length >= DEFAULT_ATTR_LIMIT) return;
    this.attrs.push({ key: k, value: attrToAny(v) });
    return this;
  }

  setAttributes(obj) {
    for (const [k, v] of Object.entries(obj)) this.setAttribute(k, v);
    return this;
  }

  addEvent(name, attrs) {
    this.events.push({
      timeUnixNano: String(nowNanos()),
      name,
      attributes: Object.entries(attrs || {}).map(([k, v]) => ({ key: k, value: attrToAny(v) })),
    });
    return this;
  }

  setStatus(code, message) {
    this.status = { code, message: message || '' };
    return this;
  }

  recordException(err) {
    this.addEvent('exception', {
      'exception.type': err.name || 'Error',
      'exception.message': err.message || String(err),
      'exception.stacktrace': err.stack || '',
    });
    this.setStatus('ERROR', err.message);
    return this;
  }

  end() {
    if (this._ended) return;
    this._ended = true;
    this.endNs = nowNanos();
    this.tracer._onSpanEnd(this);
  }

  context() {
    return { traceId: this.traceId, spanId: this.spanId };
  }
}

// ─── Tracer (unchanged from v0.1) ────────────────────────────────────────────

class Tracer {
  constructor(opts = {}) {
    this.endpoint = opts.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      'http://localhost:4318/v1/traces';
    this.serviceName = opts.serviceName || process.env.OTEL_SERVICE_NAME || 'unknown_service';
    this.headers = opts.headers || {};
    this._fetch = opts.fetch || globalThis.fetch;
    if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
      for (const part of process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',')) {
        const [k, v] = part.split('=');
        if (k && v) this.headers[k.trim()] = v.trim();
      }
    }
    this.batchSize = opts.batchSize || 100;
    this.flushIntervalMs = opts.flushIntervalMs || 5000;
    this.queue = [];
    this.timer = null;
    this._stopped = false;
    this._traceCounter = 0;
    this._spanCounter = 0;
    this._resetCounters();
    this._startTimer();
  }

  _resetCounters() {
    this._traceCounter = 0;
    this._spanCounter = 0;
  }

  _newTraceId() {
    this._traceCounter++;
    return rid(16);
  }

  _newSpanId() {
    this._spanCounter++;
    return rid(8);
  }

  startSpan(name, attrs, kind) {
    return new Span(name, kind, typeof attrs === 'function' ? null : attrs, this);
  }

  async inSpan(name, fn, attrs, kind) {
    const span = new Span(name, kind, attrs, this);
    try {
      const result = await fn(span);
      if (span.status.code === 'UNSET') span.setStatus('OK');
      return result;
    } catch (err) {
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  }

  _onSpanEnd(span) {
    this.queue.push(span);
    if (this.queue.length >= this.batchSize) {
      this.flush().catch(() => {});
    }
  }

  _toOTLP() {
    const resourceAttrs = [
      { key: 'service.name', value: { stringValue: this.serviceName } },
      ...getResourceAttrs(),
    ];
    const spans = this.queue.map((s) => ({
      traceId: s.traceId,
      spanId: s.spanId,
      parentSpanId: s.parentSpanId || undefined,
      name: s.name,
      kind: s.kind,
      startTimeUnixNano: String(s.startNs),
      endTimeUnixNano: String(s.endNs),
      attributes: s.attrs,
      events: s.events,
      status: s.status,
    }));
    this.queue = [];
    return {
      resourceSpans: [{
        resource: { attributes: resourceAttrs },
        scopeSpans: [{
          scope: { name: 'tiny-otel', version: VERSION },
          spans,
        }],
      }],
    };
  }

  async flush() {
    if (this.queue.length === 0) return;
    const body = JSON.stringify(this._toOTLP());
    try {
      const res = await this._fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body,
      });
      if (!res.ok) {
        console.error(`tiny-otel: trace export failed ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error('tiny-otel: trace export error', err.message);
    }
  }

  _startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.flush().catch(() => {}); }, this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  async shutdown() {
    this._stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  metrics() {
    return { queued: this.queue.length, traces: this._traceCounter, spans: this._spanCounter };
  }
}

function tracer(opts) {
  return new Tracer(opts);
}

// ─── LogEmitter ───────────────────────────────────────────────────────────────
// Emits OTLP/JSON-compatible log records.
// Supports trace_id / span_id correlation (pass a span.context() result).

class LogEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.endpoint]   OTLP logs endpoint
   * @param {string} [opts.serviceName]
   * @param {object} [opts.headers]
   * @param {number} [opts.batchSize]
   * @param {number} [opts.flushIntervalMs]
   * @param {function} [opts.fetch]   injectable fetch for testing
   */
  constructor(opts = {}) {
    this.endpoint = opts.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      'http://localhost:4318/v1/logs';
    this.serviceName = opts.serviceName || process.env.OTEL_SERVICE_NAME || 'unknown_service';
    this.headers = opts.headers || {};
    if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
      for (const part of process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',')) {
        const [k, v] = part.split('=');
        if (k && v) this.headers[k.trim()] = v.trim();
      }
    }
    this._fetch = opts.fetch || globalThis.fetch;
    this.batchSize = opts.batchSize || 100;
    this.flushIntervalMs = opts.flushIntervalMs || 5000;
    this.queue = [];
    this.timer = null;
    this._stopped = false;
    this._startTimer();
  }

  _startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.flush().catch(() => {}); }, this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Emit a log record.
   * @param {string} level   DEBUG | INFO | WARN | ERROR | FATAL
   * @param {string} body    log message string
   * @param {object} [attrs] arbitrary key-value pairs
   * @param {{ traceId?: string, spanId?: string }} [ctx] span context for correlation
   */
  log(level, body, attrs, ctx) {
    const record = {
      timeUnixNano: String(nowNanos()),
      severityText: String(level).toUpperCase(),
      severityNumber: _severityNumber(level),
      body: { stringValue: String(body) },
      attributes: Object.entries(attrs || {}).map(([k, v]) => ({ key: k, value: attrToAny(v) })),
      traceId: ctx && ctx.traceId ? ctx.traceId : '00000000000000000000000000000000',
      spanId:  ctx && ctx.spanId  ? ctx.spanId  : '0000000000000000',
    };
    this.queue.push(record);
    if (this.queue.length >= this.batchSize) this.flush().catch(() => {});
    return this;
  }

  debug(body, attrs, ctx) { return this.log('DEBUG', body, attrs, ctx); }
  info(body, attrs, ctx)  { return this.log('INFO',  body, attrs, ctx); }
  warn(body, attrs, ctx)  { return this.log('WARN',  body, attrs, ctx); }
  error(body, attrs, ctx)  { return this.log('ERROR', body, attrs, ctx); }

  _toOTLP() {
    const resourceAttrs = [
      { key: 'service.name', value: { stringValue: this.serviceName } },
      ...getResourceAttrs(),
    ];
    const logs = this.queue.splice(0);
    return {
      resourceLogs: [{
        resource: { attributes: resourceAttrs },
        scopeLogs: [{
          scope: { name: 'tiny-otel', version: VERSION },
          logRecords: logs,
        }],
      }],
    };
  }

  async flush() {
    if (this.queue.length === 0) return;
    const body = JSON.stringify(this._toOTLP());
    try {
      const res = await this._fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body,
      });
      if (!res.ok) {
        console.error(`tiny-otel: log export failed ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error('tiny-otel: log export error', err.message);
    }
  }

  async shutdown() {
    this._stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}

function _severityNumber(level) {
  switch (String(level).toUpperCase()) {
    case 'DEBUG': return 5;
    case 'INFO':  return 9;
    case 'WARN':  return 13;
    case 'ERROR': return 17;
    case 'FATAL': return 21;
    default:      return 9;
  }
}

function logEmitter(opts) {
  return new LogEmitter(opts);
}

// ─── MetricReader ─────────────────────────────────────────────────────────────
// In-process aggregation: counter, up-down-counter, histogram.
// Exposes Prometheus /metrics HTTP endpoint AND OTLP Metrics export.

class MetricReader {
  /**
   * @param {object} opts
   * @param {string} [opts.endpoint]   OTLP metrics endpoint
   * @param {string} [opts.serviceName]
   * @param {object} [opts.headers]
   * @param {number} [opts.prometheusPort]  port for /metrics HTTP server (default 9464)
   * @param {number} [opts.flushIntervalMs]
   * @param {function} [opts.fetch]
   */
  constructor(opts = {}) {
    this.endpoint = opts.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      'http://localhost:4318/v1/metrics';
    this.serviceName = opts.serviceName || process.env.OTEL_SERVICE_NAME || 'unknown_service';
    this.headers = opts.headers || {};
    if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
      for (const part of process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',')) {
        const [k, v] = part.split('=');
        if (k && v) this.headers[k.trim()] = v.trim();
      }
    }
    this._fetch = opts.fetch || globalThis.fetch;
    this.prometheusPort = opts.prometheusPort || 9464;
    this.flushIntervalMs = opts.flushIntervalMs || 15000;
    this._server = null;
    this._serverStopped = false;
    this._instruments = {};   // name → instrument
    this._agg = {};           // name → aggregated data
    this._timer = null;
    this._stopped = false;

    // OTLP metric temporality: cumulative (required for Prometheus)
    this._startTimeNanos = nowNanos();
  }

  // ── Instruments ──────────────────────────────────────────────────────────

  /**
   * Create a Counter. Monotonically increasing int64.
   */
  createCounter(name, opts) {
    if (this._instruments[name]) return this._instruments[name];
    const inst = { name, type: 'counter', unit: opts && opts.unit || '', description: opts && opts.description || '' };
    this._instruments[name] = inst;
    this._agg[name] = { type: 'counter', values: {}, sum: 0, count: 0 };
    return inst;
  }

  /**
   * Create an UpDownCounter. Non-monotonic int64.
   */
  createUpDownCounter(name, opts) {
    if (this._instruments[name]) return this._instruments[name];
    const inst = { name, type: 'updowncounter', unit: opts && opts.unit || '', description: opts && opts.description || '' };
    this._instruments[name] = inst;
    this._agg[name] = { type: 'updowncounter', values: {}, sum: 0, count: 0 };
    return inst;
  }

  /**
   * Create a Histogram. Float64, explicit bucket boundaries.
   */
  createHistogram(name, opts) {
    if (this._instruments[name]) return this._instruments[name];
    const inst = { name, type: 'histogram', unit: opts && opts.unit || '', description: opts && opts.description || '',
                   boundaries: opts && opts.boundaries || [1, 5, 10, 25, 50, 100, 250, 500, 1000] };
    this._instruments[name] = inst;
    this._agg[name] = { type: 'histogram', values: {}, count: 0, sum: 0,
                        buckets: Object.fromEntries(inst.boundaries.map(b => [b, 0])),
                        explicitBoundaries: inst.boundaries };
    return inst;
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  addCounter(name, value, attrs) {
    const key = _attrKey(attrs || {});
    const a = this._agg[name];
    if (!a || a.type !== 'counter') return;
    a.sum += Number(value) || 0;
    a.count += 1;
    if (!a.values[key]) a.values[key] = { attrs: attrs || {}, value: 0 };
    a.values[key].value += Number(value) || 0;
  }

  addUpDownCounter(name, value, attrs) {
    const key = _attrKey(attrs || {});
    const a = this._agg[name];
    if (!a || a.type !== 'updowncounter') return;
    a.sum += Number(value) || 0;
    a.count += 1;
    if (!a.values[key]) a.values[key] = { attrs: attrs || {}, value: 0 };
    a.values[key].value += Number(value) || 0;
  }

  recordHistogram(name, value, attrs) {
    const key = _attrKey(attrs || {});
    const a = this._agg[name];
    if (!a || a.type !== 'histogram') return;
    const v = Number(value) || 0;
    a.sum += v;
    a.count += 1;
    if (!a.values[key]) a.values[key] = { attrs: attrs || {}, value: 0, buckets: Object.fromEntries(a.explicitBoundaries.map(b => [b, 0])) };
    const entry = a.values[key];
    entry.value += v;
    for (const bound of a.explicitBoundaries) {
      if (v <= bound) entry.buckets[bound]++;
    }
  }

  // ── Prometheus /metrics endpoint ───────────────────────────────────────────

  _prometheusOutput() {
    const lines = [];
    const serviceName = this.serviceName.replace(/[^a-zA-Z0-9_]/g, '_');

    for (const [name, agg] of Object.entries(this._agg)) {
      const fullName = `${serviceName}_${name}`;
      for (const [key, entry] of Object.entries(agg.values)) {
        const attrLabels = key !== '' ? key.split(',').map((p) => {
          const [k, v] = p.split(':');
          return `${k}="${_escapePromLabel(v)}"`;
        }).join(',') : '';
        const labelBlock = attrLabels ? `{${attrLabels}}` : '';

        if (agg.type === 'counter' || agg.type === 'updowncounter') {
          lines.push(`# TYPE ${fullName} gauge`);
          if (agg.type === 'updowncounter') lines.push(`# TYPE ${fullName}_total counter`);
          lines.push(`${fullName}${labelBlock} ${entry.value}`);
          if (agg.type === 'updowncounter') lines.push(`${fullName}_total${labelBlock} ${entry.value}`);
        } else if (agg.type === 'histogram') {
          lines.push(`# TYPE ${fullName} histogram`);
          let cumCount = 0, cumSum = 0;
          for (const bound of agg.explicitBoundaries) {
            cumCount += entry.buckets[bound] || 0;
            lines.push(`${fullName}_bucket{le="${bound}",${attrLabels}} ${cumCount}`);
          }
          lines.push(`${fullName}_bucket{le="+Inf",${attrLabels}} ${agg.count}`);
          lines.push(`${fullName}_sum${labelBlock} ${agg.sum}`);
          lines.push(`${fullName}_count${labelBlock} ${agg.count}`);
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  /** Start the Prometheus /metrics HTTP server. */
  startServer() {
    if (this._server) return this._server;
    this._server = http.createServer((req, res) => {
      if (req.url === '/metrics' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(this._prometheusOutput());
        return;
      }
      res.writeHead(404);
      res.end();
    });
    return new Promise((resolve) => {
      this._server.listen(this.prometheusPort, '0.0.0.0', () => resolve(this._server));
    });
  }

  /** Stop the Prometheus server. */
  async stopServer() {
    if (!this._server || this._serverStopped) return;
    this._serverStopped = true;
    return new Promise((resolve) => this._server.close(resolve));
  }

  // ── OTLP Metrics export ──────────────────────────────────────────────────

  _toOTLPMetrics() {
    const resourceAttrs = [
      { key: 'service.name', value: { stringValue: this.serviceName } },
      ...getResourceAttrs(),
    ];
    const metrics = [];

    for (const [name, agg] of Object.entries(this._agg)) {
      const metric = { name, description: '', unit: '' };

      if (agg.type === 'counter') {
        metric.sum = { dataPoints: Object.entries(agg.values).map(([key, entry]) => ({
          asInt: String(Math.round(entry.value)),
          timeUnixNano: String(nowNanos()),
          attributes: _keyToAttrs(key),
        })), isMonotonic: true, aggregationTemporality: 'CUMULATIVE' };
        metrics.push({ counter: metric });
      } else if (agg.type === 'updowncounter') {
        metric.sum = { dataPoints: Object.entries(agg.values).map(([key, entry]) => ({
          asInt: String(Math.round(entry.value)),
          timeUnixNano: String(nowNanos()),
          attributes: _keyToAttrs(key),
        })), isMonotonic: false, aggregationTemporality: 'CUMULATIVE' };
        metrics.push({ 'updowncounter': metric });
      } else if (agg.type === 'histogram') {
        metric.dataPoints = Object.entries(agg.values).map(([key, entry]) => ({
          timeUnixNano: String(nowNanos()),
          count: agg.count,
          sum: agg.sum,
          explicitBounds: agg.explicitBoundaries,
          buckets: agg.explicitBoundaries.map(b => ({ count: entry.buckets[b] || 0 })),
          attributes: _keyToAttrs(key),
        }));
        metric.aggregationTemporality = 'CUMULATIVE';
        metrics.push({ histogram: metric });
      }
    }

    return {
      resourceMetrics: [{
        resource: { attributes: resourceAttrs },
        scopeMetrics: [{
          scope: { name: 'tiny-otel', version: VERSION },
          metrics,
        }],
      }],
    };
  }

  async flush() {
    if (Object.keys(this._agg).length === 0) return;
    const body = JSON.stringify(this._toOTLPMetrics());
    try {
      const res = await this._fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body,
      });
      if (!res.ok) {
        console.error(`tiny-otel: metric export failed ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error('tiny-otel: metric export error', err.message);
    }
  }

  async shutdown() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    await this.flush();
    await this.stopServer();
  }
}

// Helpers for metric attr key encoding

function _attrKey(attrs) {
  return Object.entries(attrs || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
}

function _keyToAttrs(key) {
  if (!key) return [];
  return key.split(',').map((p) => {
    const idx = p.indexOf(':');
    return { key: p.slice(0, idx), value: attrToAny(p.slice(idx + 1)) };
  });
}

function _escapePromLabel(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function metricReader(opts) {
  return new MetricReader(opts);
}

// ─── MultiExporter ────────────────────────────────────────────────────────────
// Fans out to multiple OTLP endpoints simultaneously.

class MultiExporter {
  /**
   * @param {Array<{ endpoint: string, headers?: object, signal: string }>} targets
   * @param {function} [opts.fetch]
   */
  constructor(targets, opts = {}) {
    this._targets = targets; // [{ endpoint, headers, signal }]
    this._fetch = opts.fetch || globalThis.fetch;
  }

  async send(signal, payload) {
    const bodies = {
      traces: () => JSON.stringify(payload),
      logs:   () => JSON.stringify(payload),
      metrics: () => JSON.stringify(payload),
    };
    const pathFor = {
      traces:  '/v1/traces',
      logs:    '/v1/logs',
      metrics: '/v1/metrics',
    };
    const bodiesBySignal = { traces: 'traces', logs: 'logs', metrics: 'metrics' };

    await Promise.allSettled(
      this._targets.map(async (t) => {
        const url = t.endpoint + (pathFor[signal] || pathFor.traces);
        const body = bodies[signal] ? bodies[signal]() : JSON.stringify(payload);
        try {
          const res = await this._fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(t.headers || {}) },
            body,
          });
          if (!res.ok) {
            console.error(`tiny-otel: multi-export [${signal}] to ${t.endpoint} failed ${res.status}`);
          }
        } catch (err) {
          console.error(`tiny-otel: multi-export [${signal}] to ${t.endpoint} error: ${err.message}`);
        }
      })
    );
  }
}

// ─── LokiLogHandler ───────────────────────────────────────────────────────────
// Formats logs as Loki push API JSON payloads and ships to Loki.
// Uses X-Panel-Id header approach for datasource proxy configuration.

class LokiLogHandler {
  /**
   * @param {object} opts
   * @param {string} opts.url       Loki push URL  e.g. https://logs-prod-us-central1.grafana.net/loki/api/v1/push
   * @param {string} opts.user      Loki username / instance ID
   * @param {string} opts.password  Loki API key (or proxy auth token)
   * @param {string} [opts.panelId] X-Panel-Id value to forward
   * @param {string} [opts.labels]  static stream labels as comma-k=v pairs
   */
  constructor(opts) {
    if (!opts.url) throw new Error('tiny-otel LokiLogHandler: opts.url is required');
    this.url = opts.url;
    this._auth = Buffer.from(`${opts.user}:${opts.password}`).toString('base64');
    this._panelId = opts.panelId || '';
    this._staticLabels = _parseLokiLabels(opts.labels || '');
    this._fetch = opts.fetch || globalThis.fetch;
    this._queue = [];
    this._timer = null;
    this._stopped = false;
    this._startTimer();
  }

  _startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => { this._flush().catch(() => {}); }, 5000);
    if (this._timer.unref) this._timer.unref();
  }

  /**
   * Push a log line.
   * @param {string} level
   * @param {string} msg
   * @param {object} [attrs]
   * @param {{ traceId?: string, spanId?: string }} [ctx]
   */
  log(level, msg, attrs, ctx) {
    const stream = { ...this._staticLabels };
    if (ctx && ctx.traceId) stream.trace_id = ctx.traceId;
    if (ctx && ctx.spanId)  stream.span_id  = ctx.spanId;
    stream.level = level;

    // Loki timestamps are ns Unix epoch
    const ns = nowNanos().toString();

    this._queue.push({ stream, values: [[ns, msg]] });
    return this;
  }

  debug(msg, attrs, ctx) { return this.log('DEBUG', msg, attrs, ctx); }
  info(msg, attrs, ctx)  { return this.log('INFO',  msg, attrs, ctx); }
  warn(msg, attrs, ctx)  { return this.log('WARN',  msg, attrs, ctx); }
  error(msg, attrs, ctx) { return this.log('ERROR', msg, attrs, ctx); }

  async _flush() {
    if (this._queue.length === 0) return;
    const streams = this._queue.splice(0);
    const payload = { streams };
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${this._auth}`,
    };
    if (this._panelId) headers['X-Panel-Id'] = this._panelId;

    try {
      const res = await this._fetch(this.url, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (!res.ok) {
        console.error(`tiny-otel: Loki push failed ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error('tiny-otel: Loki push error', err.message);
    }
  }

  async shutdown() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    await this._flush();
  }
}

function lokiLogHandler(opts) {
  return new LokiLogHandler(opts);
}

function _parseLokiLabels(str) {
  const result = {};
  if (!str) return result;
  for (const pair of str.split(',')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) result[k] = v;
  }
  return result;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  tracer,
  logEmitter,
  metricReader,
  lokiLogHandler,
  MultiExporter,
  Tracer,
  Span,
  LogEmitter,
  MetricReader,
  VERSION,
};
