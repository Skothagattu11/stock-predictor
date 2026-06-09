'use strict';

// Upstream WebSocket client for Finnhub real-time trades.
// Emits: 'trade' {symbol, price, volume, ts(ms)}, 'open', 'close', 'error'.
// Reconnects with exponential backoff (cap ~30s). If no API key, never connects.

const EventEmitter = require('events');
const WebSocket = require('ws');

const URL_BASE = 'wss://ws.finnhub.io';
const MAX_BACKOFF_MS = 30000;
const BASE_BACKOFF_MS = 1000;

class FinnhubClient extends EventEmitter {
  constructor(apiKey) {
    super();
    this.apiKey = (apiKey || '').trim();
    this.ws = null;
    this.connected = false;
    this.shouldRun = false;
    this.backoff = BASE_BACKOFF_MS;
    this.reconnectTimer = null;
    // symbol -> active (we manage de-dupe; server handles ref counting)
    this.subscriptions = new Set();
  }

  hasKey() {
    return Boolean(this.apiKey);
  }

  connect() {
    if (!this.apiKey) return; // no key => simulator handles everything
    this.shouldRun = true;
    if (this.ws && (this.connected || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this._open();
  }

  _open() {
    try {
      this.ws = new WebSocket(`${URL_BASE}?token=${encodeURIComponent(this.apiKey)}`);
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.connected = true;
      this.backoff = BASE_BACKOFF_MS;
      this.emit('open');
      // Re-subscribe everything after a (re)connect.
      for (const symbol of this.subscriptions) {
        this._send({ type: 'subscribe', symbol });
      }
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        this.emit('error', err);
        return;
      }
      try {
        this._handleMessage(msg);
      } catch (err) {
        this.emit('error', err);
      }
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.emit('close');
      if (this.shouldRun) this._scheduleReconnect();
    });
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'trade' && Array.isArray(msg.data)) {
      for (const t of msg.data) {
        if (!t) continue;
        this.emit('trade', {
          symbol: t.s,
          price: Number(t.p),
          volume: Number(t.v) || 0,
          ts: Number(t.t), // milliseconds
        });
      }
    } else if (msg.type === 'error') {
      this.emit('error', new Error(msg.msg || 'Finnhub error'));
    }
    // 'ping' and others are ignored.
  }

  _send(obj) {
    if (this.ws && this.connected && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
        return true;
      } catch (err) {
        this.emit('error', err);
      }
    }
    return false;
  }

  _scheduleReconnect() {
    if (!this.shouldRun || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldRun) this._open();
    }, delay);
  }

  subscribe(symbol) {
    if (!symbol || !this.apiKey) return;
    if (!this.subscriptions.has(symbol)) {
      this.subscriptions.add(symbol);
      this._send({ type: 'subscribe', symbol });
    }
    // Ensure connection exists.
    if (!this.connected) this.connect();
  }

  unsubscribe(symbol) {
    if (!symbol || !this.apiKey) return;
    if (this.subscriptions.has(symbol)) {
      this.subscriptions.delete(symbol);
      this._send({ type: 'unsubscribe', symbol });
    }
  }

  close() {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {
        /* ignore */
      }
    }
    this.connected = false;
  }
}

module.exports = { FinnhubClient };
