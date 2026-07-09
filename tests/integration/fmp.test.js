'use strict';
// @slow — hits the real FMP stable API. Requires FMP_API_KEY. Run via
// `npm run test:integration`; skipped automatically when the key is absent.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getFundamentals, getPeers } = require('../../src/fmp-client');

const KEY = process.env.FMP_API_KEY;
const skip = KEY ? false : 'FMP_API_KEY not set';

test('FMP: real AAPL fundamentals expose the core fields', { skip }, async () => {
  const f = await getFundamentals('AAPL', KEY);
  assert.ok(f.profile.mktCap > 0, 'mktCap');
  assert.equal(typeof f.profile.sector, 'string');
  assert.ok(f.income[0].revenue > 0, 'revenue');
  assert.ok(f.income.length >= 2, 'trailing periods');
  assert.ok(f.metrics.peRatio !== null, 'P/E');
  assert.ok(f.cashFlow.freeCashFlow !== null, 'FCF');
  assert.ok(f.balance.totalDebt !== null, 'balance-sheet debt');
});

test('FMP: real AAPL peers returns a non-empty set', { skip }, async () => {
  const peers = await getPeers('AAPL', KEY);
  assert.ok(Array.isArray(peers));
  assert.ok(peers.length > 0 && peers[0].symbol);
});
