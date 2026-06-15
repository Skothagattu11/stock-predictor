'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { createTvStore, createTvRouter, normAction } = require('../src/tv-webhook');

test('normAction maps actions to stance', () => {
  assert.equal(normAction('buy'), 'bullish');
  assert.equal(normAction('LONG'), 'bullish');
  assert.equal(normAction('sell'), 'bearish');
  assert.equal(normAction('short'), 'bearish');
  assert.equal(normAction('exit'), 'neutral');
  assert.equal(normAction('whatever'), null);
});

test('store latest respects TTL', () => {
  let t = 0;
  const s = createTvStore({ now: () => t, ttlMs: 1000 });
  s.record({ symbol: 'AAPL', stance: 'bullish' });
  assert.equal(s.latest('aapl').stance, 'bullish');   // case-insensitive
  t = 2000;
  assert.equal(s.latest('AAPL'), null);               // expired
});

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function appWith(store, secret) {
  const app = express();
  app.use(express.json());
  app.use('/api/tv', createTvRouter({ store, secret }));
  return app;
}

test('webhook records a valid alert with the right secret', async () => {
  const store = createTvStore();
  const { server, base } = await listen(appWith(store, 'sekret'));
  try {
    const r = await fetch(`${base}/api/tv/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'sekret', symbol: 'tsla', action: 'buy', strategy: 'ORB' }),
    });
    assert.equal(r.status, 200);
    assert.equal(store.latest('TSLA').stance, 'bullish');
  } finally { server.close(); }
});

test('webhook rejects a bad secret', async () => {
  const store = createTvStore();
  const { server, base } = await listen(appWith(store, 'sekret'));
  try {
    const r = await fetch(`${base}/api/tv/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'wrong', symbol: 'TSLA', action: 'buy' }),
    });
    assert.equal(r.status, 401);
  } finally { server.close(); }
});

test('webhook 400 on missing fields', async () => {
  const store = createTvStore();
  const { server, base } = await listen(appWith(store, ''));
  try {
    const r = await fetch(`${base}/api/tv/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'TSLA' }),   // no action
    });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});
