'use strict';
// @slow — end-to-end comparison against a RUNNING server with FMP + LLM keys.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');

const BASE = 'http://localhost:3000/api/analyst';
async function serverUp() { try { const r = await fetch(`${BASE}/health`); return r.ok; } catch { return false; } }

test('comparison: AAPL vs MSFT returns ranked results', async (t) => {
  if (!(await serverUp())) return t.skip('server not running on :3000');
  const res = await fetch(`${BASE}/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tickers: ['AAPL', 'MSFT'], mode: 'comparison', depth: 'standard' }),
  });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.mode, 'comparison');
  assert.equal(d.results.length, 2);
  assert.ok(d.results.every((r) => ['BUY', 'HOLD', 'SELL'].includes(r.verdict)));
  assert.ok(d.rankedVerdict.ranked.length > 0);
  assert.ok(d.rankedVerdict.rationale.length > 0);
  assert.ok(d.results.every((r) => !('_diag' in r))); // diagnostics stripped
});
