// Tiny example: capture exported OTLP payloads without a collector.
// Run with: node examples/inject-fetch.js

const { tracer } = require('../tiny_otel');

const captured = [];
const t = tracer({
  endpoint: 'http://test/v1/traces',
  serviceName: 'demo',
  fetch: async (url, init) => {
    captured.push(JSON.parse(init.body));
    return new Response(null, { status: 200 });
  },
});

(async () => {
  await t.inSpan('demo.work', async (span) => {
    span.setAttribute('demo.value', 42);
    await new Promise((r) => setTimeout(r, 5));
  });
  await t.flush();
  await t.shutdown();
  console.log(`Captured ${captured.length} export batch(es):`);
  console.log(JSON.stringify(captured, null, 2));
})();