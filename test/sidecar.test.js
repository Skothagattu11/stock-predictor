'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSidecar } = require('../src/sidecar');

function fakeFetch(record, payload = { ok: true }, status = 200, httpOk = true) {
  return async (url, opts) => {
    record.url = url; record.opts = opts;
    return { ok: httpOk, status, json: async () => payload };
  };
}

test('intraday issues GET to the right path and parses json', async () => {
  const rec = {};
  const s = createSidecar({ baseUrl: 'http://side', fetchImpl: fakeFetch(rec, { bias: 'Bullish' }) });
  const out = await s.intraday('aapl');
  assert.equal(rec.url, 'http://side/predict/intraday/aapl');
  assert.equal(rec.opts.method, 'GET');
  assert.equal(out.bias, 'Bullish');
});

test('portfolio issues POST with json body', async () => {
  const rec = {};
  const s = createSidecar({ baseUrl: 'http://side', fetchImpl: fakeFetch(rec, { flags: [] }) });
  await s.portfolio([{ symbol: 'AAPL', value: 100 }]);
  assert.equal(rec.opts.method, 'POST');
  assert.deepEqual(JSON.parse(rec.opts.body), { holdings: [{ symbol: 'AAPL', value: 100 }] });
});

test('position builds a query string from params', async () => {
  const rec = {};
  const s = createSidecar({ baseUrl: 'http://side', fetchImpl: fakeFetch(rec, {}) });
  await s.position({ symbol: 'AAPL', current_price: 130, cost_basis: 100, shares: 10 });
  assert.ok(rec.url.startsWith('http://side/predict/position/AAPL?'));
  assert.ok(rec.url.includes('current_price=130'));
  assert.ok(!rec.url.includes('symbol='));   // symbol is in the path, not the query
});

test('non-ok response throws', async () => {
  const s = createSidecar({ baseUrl: 'http://side', fetchImpl: fakeFetch({}, {}, 503, false) });
  await assert.rejects(() => s.intraday('AAPL'), /503/);
});

test('thrown error carries the upstream status code', async () => {
  const s = createSidecar({ baseUrl: 'http://side', fetchImpl: fakeFetch({}, {}, 422, false) });
  await assert.rejects(() => s.setups('AAPL'), (e) => e.status === 422);
});

test('scheme-less baseUrl (Render fromService host) defaults to https', async () => {
  const rec = {};
  const s = createSidecar({ baseUrl: 'quant-py.onrender.com', fetchImpl: fakeFetch(rec, {}) });
  await s.intraday('AAPL');
  assert.equal(rec.url, 'https://quant-py.onrender.com/predict/intraday/AAPL');
});
