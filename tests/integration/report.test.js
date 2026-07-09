'use strict';
// @slow — end-to-end against a RUNNING server (npm start) with FMP + LLM keys.
// Skips automatically when the server isn't reachable on :3000.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');

const BASE = 'http://localhost:3000/api/analyst';
async function serverUp() { try { const r = await fetch(`${BASE}/health`); return r.ok; } catch { return false; } }
function post(body) {
  return fetch(`${BASE}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('report: NVDA returns a valid 6-section report (no _diag leak)', async (t) => {
  if (!(await serverUp())) return t.skip('server not running on :3000');
  const res = await post({ ticker: 'NVDA', mode: 'single', depth: 'standard' });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.ok(['BUY', 'HOLD', 'SELL'].includes(d.verdict), `verdict ${d.verdict}`);
  assert.ok(d.confidence >= 0 && d.confidence <= 100);
  for (const s of ['overview', 'financials', 'strengthsRisks', 'valuation', 'technical', 'recommendation']) {
    assert.ok(d.report[s], `section ${s}`);
  }
  assert.match(d.disclaimer, /research purposes/i);
  assert.equal('_diag' in d, false); // diagnostics stripped from the public response
});

test('report: invalid ticker → 400', async (t) => {
  if (!(await serverUp())) return t.skip('server not running');
  const res = await post({ ticker: 'BAD TICKER' });
  assert.equal(res.status, 400);
});
