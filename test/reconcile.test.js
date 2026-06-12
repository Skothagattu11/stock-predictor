'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reconcileNumbers } = require('../src/llm/reconcile');

test('numbers matching facts are clean', () => {
  const r = reconcileNumbers('Trading at $150.25 with RSI 70.5.', [150.25, 70.5]);
  assert.equal(r.clean, true);
  assert.deepEqual(r.unverified, []);
});

test('fabricated price is flagged', () => {
  const r = reconcileNumbers('Target is $999.99 soon.', [150.25]);
  assert.equal(r.clean, false);
  assert.deepEqual(r.unverified, [999.99]);
});

test('tolerance allows tiny rounding', () => {
  const r = reconcileNumbers('about $150.24', [150.25]);   // within 1%
  assert.equal(r.clean, true);
});

test('plain small integers are ignored (not price/percent-looking)', () => {
  const r = reconcileNumbers('over the next 3 days', [150.25]);
  assert.equal(r.clean, true);
});
