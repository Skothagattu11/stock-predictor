'use strict';

// Technical-analysis indicators.
// All functions operate on the canonical candle array:
//   { time:<unix seconds>, open, high, low, close, volume }
// sorted ascending by time (last element = most recent).
//
// Robustness rule: never throw on short/empty input.
//   - scalar functions return NaN when there isn't enough data
//   - series functions return [] when there isn't enough data

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Exponential Moving Average series.
 * Seeded with the first close, then EMA_t = close*k + EMA_{t-1}*(1-k), k = 2/(period+1).
 * Returns [{time, value}] of the same length as candles. Values rounded to 2 dp.
 */
function ema(candles, period) {
  if (!Array.isArray(candles) || candles.length === 0 || !(period > 0)) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = candles[0].close; // seed with first close
  for (let i = 0; i < candles.length; i++) {
    const close = candles[i].close;
    // For i===0 this evaluates to the seed close itself.
    const val = i === 0 ? close : close * k + prev * (1 - k);
    prev = val;
    out.push({ time: candles[i].time, value: round2(val) });
  }
  return out;
}

/**
 * RSI series using Wilder's smoothing.
 * Returns [{time, value}] starting at the first candle for which RSI is defined
 * (index === period). Returns [] if not enough data.
 */
function rsiSeries(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1 || !(period > 0)) return [];

  // Initial average gain/loss = simple average over the first `period` changes.
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change >= 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  const out = [];
  const rsiFrom = (g, l) => {
    if (l === 0) return 100; // no losses => RSI 100 (guard divide-by-zero)
    if (g === 0) return 0;
    const rs = g / l;
    return 100 - 100 / (1 + rs);
  };

  // First defined RSI value sits at index === period.
  out.push({ time: candles[period].time, value: round2(rsiFrom(avgGain, avgLoss)) });

  // Wilder smoothing for the rest.
  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push({ time: candles[i].time, value: round2(rsiFrom(avgGain, avgLoss)) });
  }
  return out;
}

/** Latest RSI value (number) or NaN if not enough data. */
function rsi(candles, period = 14) {
  const s = rsiSeries(candles, period);
  return s.length ? s[s.length - 1].value : NaN;
}

/**
 * MACD.
 * macd line = emaFast - emaSlow; signal = EMA(macd line, signal); hist = macd - signal.
 * Returns latest scalar values plus full {time,value} series for each line.
 */
function macd(candles, fast = 12, slow = 26, signal = 9) {
  const empty = { macd: NaN, signal: NaN, hist: NaN, series: { macd: [], signal: [], hist: [] } };
  if (!Array.isArray(candles) || candles.length === 0) return empty;

  const emaFast = ema(candles, fast);
  const emaSlow = ema(candles, slow);

  // MACD line spans the full length (both EMAs are full-length, just less reliable early).
  const macdLine = candles.map((c, i) => ({
    time: c.time,
    value: round2(emaFast[i].value - emaSlow[i].value),
  }));

  // Signal line = EMA of the MACD line values. Reuse ema() over synthetic candles.
  const signalLine = ema(
    macdLine.map((p) => ({ time: p.time, close: p.value })),
    signal
  );

  const histLine = macdLine.map((p, i) => ({
    time: p.time,
    value: round2(p.value - signalLine[i].value),
  }));

  const lastIdx = candles.length - 1;
  return {
    macd: macdLine[lastIdx].value,
    signal: signalLine[lastIdx].value,
    hist: histLine[lastIdx].value,
    series: { macd: macdLine, signal: signalLine, hist: histLine },
  };
}

/**
 * Bollinger Bands.
 * mid = SMA(close, period); bands = mid +/- mult * population std dev of close over the window.
 * Series entries appear only once a full window is available; `last` is the most recent valid value.
 */
function bollinger(candles, period = 20, mult = 2) {
  const result = { upper: [], mid: [], lower: [], last: { upper: NaN, mid: NaN, lower: NaN } };
  if (!Array.isArray(candles) || candles.length < period || !(period > 0)) return result;

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    const mean = sum / period;

    // Population variance (divide by N).
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = candles[j].close - mean;
      varSum += d * d;
    }
    const sd = Math.sqrt(varSum / period);

    const t = candles[i].time;
    const upper = mean + mult * sd;
    const lower = mean - mult * sd;
    result.mid.push({ time: t, value: round2(mean) });
    result.upper.push({ time: t, value: round2(upper) });
    result.lower.push({ time: t, value: round2(lower) });
  }

  const n = result.mid.length;
  result.last = {
    upper: result.upper[n - 1].value,
    mid: result.mid[n - 1].value,
    lower: result.lower[n - 1].value,
  };
  return result;
}

/**
 * Latest ATR using Wilder's smoothing of True Range.
 * TR = max(high-low, |high-prevClose|, |low-prevClose|).
 * Returns NaN if not enough data.
 */
function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1 || !(period > 0)) return NaN;

  const trueRange = (c, prev) =>
    Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );

  // Seed ATR = simple average of first `period` true ranges (TR[1..period]).
  let trSum = 0;
  for (let i = 1; i <= period; i++) trSum += trueRange(candles[i], candles[i - 1]);
  let atrVal = trSum / period;

  // Wilder smoothing for the remainder.
  for (let i = period + 1; i < candles.length; i++) {
    const tr = trueRange(candles[i], candles[i - 1]);
    atrVal = (atrVal * (period - 1) + tr) / period;
  }
  return round2(atrVal);
}

