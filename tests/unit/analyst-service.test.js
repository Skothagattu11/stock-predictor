'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAnalystService, blendConfidence } = require('../../src/analyst-service');
const { TtlCache } = require('../../src/cache');

// ---- fakes -----------------------------------------------------------------
function narrative(verdict = 'BUY') {
  return {
    overview: { thesis: 'THESIS_MARKER' },
    financials: { trend: 'improving', beatMiss: 'beat' },
    strengthsRisks: { strengths: ['moat'], risks: ['ban'] },
    valuation: { vsSector: 'premium', vsHistory: 'mid', assessment: 'fair' },
    technical: { setup: 'bullish' },
    recommendation: { verdict, primaryDrivers: ['growth'], invalidationConditions: ['x'], confidenceJustification: 'ok' },
  };
}

// A rich Stage-A fundamentals stub shaped like the documented fmp-client output.
function bullishFundamentals() {
  return {
    profile: { sector: 'Semiconductors', mktCap: 2.89e12 },
    income: [{ revenue: 44.1e9, eps: 0.96, grossMargin: 0.75 }, { revenue: 26e9 }],
    metrics: { peRatio: 35, priceToSalesRatio: 19, evToEbitda: 29, pegRatio: 0.24, pbRatio: 40, debtToEquity: 0.41, freeCashFlowPerShare: 2.4 },
  };
}
function bullishTech() {
  return {
    available: true, currentPrice: 118.2,
    rsi: { value: 62.4, period: 14 },
    macd: { value: 1, signal: 0.5, crossover: 'bullish' },
    movingAverages: { sma20: 115, sma50: 110, sma200: 98, priceVsSma20: 'above', priceVsSma50: 'above', priceVsSma200: 'above' },
    cross: 'golden_active',
    bollinger: { upper: 124, middle: 116, lower: 108, position: 'inside' },
    pivots: { resistance: [124.5], support: [112] },
  };
}

function provider(name, behavior) {
  const prompts = [];
  return { name, prompts, calls: 0, async generate(p) { this.calls++; prompts.push(p); return behavior(p, this.calls); } };
}

function deps(overrides = {}) {
  return {
    fmp: { getFundamentals: async () => bullishFundamentals() },
    technicals: { computeTechnicals: async () => bullishTech() },
    news: { fetchNews: async () => [{ headline: 'NEWS_MARKER' }] },
    cache: new TtlCache(),
    now: () => '2026-07-09T00:00:00Z',
    ...overrides,
  };
}

// ---- blendConfidence (deterministic, Doc 2 exact) --------------------------
test('blendConfidence: fully bullish inputs score high (>=80)', () => {
  const c = blendConfidence(bullishFundamentals(), bullishTech());
  assert.ok(c >= 80, `expected >=80, got ${c}`);
});

test('blendConfidence: no data returns 50', () => {
  assert.equal(blendConfidence({}, { available: false }), 50);
});

test('blendConfidence: bearish/conflicting inputs score low (<50)', () => {
  const bearTech = { available: true, rsi: { value: 15 }, macd: { crossover: 'bearish' }, movingAverages: { priceVsSma200: 'below' } };
  const bearFund = { metrics: { peRatio: 90, debtToEquity: 3 }, income: [{ revenue: 10 }, { revenue: 20 }] };
  assert.ok(blendConfidence(bearFund, bearTech) < 50);
});

test('blendConfidence: negative P/E does NOT score the valuation point', () => {
  const techOff = { available: false };
  const loss = { metrics: { peRatio: -20, debtToEquity: 5 }, income: [{ revenue: 10 }, { revenue: 20 }] };
  // total=3 fundamentals, only debtToEquity/growth checked; peRatio<0 must not count.
  assert.equal(blendConfidence(loss, techOff), 0);
});

test('blendConfidence: zero debt-to-equity DOES score the low-leverage point', () => {
  const techOff = { available: false };
  const debtFree = { metrics: { peRatio: 100, debtToEquity: 0 }, income: [{ revenue: 10 }, { revenue: 20 }] };
  // only debtToEquity==0 (<1) scores → 1 of 3.
  assert.equal(blendConfidence(debtFree, techOff), 33);
});

test('blendConfidence: null prior-period revenue does NOT grant the growth point', () => {
  const techOff = { available: false };
  const single = { metrics: { peRatio: 100, debtToEquity: 5 }, income: [{ revenue: 44e9 }, { revenue: null }] };
  assert.equal(blendConfidence(single, techOff), 0);
});

