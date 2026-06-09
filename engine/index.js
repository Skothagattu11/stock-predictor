'use strict';

// Engine facade: turns a raw candle array into the full analysis object
// described in docs/CONTRACTS.md.

const indicators = require('./indicators');
const { detectPatterns } = require('./patterns');
const { score } = require('./scorer');

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);
const lastValue = (series) =>
  Array.isArray(series) && series.length ? series[series.length - 1].value : NaN;

/**
 * analyze(candles) -> full analysis object (see CONTRACTS.md).
 * Requires >= 2 candles; with too few candles, returns a safe WAIT object
 * filling in whatever is computable. Never throws on short input.
 */
function analyze(candles) {
  const cs = Array.isArray(candles) ? candles : [];

  if (cs.length < 2) {
    return safeWaitObject(cs);
  }

  const last = cs[cs.length - 1];

  // --- Indicator snapshot ------------------------------------------------
  const ema9Series = indicators.ema(cs, 9);
  const ema20Series = indicators.ema(cs, 20);
  const ema50Series = indicators.ema(cs, 50);

  const macd = indicators.macd(cs);
  const boll = indicators.bollinger(cs);
  const atr = indicators.atr(cs);
  const vwap = indicators.vwap(cs);
  const avgVol = indicators.avgVolume(cs);
  const lastVol = Number.isFinite(last.volume) ? last.volume : NaN;
  const volRatio =
    Number.isFinite(avgVol) && avgVol !== 0 && Number.isFinite(lastVol)
      ? round2(lastVol / avgVol)
      : NaN;

  const ind = {
    rsi: indicators.rsi(cs),
    ema9: lastValue(ema9Series),
    ema20: lastValue(ema20Series),
    ema50: lastValue(ema50Series),
    macd: { macd: macd.macd, signal: macd.signal, hist: macd.hist },
    bb: { upper: boll.last.upper, mid: boll.last.mid, lower: boll.last.lower },
    atr,
    vwap,
    volRatio,
  };

  // --- Patterns + scoring ------------------------------------------------
  const patterns = detectPatterns(cs);
  const scored = score({ candles: cs, indicators: ind, patterns });

  // --- Day range ---------------------------------------------------------
  const dayRange = computeDayRange(cs);

  return {
    price: round2(last.close),
    dayRange,
    signal: scored.signal,
    signalLabel: scored.signalLabel,
    score: scored.score,
    confidence: scored.confidence,
    reasons: scored.reasons,
    levels: scored.levels,
    indicators: ind,
    patterns,
    overlays: {
      ema9: ema9Series,
      ema20: ema20Series,
      ema50: ema50Series,
      bbUpper: boll.upper,
      bbMid: boll.mid,
      bbLower: boll.lower,
    },
  };
}

function computeDayRange(cs) {
  if (!cs.length) return { low: NaN, high: NaN };
  let low = Infinity;
  let high = -Infinity;
  for (const c of cs) {
    if (Number.isFinite(c.low)) low = Math.min(low, c.low);
    if (Number.isFinite(c.high)) high = Math.max(high, c.high);
  }
  return {
    low: low === Infinity ? NaN : round2(low),
    high: high === -Infinity ? NaN : round2(high),
  };
}

// Returns a valid analysis object when there are too few candles to score.
function safeWaitObject(cs) {
  const last = cs.length ? cs[cs.length - 1] : null;
  const dayRange = computeDayRange(cs);
  const emptyOverlay = {
    ema9: [],
    ema20: [],
    ema50: [],
    bbUpper: [],
    bbMid: [],
    bbLower: [],
  };
  const close = last && Number.isFinite(last.close) ? round2(last.close) : NaN;

  return {
    price: close,
    dayRange,
    signal: 'WAIT',
    signalLabel: 'WAIT',
    score: 50,
    confidence: 0,
    reasons: ['Not enough candle history yet to form a reliable signal.'],
    levels: {
      buyTrigger: last && Number.isFinite(last.high) ? round2(last.high) : NaN,
      stopLoss: last && Number.isFinite(last.low) ? round2(last.low) : NaN,
      sellTarget: last && Number.isFinite(last.high) ? round2(last.high) : NaN,
    },
    indicators: {
      rsi: NaN,
      ema9: close,
      ema20: close,
      ema50: close,
      macd: { macd: NaN, signal: NaN, hist: NaN },
      bb: { upper: NaN, mid: NaN, lower: NaN },
      atr: NaN,
      vwap: cs.length ? indicators.vwap(cs) : NaN,
      volRatio: NaN,
    },
    patterns: detectPatterns(cs),
    overlays: emptyOverlay,
  };
}

module.exports = { analyze };
