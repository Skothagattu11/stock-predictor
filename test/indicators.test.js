'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ema,
  rsi,
  rsiSeries,
  macd,
  bollinger,
  atr,
  vwap,
  avgVolume,
} = require('../engine/indicators');

// Helper to build a canonical candle.
function candle(time, o, h, l, c, v) {
  return { time, open: o, high: h, low: l, close: c, volume: v };
}

// Build a series of candles from an array of closes, with simple derived OHLCV.
function fromCloses(closes, { highPad = 0, lowPad = 0, volume = 100 } = {}) {
  return closes.map((c, i) =>
    candle(1000 + i, c, c + highPad, c - lowPad, c, volume)
  );
}

// A steadily rising series and a steadily falling series.
const RISING = fromCloses([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
const FALLING = fromCloses([25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10]);

test('ema matches hand-computed values (period 3, k=0.5)', () => {
  const c = fromCloses([10, 11, 12, 13, 14]);
  const e = ema(c, 3);
  assert.equal(e.length, c.length); // same length as candles
  // Seed = first close.
  assert.equal(e[0].value, 10);
  // 11*0.5 + 10*0.5 = 10.5
  assert.ok(Math.abs(e[1].value - 10.5) < 0.01);
  // 12*0.5 + 10.5*0.5 = 11.25
  assert.ok(Math.abs(e[2].value - 11.25) < 0.01);
  // 13*0.5 + 11.25*0.5 = 12.125 -> 12.13
  assert.ok(Math.abs(e[3].value - 12.13) < 0.01);
  // 14*0.5 + 12.125*0.5 = 13.0625 -> 13.06
  assert.ok(Math.abs(e[4].value - 13.06) < 0.01);
  // time carried through
  assert.equal(e[0].time, 1000);
  assert.equal(e[4].time, 1004);
});

test('ema returns [] on empty or bad input', () => {
  assert.deepEqual(ema([], 5), []);
  assert.deepEqual(ema(RISING, 0), []);
});

test('rsi of a steadily rising series is high (>70)', () => {
  const r = rsi(RISING, 14);
  // All gains, no losses -> RSI should be 100.
  assert.ok(r > 70, `expected >70, got ${r}`);
  assert.equal(r, 100);
});

test('rsi of a steadily falling series is low (<30)', () => {
  const r = rsi(FALLING, 14);
  // All losses, no gains -> RSI should be 0.
  assert.ok(r < 30, `expected <30, got ${r}`);
  assert.equal(r, 0);
});

test('rsiSeries returns {time,value} entries and last equals rsi()', () => {
  const s = rsiSeries(RISING, 14);
  assert.ok(s.length > 0);
  assert.ok('time' in s[0] && 'value' in s[0]);
  // First defined RSI sits at index === period.
  assert.equal(s[0].time, RISING[14].time);
  assert.equal(s[s.length - 1].value, rsi(RISING, 14));
});

test('rsi returns NaN when not enough data', () => {
  assert.ok(Number.isNaN(rsi(fromCloses([1, 2, 3]), 14)));
  assert.deepEqual(rsiSeries(fromCloses([1, 2, 3]), 14), []);
});

test('macd shape and series lengths', () => {
  const m = macd(RISING, 3, 6, 3); // smaller params so we have data
  assert.ok('macd' in m && 'signal' in m && 'hist' in m && 'series' in m);
  assert.equal(m.series.macd.length, RISING.length);
  assert.equal(m.series.signal.length, RISING.length);
  assert.equal(m.series.hist.length, RISING.length);
  // hist = macd - signal (latest)
  assert.ok(Math.abs(m.hist - (m.macd - m.signal)) < 0.01);
  // On a steadily rising series, fast EMA > slow EMA so MACD line is positive.
  assert.ok(m.macd > 0);
  // series entries are {time,value}
  assert.ok('time' in m.series.macd[0] && 'value' in m.series.macd[0]);
});

test('macd safe on empty input', () => {
  const m = macd([]);
  assert.ok(Number.isNaN(m.macd));
  assert.deepEqual(m.series.macd, []);
});

test('bollinger mid equals SMA and bands collapse to mid on a flat series', () => {
  const flat = fromCloses([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]); // 10 candles, all close=5
  const b = bollinger(flat, 5, 2);
  // mid = SMA = 5
  assert.equal(b.last.mid, 5);
  // zero variance => zero band width => upper == lower == mid
  assert.equal(b.last.upper, 5);
  assert.equal(b.last.lower, 5);
  // first window starts at index period-1
  assert.equal(b.mid[0].time, flat[4].time);
  assert.ok('time' in b.mid[0] && 'value' in b.mid[0]);
});

test('bollinger upper > mid > lower on a varying series', () => {
  const b = bollinger(fromCloses([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 5, 2);
  assert.ok(b.last.upper > b.last.mid);
  assert.ok(b.last.mid > b.last.lower);
});

test('bollinger safe when not enough data', () => {
  const b = bollinger(fromCloses([1, 2, 3]), 20, 2);
  assert.deepEqual(b.mid, []);
  assert.ok(Number.isNaN(b.last.mid));
});

test('atr is positive and matches hand calc on a constant-range series', () => {
  // Each candle has high-low = 2, closes flat at 10 so TR = 2 every bar.
  const c = [];
  for (let i = 0; i < 20; i++) c.push(candle(1000 + i, 10, 11, 9, 10, 100));
  const a = atr(c, 14);
  assert.ok(a > 0);
  // All TR = 2 => ATR = 2
  assert.ok(Math.abs(a - 2) < 0.01, `expected ~2, got ${a}`);
});

test('atr returns NaN when not enough data', () => {
  assert.ok(Number.isNaN(atr(fromCloses([1, 2, 3]), 14)));
});

test('vwap of a single-price series equals that price', () => {
  // All prices = 50, so typical price = 50 everywhere -> VWAP = 50.
  const c = [];
  for (let i = 0; i < 5; i++) c.push(candle(1000 + i, 50, 50, 50, 50, 100 + i));
  assert.equal(vwap(c), 50);
});

test('vwap is volume weighted', () => {
  // Two candles: tp=10 vol=1, tp=20 vol=3 -> (10*1 + 20*3)/4 = 70/4 = 17.5
  const c = [candle(1, 10, 10, 10, 10, 1), candle(2, 20, 20, 20, 20, 3)];
  assert.equal(vwap(c), 17.5);
});

test('vwap NaN on empty input', () => {
  assert.ok(Number.isNaN(vwap([])));
});

test('avgVolume computes mean of last n', () => {
  const c = [
    candle(1, 1, 1, 1, 1, 10),
    candle(2, 1, 1, 1, 1, 20),
    candle(3, 1, 1, 1, 1, 30),
    candle(4, 1, 1, 1, 1, 40),
  ];
  // last 2 -> (30+40)/2 = 35
  assert.equal(avgVolume(c, 2), 35);
  // all 4 -> (10+20+30+40)/4 = 25
  assert.equal(avgVolume(c, 20), 25);
});

test('avgVolume NaN on empty input', () => {
  assert.ok(Number.isNaN(avgVolume([], 20)));
});
