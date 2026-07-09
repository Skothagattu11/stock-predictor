'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFundamentals, mergePreferFmp } = require('../../src/fundamentals');

function fmpFull() {
  return {
    profile: { sector: 'Tech', mktCap: 4.6e12 },
    income: [{ revenue: 416e9, eps: 7.49, grossMargin: 0.47 }, { revenue: 391e9 }],
    metrics: { peRatio: 37.9, priceToSalesRatio: 10, evToEbitda: 29, pegRatio: 2.5, pbRatio: 43, debtToEquity: 0.79, returnOnEquity: 1.4, interestCoverage: 100 },
    cashFlow: { freeCashFlow: 98e9 },
    balance: { cash: 36e9, totalDebt: 112e9, netDebt: 76e9 },
    limited: false,
  };
}
function fmpGated() { return { profile: { sector: 'Tech', mktCap: 286e9 }, income: [], metrics: { peRatio: null, priceToSalesRatio: null, evToEbitda: null, pegRatio: null, pbRatio: null, debtToEquity: null, returnOnEquity: null, interestCoverage: null }, cashFlow: { freeCashFlow: null }, balance: { cash: null, totalDebt: null, netDebt: null }, limited: true }; }
function yahooData() { return { profile: { sector: 'Technology', mktCap: 287e9 }, income: [{ revenue: 13.2e9, eps: 29.19, grossMargin: 0.56 }, { revenue: 6.6e9 }], metrics: { peRatio: 66, priceToSalesRatio: 21, evToEbitda: 18, pegRatio: 1.2, pbRatio: 5, debtToEquity: 0.015, returnOnEquity: 0.4, interestCoverage: null }, cashFlow: { freeCashFlow: 2.26e9 }, balance: { cash: 3.7e9, totalDebt: 207e6, netDebt: null }, limited: false }; }

test('FMP full → uses FMP, no Yahoo call', async () => {
  let yahooCalled = false;
  const prov = createFundamentals({ fmp: { getFundamentals: async () => fmpFull() }, yahoo: { getFundamentals: async () => { yahooCalled = true; return yahooData(); } } });
  const f = await prov.getFundamentals('AAPL', 'k');
  assert.equal(f.source, 'fmp');
  assert.equal(f.income[0].revenue, 416e9);
  assert.equal(yahooCalled, false);
});

test('FMP gated → falls back to Yahoo, fills the gated fields', async () => {
  const prov = createFundamentals({ fmp: { getFundamentals: async () => fmpGated() }, yahoo: { getFundamentals: async () => yahooData() } });
  const f = await prov.getFundamentals('SNDK', 'k');
  assert.equal(f.source, 'fmp+yahoo');
  assert.equal(f.limited, false);
  assert.equal(f.income[0].revenue, 13.2e9);     // filled from Yahoo
  assert.equal(f.metrics.peRatio, 66);
  assert.equal(f.cashFlow.freeCashFlow, 2.26e9);
  assert.equal(f.profile.sector, 'Tech');        // FMP profile preferred
});

test('FMP throws → falls back to Yahoo entirely', async () => {
  const prov = createFundamentals({ fmp: { getFundamentals: async () => { const e = new Error('402'); e.status = 503; throw e; } }, yahoo: { getFundamentals: async () => yahooData() } });
  const f = await prov.getFundamentals('SNDK', 'k');
  assert.equal(f.source, 'yahoo');
  assert.equal(f.income[0].revenue, 13.2e9);
});

test('both fail → propagates FMP error status', async () => {
  const prov = createFundamentals({ fmp: { getFundamentals: async () => { const e = new Error('down'); e.status = 429; throw e; } }, yahoo: { getFundamentals: async () => { throw new Error('yahoo down'); } } });
  await assert.rejects(() => prov.getFundamentals('X', 'k'), (e) => e.status === 429);
});

test('mergePreferFmp: prefers FMP non-null, fills nulls from Yahoo', () => {
  const merged = mergePreferFmp(fmpGated(), yahooData());
  assert.equal(merged.metrics.peRatio, 66);        // FMP null → Yahoo
  assert.equal(merged.profile.mktCap, 286e9);      // FMP present → FMP
});

test('getPeers delegates to fmp', async () => {
  const prov = createFundamentals({ fmp: { getFundamentals: async () => fmpFull(), getPeers: async () => [{ symbol: 'MSFT' }], CALLS_PER_REQUEST: 6 } });
  assert.deepEqual(await prov.getPeers('AAPL', 'k'), [{ symbol: 'MSFT' }]);
  assert.equal(prov.CALLS_PER_REQUEST, 6);
});
