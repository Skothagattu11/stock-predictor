'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createScheduler } = require('../src/scheduler');

test('refreshOnce warms intraday+outlook for each symbol', async () => {
  const hits = [];
  const service = {
    intraday: async (s) => hits.push(`i:${s}`),
    outlook: async (s) => hits.push(`o:${s}`),
  };
  const sch = createScheduler({ service, symbols: ['AAPL', 'MSFT'] });
  await sch.refreshOnce();
  assert.deepEqual(hits.sort(), ['i:AAPL', 'i:MSFT', 'o:AAPL', 'o:MSFT']);
});

test('one failing symbol does not stop the others', async () => {
  const hits = [];
  const service = {
    intraday: async (s) => { if (s === 'BAD') throw new Error('boom'); hits.push(s); },
    outlook: async () => {},
  };
  const sch = createScheduler({ service, symbols: ['BAD', 'AAPL'], log: () => {} });
  await sch.refreshOnce();
  assert.deepEqual(hits, ['AAPL']);
});
