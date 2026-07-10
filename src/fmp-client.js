'use strict';
// FMP fundamentals client. Uses FMP's current "stable" API (query-param style):
// the legacy /api/v3/ path endpoints now return 403 "Legacy Endpoint" for new free
// keys. Fundamentals only — price/candles/technicals come from Yahoo, not here.
//
// getFundamentals(symbol, key) → the shape analyst-service expects:
//   { profile:{sector,mktCap}, income:[{revenue,eps,grossMargin},{revenue}],
//     metrics:{peRatio,priceToSalesRatio,evToEbitda,pegRatio,pbRatio,debtToEquity,returnOnEquity},
//     cashFlow:{freeCashFlow} }

const BASE = 'https://financialmodelingprep.com/stable';

function num(x) { return typeof x === 'number' && Number.isFinite(x) ? x : null; }

async function fmpGet(endpoint, symbol, key, extra, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const url = `${BASE}/${endpoint}?symbol=${encodeURIComponent(symbol)}${extra || ''}&apikey=${encodeURIComponent(key)}`;
  const res = await doFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) {
    const e = new Error(`FMP ${endpoint} -> ${res.status}`);
    e.status = res.status === 429 ? 429 : 503;
    throw e;
  }
  return res.json();
}

function first(x) { return Array.isArray(x) ? x[0] : x; }

function mapIncome(q) {
  if (!q) return { revenue: null, eps: null, grossMargin: null };
  const rev = num(q.revenue);
  const gp = num(q.grossProfit);
  return { revenue: rev, eps: num(q.eps), grossMargin: rev && gp != null ? gp / rev : null };
}

// Number of FMP API calls one getFundamentals() makes (for quota accounting).
const CALLS_PER_REQUEST = 6;

async function getFundamentals(symbol, key, { fetchImpl } = {}) {
  if (!key) { const e = new Error('FMP_API_KEY not configured'); e.status = 503; throw e; }
  // Only `profile` is required. The financial statements are gated per-symbol on FMP's
  // free tier ("premium/special endpoint" 402 for many tickers), so a failure of any of
  // them degrades that piece to null rather than failing the whole report — the LLM then
  // works from technicals + whatever fundamentals are available.
  // profile is a HARD fetch — its failure (bad symbol, 429 rate limit) propagates with
  // its status. The financial statements use settle() so a per-symbol 402 gate degrades
  // to null instead of failing the report.
  const settle = (ep, extra) => fmpGet(ep, symbol, key, extra, fetchImpl).then((d) => ({ ok: true, d })).catch(() => ({ ok: false }));
  const [profileA, incomeR, kmR, ratiosR, cashR, balanceR] = await Promise.all([
    fmpGet('profile', symbol, key, '', fetchImpl),
    settle('income-statement', '&limit=5'),
    settle('key-metrics-ttm', ''),
    settle('ratios-ttm', ''),
    settle('cash-flow-statement', '&limit=1'),
    settle('balance-sheet-statement', '&limit=1'),
  ]);
  const p = first(profileA);
  if (!p || !p.symbol) { const e = new Error(`FMP no profile for ${symbol}`); e.status = 503; throw e; }
  const km = (kmR.ok && first(kmR.d)) || {};
  const rt = (ratiosR.ok && first(ratiosR.d)) || {};
  const cf = (cashR.ok && first(cashR.d)) || {};
  const bs = (balanceR.ok && first(balanceR.d)) || {};
  const inc = incomeR.ok && Array.isArray(incomeR.d) ? incomeR.d : [];
  // True if the free tier gated the financial statements for this symbol.
  const limited = !incomeR.ok || !kmR.ok || !ratiosR.ok || !cashR.ok || !balanceR.ok;
  return {
    profile: { sector: p.sector || '', mktCap: num(p.marketCap) },
    income: inc.slice(0, 5).map(mapIncome), // trailing trend for LLM context
    metrics: {
      peRatio: num(rt.priceToEarningsRatioTTM),
      priceToSalesRatio: num(rt.priceToSalesRatioTTM),
      evToEbitda: num(km.evToEBITDATTM),
      pegRatio: num(rt.priceToEarningsGrowthRatioTTM),
      pbRatio: num(rt.priceToBookRatioTTM),
      debtToEquity: num(rt.debtToEquityRatioTTM), // already a ratio in stable API
      returnOnEquity: num(rt.returnOnEquityTTM),
      interestCoverage: num(rt.interestCoverageRatioTTM),
    },
    // True free cash flow (operating cash flow − capex), NOT free-cash-flow-to-equity.
    cashFlow: { freeCashFlow: num(cf.freeCashFlow) },
    balance: { cash: num(bs.cashAndCashEquivalents), totalDebt: num(bs.totalDebt), netDebt: num(bs.netDebt) },
    limited,
  };
}

// Peer set for deep mode (1 FMP call). Degrades to [] on any failure — never fatal.
async function getPeers(symbol, key, { fetchImpl } = {}) {
  if (!key) return [];
  try {
    const data = await fmpGet('stock-peers', symbol, key, '', fetchImpl);
    const arr = Array.isArray(data) ? data : [];
    return arr.slice(0, 6).map((p) => ({ symbol: p.symbol, name: p.companyName || '', mktCap: num(p.mktCap) }));
  } catch (_) {
    return [];
  }
}

module.exports = { getFundamentals, getPeers, mapIncome, CALLS_PER_REQUEST };
