'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ReadSchema } = require('../src/llm/schemas');

test('valid read parses', () => {
  const r = ReadSchema.parse({ stance: 'bullish', confidence: 0.7, rationale: 'up trend',
    keyRisks: ['earnings'], sources: ['https://x'] });
  assert.equal(r.stance, 'bullish');
});

test('invalid stance rejected', () => {
  assert.throws(() => ReadSchema.parse({ stance: 'up', confidence: 0.5, rationale: 'x' }));
});

test('defaults fill arrays', () => {
  const r = ReadSchema.parse({ stance: 'neutral', confidence: 0.5, rationale: 'flat' });
  assert.deepEqual(r.keyRisks, []);
  assert.deepEqual(r.sources, []);
});
