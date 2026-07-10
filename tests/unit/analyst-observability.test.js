'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createObservability } = require('../../src/analyst-observability');

// logPath: null → no filesystem writes (pure offline unit test).
function obs() { return createObservability({ logPath: null }); }

test('log: records a request and stamps a ts', () => {
  const o = obs();
  o.log({ ticker: 'NVDA', verdict: 'BUY', confidence: 80, cacheHit: false, totalMs: 100 });
  const m = o.getMetrics();
  assert.equal(m.requests.length, 1);
  assert.equal(m.requests[0].ticker, 'NVDA');
  assert.ok(m.requests[0].ts);
  assert.equal(m.summary.totalRequests, 1);
});

test('logError: records into the error ring, separate from requests', () => {
  const o = obs();
  o.logError({ ticker: 'BAD', error: 'FMP_429' });
  const m = o.getMetrics();
  assert.equal(m.errors.length, 1);
  assert.equal(m.errors[0].error, 'FMP_429');
  assert.equal(m.requests.length, 0);
});

test('summary: cacheHitRate and avgTotalMs computed across requests', () => {
  const o = obs();
  o.log({ ticker: 'A', cacheHit: false, totalMs: 100 });
  o.log({ ticker: 'B', cacheHit: true, totalMs: 0 });
  o.log({ ticker: 'C', cacheHit: false, totalMs: 200 });
  const s = o.getMetrics().summary;
  assert.equal(s.totalRequests, 3);
  assert.equal(s.cacheHitRate, 0.33); // 1/3
  assert.equal(s.avgTotalMs, 100);    // (100+0+200)/3
});

test('summary: fmpCallsToday accumulates', () => {
  const o = obs();
  o.log({ ticker: 'A', fmpCalls: 4 });
  o.log({ ticker: 'B', fmpCalls: 4 });
  assert.equal(o.getMetrics().summary.fmpCallsToday, 8);
});

test('requests ring buffer caps at 50; getMetrics returns newest 20', () => {
  const o = obs();
  for (let i = 0; i < 60; i++) o.log({ ticker: `T${i}` });
  const m = o.getMetrics();
  assert.equal(m.requests.length, 20);           // getMetrics slice
  assert.equal(m.requests[0].ticker, 'T59');     // newest first
  assert.equal(m.summary.totalRequests, 60);     // cumulative counter unaffected by ring
});

test('errors ring buffer caps at 10', () => {
  const o = obs();
  for (let i = 0; i < 15; i++) o.logError({ error: `E${i}` });
  const m = o.getMetrics();
  assert.equal(m.errors.length, 10);
  assert.equal(m.errors[0].error, 'E14');
});

test('empty metrics are well-formed', () => {
  const s = obs().getMetrics().summary;
  assert.equal(s.totalRequests, 0);
  assert.equal(s.cacheHitRate, 0);
  assert.equal(s.avgTotalMs, 0);
});
