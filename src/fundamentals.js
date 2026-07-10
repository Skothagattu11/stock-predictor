'use strict';
// Fundamentals provider: FMP primary → Yahoo fallback, both normalised to the SAME
// shape so the analyst scoring + LLM pipeline is source-agnostic. Injected into
// analyst-service as the `fmp` dependency (getFundamentals / getPeers).
//
// Policy:
//   - FMP full (not `limited`)         → use FMP.
//   - FMP gated (`limited`) or errored → fetch Yahoo; merge FMP-present fields over
//     Yahoo (prefer FMP where non-null), so gated financials get filled from Yahoo.
//   - Neither available                → propagate the FMP error (status preserved).

function pick(a, b) { return a != null ? a : b; }

function mergePreferFmp(f, y) {
  if (!f) return { ...y, limited: false };
  const fIncomeOk = Array.isArray(f.income) && f.income.length && f.income[0] && f.income[0].revenue != null;
  return {
    profile: {
      sector: f.profile.sector || y.profile.sector || '',
      mktCap: pick(f.profile.mktCap, y.profile.mktCap),
    },
    income: fIncomeOk ? f.income : y.income,
    metrics: {
      peRatio: pick(f.metrics.peRatio, y.metrics.peRatio),
      priceToSalesRatio: pick(f.metrics.priceToSalesRatio, y.metrics.priceToSalesRatio),
      evToEbitda: pick(f.metrics.evToEbitda, y.metrics.evToEbitda),
      pegRatio: pick(f.metrics.pegRatio, y.metrics.pegRatio),
      pbRatio: pick(f.metrics.pbRatio, y.metrics.pbRatio),
      debtToEquity: pick(f.metrics.debtToEquity, y.metrics.debtToEquity),
      returnOnEquity: pick(f.metrics.returnOnEquity, y.metrics.returnOnEquity),
      interestCoverage: pick(f.metrics.interestCoverage, y.metrics.interestCoverage),
    },
    cashFlow: { freeCashFlow: pick(f.cashFlow.freeCashFlow, y.cashFlow && y.cashFlow.freeCashFlow) },
    balance: {
      cash: pick(f.balance && f.balance.cash, y.balance && y.balance.cash),
      totalDebt: pick(f.balance && f.balance.totalDebt, y.balance && y.balance.totalDebt),
      netDebt: pick(f.balance && f.balance.netDebt, y.balance && y.balance.netDebt),
    },
    limited: false,
  };
}

function createFundamentals({ fmp, yahoo }) {
  if (!fmp) throw new Error('createFundamentals requires { fmp }');

  async function getFundamentals(symbol, key, opts) {
    let fmpData = null;
    let fmpErr = null;
    try { fmpData = await fmp.getFundamentals(symbol, key, opts); } catch (e) { fmpErr = e; }

    // FMP has full data → use it directly.
    if (fmpData && !fmpData.limited) return { ...fmpData, source: 'fmp' };

    // FMP gated or errored → try Yahoo and merge.
    if (yahoo) {
      let yahooData = null;
      try { yahooData = await yahoo.getFundamentals(symbol, key, opts); } catch (_) { /* fall through */ }
      if (yahooData) return { ...mergePreferFmp(fmpData, yahooData), source: fmpData ? 'fmp+yahoo' : 'yahoo' };
    }

    if (fmpData) return { ...fmpData, source: 'fmp' }; // partial FMP, no Yahoo
    const e = fmpErr || new Error(`fundamentals unavailable for ${symbol}`);
    if (!e.status) e.status = 503;
    throw e;
  }

  const getPeers = typeof fmp.getPeers === 'function'
    ? (symbol, key, opts) => fmp.getPeers(symbol, key, opts)
    : async () => [];

  return { getFundamentals, getPeers, CALLS_PER_REQUEST: fmp.CALLS_PER_REQUEST || 0 };
}

module.exports = { createFundamentals, mergePreferFmp };
