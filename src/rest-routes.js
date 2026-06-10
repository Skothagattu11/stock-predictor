'use strict';

// Express router for REST endpoints (docs/CONTRACTS.md "REST routes").
// Uses Node 22 global fetch. Falls back to mock data when no API key.

const express = require('express');
const config = require('./config');
const yahoo = require('./yahoo-client');

// ---- AI assistant abuse guardrails (token-cost protection) ----------------
const CHAT_LIMITS = {
  perMin: parseInt(process.env.CHAT_PER_MIN, 10) || 8,          // per IP / minute
  perDayIp: parseInt(process.env.CHAT_PER_DAY_IP, 10) || 80,    // per IP / day
  perDayGlobal: parseInt(process.env.CHAT_PER_DAY, 10) || 800,  // all users / day
  maxMessages: 8,            // only the last N turns are sent
  maxMsgChars: 1500,         // per message, truncated
  maxContextChars: 3000,     // dashboard context JSON, truncated
  maxOutputTokens: parseInt(process.env.CHAT_MAX_OUTPUT_TOKENS, 10) || 700,
};
const ipHits = new Map();    // ip -> [timestamps]
const globalDay = { day: '', count: 0 };
const ymd = () => new Date().toISOString().slice(0, 10);

function chatRateCheck(ip) {
  const now = Date.now();
  const d = ymd();
  if (globalDay.day !== d) { globalDay.day = d; globalDay.count = 0; }
  if (globalDay.count >= CHAT_LIMITS.perDayGlobal) {
    return { ok: false, code: 503, msg: 'The assistant has reached its daily usage limit. Please try again tomorrow.' };
  }
  if (ipHits.size > 5000) ipHits.clear(); // crude memory cap
  const dayAgo = now - 86400000, minAgo = now - 60000;
  let arr = (ipHits.get(ip) || []).filter((t) => t > dayAgo);
  if (arr.filter((t) => t > minAgo).length >= CHAT_LIMITS.perMin) {
    return { ok: false, code: 429, msg: 'Too many questions in a short time — please wait a few seconds.' };
  }
  if (arr.length >= CHAT_LIMITS.perDayIp) {
    return { ok: false, code: 429, msg: "You've reached today's question limit for the assistant." };
  }
  arr.push(now);
  ipHits.set(ip, arr);
  globalDay.count++;
  return { ok: true };
}

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
  // Keyless symbol search via Yahoo (works in prod without a Finnhub key and
  // covers more tickers). Falls back to Finnhub (if a key is set) then a mock list.
  router.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const ql = q.toLowerCase();
    const mock = MOCK_SYMBOLS.filter(
      (s) => s.symbol.toLowerCase().includes(ql) || s.description.toLowerCase().includes(ql)
    );

    // 1) Yahoo (no key needed)
    try {
      const list = await yahoo.searchSymbols(q);
      if (list.length) return res.json(list);
    } catch (err) {
      // fall through to Finnhub / mock
    }

    // 2) Finnhub (only if a key is configured)
    if (config.hasKey) {
      try {
        const url = `${FINNHUB_REST}/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(config.FINNHUB_API_KEY)}`;
        const r = await fetch(url);
        if (r.ok) {
          const data = await r.json();
          const result = Array.isArray(data && data.result) ? data.result : [];
          if (result.length) {
            return res.json(result.map((x) => ({ symbol: x.symbol, description: x.description })));
          }
        }
      } catch (err) { /* fall through */ }
    }

    // 3) Last resort: mock list
    return res.json(mock);
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

  // POST /api/chat -> { text, sources:[{title,uri}] }
  // Proxies to Google Gemini (key stays server-side). Optional Google Search
  // grounding + the live dashboard context the browser attaches.
  router.post('/chat', async (req, res) => {
    if (!config.hasGemini) {
      return res.status(200).json({
        needsKey: true,
        text: 'The AI assistant isn’t configured yet. Set GEMINI_API_KEY (from aistudio.google.com) in the server environment to enable it.',
      });
    }
    // Abuse guardrail: rate-limit by client IP + global daily cap.
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    const gate = chatRateCheck(ip);
    if (!gate.ok) {
      return res.status(gate.code).json({ error: gate.msg, rateLimited: true });
    }
    try {
      const body = req.body || {};
      // Cap turns + per-message length to bound input tokens.
      const messages = (Array.isArray(body.messages) ? body.messages : [])
        .slice(-CHAT_LIMITS.maxMessages)
        .map((m) => ({ role: m.role, text: String(m.text || '').slice(0, CHAT_LIMITS.maxMsgChars) }));
      // Cap the attached dashboard context size.
      let ctx = body.context || null;
      if (ctx) {
        let ctxStr = JSON.stringify(ctx);
        if (ctxStr.length > CHAT_LIMITS.maxContextChars) ctxStr = ctxStr.slice(0, CHAT_LIMITS.maxContextChars);
        ctx = ctxStr;
      }
      const webSearch = body.webSearch !== false;

      const sys =
        'You are a concise, helpful trading assistant embedded in a live day-trading dashboard. ' +
        'Answer the user using the LIVE DASHBOARD CONTEXT below when relevant (ticker, signal, indicators, ' +
        "the user's position and P/L, patterns). Explain reasoning briefly and in plain language. " +
        'You are NOT a licensed financial advisor — when you give a buy/sell/hold view, add a short caution ' +
        'that it is not financial advice. Keep answers short — a few sentences or bullets.' +
        (ctx ? '\n\nLIVE DASHBOARD CONTEXT (JSON):\n' + ctx : '');

      const contents = messages.map((m) => ({
        role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
        parts: [{ text: String(m.text || '') }],
      }));
      if (!contents.length) return res.status(400).json({ error: 'no message' });

      const payload = {
        system_instruction: { parts: [{ text: sys }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: CHAT_LIMITS.maxOutputTokens },
      };
      if (webSearch) payload.tools = [{ google_search: {} }];

      const url =
        'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(config.GEMINI_MODEL) +
        ':generateContent?key=' + encodeURIComponent(config.GEMINI_API_KEY);

      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) {
        const msg = (data && data.error && data.error.message) || ('Gemini error ' + r.status);
        return res.status(502).json({ error: msg });
      }

      const cand = data && data.candidates && data.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      const text = parts.map((p) => p.text || '').join('').trim() || '(no answer)';

      // Grounding citations (if Google Search was used).
      const sources = [];
      const gm = cand && cand.groundingMetadata;
      const chunks = gm && (gm.groundingChunks || gm.grounding_chunks);
      if (Array.isArray(chunks)) {
        chunks.forEach((c) => {
          const w = c && c.web;
          if (w && w.uri) sources.push({ title: w.title || w.uri, uri: w.uri });
        });
      }
      return res.json({ text, sources });
    } catch (err) {
      return res.status(502).json({ error: 'Chat request failed: ' + String(err && err.message || err) });
    }
  });

  // GET /api/health
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      mode: config.hasKey ? 'live' : 'simulated',
      hasKey: config.hasKey,
      hasGemini: config.hasGemini,
    });
  });

  return router;
}

module.exports = { createRouter };
