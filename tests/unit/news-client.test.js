'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNewsClient } = require('../../src/news-client');

function yahooFetch() {
  return async () => ({ ok: true, json: async () => ({ news: [
    { title: 'Apple beats earnings', publisher: 'Reuters', link: 'http://x', providerPublishTime: 1 },
    { title: null }, // filtered out
  ] }) });
}

test('fetchNews: maps Yahoo search results to headline shape', async () => {
  const nc = createNewsClient({ fetchImpl: yahooFetch() });
  const items = await nc.fetchNews('AAPL');
  assert.equal(items.length, 1);
  assert.equal(items[0].headline, 'Apple beats earnings');
  assert.equal(items[0].source, 'Reuters');
});

test('fetchNews: prefers Finnhub when a key is set and it returns items', async () => {
  const impl = async (url) => {
    if (url.includes('finnhub')) return { ok: true, json: async () => [{ headline: 'FH news', source: 'FH', datetime: 5 }] };
    return { ok: true, json: async () => ({ news: [{ title: 'YH news', link: 'x' }] }) };
  };
  const nc = createNewsClient({ finnhubKey: 'k', fetchImpl: impl });
  const items = await nc.fetchNews('AAPL');
  assert.equal(items[0].headline, 'FH news');
});

test('fetchNews: empty symbol returns [], never throws', async () => {
  const nc = createNewsClient({ fetchImpl: async () => { throw new Error('boom'); } });
  assert.deepEqual(await nc.fetchNews(''), []);
  assert.deepEqual(await nc.fetchNews('AAPL'), []); // fetch throws → degrades to []
});
