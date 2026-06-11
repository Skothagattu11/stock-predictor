'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TtlCache } = require('../src/cache');

test('returns fresh value without reloading within ttl', async () => {
  let calls = 0;
  const c = new TtlCache();
  const load = async () => (++calls, 'v1');
  assert.equal(await c.getOrLoad('k', 1000, load), 'v1');
  assert.equal(await c.getOrLoad('k', 1000, load), 'v1');
  assert.equal(calls, 1);
});

test('single-flight: concurrent loads call loader once', async () => {
  let calls = 0;
  const c = new TtlCache();
  const load = () => { calls++; return new Promise((r) => setTimeout(() => r('v'), 10)); };
  const [a, b] = await Promise.all([c.getOrLoad('k', 1000, load), c.getOrLoad('k', 1000, load)]);
  assert.equal(a, 'v'); assert.equal(b, 'v'); assert.equal(calls, 1);
});

test('reloads after full expiry (past stale window)', async () => {
  let t = 0; let calls = 0;
  const c = new TtlCache({ now: () => t, staleTtlMs: 100 });
  const load = async () => `v${++calls}`;
  assert.equal(await c.getOrLoad('k', 100, load), 'v1');
  t = 1000;                                   // past ttl(100)+stale(100)
  assert.equal(await c.getOrLoad('k', 100, load), 'v2');
  assert.equal(calls, 2);
});

test('stale-while-revalidate: returns stale immediately then refreshes', async () => {
  let t = 0; let calls = 0;
  const c = new TtlCache({ now: () => t, staleTtlMs: 1000 });
  const load = async () => `v${++calls}`;
  assert.equal(await c.getOrLoad('k', 100, load), 'v1');     // calls=1
  t = 150;                                                   // expired but within stale window
  assert.equal(await c.getOrLoad('k', 100, load), 'v1');     // serves stale immediately
  await new Promise((r) => setImmediate(r));                 // let background revalidate run
  assert.equal(calls, 2);                                    // refreshed in background
});
