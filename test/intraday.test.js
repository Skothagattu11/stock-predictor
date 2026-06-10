'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ind = require('../engine/indicators');
const { scoreIntraday } = require('../engine/intraday');
const { analyze } = require('../engine');

const DAY = 86400;
// helper: build an intraday 5m series for one session starting at `start`
function intradaySession(start, prices, vol = 100000) {
  return prices.map((p, i) => ({
    time: start + i * 300,
    open: p, high: p + 0.5, low: p - 0.5, close: p, volume: vol,
  }));
}

test('vwapSeries resets at session gap; cumulative does not', () => {
  const day1 = intradaySession(1000000, [10, 10, 10]);          // vwap ~10
  const day2 = intradaySession(1000000 + DAY, [20, 20, 20]);    // next day, vwap ~20
  const all = day1.concat(day2);
  const sessionVwap = ind.vwap(all, { session: true });
  const cumulativeVwap = ind.vwap(all); // blends both days
  assert.ok(Math.abs(sessionVwap - 20) < 0.5, 'session VWAP tracks the current day (~20)');
  assert.ok(cumulativeVwap > 12 && cumulativeVwap < 18, 'cumulative VWAP blends both days');
});

test('openingRange captures first N minutes of the latest session', () => {
  // session start at t0; first 30 min = first 6 of the 5m bars
  const prices = [10, 11, 12, 9, 10, 11, 30, 5]; // bars 0-5 are the opening range
  const cs = intradaySession(2000000, prices);
  const orb = ind.openingRange(cs, 30);
  // opening-range high/low come from the first 6 bars' high/low (+/-0.5)
  assert.ok(orb.high >= 12 && orb.high < 13, 'OR high from first 30 min');
  assert.ok(orb.low > 8 && orb.low <= 9, 'OR low from first 30 min');
});

test('supertrend reports an up trend on a steadily rising series', () => {
  const prices = [];
  for (let i = 0; i < 40; i++) prices.push(100 + i); // rising
  const cs = intradaySession(3000000, prices);
  const st = ind.supertrend(cs, 10, 3);
  assert.equal(st.trend, 'up');
  assert.ok(Number.isFinite(st.value));
  assert.ok(st.series.length > 0);
});

test('scoreIntraday is bullish above VWAP + uptrend + ORB break', () => {
  const cs = intradaySession(4000000, [10, 10.2, 10.4, 10.6, 10.8, 11]);
  const res = scoreIntraday({
    candles: cs,
    indicators: { rsi: 60, ema9: 11, ema20: 10.5, ema50: 10, macd: { hist: 0.2 }, atr: 0.3, vwap: 10.5, volRatio: 1.6 },
    patterns: [{ name: 'Bullish engulfing', signal: 'buy', strength: 3 }],
    vwap: 10.5,
    supertrend: { trend: 'up', flipped: true, value: 10.2 },
    orb: { high: 10.7, low: 10.0 }, // price 11 > orb.high
  });
  assert.equal(res.signal, 'BUY');
  assert.ok(res.score >= 64);
  assert.match(res.setup, /Supertrend flip — long|breakout — long|long/);
  assert.ok(res.levels.stopLoss < res.levels.sellTarget);
});

test('scoreIntraday is bearish below VWAP + downtrend', () => {
  const cs = intradaySession(5000000, [11, 10.8, 10.6, 10.4, 10.2, 10]);
  const res = scoreIntraday({
    candles: cs,
    indicators: { rsi: 40, ema9: 10, ema20: 10.5, ema50: 11, macd: { hist: -0.2 }, atr: 0.3, vwap: 10.5, volRatio: 1.6 },
    patterns: [{ name: 'Bearish engulfing', signal: 'sell', strength: 3 }],
    vwap: 10.5,
    supertrend: { trend: 'down', flipped: false, value: 10.8 },
    orb: { high: 11.2, low: 10.1 }, // price 10 < orb.low
  });
  assert.equal(res.signal, 'SELL');
  assert.ok(res.score <= 36);
});

test('analyze(intraday) returns intraday fields + vwap/supertrend overlays', () => {
  const prices = [];
  for (let i = 0; i < 40; i++) prices.push(100 + Math.sin(i / 3) * 2 + i * 0.1);
  const cs = intradaySession(6000000, prices);
  const a = analyze(cs, { intraday: true });
  assert.equal(a.mode, 'intraday');
  assert.ok(typeof a.setup === 'string' && a.setup.length > 0);
  assert.ok(a.intraday && a.intraday.supertrend && a.intraday.openingRange);
  assert.ok(Array.isArray(a.overlays.vwap) && a.overlays.vwap.length === cs.length);
  assert.ok(Array.isArray(a.overlays.supertrend));
  assert.ok(['BUY', 'SELL', 'WAIT'].includes(a.signal));
});

test('analyze(swing) keeps the original mode', () => {
  const prices = [];
  for (let i = 0; i < 40; i++) prices.push(100 + i);
  const cs = prices.map((p, i) => ({ time: 7000000 + i * DAY, open: p, high: p + 1, low: p - 1, close: p, volume: 1000 }));
  const a = analyze(cs); // no intraday flag
  assert.equal(a.mode, 'swing');
  assert.ok(!a.intraday);
});