// ---- pipeline / merge ------------------------------------------------------
test('report merges Stage-A numbers with LLM narrative; no meta field', async () => {
  const p = provider('anthropic', () => narrative('BUY'));
  const svc = createAnalystService(deps({ llm: [p] }));
  const res = await svc.report('nvda', 'single', 'standard', false);

  // Stage-A numbers (from fmp/tech), NOT from the model:
  assert.equal(res.report.overview.mktCap, 2.89e12);
  assert.equal(res.report.financials.revenue, 44.1e9);
  assert.equal(res.report.valuation.ratios.pe, 35);
  assert.equal(res.report.technical.indicators.rsi.value, 62.4);
  assert.deepEqual(res.report.technical.keyLevels, { resistance: [124.5], support: [112] });
  assert.ok('volume' in res.report.technical.indicators); // volume carried into merged report
  assert.equal(res.report.financials.fcf, null); // per-share metric is NOT fcf; left null
  // LLM narrative:
  assert.equal(res.report.overview.thesis, 'THESIS_MARKER');
  // Contract: no meta in public response
  assert.equal('meta' in res, false);
  assert.equal(res.ticker, 'NVDA');
  assert.equal(res.disclaimer, 'For research purposes; not personalized investment advice.');
});

test('verdict is LLM-owned when confidence >= 50', async () => {
  const p = provider('anthropic', () => narrative('BUY'));
  const svc = createAnalystService(deps({ llm: [p] }));
  const res = await svc.report('nvda');
  assert.ok(res.confidence >= 50);
  assert.equal(res.verdict, 'BUY');
  assert.equal(res.report.recommendation.verdict, 'BUY');
});

test('documented override: confidence < 50 forces verdict HOLD (nested + top-level)', async () => {
  // Bearish Stage-A drives confidence < 50, even though the LLM says BUY.
  const bearTech = { available: true, rsi: { value: 15 }, macd: { crossover: 'bearish' }, movingAverages: { priceVsSma200: 'below' } };
  const bearFund = { profile: {}, metrics: { peRatio: 90, debtToEquity: 3 }, income: [{ revenue: 10 }, { revenue: 20 }] };
  const p = provider('anthropic', () => narrative('BUY'));
  const svc = createAnalystService(deps({
    llm: [p],
    fmp: { getFundamentals: async () => bearFund },
    technicals: { computeTechnicals: async () => bearTech },
  }));
  const res = await svc.report('nvda');
  assert.ok(res.confidence < 50);
  assert.equal(res.verdict, 'HOLD');
  assert.equal(res.report.recommendation.verdict, 'HOLD');
});

test('Stage A bundles fundamentals/technicals/news into the prompt', async () => {
  const p = provider('anthropic', () => narrative());
  const svc = createAnalystService(deps({ llm: [p] }));
  await svc.report('aapl');
  assert.match(p.prompts[0], /Semiconductors/);
  assert.match(p.prompts[0], /NEWS_MARKER/);
});

test('OpenAI fallback when primary errors', async () => {
  const primary = provider('anthropic', () => { const e = new Error('boom'); e.kind = 'timeout'; throw e; });
  const fallback = provider('openai', () => narrative('HOLD'));
  const svc = createAnalystService(deps({ llm: [primary, fallback] }));
  const res = await svc.report('nvda');
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 1);
  // confidence from bullish Stage-A >= 50, so LLM 'HOLD' stands
  assert.equal(res.verdict, 'HOLD');
});

test('stricter-prompt retry on schema failure, same provider', async () => {
  const p = provider('anthropic', (_p, n) => (n === 1 ? { bad: true } : narrative('BUY')));
  const svc = createAnalystService(deps({ llm: [p] }));
  const res = await svc.report('nvda');
  assert.equal(p.calls, 2);
  assert.match(p.prompts[1], /failed schema validation/i);
  assert.equal(res.verdict, 'BUY');
});

test('empty required narrative arrays trigger a stricter-prompt retry', async () => {
  // First response is schema-valid but has empty primaryDrivers → must retry, not serve.
  const emptyDrivers = () => { const n = narrative('BUY'); n.recommendation.primaryDrivers = []; return n; };
  const p = provider('anthropic', (_p, n) => (n === 1 ? emptyDrivers() : narrative('BUY')));
  const svc = createAnalystService(deps({ llm: [p] }));
  const res = await svc.report('nvda');
  assert.equal(p.calls, 2); // retried
  assert.ok(res.report.recommendation.primaryDrivers.length > 0);
});

