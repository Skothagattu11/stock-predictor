'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectPatterns,
  body,
  range,
  upperWick,
  lowerWick,
  isBull,
  isBear,
} = require('../engine/patterns.js');

let __t = 1000;
function candle(o, h, l, c, v = 1000, time = __t++) {
  return { time, open: o, high: h, low: l, close: c, volume: v };
}

// Reset the auto-incrementing time before building each fixture so
// fixtures are independent and deterministic.
function reset() { __t = 1000; }

function names(result) {
  return result.map((p) => p.name.toLowerCase());
}
function has(result, fragment) {
  const f = fragment.toLowerCase();
  return names(result).some((n) => n.includes(f));
}
function assertHas(result, fragment) {
  assert.ok(
    has(result, fragment),
    `expected a pattern name containing "${fragment}", got: ${JSON.stringify(names(result))}`
  );
}

// A flat upward-drifting series used as a benign "context" prefix so that
// trend-sensitive patterns (hammer, stars, etc.) see the right backdrop.
function downContext() {
  reset();
  return [
    candle(120, 121, 119, 118),
    candle(118, 119, 116, 115),
    candle(115, 116, 112, 111),
  ];
}
function upContext() {
  reset();
  return [
    candle(100, 102, 99, 101),
    candle(101, 104, 100, 103),
    candle(103, 106, 102, 105),
  ];
}

