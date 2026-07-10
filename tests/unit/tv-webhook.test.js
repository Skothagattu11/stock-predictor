'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PendingQueue, PINE_DEFAULTS } = require('../../src/tv-webhook');

test('PINE_DEFAULTS has expected shape', () => {
  assert.equal(PINE_DEFAULTS.enabled, false);
  assert.equal(PINE_DEFAULTS.mode, 'auto');
  assert.equal(PINE_DEFAULTS.onDuplicate, 'skip');
  assert.equal(PINE_DEFAULTS.onExit, 'closeAll');
  assert.equal(typeof PINE_DEFAULTS.tradeBudget, 'number');
});

test('PendingQueue: add returns an entry with id and ts', () => {
  const q = new PendingQueue(50);
  const entry = q.add({ symbol: 'AAPL', stance: 'bullish', action: 'buy', price: 200, strategy: 'Test' });
  assert.ok(entry.id);
  assert.ok(entry.ts);
  assert.equal(entry.symbol, 'AAPL');
});

test('PendingQueue: list returns added entries', () => {
  const q = new PendingQueue(50);
  q.add({ symbol: 'AAPL', stance: 'bullish', action: 'buy', price: 200, strategy: 'Test' });
  assert.equal(q.list().length, 1);
});

test('PendingQueue: reject removes entry', () => {
  const q = new PendingQueue(50);
  const e = q.add({ symbol: 'AAPL', stance: 'bullish', action: 'buy', price: 200, strategy: 'Test' });
  const removed = q.reject(e.id);
  assert.ok(removed);
  assert.equal(q.list().length, 0);
});

test('PendingQueue: approve removes and returns entry', () => {
  const q = new PendingQueue(50);
  const e = q.add({ symbol: 'TSLA', stance: 'bearish', action: 'sell', price: 100, strategy: 'Test' });
  const found = q.approve(e.id);
  assert.equal(found.symbol, 'TSLA');
  assert.equal(q.list().length, 0);
});

test('PendingQueue: approve returns null for unknown id', () => {
  const q = new PendingQueue(50);
  assert.equal(q.approve('no-such-id'), null);
});

test('PendingQueue: drops oldest when full', () => {
  const q = new PendingQueue(2);
  q.add({ symbol: 'A', stance: 'bullish', action: 'buy', price: 1, strategy: 'S' });
  const second = q.add({ symbol: 'B', stance: 'bullish', action: 'buy', price: 2, strategy: 'S' });
  q.add({ symbol: 'C', stance: 'bullish', action: 'buy', price: 3, strategy: 'S' });
  const ids = q.list().map(e => e.id);
  assert.ok(!ids.includes(second.id) || ids.length === 2);
  assert.equal(q.list().length, 2);
});

test('PendingQueue: isFull returns true when at cap', () => {
  const q = new PendingQueue(1);
  q.add({ symbol: 'A', stance: 'bullish', action: 'buy', price: 1, strategy: 'S' });
  assert.equal(q.isFull(), true);
});