test('all providers failing → 503', async () => {
  const p = provider('anthropic', () => { throw new Error('down'); });
  const svc = createAnalystService(deps({ llm: [p] }));
  await assert.rejects(() => svc.report('nvda'), (e) => e.status === 503);
});

test('auth/config errors fail over immediately (no stricter-prompt retry)', async () => {
  const primary = provider('anthropic', () => { throw new Error('invalid API key'); });
  const fallback = provider('openai', () => narrative('BUY'));
  const svc = createAnalystService(deps({ llm: [primary, fallback] }));
  const res = await svc.report('nvda');
  assert.equal(primary.calls, 1); // NOT retried on the same provider
  assert.equal(fallback.calls, 1);
  assert.equal(res.verdict, 'BUY');
});

test('FMP failure fails the pipeline (core source) — propagates, no fabricated report', async () => {
  const p = provider('anthropic', () => narrative('BUY'));
  const svc = createAnalystService(deps({
    llm: [p],
    fmp: { getFundamentals: async () => { const e = new Error('FMP 429'); e.status = 429; throw e; } },
  }));
  await assert.rejects(() => svc.report('nvda'), (e) => e.message === 'FMP 429' && e.status === 429);
});

test('cache hit avoids a second LLM call', async () => {
  const p = provider('anthropic', () => narrative());
  const svc = createAnalystService(deps({ llm: [p] }));
  const first = await svc.report('nvda', 'single', 'standard', false);
  const second = await svc.report('nvda', 'single', 'standard', false);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(p.calls, 1);
});

test('fresh=true bypasses cache and regenerates', async () => {
  const p = provider('anthropic', () => narrative());
  const svc = createAnalystService(deps({ llm: [p] }));
  await svc.report('nvda', 'single', 'standard', false);
  const fresh = await svc.report('nvda', 'single', 'standard', true);
  assert.equal(fresh.cacheHit, false);
  assert.equal(p.calls, 2);
});

test('technicals unavailable → report still generated, technical.available=false', async () => {
  const p = provider('anthropic', () => narrative());
  const svc = createAnalystService(deps({
    llm: [p],
    technicals: { computeTechnicals: async () => { throw new Error('yahoo down'); } },
  }));
  const res = await svc.report('nvda');
  assert.equal(res.report.technical.available, false);
  assert.equal(res.report.technical.setup, 'unavailable');
});

test('empty ticker → 400', async () => {
  const p = provider('anthropic', () => narrative());
  const svc = createAnalystService(deps({ llm: [p] }));
  await assert.rejects(() => svc.report('   '), (e) => e.status === 400);
});

test('missing required deps throws at construction', () => {
  assert.throws(() => createAnalystService({ fmp: {}, technicals: {} }), /requires/);
});

// ---- comparison mode (M5) --------------------------------------------------
test('comparison: returns per-ticker results + LLM rankedVerdict', async () => {
  // Provider returns a narrative for report prompts, a ranking for the rank prompt.
  const p = {
    name: 'anthropic', calls: 0,
    async generate(prompt) {
      this.calls++;
      if (/Rank these/i.test(prompt)) return { ranked: ['AAPL', 'NVDA'], rationale: 'AAPL is cheaper on PEG.' };
      return narrative('BUY');
    },
  };
  const svc = createAnalystService(deps({ llm: [p] }));
  const res = await svc.comparison(['nvda', 'aapl'], 'standard', false);
  assert.equal(res.mode, 'comparison');
  assert.equal(res.results.length, 2);
  assert.deepEqual(res.rankedVerdict.ranked, ['AAPL', 'NVDA']);
  assert.match(res.rankedVerdict.rationale, /cheaper/i);
});

test('comparison: falls back to confidence-sorted ranking when the LLM rank pass fails', async () => {
  const p = provider('anthropic', (prompt) => {
    if (/Rank these/i.test(prompt)) throw new Error('rank pass down');
    return narrative('BUY');
  });
  const svc = createAnalystService(deps({ llm: [p] }));
  const res = await svc.comparison(['nvda', 'aapl'], 'standard', false);
  assert.equal(res.results.length, 2);
  assert.equal(res.rankedVerdict.ranked.length, 2);
  assert.match(res.rankedVerdict.rationale, /confidence/i); // fallback rationale
});
