'use strict';
// Fallback fundamentals via Yahoo quoteSummary (keyless), normalised to the SAME shape
// as src/fmp-client.js getFundamentals so the analyst pipeline treats it identically.
// Yahoo gates quoteSummary behind a cookie+crumb handshake (cached, refreshed on 401).
// Used only when FMP's free tier gates a symbol's financial statements. See
// docs/ANALYST_DEVIATIONS.md.

const UA = 'Mozilla/5.0';
const MODULES = 'assetProfile,summaryDetail,defaultKeyStatistics,financialData,incomeStatementHistory';
const SESSION_TTL_MS = 30 * 60 * 1000;

let _session = null; // { cookie, crumb, at }

function raw(x) {
  if (x == null) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'object' && 'raw' in x) return typeof x.raw === 'number' ? x.raw : null;
  return null;
}

async function newSession(fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const res = await doFetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
  const setCookie = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookie.map((c) => String(c).split(';')[0]).join('; ');
  const crumb = await doFetch('https://query1.finance.yahoo.com/v1/test/getcrumb',
    { headers: { 'User-Agent': UA, Cookie: cookie } }).then((r) => r.text());
  _session = { cookie, crumb, at: Date.now() };
  return _session;
}

async function getSession(fetchImpl, force) {
  if (_session && !force && Date.now() - _session.at < SESSION_TTL_MS) return _session;
  return newSession(fetchImpl);
}

async function fetchSummary(symbol, session, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' +
    encodeURIComponent(symbol) + '?modules=' + MODULES + '&crumb=' + encodeURIComponent(session.crumb);
  return doFetch(url, { headers: { 'User-Agent': UA, Cookie: session.cookie } });
}

// Pure mapper: Yahoo quoteSummary result → the fmp-client fundamentals shape.
function mapFundamentals(result) {
  const ap = result.assetProfile || {};
  const sd = result.summaryDetail || {};
  const ks = result.defaultKeyStatistics || {};
  const fd = result.financialData || {};
  const hist = (result.incomeStatementHistory && result.incomeStatementHistory.incomeStatementHistory) || [];

  const income = hist.slice(0, 5).map((q) => {
    const rev = raw(q.totalRevenue);
    const gp = raw(q.grossProfit);
    return { revenue: rev, eps: null, grossMargin: rev && gp != null ? gp / rev : null };
  });
  if (income[0]) {
    if (income[0].eps == null) income[0].eps = raw(ks.trailingEps);
    // Prefer the reliable TTM gross margin over a possibly-zero/missing history grossProfit.
    const ttmGm = raw(fd.grossMargins);
    if (ttmGm != null) income[0].grossMargin = ttmGm;
  }
  const de = raw(fd.debtToEquity);
  const cash = raw(fd.totalCash);
  const totalDebt = raw(fd.totalDebt);
  return {
    profile: { sector: ap.sector || '', mktCap: raw(sd.marketCap) },
    income,
    metrics: {
      peRatio: raw(sd.trailingPE),
      priceToSalesRatio: raw(sd.priceToSalesTrailing12Months),
      evToEbitda: raw(ks.enterpriseToEbitda),
      pegRatio: raw(ks.pegRatio),
      pbRatio: raw(ks.priceToBook),
      // Yahoo reports debtToEquity as a percentage (e.g. 79.5); normalise to a ratio.
      debtToEquity: de == null ? null : de / 100,
      returnOnEquity: raw(fd.returnOnEquity),
      interestCoverage: null, // not exposed by Yahoo quoteSummary
    },
    cashFlow: { freeCashFlow: raw(fd.freeCashflow) },
    balance: { cash, totalDebt, netDebt: cash != null && totalDebt != null ? totalDebt - cash : null },
    limited: false,
  };
}

// Signature mirrors fmp-client.getFundamentals(symbol, key, opts) — key is ignored.
async function getFundamentals(symbol, _key, { fetchImpl } = {}) {
  let session = await getSession(fetchImpl);
  let res = await fetchSummary(symbol, session, fetchImpl);
  if (res.status === 401) { session = await getSession(fetchImpl, true); res = await fetchSummary(symbol, session, fetchImpl); }
  if (!res.ok) { const e = new Error(`Yahoo fundamentals ${symbol} -> ${res.status}`); e.status = res.status === 429 ? 429 : 503; throw e; }
  const json = await res.json();
  const result = json && json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
  if (!result) { const e = new Error(`Yahoo fundamentals: no data for ${symbol}`); e.status = 503; throw e; }
  return mapFundamentals(result);
}

module.exports = { getFundamentals, mapFundamentals, _resetSession: () => { _session = null; } };
