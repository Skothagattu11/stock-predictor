'use strict';
const express = require('express');
const { randomUUID } = require('crypto');

const PINE_DEFAULTS = {
  enabled: false,
  mode: 'auto',          // 'auto' | 'approval'
  onDuplicate: 'skip',   // 'skip' | 'stack' | 'scale'
  onExit: 'closeAll',    // 'closeAll' | 'closeLatest' | 'ignore'
  tradeBudget: 200,      // dollars per auto-trade
};

class PendingQueue {
  constructor(cap = 50) {
    this._cap = cap;
    this._items = [];
  }
  add(signal) {
    if (this._items.length >= this._cap) this._items.shift();
    const entry = { id: randomUUID(), ts: Date.now(), ...signal };
    this._items.push(entry);
    return entry;
  }
  list() { return this._items.slice(); }
  approve(id) {
    const idx = this._items.findIndex(e => e.id === id);
    if (idx === -1) return null;
    return this._items.splice(idx, 1)[0];
  }
  reject(id) {
    const idx = this._items.findIndex(e => e.id === id);
    if (idx === -1) return false;
    this._items.splice(idx, 1);
    return true;
  }
  isFull() { return this._items.length >= this._cap; }
}

// Map a TradingView/Pine alert action onto our stance vocabulary.
function normAction(x) {
  x = String(x || '').toLowerCase().trim();
  if (['buy', 'long', 'bull', 'bullish', 'strongbuy'].indexOf(x) >= 0) return 'bullish';
  if (['sell', 'short', 'bear', 'bearish', 'strongsell'].indexOf(x) >= 0) return 'bearish';
  if (['exit', 'flat', 'close', 'neutral', 'hold'].indexOf(x) >= 0) return 'neutral';
  return null;
}

// In-memory store of recent TradingView alerts. Latest per symbol (with TTL) feeds
// the consensus voice; a capped recent list backs an alerts feed.
function createTvStore({ now = Date.now, ttlMs = 30 * 60 * 1000, max = 200 } = {}) {
  const bySymbol = new Map();
  const recent = [];
  function record(a) {
    a.ts = now();
    bySymbol.set(a.symbol, a);
    recent.push(a);
    if (recent.length > max) recent.shift();
  }
  function latest(symbol) {
    const a = bySymbol.get(String(symbol || '').toUpperCase());
    if (!a) return null;
    if (now() - a.ts > ttlMs) return null;   // too old to count as a live signal
    return a;
  }
  function feed() { return recent.slice().reverse(); }
  return { record, latest, feed };
}

async function executeSignal(signal, sidecar, pineSettings) {
  const { symbol, stance, price } = signal;
  const pine = { ...PINE_DEFAULTS, ...pineSettings };
  const budget = pine.tradeBudget || 200;

  if (stance === 'bullish') {
    // Check for existing position
    const { open = [] } = await sidecar.paperPortfolio().catch(() => ({ open: [] }));
    const existing = open.filter(p => p.symbol === symbol);
    if (existing.length > 0 && pine.onDuplicate === 'skip') return { action: 'skipped', reason: 'duplicate' };
    // stack or scale both open a new order (engine has no merge concept)
    const target = price ? +(price * 1.06).toFixed(2) : null;
    const stop   = price ? +(price * 0.97).toFixed(2) : null;
    await sidecar.paperOrder({ symbol, budget, target, stop });
    return { action: 'opened', symbol };
  }

  if (stance === 'bearish' || stance === 'neutral') {
    if (pine.onExit === 'ignore') return { action: 'ignored' };
    const { open = [] } = await sidecar.paperPortfolio().catch(() => ({ open: [] }));
    const matching = open.filter(p => p.symbol === symbol);
    if (!matching.length) return { action: 'no_position' };
    if (pine.onExit === 'closeAll') {
      await Promise.all(matching.map(p => sidecar.paperClose(p.id).catch(() => {})));
      return { action: 'closedAll', count: matching.length };
    }
    if (pine.onExit === 'closeLatest') {
      const latest = matching[matching.length - 1];
      await sidecar.paperClose(latest.id).catch(() => {});
      return { action: 'closedLatest', id: latest.id };
    }
  }

  return { action: 'noop' };
}

// POST /webhook (TradingView posts here), GET /alerts/:symbol, GET /alerts
// GET /pending, POST /pending/:id/approve, POST /pending/:id/reject
function createTvRouter({ store, secret, sidecar, _queue } = {}) {
  const router = express.Router();
  const pendingQueue = _queue || new PendingQueue(50);

  router.post('/webhook', async (req, res) => {
    const b = req.body || {};
    if (secret && b.secret !== secret) return res.status(401).json({ error: 'bad or missing secret' });
    const symbol = String(b.symbol || b.ticker || '').toUpperCase();
    const stance = normAction(b.action || b.side || b.signal);
    if (!symbol || !stance) return res.status(400).json({ error: 'need symbol + action (buy/sell/exit)' });

    const signal = {
      symbol, stance, action: String(b.action || b.side || b.signal),
      price: Number(b.price) || null, strategy: String(b.strategy || b.alert || 'TradingView'),
      note: String(b.note || ''),
    };
    store.record(signal);

    // Pine auto-trade bridge
    if (sidecar) {
      try {
        const settings = await sidecar.paperSettings().catch(() => ({}));
        const pine = { ...PINE_DEFAULTS, ...(settings.pine || {}) };
        if (pine.enabled) {
          if (pine.mode === 'auto') {
            await executeSignal(signal, sidecar, pine).catch(() => {});
          } else if (pine.mode === 'approval') {
            pendingQueue.add(signal);
          }
        }
      } catch (_) { /* never block webhook response on pine errors */ }
    }

    res.json({ ok: true, symbol, stance });
  });

  router.get('/alerts/:symbol', (req, res) => res.json(store.latest(req.params.symbol) || {}));
  router.get('/alerts', (req, res) => res.json(store.feed()));

  router.get('/pending', (_req, res) => res.json(pendingQueue.list()));

  router.post('/pending/:id/approve', async (req, res) => {
    const entry = pendingQueue.approve(req.params.id);
    if (!entry) return res.status(404).json({ error: 'signal not found' });
    if (sidecar) {
      try {
        const settings = await sidecar.paperSettings().catch(() => ({}));
        await executeSignal(entry, sidecar, { ...PINE_DEFAULTS, ...(settings.pine || {}) });
      } catch (_) {}
    }
    res.json({ ok: true, symbol: entry.symbol, stance: entry.stance });
  });

  router.post('/pending/:id/reject', (req, res) => {
    const removed = pendingQueue.reject(req.params.id);
    if (!removed) return res.status(404).json({ error: 'signal not found' });
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createTvStore, createTvRouter, normAction, PendingQueue, PINE_DEFAULTS };
