'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapFundamentals, getFundamentals, _resetSession } = require('../../src/yahoo-fundamentals');

function yahooResult() {
  return {
    assetProfile: { sector: 'Technology' },
    summaryDetail: { marketCap: { raw: 286e9 }, trailingPE: { raw: 66.3 }, priceToSalesTrailing12Months: { raw: 21.7 } },
    defaultKeyStatistics: { pegRatio: { raw: 1.2 }, priceToBook: { raw: 5.1 }, enterpriseToEbitda: { raw: 18 }, trailingEps: { raw: 29.19 } },
    financialData: { totalRevenue: { raw: 13.18e9 }, grossMargins: { raw: 0.56 }, freeCashflow: { raw: 2.26e9 }, debtToEquity: { raw: 1.503 }, returnOnEquity: { raw: 0.4 }, totalCash: { raw: 3.7e9 }, totalDebt: { raw: 207e6 } },
    incomeStatementHistory: { incomeStatementHistory: [{ totalRevenue: { raw: 7.35e9 }, grossProfit: { raw: 4.1e9 } }, { totalRevenue: { raw: 6.6e9 } }] },
  };
}

test('mapFundamentals: normalises Yahoo result to the fmp-client shape', () => {
  const f = mapFundamentals(yahooResult());
  assert.equal(f.profile.sector, 'Technology');
  assert.equal(f.profile.mktCap, 286e9);
  assert.equal(f.metrics.peRatio, 66.3);
  assert.equal(f.metrics.pegRatio, 1.2);
  assert.equal(f.cashFlow.freeCashFlow, 2.26e9);
  assert.equal(f.income[0].revenue, 7.35e9);
  assert.equal(f.income[0].eps, 29.19);         // filled from trailingEps
  assert.equal(f.income[1].revenue, 6.6e9);
  assert.equal(f.balance.totalDebt, 207e6);
  assert.equal(f.limited, false);
});

test('mapFundamentals: normalises debtToEquity percentage to a ratio', () => {
  const f = mapFundamentals(yahooResult());
  assert.ok(Math.abs(f.metrics.debtToEquity - 0.01503) < 1e-9); // 1.503% → 0.01503
});

function mockFetch(summaryStatus = 200) {
  return async (url) => {
    if (url.includes('fc.yahoo.com')) return { status: 404, headers: { getSetCookie: () => ['A1=abc'] } };
    if (url.includes('getcrumb')) return { status: 200, text: async () => 'CRUMB' };
    return { status: summaryStatus, ok: summaryStatus === 200, json: async () => ({ quoteSummary: { result: [yahooResult()] } }) };
  };
}

test('getFundamentals: handshake + returns mapped data', async () => {
  _resetSession();
  const f = await getFundamentals('SNDK', null, { fetchImpl: mockFetch(200) });
  assert.equal(f.profile.sector, 'Technology');
  assert.equal(f.income[0].revenue, 7.35e9);
});

test('getFundamentals: non-ok summary throws with status', async () => {
  _resetSession();
  await assert.rejects(() => getFundamentals('ZZZZ', null, { fetchImpl: mockFetch(503) }), (e) => e.status === 503);
});
