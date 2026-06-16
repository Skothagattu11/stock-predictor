'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { createPredictRouter } = require('../src/predict-routes');

function appWith(service) {
  const app = express();
  app.use(express.json());
  app.use('/api/predict', createPredictRouter({ service }));
  return app;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

test('GET /api/predict/intraday/:symbol returns sidecar json', async () => {
  const service = { intraday: async (s) => ({ symbol: s, bias: 'Bullish' }) };
  const { server, base } = await listen(appWith(service));
  try {
    const r = await fetch(`${base}/api/predict/intraday/aapl`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).symbol, 'AAPL');   // upper-cased by route
  } finally { server.close(); }
});

test('sidecar failure surfaces as 503', async () => {
  const service = { intraday: async () => { throw new Error('down'); } };
  const { server, base } = await listen(appWith(service));
  try {
    const r = await fetch(`${base}/api/predict/intraday/AAPL`);
    assert.equal(r.status, 503);
  } finally { server.close(); }
});

test('upstream 422 (forming) is forwarded, not flattened to 503', async () => {
  const err = new Error('sidecar /predict/setups/AAPL -> 422'); err.status = 422;
  const service = { setups: async () => { throw err; } };
  const { server, base } = await listen(appWith(service));
  try {
    const r = await fetch(`${base}/api/predict/setups/AAPL`);
    assert.equal(r.status, 422);   // UI shows "Forming…", not "sidecar unreachable"
  } finally { server.close(); }
});

test('upstream 5xx still surfaces as 503', async () => {
  const err = new Error('sidecar /predict/setups/AAPL -> 500'); err.status = 500;
  const service = { setups: async () => { throw err; } };
  const { server, base } = await listen(appWith(service));
  try {
    const r = await fetch(`${base}/api/predict/setups/AAPL`);
    assert.equal(r.status, 503);
  } finally { server.close(); }
});

test('POST /api/predict/portfolio passes holdings through', async () => {
  const service = { portfolio: async (h) => ({ count: h.length }) };
  const { server, base } = await listen(appWith(service));
  try {
    const r = await fetch(`${base}/api/predict/portfolio`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holdings: [{ symbol: 'AAPL', value: 1 }] }),
    });
    assert.equal((await r.json()).count, 1);
  } finally { server.close(); }
});
