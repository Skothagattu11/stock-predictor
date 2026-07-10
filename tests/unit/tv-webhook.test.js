'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PendingQueue, PINE_DEFAULTS, createTvStore, createTvRouter, normAction } = require('../../src/tv-webhook');

test('PINE_DEFAULTS has expected shape', () => {
  assert.equal(PINE_DEFAULTS.enabled, false);
  assert.equal(PINE_DEFAULTS.mode, 'auto');
  assert.equal(PINE_DEFAULTS.onDuplicate, 'skip');
  assert.equal(PINE_DEFAULTS.onExit, 'closeAll');
  assert.equal(typeof PINE_DEFAULTS.tradeBudget, 'number');
});

test('PendingQueue: add returns an entry with id and ts', () => {
  const q = new PendingQueue(50);
  const entry = q.add({ symbol: 'AAPL', stance: 'bullish', action: 'buy', price: 200, strategy: 'Test' });
  assert.ok(entry.id);
  assert.ok(entry.ts);
  assert.equal(entry.symbol, 'AAPL');
});

test('PendingQueue: list returns added entries', () => {
  const q = new PendingQueue(50);
  q.add({ symbol: 'AAPL', stance: 'bullish', action: 'buy', price: 200, strategy: 'Test' });
  assert.equal(q.list().length, 1);
});

test('PendingQueue: reject removes entry', () => {
  const q = new PendingQueue(50);
  const e = q.add({ symbol: 'AAPL', stance: 'bullish', action: 'buy', price: 200, strategy: 'Test' });
  const removed = q.reject(e.id);
  assert.ok(removed);
  assert.equal(q.list().length, 0);
});

test('PendingQueue: approve removes and returns entry', () => {
  const q = new PendingQueue(50);
  const e = q.add({ symbol: 'TSLA', stance: 'bearish', action: 'sell', price: 100, strategy: 'Test' });
  const found = q.approve(e.id);
  assert.equal(found.symbol, 'TSLA');
  assert.equal(q.list().length, 0);
});

test('PendingQueue: approve returns null for unknown id', () => {
  const q = new PendingQueue(50);
  assert.equal(q.approve('no-such-id'), null);
});

test('PendingQueue: drops oldest when full', () => {
  const q = new PendingQueue(2);
  const first = q.add({ symbol: 'A', stance: 'bullish', action: 'buy', price: 1, strategy: 'S' });
  const second = q.add({ symbol: 'B', stance: 'bullish', action: 'buy', price: 2, strategy: 'S' });
  q.add({ symbol: 'C', stance: 'bullish', action: 'buy', price: 3, strategy: 'S' });
  const ids = q.list().map(e => e.id);
  assert.equal(q.list().length, 2);
  assert.ok(!ids.includes(first.id), 'oldest entry (A) should have been dropped');
  assert.ok(ids.includes(second.id), 'second entry (B) should still be in queue');
});

test('PendingQueue: isFull returns true when at cap', () => {
  const q = new PendingQueue(1);
  q.add({ symbol: 'A', stance: 'bullish', action: 'buy', price: 1, strategy: 'S' });
  assert.equal(q.isFull(), true);
});

// ---------------------------------------------------------------------------
// Task 2: executeSignal + new API routes
// ---------------------------------------------------------------------------
const http = require('node:http');

// Stub sidecar factory
function makeSidecar(overrides = {}) {
  const orders = [];
  const closes = [];
  const openPositions = overrides.openPositions || [];
  return {
    orders,
    closes,
    paperPortfolio: async () => ({ open: openPositions, account: {}, stats: {} }),
    paperSettings: async () => ({ ...PINE_DEFAULTS, ...overrides.settings }),
    paperOrder: async (body) => { orders.push(body); return { ok: true }; },
    paperClose: async (id) => { closes.push(id); return { ok: true }; },
  };
}

function makeRouter(sidecarOverrides = {}) {
  const store = createTvStore();
  const queue = new PendingQueue(50);
  const sidecar = makeSidecar(sidecarOverrides);
  const router = createTvRouter({ store, secret: null, sidecar, _queue: queue });
  return { router, sidecar, queue };
}

function request(router, method, path, body) {
  return new Promise((resolve) => {
    const app = require('express')();
    app.use(require('express').json());
    app.use('/', router);
    const srv = app.listen(0, () => {
      const port = srv.address().port;
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host: '127.0.0.1', port, method, path,
        headers: { 'content-type': 'application/json', 'content-length': data ? Buffer.byteLength(data) : 0 }
      }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: JSON.parse(raw || 'null') }); });
      });
      if (data) req.write(data);
      req.end();
    });
  });
}

test('webhook: pine disabled — no order placed', async () => {
  const { router, sidecar } = makeRouter({ settings: { pine: { enabled: false } } });
  await request(router, 'POST', '/webhook', { symbol: 'AAPL', action: 'buy', price: 200, strategy: 'Test' });
  assert.equal(sidecar.orders.length, 0);
});

test('webhook: pine auto mode bullish — places order with correct target and stop', async () => {
  const { router, sidecar } = makeRouter({ settings: { pine: { enabled: true, mode: 'auto', onDuplicate: 'stack', onExit: 'ignore', tradeBudget: 200 } } });
  const res = await request(router, 'POST', '/webhook', { symbol: 'NVDA', action: 'buy', price: 500, strategy: 'GC' });
  assert.equal(res.status, 200);
  assert.equal(sidecar.orders.length, 1);
  assert.equal(sidecar.orders[0].symbol, 'NVDA');
  assert.equal(sidecar.orders[0].budget, 200);
  assert.equal(sidecar.orders[0].target, +(500 * 1.06).toFixed(2)); // 530
  assert.equal(sidecar.orders[0].stop,   +(500 * 0.97).toFixed(2)); // 485
});

