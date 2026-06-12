'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TtlCache } = require('../src/cache');
const { createPredictService } = require('../src/predict-service');

function fakeSidecar(counts) {
  return {
    intraday: async (s) => (counts.intraday = (counts.intraday || 0) + 1, { symbol: s, bias: 'Bullish' }),
    outlook: async (s) => ({ symbol: s, stance: 'Constructive' }),
    macro: async () => ({ vix: 15 }),
    fundamentals: async (s) => ({ merged: { symbol: s } }),
    impliedMove: async (s) => ({ symbol: s, high: 1, low: 0, spot: 0.5 }),
    position: async (p) => (counts.position = (counts.position || 0) + 1, { symbol: p.symbol, action: 'HOLD' }),
    portfolio: async (h) => ({ holdings: h }),
  };
}

test('intraday is cached (sidecar hit once within ttl)', async () => {
  const counts = {};
  const svc = createPredictService({ sidecar: fakeSidecar(counts), cache: new TtlCache() });
  await svc.intraday('AAPL');
  await svc.intraday('AAPL');
  assert.equal(counts.intraday, 1);
});

test('position is uncached pass-through (param-specific)', async () => {
  const counts = {};
  const svc = createPredictService({ sidecar: fakeSidecar(counts), cache: new TtlCache() });
  await svc.position('AAPL', { current_price: 130, cost_basis: 100 });
  await svc.position('AAPL', { current_price: 131, cost_basis: 100 });
  assert.equal(counts.position, 2);
});

test('setups is cached', async () => {
  const counts = {};
  const sidecar = { setups: async (s) => (counts.s = (counts.s || 0) + 1, { symbol: s, setups: [] }) };
  const { createPredictService } = require('../src/predict-service');
  const svc = createPredictService({ sidecar, cache: new (require('../src/cache').TtlCache)() });
  await svc.setups('AAPL'); await svc.setups('AAPL');
  assert.equal(counts.s, 1);
});

test('discover is cached', async () => {
  const counts = {};
  const sidecar = { discover: async () => (counts.d = (counts.d || 0) + 1, { hot: [], penny: [], shine: [] }) };
  const { createPredictService } = require('../src/predict-service');
  const svc = createPredictService({ sidecar, cache: new (require('../src/cache').TtlCache)() });
  await svc.discover(); await svc.discover();
  assert.equal(counts.d, 1);
});
