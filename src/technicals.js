'use strict';
// Technical-indicator engine for the AI Equity Analyst (Stage-A technicals).
// Pure math is exported for unit testing (no network); computeTechnicals() is the
// only function that touches the network, via the existing keyless Yahoo client.
const yahoo = require('./yahoo-client');

// Simple moving average. Returns an array aligned to `closes`, null until warmed up.
function sma(closes, period) {
  const result = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    result[i] = sum / period;
  }
  return result;
}

// Exponential moving average, seeded with the SMA of the first `period` values.
function ema(closes, period) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  result[period - 1] = seed / period;
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

// Wilder's RSI. null for the first `period` bars.
function rsi(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  result[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    result[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return result;
}

// MACD with signal line and last-bar crossover classification.
function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) =>
    ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null);
  // Signal EMA is computed over the contiguous non-null MACD values, then mapped
  // back onto the original index positions.
  const nonNull = line.map((v, i) => ({ v, i })).filter((x) => x.v !== null);
  const sigEma = ema(nonNull.map((x) => x.v), signal);
  const sigLine = new Array(closes.length).fill(null);
  nonNull.forEach(({ i }, idx) => { sigLine[i] = sigEma[idx]; });
  const hist = closes.map((_, i) =>
    line[i] !== null && sigLine[i] !== null ? line[i] - sigLine[i] : null);
  // Crossover: compare the last two bars that both have a signal value.
  const valid = sigLine.map((v, i) => (v !== null && line[i] !== null ? i : -1)).filter((i) => i >= 0);
  const i1 = valid[valid.length - 1];
  const i0 = valid[valid.length - 2];
  let crossover = 'none';
  if (i0 !== undefined && i1 !== undefined) {
    if (line[i1] > sigLine[i1] && line[i0] <= sigLine[i0]) crossover = 'bullish';
    else if (line[i1] < sigLine[i1] && line[i0] >= sigLine[i0]) crossover = 'bearish';
    else crossover = line[i1] > sigLine[i1] ? 'above' : 'below';
  }
  return {
    macdLine: line,
    signalLine: sigLine,
    histogram: hist,
    current: { macd: i1 !== undefined ? line[i1] : null, signal: i1 !== undefined ? sigLine[i1] : null },
    crossover,
  };
}

// Bollinger Bands (population std dev, matching common charting convention).
function bollingerBands(closes, period = 20, stdDev = 2) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const mean = middle[i];
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mean) ** 2;
    const std = Math.sqrt(variance / period);
    upper[i] = mean + stdDev * std;
    lower[i] = mean - stdDev * std;
  }
  return { upper, middle, lower };
}

// Recent pivot highs/lows as rough support/resistance.
function pivots(candles, lookback = 10) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const win = candles.slice(i - lookback, i + lookback + 1);
    if (candles[i].high === Math.max(...win.map((c) => c.high))) highs.push(candles[i].high);
    if (candles[i].low === Math.min(...win.map((c) => c.low))) lows.push(candles[i].low);
  }
  // Spec §190: recent 10 pivot highs + 10 pivot lows.
  return { resistance: highs.slice(-10), support: lows.slice(-10) };
}

// Fetches 1Y of daily candles from Yahoo and derives the full indicator set.
// Returns { available: false, reason } when there isn't enough data to be meaningful.
async function computeTechnicals(symbol) {
  const { candles } = await yahoo.fetchCandles(symbol, '1D', '1Y');
  if (!candles || candles.length < 30) {
    return { available: false, reason: 'insufficient candle data' };
  }
  const closes = candles.map((c) => c.close);
  const n = closes.length - 1;
  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const rsiVals = rsi(closes, 14);
  const macdResult = macd(closes);
  const bb = bollingerBands(closes, 20, 2);
  const piv = pivots(candles);
  const last = candles[n];

  const prev50 = s50.slice(0, n).reverse().find((v) => v !== null);
  const prev200 = s200.slice(0, n).reverse().find((v) => v !== null);
  let cross = 'none';
  if (s50[n] !== null && s200[n] !== null && prev50 != null && prev200 != null) {
    if (s50[n] > s200[n] && prev50 <= prev200) cross = 'golden';
    else if (s50[n] < s200[n] && prev50 >= prev200) cross = 'death';
    else cross = s50[n] > s200[n] ? 'golden_active' : 'death_active';
  }

  const priceVs = (ma) => (ma == null ? 'unknown' : last.close > ma ? 'above' : 'below');

  return {
    available: true,
    currentPrice: last.close,
    rsi: { value: rsiVals[n] == null ? null : +rsiVals[n].toFixed(2), period: 14 },
    macd: {
      value: macdResult.current.macd,
      signal: macdResult.current.signal,
      crossover: macdResult.crossover,
    },
    movingAverages: {
      sma20: s20[n], sma50: s50[n], sma200: s200[n],
      priceVsSma20: priceVs(s20[n]),
      priceVsSma50: priceVs(s50[n]),
      priceVsSma200: priceVs(s200[n]),
    },
    cross,
    bollinger: {
      upper: bb.upper[n], middle: bb.middle[n], lower: bb.lower[n],
      position: bb.upper[n] == null ? 'unknown'
        : last.close > bb.upper[n] ? 'above'
        : last.close < bb.lower[n] ? 'below' : 'inside',
    },
    pivots: piv,
    volume: {
      last: last.volume,
      avg20: candles.slice(-20).reduce((a, c) => a + c.volume, 0) / Math.min(20, candles.length),
    },
  };
}

module.exports = { computeTechnicals, sma, ema, rsi, macd, bollingerBands, pivots };
