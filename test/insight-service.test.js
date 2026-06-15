'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createInsightService } = require('../src/insight-service');

const fakePredict = {
  intraday: async (s) => ({ symbol: s, bias: 'Bullish', probability_up: 0.7, expected_move: { base: 100 } }),
  outlook: async (s) => ({ symbol: s, stance: 'Constructive', confidence: 0.6 }),
};

test('no LLM adapters => pure-quant consensus from the quant voice', async () => {
  const router = { size: 0, ensemble: async () => [] };
  const svc = createInsightService({ predictService: fakePredict, router });
  const out = await svc.insight('intraday', 'AAPL');
  assert.equal(out.models.length, 0);
  assert.equal(out.consensus.stance, 'bullish');     // mapped from quant bias
  assert.equal(out.quant.symbol, 'AAPL');
});

test('LLM voices join the quant voice in consensus', async () => {
  const router = {
    size: 2,
    ensemble: async () => [
      { name: 'openai', ok: true, result: { stance: 'bullish', confidence: 0.7, rationale: 'r', sources: [] } },
      { name: 'gemini', ok: true, result: { stance: 'bullish', confidence: 0.6, rationale: 'r', sources: [] } },
    ],
  };
  const svc = createInsightService({ predictService: fakePredict, router });
  const out = await svc.insight('intraday', 'AAPL');
  assert.equal(out.models.length, 2);
  assert.equal(out.consensus.stance, 'bullish');
  assert.equal(out.consensus.votes.length, 3);       // quant + 2 models
  assert.equal(out.consensus.divergence, false);
});

test('outlook maps Cautious => bearish quant vote', async () => {
  const router = { size: 0, ensemble: async () => [] };
  const svc = createInsightService({ predictService: {
    outlook: async (s) => ({ symbol: s, stance: 'Cautious', confidence: 0.5 }) }, router });
  const out = await svc.insight('outlook', 'AAPL');
  assert.equal(out.consensus.stance, 'bearish');
});

test('statistical voice joins consensus when available', async () => {
  const predictService = {
    intraday: async (s) => ({ symbol: s, bias: 'Bullish', probability_up: 0.7 }),
    statistical: async () => ({ stance: 'bullish', confidence: 0.5 }),
  };
  const router = { size: 0, ensemble: async () => [] };
  const { createInsightService } = require('../src/insight-service');
  const svc = createInsightService({ predictService, router });
  const out = await svc.insight('intraday', 'AAPL');
  const names = out.consensus.votes.map((v) => v.name);
  assert.ok(names.includes('quant'));
  assert.ok(names.includes('statistical'));
});

test('missing statistical method is skipped gracefully', async () => {
  const predictService = { intraday: async (s) => ({ symbol: s, bias: 'Bullish', probability_up: 0.7 }) };
  const router = { size: 0, ensemble: async () => [] };
  const { createInsightService } = require('../src/insight-service');
  const out = await createInsightService({ predictService, router }).insight('intraday', 'AAPL');
  assert.deepEqual(out.consensus.votes.map((v) => v.name), ['quant']);
});
