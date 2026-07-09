'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sma, ema, rsi, macd, bollingerBands, pivots } = require('../../src/technicals');

test('sma: computes 3-period SMA correctly with null padding', () => {
  const r = sma([10, 20, 30, 40, 50], 3);
  assert.equal(r[0], null);
  assert.equal(r[1], null);
  assert.equal(r[2], 20); // (10+20+30)/3
  assert.equal(r[3], 30);
  assert.equal(r[4], 40);
});

test('ema: null until warmed, seeded by SMA of first period', () => {
  const r = ema([2, 4, 6, 8, 10], 3);
  assert.equal(r[0], null);
  assert.equal(r[1], null);
  assert.equal(r[2], 4); // SMA(2,4,6)
  assert.ok(r[3] > 4 && r[4] > r[3]); // trending up
});

test('ema: returns all-null when series shorter than period', () => {
  assert.deepEqual(ema([1, 2], 5), [null, null]);
});

test('rsi: null for the first `period` bars, value after', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const r = rsi(closes, 14);
  assert.equal(r[0], null);
  assert.equal(r[13], null);
  assert.ok(r[14] !== null);
});

test('rsi: pure gains approach 100', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
  const r = rsi(closes, 14);
  assert.ok(r[r.length - 1] > 90);
});

test('rsi: pure losses approach 0', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 200 - i * 2);
  const r = rsi(closes, 14);
  assert.ok(r[r.length - 1] < 10);
});

test('rsi: insufficient data returns all null', () => {
  assert.deepEqual(rsi([1, 2, 3], 14), [null, null, null]);
});

test('macd: returns shape and a valid crossover classification', () => {
  const closes = [
    ...Array.from({ length: 26 }, (_, i) => 100 - i),
    ...Array.from({ length: 20 }, (_, i) => 75 + i * 3),
  ];
  const r = macd(closes);
  assert.ok(['bullish', 'bearish', 'above', 'below', 'none'].includes(r.crossover));
  assert.ok(r.current.macd !== null);
  assert.equal(r.macdLine.length, closes.length);
  assert.equal(r.signalLine.length, closes.length);
});

test('bollingerBands: upper > middle > lower once warmed', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
  const r = bollingerBands(closes, 20, 2);
  const last = closes.length - 1;
  assert.ok(r.upper[last] > r.middle[last]);
  assert.ok(r.middle[last] > r.lower[last]);
  assert.equal(r.upper[0], null);
});

test('pivots: returns at most 10 support and resistance levels', () => {
  const candles = Array.from({ length: 60 }, (_, i) => {
    const base = 100 + Math.sin(i / 3) * 10;
    return { high: base + 1, low: base - 1, close: base };
  });
  const r = pivots(candles);
  assert.ok(r.support.length <= 10);
  assert.ok(r.resistance.length <= 10);
});
