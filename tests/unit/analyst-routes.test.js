'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAnalystRouter, validateTicker } = require('../../src/analyst-routes');
const { createObservability } = require('../../src/analyst-observability');

// --- offline component harness: mount router with stub svc + stub probes ---
function makeServer(overrides = {}) {
  const obs = createObservability({ logPath: null });
  const svc = overrides.svc || {
    report: async (ticker) => ({ ticker, verdict: 'BUY', confidence: 80, cacheHit: false, report: { recommendation: { verdict: 'BUY' } }, disclaimer: 'x' }),
    comparison: async (tickers) => ({
      mode: 'comparison',
      results: tickers.map((t) => ({ ticker: t.toUpperCase(), verdict: 'BUY', confidence: 80, report: {} })),
      rankedVerdict: { ranked: tickers.map((t) => t.toUpperCase()), rationale: 'top pick reason' },
    }),
  };
  const probes = overrides.probes || {
    fmp: async () => ({ ok: false, reason: 'FMP_API_KEY not configured' }),
    yahoo: async () => ({ ok: true }),
    llm: async () => ({ ok: true }),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/analyst', createAnalystRouter({ svc, obs, config: {}, probes }));
  const server = app.listen(0);
  const port = server.address().port;
  return { server, port, obs, svc };
}

let ctx;
before(() => { ctx = makeServer(); });
after(() => ctx.server.close());

function post(port, path, body) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

// --- validateTicker (pure) --------------------------------------------------
test('validateTicker: accepts good tickers, rejects bad', () => {
  assert.equal(validateTicker('NVDA'), null);
  assert.equal(validateTicker('brk.b'), null);
  assert.ok(validateTicker(''));
  assert.ok(validateTicker('TOOLONGTICKER'));
  assert.ok(validateTicker('BAD SPACE'));
});

// --- POST /report -----------------------------------------------------------
test('POST /report: valid ticker returns the service result', async () => {
  const r = await post(ctx.port, '/api/analyst/report', { ticker: 'nvda', mode: 'single', depth: 'standard' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ticker, 'NVDA');
  assert.ok(['BUY', 'HOLD', 'SELL'].includes(d.verdict));
});

test('POST /report: invalid ticker → 400 before calling the service', async () => {
  const r = await post(ctx.port, '/api/analyst/report', { ticker: 'BAD TICKER' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /1–10 alphanumeric/);
});

test('POST /report: missing ticker → 400', async () => {
  const r = await post(ctx.port, '/api/analyst/report', {});
  assert.equal(r.status, 400);
});

test('POST /report: service failure → 503 with retryAfter', async () => {
  const s = makeServer({ svc: { report: async () => { const e = new Error('FMP 429 rate limit'); e.status = 429; throw e; } } });
  const r = await post(s.port, '/api/analyst/report', { ticker: 'NVDA' });
  assert.equal(r.status, 503);
  const d = await r.json();
  assert.equal(d.retryAfter, 60); // rate-limit → 60
  s.server.close();
});

test('POST /report: comparison mode requires >= 2 tickers', async () => {
  const r = await post(ctx.port, '/api/analyst/report', { mode: 'comparison', tickers: ['NVDA'] });
  assert.equal(r.status, 400);
});

test('POST /report: comparison mode returns results + rankedVerdict', async () => {
  const r = await post(ctx.port, '/api/analyst/report', { mode: 'comparison', tickers: ['NVDA', 'AAPL'] });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.mode, 'comparison');
  assert.equal(d.results.length, 2);
  assert.ok(Array.isArray(d.rankedVerdict.ranked));
  assert.ok(d.rankedVerdict.rationale.length > 0);
});

// --- GET /health & /metrics -------------------------------------------------
test('GET /health: honestly reports FMP unavailable when not configured', async () => {
  const r = await fetch(`http://localhost:${ctx.port}/api/analyst/health`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.connectors.fmp.status, 'unavailable'); // not 'ok'
  assert.equal(d.connectors.yahoo.status, 'ok');
  assert.equal(d.status, 'degraded'); // fmp down but others up
});

test('GET /metrics: returns requests/errors/summary shape', async () => {
  const r = await fetch(`http://localhost:${ctx.port}/api/analyst/metrics`);
  const d = await r.json();
  assert.ok(Array.isArray(d.requests));
  assert.ok(Array.isArray(d.errors));
  assert.ok('totalRequests' in d.summary);
});

test('createAnalystRouter: throws without required deps', () => {
  assert.throws(() => createAnalystRouter({}), /requires/);
});
