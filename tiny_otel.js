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
 *   const otel = require('tiny-otel');
 *   const tracer = otel.tracer({ endpoint: process.env.OTEL_ENDPOINT });
 *   await tracer.startSpan('agent.run', async (span) => {
 *     span.setAttribute('agent.id', '42');
 *     await doWork();
 *   });
 *   await tracer.shutdown();   // flush + close
 */

const crypto = require('crypto');

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
  // Wall-clock time in nanoseconds (OTLP requires this on every span).
  const [sec, nano] = process.hrtime();
  return BigInt(Date.now()) * 1_000_000n + BigInt(nano);
}

function nowHrTime() {
  return process.hrtime.bigint();
}

class Span {
  constructor(name, kind, attrs, tracer) {
    this.name = name;
    this.kind = kind || 'INTERNAL'; // INTERNAL, SERVER, CLIENT, PRODUCER, CONSUMER
    this.tracer = tracer;
    this.traceId = tracer._newTraceId();
    this.spanId = tracer._newSpanId();
    this.parentSpanId = null;
    this.startHr = nowHrTime();
    this.startNs = nowNanos();
    this.endNs = null;
    this.status = { code: 'UNSET' /* OK | ERROR | UNSET */, message: '' };
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

class Tracer {
  constructor(opts = {}) {
    this.endpoint = opts.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      'http://localhost:4318/v1/traces';
    this.serviceName = opts.serviceName || process.env.OTEL_SERVICE_NAME || 'unknown_service';
    this.headers = opts.headers || {};
    this._fetch = opts.fetch || globalThis.fetch; // allow injection for testing
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
    // 16 bytes / 32 hex chars per OTLP spec.
    return rid(16);
  }

  _newSpanId() {
    this._spanCounter++;
    return rid(8);
  }

  startSpan(name, attrs, kind) {
    return new Span(name, kind, typeof attrs === 'function' ? null : attrs, this);
  }

  // Convenience: span around an async function with auto-end + exception capture.
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
      this.flush().catch(() => {}); // swallow; logged separately
    }
  }

  _toOTLP() {
    const resourceAttrs = [
      { key: 'service.name', value: { stringValue: this.serviceName } },
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
          scope: { name: 'tiny-otel', version: '0.1.0' },
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
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body,
      });
      if (!res.ok) {
        // Re-queue on transient errors? For now: log via console.error.
        console.error(`tiny-otel: export failed ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error('tiny-otel: export error', err.message);
    }
  }

  _startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);
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

module.exports = { tracer, Tracer, Span };