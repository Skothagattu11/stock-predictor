'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRouter } = require('../src/llm/router');

test('ensemble fans out to all adapters', async () => {
  const adapters = [
    { name: 'a', generate: async () => ({ stance: 'bullish', confidence: 0.7, rationale: 'x' }) },
    { name: 'b', generate: async () => ({ stance: 'bearish', confidence: 0.6, rationale: 'y' }) },
  ];
  const r = createRouter({ adapters });
  const out = await r.ensemble('prompt', {});
  assert.equal(r.size, 2);
  assert.equal(out.length, 2);
  assert.equal(out.find((x) => x.name === 'a').ok, true);
  assert.equal(out.find((x) => x.name === 'a').result.stance, 'bullish');
});

test('a failing adapter is captured, not thrown', async () => {
  const adapters = [
    { name: 'good', generate: async () => ({ stance: 'neutral', confidence: 0.5, rationale: 'z' }) },
    { name: 'bad', generate: async () => { throw new Error('429 rate limit'); } },
  ];
  const out = await createRouter({ adapters }).ensemble('p', {});
  assert.equal(out.find((x) => x.name === 'good').ok, true);
  const bad = out.find((x) => x.name === 'bad');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /429/);
});

test('empty adapters => size 0, empty ensemble', async () => {
  const r = createRouter({ adapters: [] });
  assert.equal(r.size, 0);
  assert.deepEqual(await r.ensemble('p', {}), []);
});