// ---------------------------------------------------------------------------
// Helper function sanity
// ---------------------------------------------------------------------------
test('helpers compute body/range/wicks/direction', () => {
  const c = candle(10, 15, 8, 12);
  assert.equal(body(c), 2);
  assert.equal(range(c), 7);
  assert.equal(upperWick(c), 3); // 15 - max(10,12)
  assert.equal(lowerWick(c), 2); // min(10,12) - 8
  assert.equal(isBull(c), true);
  assert.equal(isBear(c), false);
  const d = candle(12, 15, 8, 10);
  assert.equal(isBull(d), false);
  assert.equal(isBear(d), true);
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------
test('every result item has the contract shape', () => {
  const res = detectPatterns([...downContext(), candle(100, 100.4, 95, 100.3)]);
  for (const item of res) {
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.meaning, 'string');
    assert.ok(['buy', 'sell', 'wait'].includes(item.signal));
    assert.ok([1, 2, 3].includes(item.strength));
  }
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------
test('flat/neutral series returns No strong pattern', () => {
  reset();
  // Ordinary mid-body candles, no special structure, no equal highs/lows,
  // no engulfing/harami relationship between consecutive bodies.
  // Mixed directions (bull, bear, bull) with moderate bodies; bodies are not
  // engulfing/harami related and highs/lows differ, so nothing should trigger.
  const series = [
    candle(100, 103, 99, 102), // bull
    candle(102.2, 103.5, 100, 100.6), // bear, body not engulfing prior, not inside it
    candle(100.4, 102, 99.5, 101.3), // bull, smaller body, not engulfing prior bear
  ];
  const res = detectPatterns(series);
  assertHas(res, 'no strong pattern');
  assert.equal(res.length, 1);
});

test('empty input returns fallback', () => {
  const res = detectPatterns([]);
  assertHas(res, 'no strong pattern');
});

// ---------------------------------------------------------------------------
// Single-candle patterns
// ---------------------------------------------------------------------------
test('Doji', () => {
  reset();
  const res = detectPatterns([
    candle(100, 103, 97, 101),
    candle(101, 104, 98, 100.5),
    candle(100, 105, 95, 100.05), // body 0.05 vs range 10 => ratio 0.005
  ]);
  assertHas(res, 'doji');
});

test('Hammer', () => {
  // bullish, long lower wick >= 2x body, small upper wick, after a down move
  const res = detectPatterns([
    ...downContext(),
    candle(100, 101.5, 96, 101), // body 1, lower wick 4, upper 0.5, ratio 0.18
  ]);
  assertHas(res, 'hammer');
  // make sure it is the plain hammer, not inverted
  assert.ok(has(res, 'hammer'));
});

test('Inverted hammer', () => {
  // bullish, long upper wick, small lower wick, in a downmove
  const res = detectPatterns([
    ...downContext(),
    candle(100, 110, 99.5, 102), // body 2, upper wick 8, lower wick 0.5
  ]);
  assertHas(res, 'inverted hammer');
});

test('Hanging man', () => {
  // hammer shape (long lower wick) but after an up move
  const res = detectPatterns([
    ...upContext(),
    candle(105, 106.5, 101, 106), // body 1, lower wick 4, upper 0.5, after up move
  ]);
  assertHas(res, 'hanging man');
});

test('Shooting star', () => {
  // bearish, long upper wick, small lower wick
  const res = detectPatterns([
    ...upContext(),
    candle(110, 121, 104, 105), // bear, body 5, upper wick 11, lower wick 1
  ]);
  assertHas(res, 'shooting star');
});

test('Bullish marubozu', () => {
  reset();
  const res = detectPatterns([
    candle(100, 101, 99, 100.2),
    candle(100.2, 101, 99, 100.3),
    candle(100, 110.1, 99.95, 110), // body 10 vs range ~10.15 => >0.82, bull
  ]);
  assertHas(res, 'bullish marubozu');
});

test('Bearish marubozu', () => {
  reset();
  const res = detectPatterns([
    candle(100, 101, 99, 100.2),
    candle(100.2, 101, 99, 100.3),
    candle(110, 110.05, 99.9, 100), // body 10 vs range ~10.15, bear
  ]);
  assertHas(res, 'bearish marubozu');
});

// ---------------------------------------------------------------------------
// Two-candle patterns
// ---------------------------------------------------------------------------
test('Bullish engulfing', () => {
  reset();
  const res = detectPatterns([
    candle(105, 106, 103, 104),
    candle(103, 104, 100, 101), // bear p: body 100..103
    candle(99, 108, 98, 107), // bull c engulfs p body
  ]);
  assertHas(res, 'bullish engulfing');
});

test('Bearish engulfing', () => {
  reset();
  const res = detectPatterns([
    candle(100, 102, 99, 100),
    candle(101, 105, 100, 104), // bull p: body 101..104
    candle(106, 107, 99, 100), // bear c engulfs p body
  ]);
  assertHas(res, 'bearish engulfing');
});

test('Bullish harami', () => {
  reset();
  const res = detectPatterns([
    candle(120, 121, 118, 119),
    candle(118, 119, 105, 106), // large bear p: body 106..118
    candle(110, 112, 109, 113 - 1), // small bull c (110..112) inside p body
  ]);
  assertHas(res, 'bullish harami');
});

test('Bearish harami', () => {
  reset();
  const res = detectPatterns([
    candle(100, 102, 99, 101),
    candle(102, 119, 101, 118), // large bull p: body 102..118
    candle(112, 113, 110, 110.5), // small bear c (110.5..112) inside p body
  ]);
  assertHas(res, 'bearish harami');
});

test('Piercing line', () => {
  reset();
  // bear p body 100..110 (open 110, close 100), midpoint 105.
  // bull c opens below min(p.low,p.close), closes above 105 but below p.open(110).
  const res = detectPatterns([
    candle(112, 113, 109, 111),
    candle(110, 111, 98, 100), // bear p, low 98, close 100
    candle(97, 107, 96, 106), // opens 97 (< min(98,100)), closes 106 (>105, <110)
  ]);
  assertHas(res, 'piercing');
});

test('Dark cloud cover', () => {
  reset();
  // bull p body 100..110 (open 100, close 110), high 111, midpoint 105.
  // bear c opens above max(p.high,p.close)=111, closes below 105 but above p.open(100).
  const res = detectPatterns([
    candle(98, 101, 97, 99),
    candle(100, 111, 99, 110), // bull p
    candle(112, 113, 103, 104), // opens 112 (>111), closes 104 (<105, >100)
  ]);
  assertHas(res, 'dark cloud');
});

test('Tweezer bottom', () => {
  // two ~equal lows after a down move
  const res = detectPatterns([
    ...downContext(),
    candle(112, 114, 105.0, 113), // low 105
    candle(110, 112, 105.0, 111), // low 105 (equal) -- last
  ]);
  assertHas(res, 'tweezer bottom');
});

test('Tweezer top', () => {
  // two ~equal highs after an up move
  const res = detectPatterns([
    ...upContext(),
    candle(106, 115.0, 105, 107), // high 115
    candle(107, 115.0, 106, 108), // high 115 (equal) -- last
  ]);
  assertHas(res, 'tweezer top');
});

// ---------------------------------------------------------------------------
// Three-candle patterns
// ---------------------------------------------------------------------------
test('Morning star', () => {
  reset();
  // p2 bear (body 110..120), p small body, c bull closing above midpoint(115)
  const res = detectPatterns([
    candle(120, 121, 109, 110), // p2 bear, mid 115
    candle(108, 109, 106, 107.2), // p small body
    candle(108, 117, 107, 116), // c bull, close 116 > 115
  ]);
  assertHas(res, 'morning star');
});

test('Evening star', () => {
  reset();
  // p2 bull (body 110..120), p small body, c bear closing below midpoint(115)
  const res = detectPatterns([
    candle(110, 121, 109, 120), // p2 bull, mid 115
    candle(122, 123, 121, 121.8), // p small body
    candle(121, 122, 112, 113), // c bear, close 113 < 115
  ]);
  assertHas(res, 'evening star');
});

test('Three white soldiers', () => {
  reset();
  const res = detectPatterns([
    candle(100, 105, 99, 104), // bull
    candle(102, 108, 101, 107), // bull, higher close, open within prior body, > p2.open
    candle(105, 112, 104, 111), // bull, higher close, open > p2.open
  ]);
  assertHas(res, 'three white soldiers');
});

test('Three black crows', () => {
  reset();
  const res = detectPatterns([
    candle(120, 121, 115, 116), // bear
    candle(118, 119, 112, 113), // bear, lower close, open < p2.open
    candle(115, 116, 109, 110), // bear, lower close, open < p2.open
  ]);
  assertHas(res, 'three black crows');
});