// A gap between consecutive bars larger than this (seconds) is treated as a new
// trading session — used to anchor intraday VWAP / opening range to each day.
const SESSION_GAP = 2 * 3600;

/**
 * VWAP = sum(typicalPrice*volume)/sum(volume), typicalPrice=(h+l+c)/3.
 * By default cumulative over all candles. Pass { session:true } to reset at each
 * session boundary (the standard intraday VWAP that day traders use).
 */
function vwap(candles, opts = {}) {
  if (opts && opts.session) {
    const s = vwapSeries(candles, { session: true });
    return s.length ? s[s.length - 1].value : NaN;
  }
  if (!Array.isArray(candles) || candles.length === 0) return NaN;
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
  }
  if (vol === 0) return NaN; // guard divide-by-zero
  return round2(pv / vol);
}

/**
 * VWAP series [{time,value}]. session:true (default here) resets the cumulative
 * sums whenever a session gap is detected, so it matches each day's anchored VWAP.
 */
function vwapSeries(candles, opts = {}) {
  const session = opts.session !== false;
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const out = [];
  let pv = 0;
  let vol = 0;
  let prevTime = null;
  for (const c of candles) {
    if (session && prevTime != null && c.time - prevTime > SESSION_GAP) {
      pv = 0;
      vol = 0;
    }
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
    // Only emit a point once volume exists — skip zero-volume (e.g. early
    // pre-market) bars so the series has no NaN/0 points that break the scale.
    if (vol > 0) out.push({ time: c.time, value: round2(pv / vol) });
    prevTime = c.time;
  }
  return out;
}

/** Index where the most recent session begins (gap-based). */
function sessionStartIndex(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return 0;
  let start = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].time - candles[i - 1].time > SESSION_GAP) start = i;
  }
  return start;
}

/**
 * Opening Range = high/low of the first `minutes` of the most recent session.
 * Classic intraday breakout reference. Returns {high, low} or NaNs.
 */
function openingRange(candles, minutes = 30) {
  const empty = { high: NaN, low: NaN };
  if (!Array.isArray(candles) || candles.length === 0) return empty;
  const s = sessionStartIndex(candles);
  const startT = candles[s].time;
  let hi = -Infinity;
  let lo = Infinity;
  let n = 0;
  for (let i = s; i < candles.length && candles[i].time < startT + minutes * 60; i++) {
    if (Number.isFinite(candles[i].high)) hi = Math.max(hi, candles[i].high);
    if (Number.isFinite(candles[i].low)) lo = Math.min(lo, candles[i].low);
    n++;
  }
  if (n === 0 || hi === -Infinity) return empty;
  return { high: round2(hi), low: round2(lo) };
}

/**
 * Supertrend (ATR-based trend filter). Returns the latest line value, trend
 * direction ('up'/'down'), whether it just flipped, and the full series.
 */
function supertrend(candles, period = 10, mult = 3) {
  const empty = { value: NaN, trend: null, flipped: false, series: [] };
  if (!Array.isArray(candles) || candles.length < period + 1) return empty;

  // True range per bar.
  const tr = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  // Wilder ATR series.
  const atrArr = new Array(candles.length).fill(NaN);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atrArr[period] = sum / period;
  for (let i = period + 1; i < candles.length; i++) {
    atrArr[i] = (atrArr[i - 1] * (period - 1) + tr[i]) / period;
  }

  const series = [];
  const dir = new Array(candles.length).fill(0);
  let prevFinalUpper = NaN;
  let prevFinalLower = NaN;
  let prevTrend = 1;
  for (let i = period; i < candles.length; i++) {
    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;
    const a = atrArr[i];
    const basicUpper = hl2 + mult * a;
    const basicLower = hl2 - mult * a;

    let finalUpper;
    let finalLower;
    let trend;
    if (i === period) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      trend = c.close >= hl2 ? 1 : -1;
    } else {
      finalUpper =
        basicUpper < prevFinalUpper || candles[i - 1].close > prevFinalUpper ? basicUpper : prevFinalUpper;
      finalLower =
        basicLower > prevFinalLower || candles[i - 1].close < prevFinalLower ? basicLower : prevFinalLower;
      trend = prevTrend === 1 ? (c.close < finalLower ? -1 : 1) : (c.close > finalUpper ? 1 : -1);
    }
    const stVal = trend === 1 ? finalLower : finalUpper;
    series.push({ time: c.time, value: round2(stVal) });
    dir[i] = trend;
    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevTrend = trend;
  }

  const lastIdx = candles.length - 1;
  const flipped = dir[lastIdx] !== 0 && dir[lastIdx - 1] !== 0 && dir[lastIdx] !== dir[lastIdx - 1];
  return {
    value: series.length ? series[series.length - 1].value : NaN,
    trend: dir[lastIdx] === 1 ? 'up' : dir[lastIdx] === -1 ? 'down' : null,
    flipped,
    series,
  };
}

/** Mean volume of the last n candles. NaN if no candles. */
function avgVolume(candles, n = 20) {
  if (!Array.isArray(candles) || candles.length === 0 || !(n > 0)) return NaN;
  const slice = candles.slice(-n);
  let sum = 0;
  for (const c of slice) sum += c.volume;
  return round2(sum / slice.length);
}

module.exports = {
  ema,
  rsi,
  rsiSeries,
  macd,
  bollinger,
  atr,
  vwap,
  vwapSeries,
  sessionStartIndex,
  openingRange,
  supertrend,
  avgVolume,
};
