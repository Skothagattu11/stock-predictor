'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildConsensus } = require('../src/llm/consensus');

test('unanimous => full agreement, no divergence', () => {
  const c = buildConsensus([
    { name: 'quant', stance: 'bullish', confidence: 0.8 },
    { name: 'openai', stance: 'bullish', confidence: 0.7 }]);
  assert.equal(c.stance, 'bullish');
  assert.equal(c.agreement, 1);
  assert.equal(c.divergence, false);
});

test('split => divergence flagged', () => {
  const c = buildConsensus([
    { name: 'quant', stance: 'bullish', confidence: 0.6 },
    { name: 'openai', stance: 'bearish', confidence: 0.6 }]);
  assert.equal(c.divergence, true);
  assert.ok(c.agreement <= 0.6);
});

test('confidence-weighted majority wins', () => {
  const c = buildConsensus([
    { name: 'a', stance: 'bearish', confidence: 0.9 },
    { name: 'b', stance: 'bullish', confidence: 0.2 },
    { name: 'c', stance: 'bullish', confidence: 0.2 }]);
  assert.equal(c.stance, 'bearish');   // 0.9 weight beats 0.4
});

test('empty => neutral, divergent', () => {
  const c = buildConsensus([]);
  assert.equal(c.stance, 'neutral');
  assert.equal(c.divergence, true);
});
