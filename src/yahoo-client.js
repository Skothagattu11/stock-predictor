'use strict';

// Real intraday OHLCV candles from Yahoo Finance's public chart API.
// No API key required. This is the PRIMARY candle source so that pattern
// detection / signals run on real market data (Finnhub's free tier has no
// intraday candles). Returns canonical candle objects per docs/CONTRACTS.md.

// Map our timeframe (minutes) -> Yahoo interval + a range that yields enough
// history for indicators (EMA50 etc.) without being huge.
const TF_MAP = {
  1: { interval: '1m', range: '5d' },
  5: { interval: '5m', range: '5d' },
  15: { interval: '15m', range: '1mo' },
  60: { interval: '60m', range: '3mo' },
};

const MAX_BARS = 320; // cap sent to the browser / kept in the aggregator

async function fetchCandles(symbol, tfMinutes) {
  const m = TF_MAP[tfMinutes] || TF_MAP[5];
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) +
    '?interval=' + m.interval +
    '&range=' + m.range +
    '&includePrePost=false';

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
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open ? q.open[i] : null;
    const h = q.high ? q.high[i] : null;
    const l = q.low ? q.low[i] : null;
    const c = q.close ? q.close[i] : null;
    const v = q.volume ? q.volume[i] : 0;
    // Skip gap rows where Yahoo has nulls (no trade in that bucket).
    if (o == null || h == null || l == null || c == null) continue;
    out.push({
      time: ts[i],
      open: +o.toFixed(4),
      high: +h.toFixed(4),
      low: +l.toFixed(4),
      close: +c.toFixed(4),
      volume: v || 0,
    });
  }

  return {
    candles: out.slice(-MAX_BARS),
    meta: result.meta || {},
  };
}

module.exports = { fetchCandles };
