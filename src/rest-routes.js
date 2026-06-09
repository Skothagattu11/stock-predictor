'use strict';

// Express router for REST endpoints (docs/CONTRACTS.md "REST routes").
// Uses Node 22 global fetch. Falls back to mock data when no API key.

const express = require('express');
const config = require('./config');
const yahoo = require('./yahoo-client');

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

  // GET /api/news/:symbol  -> [{ headline, source, url, datetime, summary, image }]
  // Finnhub company-news when a key is present (has summaries); otherwise falls
  // back to Yahoo Finance news (no key needed).
  router.get('/news/:symbol', async (req, res) => {
    const symbol = String(req.params.symbol || '').trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });

    const ymd = (d) => d.toISOString().slice(0, 10);
    try {
      if (config.hasKey) {
        const to = new Date();
        const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
        const url = `${FINNHUB_REST}/company-news?symbol=${encodeURIComponent(symbol)}&from=${ymd(from)}&to=${ymd(to)}&token=${encodeURIComponent(config.FINNHUB_API_KEY)}`;
        const r = await fetch(url);
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data) && data.length) {
            const items = data
              .filter((n) => n && n.headline && n.url)
              .sort((a, b) => b.datetime - a.datetime)
              .slice(0, 15)
              .map((n) => ({
                headline: n.headline,
                source: n.source || '',
                url: n.url,
                datetime: n.datetime, // unix seconds
                summary: n.summary || '',
                image: n.image || '',
              }));
            return res.json(items);
          }
        }
      }

      // Fallback: Yahoo Finance news search (no key).
      const yurl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=15&quotesCount=0`;
      const yr = await fetch(yurl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!yr.ok) return res.status(502).json({ error: `News failed (${yr.status})` });
      const yj = await yr.json();
      const news = Array.isArray(yj && yj.news) ? yj.news : [];
      const items = news
        .filter((n) => n && n.title && n.link)
        .slice(0, 15)
        .map((n) => ({
          headline: n.title,
          source: n.publisher || '',
          url: n.link,
          datetime: n.providerPublishTime || 0,
          summary: '',
          image: (n.thumbnail && n.thumbnail.resolutions && n.thumbnail.resolutions[0] && n.thumbnail.resolutions[0].url) || '',
        }));
      return res.json(items);
    } catch (err) {
      return res.status(502).json({ error: 'News request failed', detail: String(err && err.message || err) });
    }
  });

  // GET /api/price/:symbol -> { price, prevClose }  (Yahoo, real, no key)
  // Used to value portfolio positions for tickers that aren't being streamed.
  router.get('/price/:symbol', async (req, res) => {
    const symbol = String(req.params.symbol || '').trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    try {
      const p = await yahoo.fetchPrice(symbol);
      return res.json(p);
    } catch (err) {
      return res.status(502).json({ error: 'Price request failed', detail: String(err && err.message || err) });
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