test('webhook: pine auto mode onDuplicate=skip — skips when position exists', async () => {
  const { router, sidecar } = makeRouter({
    openPositions: [{ id: '1', symbol: 'AAPL' }],
    settings: { pine: { enabled: true, mode: 'auto', onDuplicate: 'skip', onExit: 'ignore', tradeBudget: 200 } }
  });
  await request(router, 'POST', '/webhook', { symbol: 'AAPL', action: 'buy', price: 200, strategy: 'Test' });
  assert.equal(sidecar.orders.length, 0);
});

test('webhook: pine auto mode onExit=closeAll — closes all matching positions', async () => {
  const { router, sidecar } = makeRouter({
    openPositions: [{ id: 'p1', symbol: 'TSLA' }, { id: 'p2', symbol: 'TSLA' }, { id: 'p3', symbol: 'AAPL' }],
    settings: { pine: { enabled: true, mode: 'auto', onDuplicate: 'skip', onExit: 'closeAll', tradeBudget: 200 } }
  });
  await request(router, 'POST', '/webhook', { symbol: 'TSLA', action: 'sell', price: 100, strategy: 'Test' });
  assert.equal(sidecar.closes.length, 2);
  assert.ok(sidecar.closes.includes('p1'));
  assert.ok(sidecar.closes.includes('p2'));
});

test('webhook: pine auto mode onExit=closeLatest — closes only most recent', async () => {
  const { router, sidecar } = makeRouter({
    openPositions: [{ id: 'p1', symbol: 'TSLA' }, { id: 'p2', symbol: 'TSLA' }],
    settings: { pine: { enabled: true, mode: 'auto', onDuplicate: 'skip', onExit: 'closeLatest', tradeBudget: 200 } }
  });
  await request(router, 'POST', '/webhook', { symbol: 'TSLA', action: 'exit', price: 100, strategy: 'Test' });
  assert.equal(sidecar.closes.length, 1);
  assert.equal(sidecar.closes[0], 'p2');
});

test('webhook: pine approval mode — queues signal, no order', async () => {
  const { router, sidecar, queue } = makeRouter({
    settings: { pine: { enabled: true, mode: 'approval', onDuplicate: 'skip', onExit: 'closeAll', tradeBudget: 200 } }
  });
  await request(router, 'POST', '/webhook', { symbol: 'MSFT', action: 'buy', price: 300, strategy: 'Test' });
  assert.equal(sidecar.orders.length, 0);
  assert.equal(queue.list().length, 1);
});

test('GET /pending — returns queued signals', async () => {
  const { router, queue } = makeRouter({ settings: { pine: { enabled: true, mode: 'approval', onDuplicate: 'skip', onExit: 'closeAll', tradeBudget: 200 } } });
  queue.add({ symbol: 'AAPL', stance: 'bullish', action: 'buy', price: 200, strategy: 'T' });
  const res = await request(router, 'GET', '/pending', null);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].symbol, 'AAPL');
});

test('POST /pending/:id/approve — executes and removes from queue', async () => {
  const { router, sidecar, queue } = makeRouter({ settings: { pine: { enabled: true, mode: 'approval', onDuplicate: 'stack', onExit: 'closeAll', tradeBudget: 200 } } });
  const entry = queue.add({ symbol: 'GOOGL', stance: 'bullish', action: 'buy', price: 150, strategy: 'T' });
  const res = await request(router, 'POST', `/pending/${entry.id}/approve`, null);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(queue.list().length, 0);
  assert.equal(sidecar.orders.length, 1);
});

test('POST /pending/:id/reject — removes without executing', async () => {
  const { router, sidecar, queue } = makeRouter({ settings: { pine: { enabled: true, mode: 'approval', onDuplicate: 'skip', onExit: 'closeAll', tradeBudget: 200 } } });
  const entry = queue.add({ symbol: 'GOOGL', stance: 'bullish', action: 'buy', price: 150, strategy: 'T' });
  const res = await request(router, 'POST', `/pending/${entry.id}/reject`, null);
  assert.equal(res.status, 200);
  assert.equal(queue.list().length, 0);
  assert.equal(sidecar.orders.length, 0);
});

test('POST /pending/:id/approve — 404 for unknown id', async () => {
  const { router } = makeRouter();
  const res = await request(router, 'POST', '/pending/no-such-id/approve', null);
  assert.equal(res.status, 404);
});

test('webhook: pine auto mode onDuplicate=stack — places order even with existing position', async () => {
  const { router, sidecar } = makeRouter({
    openPositions: [{ id: '1', symbol: 'AAPL' }],
    settings: { pine: { enabled: true, mode: 'auto', onDuplicate: 'stack', onExit: 'ignore', tradeBudget: 200 } }
  });
  await request(router, 'POST', '/webhook', { symbol: 'AAPL', action: 'buy', price: 200, strategy: 'Test' });
  assert.equal(sidecar.orders.length, 1);
});

test('webhook: pine auto mode onExit=ignore — no close on bearish', async () => {
  const { router, sidecar } = makeRouter({
    openPositions: [{ id: 'p1', symbol: 'TSLA' }],
    settings: { pine: { enabled: true, mode: 'auto', onDuplicate: 'skip', onExit: 'ignore', tradeBudget: 200 } }
  });
  await request(router, 'POST', '/webhook', { symbol: 'TSLA', action: 'sell', price: 100, strategy: 'Test' });
  assert.equal(sidecar.closes.length, 0);
});
