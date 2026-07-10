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

  // Non-loading lookup of the entry's freshness: 'fresh' | 'stale' | 'miss'.
  // Mirrors getOrLoad's branches so callers can label a served value hit/miss
  // without racing the background revalidation.
  peek(key) {
    const now = this._now();
    const entry = this._store.get(key);
    if (!entry) return 'miss';
    if (entry.expiresAt > now) return 'fresh';
    if (entry.expiresAt + this._staleTtl > now) return 'stale';
    return 'miss';
  }

  // Total stored entries (for observability). Includes not-yet-evicted stale entries.
  size() { return this._store.size; }

  // Count entries whose key starts with `prefix` (e.g. 'fmp:', 'analyst:').
  sizeByPrefix(prefix) {
    let n = 0;
    for (const k of this._store.keys()) if (k.startsWith(prefix)) n++;
    return n;
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
