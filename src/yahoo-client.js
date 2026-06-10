'use strict';

// Real OHLCV candles from Yahoo Finance's public chart API. No API key required.
// PRIMARY candle source so pattern detection / signals run on real market data.
// Returns canonical candle objects per docs/CONTRACTS.md.
//
// The UI picks an INTERVAL (candle size) and a RANGE (lookback). Yahoo limits how
// far back each interval can go, so we clamp the range to a valid window.

// UI interval -> Yahoo interval code + max lookback (days) Yahoo allows for it.
const INTERVALS = {
  '1m': { y: '1m', maxDays: 7, intraday: true },
  '5m': { y: '5m', maxDays: 60, intraday: true },
  '15m': { y: '15m', maxDays: 60, intraday: true },
  '30m': { y: '30m', maxDays: 60, intraday: true },
  '1h': { y: '60m', maxDays: 730, intraday: true },
  '1D': { y: '1d', maxDays: Infinity, intraday: false },
  '1W': { y: '1wk', maxDays: Infinity, intraday: false },
};

// UI range -> Yahoo range code + approx span in days (for clamping).
const RANGES = {
  '1D': { y: '1d', days: 1 },
  '5D': { y: '5d', days: 5 },
  '1M': { y: '1mo', days: 31 },
  '3M': { y: '3mo', days: 93 },
  '6M': { y: '6mo', days: 186 },
  'YTD': { y: 'ytd', days: 366 },
  '1Y': { y: '1y', days: 366 },
  '5Y': { y: '5y', days: 1830 },
  'MAX': { y: 'max', days: Infinity },
};

// Order used when clamping a range down to what the interval supports.
const RANGE_ORDER = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'MAX'];

// Seconds per interval bucket — used to snap bar timestamps so Yahoo's trailing
// live-snapshot point folds into its proper candle instead of forming a new bar.
const INTERVAL_SECONDS = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600,
  '1D': 86400, '1W': 604800,
};

const INTERVAL_KEYS = Object.keys(INTERVALS);
const RANGE_KEYS = Object.keys(RANGES);
const MAX_BARS = 400;

function normInterval(i) {
  return INTERVALS[i] ? i : '5m';
}
function normRange(r) {
  return RANGES[r] ? r : '1D';
}
function isIntraday(interval) {
  return INTERVALS[normInterval(interval)].intraday;
}

// Pick the requested range, or the largest valid one the interval allows.
function clampRange(interval, range) {
  const maxDays = INTERVALS[normInterval(interval)].maxDays;
  const want = normRange(range);
  if (RANGES[want].days <= maxDays) return want;
  // Walk down to the largest range that fits.
  for (let i = RANGE_ORDER.length - 1; i >= 0; i--) {
    const k = RANGE_ORDER[i];
    if (RANGES[k].days <= maxDays) return k;
  }
  return '1D';
}

async function fetchCandles(symbol, interval, range) {
  const iv = normInterval(interval);
  const effRange = clampRange(iv, range);
  // Include pre-market / after-hours for intraday so the chart stays live through
  // extended hours (~4am–8pm ET), not just the regular 9:30–16:00 session.
  const prePost = INTERVALS[iv].intraday ? 'true' : 'false';
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) +
    '?interval=' + INTERVALS[iv].y +
    '&range=' + RANGES[effRange].y +
    '&includePrePost=' + prePost;

  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const j = await res.json();

  const result = j && j.chart && j.chart.result && j.chart.result[0];
  if (!result || !result.timestamp) {
    const err = j && j.chart && j.chart.error;
    throw new Error(err ? (err.description || err.code) : 'no candle data');
  }

  const ts = result.timestamp;
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const secs = INTERVAL_SECONDS[iv] || 300;
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open ? q.open[i] : null;
    const h = q.high ? q.high[i] : null;
    const l = q.low ? q.low[i] : null;
    const c = q.close ? q.close[i] : null;
    const v = q.volume ? q.volume[i] : 0;
    if (o == null || h == null || l == null || c == null) continue;
    // Snap to the interval bucket so Yahoo's trailing live-snapshot point (a
    // non-bucket-aligned single price) merges into the forming candle instead
    // of marching across the chart as flat one-price bars.
    const t = Math.floor(ts[i] / secs) * secs;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, +h.toFixed(4));
      last.low = Math.min(last.low, +l.toFixed(4));
      last.close = +c.toFixed(4); // last price in the bucket wins
      last.volume += v || 0;
    } else {
      out.push({
        time: t,
        open: +o.toFixed(4),
        high: +h.toFixed(4),
        low: +l.toFixed(4),
        close: +c.toFixed(4),
        volume: v || 0,
      });
    }
  }

  return {
    candles: out.slice(-MAX_BARS),
    effRange, // the range actually used (may be clamped from the request)
    clamped: effRange !== normRange(range),
    meta: result.meta || {},
  };
}

// Lightweight current-price lookup (for valuing portfolio positions that aren't
// the actively-streamed ticker). Returns { price, prevClose } or throws.
async function fetchPrice(symbol) {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) +
    '?interval=1d&range=1d';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const j = await res.json();
  const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') {
    throw new Error('no price');
  }
  return {
    price: meta.regularMarketPrice,
    prevClose: (typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose
      : (typeof meta.previousClose === 'number' ? meta.previousClose : null)),
  };
}

// Keyless symbol search via Yahoo Finance (covers far more tickers than the
// Finnhub free search, incl. ADRs/OTC like SFTBY). Returns [{symbol, description}].
async function searchSymbols(q) {
  const url =
    'https://query1.finance.yahoo.com/v1/finance/search?q=' +
    encodeURIComponent(q) + '&quotesCount=10&newsCount=0';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('Yahoo search HTTP ' + res.status);
  const j = await res.json();
  const quotes = Array.isArray(j && j.quotes) ? j.quotes : [];
  const allow = { EQUITY: 1, ETF: 1, MUTUALFUND: 1, INDEX: 1, CURRENCY: 1, CRYPTOCURRENCY: 1, FUTURE: 1 };
  return quotes
    .filter(function (x) { return x && x.symbol && (!x.quoteType || allow[x.quoteType]); })
    .map(function (x) {
      var exch = x.exchange || x.exchDisp || '';
      return {
        symbol: x.symbol,
        description: x.shortname || x.longname || x.quoteType || exch || '',
      };
    });
}

module.exports = {
  fetchCandles,
  fetchPrice,
  searchSymbols,
  isIntraday,
  normInterval,
  normRange,
  INTERVAL_KEYS,
  RANGE_KEYS,
};
