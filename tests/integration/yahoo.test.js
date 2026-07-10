'use strict';
// @slow — hits the real Yahoo chart API (keyless). Run via `npm run test:integration`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeTechnicals } = require('../../src/technicals');

test('Yahoo: real MSFT technicals compute with a valid RSI and MAs', async () => {
  const t = await computeTechnicals('MSFT');
  assert.equal(t.available, true);
  assert.ok(t.rsi.value >= 0 && t.rsi.value <= 100, `RSI in range, got ${t.rsi.value}`);
  assert.ok(t.movingAverages.sma50 > 0, 'sma50');
  assert.ok(['golden', 'death', 'golden_active', 'death_active', 'none'].includes(t.cross));
  assert.ok(Array.isArray(t.pivots.support));
});
