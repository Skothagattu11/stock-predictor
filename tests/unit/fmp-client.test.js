'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getFundamentals, mapIncome } = require('../../src/fmp-client');

test('mapIncome: computes grossMargin from grossProfit/revenue', () => {
  const m = mapIncome({ revenue: 1000, grossProfit: 480, eps: 7.49 });
  assert.equal(m.revenue, 1000);
  assert.equal(m.eps, 7.49);
  assert.ok(Math.abs(m.grossMargin - 0.48) < 1e-9);
});

test('mapIncome: missing fields → nulls, no NaN', () => {
  const m = mapIncome({});
  assert.equal(m.revenue, null);
  assert.equal(m.grossMargin, null);
});

// Mock fetch keyed on the stable endpoint in the URL.
function mockFetch(map, status = 200) {
  return async (url) => {
    const ep = ['profile', 'income-statement', 'key-metrics-ttm', 'ratios-ttm', 'cash-flow-statement', 'balance-sheet-statement'].find((e) => url.includes('/' + e + '?'));
    return { ok: status === 200, status, json: async () => map[ep] };
  };
}

const FIXTURE = {
  profile: [{ symbol: 'AAPL', sector: 'Technology', marketCap: 4.6e12 }],
  'income-statement': [{ revenue: 416e9, grossProfit: 195e9, eps: 7.49 }, { revenue: 391e9, grossProfit: 170e9, eps: 6.1 }],
  'key-metrics-ttm': [{ evToEBITDATTM: 29.1, freeCashFlowToEquityTTM: 114e9 }],
  'ratios-ttm': [{ priceToEarningsRatioTTM: 37.9, priceToSalesRatioTTM: 10.2, priceToBookRatioTTM: 43.4, priceToEarningsGrowthRatioTTM: 2.5, debtToEquityRatioTTM: 0.795, interestCoverageRatioTTM: 112 }],
  'cash-flow-statement': [{ freeCashFlow: 98e9, operatingCashFlow: 111e9, capitalExpenditure: -13e9 }],
  'balance-sheet-statement': [{ cashAndCashEquivalents: 36e9, totalDebt: 112e9, netDebt: 76e9 }],
};

test('getFundamentals: maps FMP stable responses to the service shape', async () => {
  const f = await getFundamentals('AAPL', 'testkey', { fetchImpl: mockFetch(FIXTURE) });
  assert.equal(f.profile.sector, 'Technology');
  assert.equal(f.profile.mktCap, 4.6e12);
  assert.equal(f.income[0].revenue, 416e9);
  assert.equal(f.income[1].revenue, 391e9);
  assert.ok(Math.abs(f.income[0].grossMargin - 195 / 416) < 1e-6);
  assert.equal(f.metrics.peRatio, 37.9);
  assert.equal(f.metrics.pegRatio, 2.5);
  assert.equal(f.metrics.evToEbitda, 29.1);
  assert.equal(f.metrics.debtToEquity, 0.795); // stable API already a ratio
  assert.equal(f.metrics.interestCoverage, 112);
  assert.equal(f.cashFlow.freeCashFlow, 98e9); // true FCF from cash-flow-statement, NOT FCFE
  assert.equal(f.balance.cash, 36e9);
  assert.equal(f.balance.totalDebt, 112e9);
});

test('getFundamentals: all endpoints ok → limited is false', async () => {
  const f = await getFundamentals('AAPL', 'k', { fetchImpl: mockFetch(FIXTURE) });
  assert.equal(f.limited, false);
});

test('getFundamentals: financial statements gated (402) still return a report from profile alone', async () => {
  // profile 200, every statement endpoint 402 — like a free-tier "premium symbol" (e.g. SNDK).
  const impl = async (url) => {
    if (url.includes('/profile?')) return { ok: true, status: 200, json: async () => FIXTURE.profile };
    return { ok: false, status: 402, json: async () => ({}) };
  };
  const f = await getFundamentals('SNDK', 'k', { fetchImpl: impl });
  assert.equal(f.profile.sector, 'Technology'); // profile still present
  assert.equal(f.limited, true);
  assert.deepEqual(f.income, []);               // gated → empty, not a throw
  assert.equal(f.metrics.peRatio, null);
  assert.equal(f.cashFlow.freeCashFlow, null);
});

test('getFundamentals: throws 503 without a key', async () => {
  await assert.rejects(() => getFundamentals('AAPL', ''), (e) => e.status === 503);
});

test('getFundamentals: throws 503 when even profile is unavailable', async () => {
  const impl = async () => ({ ok: false, status: 402, json: async () => ({}) });
  await assert.rejects(() => getFundamentals('ZZZZ', 'k', { fetchImpl: impl }), (e) => e.status === 503);
});

test('getFundamentals: non-ok response throws with status', async () => {
  await assert.rejects(
    () => getFundamentals('AAPL', 'k', { fetchImpl: mockFetch(FIXTURE, 429) }),
    (e) => e.status === 429,
  );
});

test('getFundamentals: empty profile throws', async () => {
  const bad = { ...FIXTURE, profile: [] };
  await assert.rejects(() => getFundamentals('ZZZZ', 'k', { fetchImpl: mockFetch(bad) }), /no profile/);
});
