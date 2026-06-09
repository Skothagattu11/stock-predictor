'use strict';

// Express router for REST endpoints (docs/CONTRACTS.md "REST routes").
// Uses Node 22 global fetch. Falls back to mock data when no API key.

const express = require('express');
const config = require('./config');

const FINNHUB_REST = 'https://finnhub.io/api/v1';

const MOCK_SYMBOLS = [
  { symbol: 'MRVL', description: 'MARVELL TECHNOLOGY INC' },
  { symbol: 'NVDA', description: 'NVIDIA CORP' },
  { symbol: 'AMD', description: 'ADVANCED MICRO DEVICES INC' },
  { symbol: 'AAPL', description: 'APPLE INC' },
  { symbol: 'MSFT', description: 'MICROSOFT CORP' },
  { symbol: 'TSLA', description: 'TESLA INC' },
];

function mockQuote(symbol) {
  // Stable-ish pseudo quote derived from the symbol so it isn't all zeros.
  let seed = 0;
  for (let i = 0; i < symbol.length; i++) seed += symbol.charCodeAt(i);
  const base = 100 + (seed % 250);
  const c = +(base + (seed % 7) - 3).toFixed(2);
  return {
    c,
    h: +(c * 1.02).toFixed(2),
    l: +(c * 0.98).toFixed(2),
    o: +(c * 0.995).toFixed(2),
    pc: +(c * 0.99).toFixed(2),
  };
}

function createRouter() {
  const router = express.Router();

  // GET /api/search?q=
  router.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim();

    if (!config.hasKey) {
      const ql = q.toLowerCase();
      const list = q
        ? MOCK_SYMBOLS.filter(
            (s) =>
              s.symbol.toLowerCase().includes(ql) ||
              s.description.toLowerCase().includes(ql)
          )
        : MOCK_SYMBOLS;
      return res.json(list);
    }

    try {
      const url = `${FINNHUB_REST}/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(config.FINNHUB_API_KEY)}`;
      const r = await fetch(url);
      if (!r.ok) {
        return res.status(502).json({ error: `Finnhub search failed (${r.status})` });
      }
      const data = await r.json();
      const result = Array.isArray(data && data.result) ? data.result : [];
      return res.json(
        result.map((x) => ({ symbol: x.symbol, description: x.description }))
      );
    } catch (err) {
      return res.status(502).json({ error: 'Search request failed', detail: String(err && err.message || err) });
    }
  });

  // GET /api/quote/:symbol
  router.get('/quote/:symbol', async (req, res) => {
    const symbol = String(req.params.symbol || '').trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });

    if (!config.hasKey) {
      return res.json(mockQuote(symbol));
    }

    try {
      const url = `${FINNHUB_REST}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(config.FINNHUB_API_KEY)}`;
      const r = await fetch(url);
      if (!r.ok) {
        return res.status(502).json({ error: `Finnhub quote failed (${r.status})` });
      }
      const data = await r.json();
      return res.json({
        c: data.c,
        h: data.h,
        l: data.l,
        o: data.o,
        pc: data.pc,
      });
    } catch (err) {
      return res.status(502).json({ error: 'Quote request failed', detail: String(err && err.message || err) });
    }
  });

  // GET /api/health
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      mode: config.hasKey ? 'live' : 'simulated',
      hasKey: config.hasKey,
    });
  });

  return router;
}

module.exports = { createRouter };
