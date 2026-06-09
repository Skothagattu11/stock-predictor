'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { score } = require('../engine/scorer.js');
const { analyze } = require('../engine/index.js');

// --- helpers ---------------------------------------------------------------

let t = 1700000000;
function candle(open, high, low, close, volume) {
  t += 300;
  return { time: t, open, high, low, close, volume };
}

// A small generic candle array used where exact values don't matter.
function makeCandles(closes) {
  let prevClose = closes[0];
  return closes.map((c, i) => {
    const open = i === 0 ? c : prevClose;
    const high = Math.max(open, c) + 1;
    const low = Math.min(open, c) - 1;
    prevClose = c;
    return candle(open, high, low, c, 1000000 + i * 1000);
  });
}

// --- score(): strongly bullish --------------------------------------------

test('strongly bullish inputs yield BUY with score >= 68', () => {
  const candles = makeCandles([100, 101, 102, 103, 104, 106]);
  const last = candles[candles.length - 1];
  const indicators = {
    rsi: 30,                         // oversold +12
    ema9: 105,
    ema20: 102,                      // ema9>ema20 (+12)
    ema50: 100,                      // also > ema50
    macd: { macd: 1.2, signal: 0.8, hist: 0.4 }, // +8
    bb: { upper: 110, mid: 103, lower: 98 },
    atr: 2.5,
    vwap: 103,
    volRatio: 2.0,                   // high vol, bullish context +10
  };
  const patterns = [
    { name: 'Bullish engulfing', meaning: 'x', signal: 'buy', strength: 3 }, // +18
  ];

  const r = score({ candles, indicators, patterns });

  assert.equal(r.signal, 'BUY');
  assert.equal(r.signalLabel, 'BUY WATCH');
  assert.ok(r.score >= 68, `score ${r.score} should be >= 68`);
  assert.ok(r.score <= 100);
  assert.ok(r.confidence >= 0 && r.confidence <= 100);
  assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0 && r.reasons.length <= 6);

  // levels are numbers and ordered sensibly
  assert.equal(typeof r.levels.buyTrigger, 'number');
  assert.equal(typeof r.levels.stopLoss, 'number');
  assert.equal(typeof r.levels.sellTarget, 'number');
  assert.ok(r.levels.stopLoss < r.levels.sellTarget);
  // buyTrigger should sit at/above the recent action
  assert.ok(r.levels.buyTrigger >= last.high - 0.01);
});

// --- score(): strongly bearish --------------------------------------------

test('strongly bearish inputs yield SELL', () => {
  const candles = makeCandles([110, 108, 106, 104, 101, 98]);
  const indicators = {
    rsi: 78,                         // overbought -15
    ema9: 99,
    ema20: 104,                      // ema9<ema20 (-12)
    ema50: 106,
    macd: { macd: -1.0, signal: -0.5, hist: -0.5 }, // -8
    bb: { upper: 112, mid: 105, lower: 100 },        // close 98 < lower? bonus
    atr: 3.0,
    vwap: 105,
    volRatio: 2.2,                   // high vol, bearish context -8
  };
  const patterns = [
    { name: 'Bearish engulfing', meaning: 'x', signal: 'sell', strength: 3 }, // -22
  ];

  const r = score({ candles, indicators, patterns });

  assert.equal(r.signal, 'SELL');
  assert.equal(r.signalLabel, 'SELL / AVOID');
  assert.ok(r.score <= 38, `score ${r.score} should be <= 38`);
  assert.ok(r.score >= 0);
  assert.ok(r.levels.stopLoss < r.levels.sellTarget);
});

// --- score(): neutral -------------------------------------------------------

test('neutral inputs yield WAIT', () => {
  const candles = makeCandles([100, 100.5, 99.8, 100.2, 100.1, 100.0]);
  const indicators = {
    rsi: 50,
    ema9: 100.1,
    ema20: 100.1,                    // equal -> no EMA push
    ema50: 100.1,
    macd: { macd: 0, signal: 0, hist: 0 }, // no push
    bb: { upper: 103, mid: 100, lower: 97 },
    atr: 1.0,
    vwap: 100,
    volRatio: 1.0,                   // not high vol
  };
  const patterns = [
    { name: 'No strong pattern', meaning: 'x', signal: 'wait', strength: 1 },
  ];

  const r = score({ candles, indicators, patterns });

  assert.equal(r.signal, 'WAIT');
  assert.equal(r.signalLabel, 'WAIT');
  assert.ok(r.score > 38 && r.score < 68, `score ${r.score} should be in WAIT band`);
});

