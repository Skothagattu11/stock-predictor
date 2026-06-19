// test/paper-routes.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { createPaperRouter } = require('../src/paper-routes');

function appWith(sidecar) {
  const app = express();
  app.use(express.json());
  app.use('/api/paper', createPaperRouter({ sidecar }));
  return app;
}
async function listen(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('GET /api/paper/portfolio proxies to sidecar', async () => {
  const sidecar = { paperPortfolio: async () => ({ account: { cash: 10000 }, open: [], stats: {} }) };
  const { server, base } = await listen(appWith(sidecar));
  try {
    const r = await fetch(`${base}/api/paper/portfolio`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).account.cash, 10000);
  } finally { server.close(); }
});

test('POST /api/paper/order forwards the body', async () => {
  let got;
  const sidecar = { paperOrder: async (b) => (got = b, { id: 'x', shares: 5 }) };
  const { server, base } = await listen(appWith(sidecar));
  try {
    const r = await fetch(`${base}/api/paper/order`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', budget: 200, target: 42, stop: 38 }),
    });
    assert.equal((await r.json()).shares, 5);
    assert.equal(got.symbol, 'AAPL');
  } finally { server.close(); }
});

test('upstream 400 (rejected order) is forwarded', async () => {
  const err = new Error('sidecar /paper/order -> 400'); err.status = 400;
  const sidecar = { paperOrder: async () => { throw err; } };
  const { server, base } = await listen(appWith(sidecar));
  try {
    const r = await fetch(`${base}/api/paper/order`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});
