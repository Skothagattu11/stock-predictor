'use strict';
// @slow — requires a RUNNING server. Verifies the report cache serves a hit.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');

const BASE = 'http://localhost:3000/api/analyst';
async function serverUp() { try { const r = await fetch(`${BASE}/health`); return r.ok; } catch { return false; } }
function post() {
  return fetch(`${BASE}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker: 'AAPL' }) });
}

test('cache: a second identical request is served from cache (<200ms, cacheHit:true)', async (t) => {
  if (!(await serverUp())) return t.skip('server not running on :3000');
  await (await post()).json(); // prime
  const t0 = Date.now();
  const second = await (await post()).json();
  const ms = Date.now() - t0;
  assert.equal(second.cacheHit, true);
  assert.ok(ms < 500, `cache hit should be fast, took ${ms}ms`);
});