// --- score(): ATR=NaN falls back to swing levels ---------------------------

test('NaN ATR falls back to swing-only levels (still numbers)', () => {
  const candles = makeCandles([100, 101, 99, 102, 98, 103]);
  const indicators = {
    rsi: 50, ema9: 101, ema20: 100, ema50: 100,
    macd: { macd: 0, signal: 0, hist: 0 },
    bb: { upper: 110, mid: 100, lower: 90 },
    atr: NaN,
    vwap: 100, volRatio: 1,
  };
  const patterns = [{ name: 'No strong pattern', meaning: 'x', signal: 'wait', strength: 1 }];

  const r = score({ candles, indicators, patterns });
  assert.ok(Number.isFinite(r.levels.stopLoss));
  assert.ok(Number.isFinite(r.levels.sellTarget));
  assert.ok(r.levels.stopLoss < r.levels.sellTarget);
});

// --- analyze(): end-to-end --------------------------------------------------

const REQUIRED_KEYS = [
  'price', 'dayRange', 'signal', 'signalLabel', 'score',
  'confidence', 'reasons', 'levels', 'indicators', 'patterns', 'overlays',
];

test('analyze() end-to-end returns all required keys with valid ranges', () => {
  // Build a realistic-ish ~60 candle uptrend with noise.
  const closes = [];
  let price = 100;
  for (let i = 0; i < 60; i++) {
    price += Math.sin(i / 4) * 0.8 + 0.3;
    closes.push(+price.toFixed(2));
  }
  const candles = makeCandles(closes);

  const a = analyze(candles);

  for (const k of REQUIRED_KEYS) {
    assert.ok(k in a, `missing key: ${k}`);
  }

  assert.equal(typeof a.price, 'number');
  assert.equal(typeof a.dayRange.low, 'number');
  assert.equal(typeof a.dayRange.high, 'number');
  assert.ok(a.dayRange.low <= a.dayRange.high);

  assert.ok(['BUY', 'SELL', 'WAIT'].includes(a.signal));
  assert.ok(['BUY WATCH', 'SELL / AVOID', 'WAIT'].includes(a.signalLabel));
  assert.ok(a.score >= 0 && a.score <= 100);
  assert.ok(a.confidence >= 0 && a.confidence <= 100);

  assert.ok(Array.isArray(a.reasons));
  assert.ok(a.reasons.length <= 6);

  // indicators snapshot shape
  const ind = a.indicators;
  for (const k of ['rsi', 'ema9', 'ema20', 'ema50', 'macd', 'bb', 'atr', 'vwap', 'volRatio']) {
    assert.ok(k in ind, `indicators missing: ${k}`);
  }
  assert.ok('hist' in ind.macd);
  assert.ok('upper' in ind.bb && 'mid' in ind.bb && 'lower' in ind.bb);

  // levels
  assert.equal(typeof a.levels.buyTrigger, 'number');
  assert.ok(a.levels.stopLoss < a.levels.sellTarget);

  // overlays are series arrays
  for (const k of ['ema9', 'ema20', 'ema50', 'bbUpper', 'bbMid', 'bbLower']) {
    assert.ok(Array.isArray(a.overlays[k]), `overlay ${k} should be an array`);
  }
  assert.equal(a.overlays.ema9.length, candles.length);

  // patterns shape
  assert.ok(Array.isArray(a.patterns) && a.patterns.length > 0);
  assert.ok('name' in a.patterns[0] && 'signal' in a.patterns[0] && 'strength' in a.patterns[0]);
});

test('analyze() with too few candles returns safe WAIT object (no throw)', () => {
  const a = analyze([{ time: 1, open: 10, high: 11, low: 9, close: 10, volume: 100 }]);
  assert.equal(a.signal, 'WAIT');
  assert.equal(a.signalLabel, 'WAIT');
  for (const k of REQUIRED_KEYS) {
    assert.ok(k in a, `missing key: ${k}`);
  }
  assert.ok(Array.isArray(a.overlays.ema9));

  // zero candles must also not throw
  const empty = analyze([]);
  assert.equal(empty.signal, 'WAIT');
});
