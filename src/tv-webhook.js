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

// POST /webhook (TradingView posts here), GET /alerts/:symbol, GET /alerts
function createTvRouter({ store, secret }) {
  const router = express.Router();
  router.post('/webhook', (req, res) => {
    const b = req.body || {};
    if (secret && b.secret !== secret) return res.status(401).json({ error: 'bad or missing secret' });
    const symbol = String(b.symbol || b.ticker || '').toUpperCase();
    const stance = normAction(b.action || b.side || b.signal);
    if (!symbol || !stance) return res.status(400).json({ error: 'need symbol + action (buy/sell/exit)' });
    store.record({
      symbol: symbol, stance: stance, action: String(b.action || b.side || b.signal),
      price: Number(b.price) || null, strategy: String(b.strategy || b.alert || 'TradingView'),
      note: String(b.note || ''),
    });
    res.json({ ok: true, symbol: symbol, stance: stance });
  });
  router.get('/alerts/:symbol', (req, res) => res.json(store.latest(req.params.symbol) || {}));
  router.get('/alerts', (req, res) => res.json(store.feed()));
  return router;
}

module.exports = { createTvStore, createTvRouter, normAction, PendingQueue, PINE_DEFAULTS };
