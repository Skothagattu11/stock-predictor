'use strict';

class TtlCache {
  constructor({ now = Date.now, staleTtlMs = 5 * 60 * 1000 } = {}) {
    this._store = new Map();      // key -> { value, expiresAt }
    this._inflight = new Map();   // key -> Promise
    this._now = now;
    this._staleTtl = staleTtlMs;
  }

  set(key, value, ttlMs) {
    this._store.set(key, { value, expiresAt: this._now() + ttlMs });
  }

  getOrLoad(key, ttlMs, loader) {
    const now = this._now();
    const entry = this._store.get(key);
    if (entry && entry.expiresAt > now) return Promise.resolve(entry.value);          // fresh
    if (entry && entry.expiresAt + this._staleTtl > now) {                            // stale
      this._revalidate(key, ttlMs, loader);
      return Promise.resolve(entry.value);
    }
    return this._load(key, ttlMs, loader);                                            // miss/expired
  }

  _load(key, ttlMs, loader) {
    if (this._inflight.has(key)) return this._inflight.get(key);
    const p = Promise.resolve().then(loader)
      .then((value) => { this.set(key, value, ttlMs); return value; })
      .finally(() => this._inflight.delete(key));
    this._inflight.set(key, p);
    return p;
  }

  _revalidate(key, ttlMs, loader) {
    if (this._inflight.has(key)) return;
    this._load(key, ttlMs, loader).catch(() => {});   // background; keep stale on failure
  }
}

module.exports = { TtlCache };
