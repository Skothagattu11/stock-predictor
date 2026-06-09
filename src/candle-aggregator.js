'use strict';

// Buckets incoming trade ticks into OHLCV candles for a fixed timeframe.
// Candle shape (per docs/CONTRACTS.md):
//   { time:<unix seconds>, open, high, low, close, volume }
// Bucket start = floor(tsSeconds / (tf*60)) * tf*60.

const MAX_CANDLES = 300;

class CandleAggregator {
  constructor(timeframeMinutes) {
    const tf = parseInt(timeframeMinutes, 10);
    this.timeframeMinutes = Number.isFinite(tf) && tf > 0 ? tf : 5;
    this.bucketSeconds = this.timeframeMinutes * 60;
    this.candles = [];
  }

  reset() {
    this.candles = [];
  }

  // Seed with pre-built candles (e.g. simulator output). Sorted + capped.
  seed(candles) {
    if (!Array.isArray(candles)) return;
    this.candles = candles
      .filter((c) => c && Number.isFinite(c.time))
      .slice()
      .sort((a, b) => a.time - b.time)
      .slice(-MAX_CANDLES);
  }

  _bucketStart(tsSeconds) {
    return Math.floor(tsSeconds / this.bucketSeconds) * this.bucketSeconds;
  }

  // addTrade({ price, volume, ts }) where ts is epoch MILLISECONDS.
  // Returns { candle, closed } where closed=true when this trade opened a
  // NEW bucket (i.e. the previous candle was finalized).
  addTrade({ price, volume, ts }) {
    const p = Number(price);
    const v = Number(volume) || 0;
    const tsSec = Math.floor(Number(ts) / 1000);
    if (!Number.isFinite(p) || !Number.isFinite(tsSec)) {
      const last = this.candles[this.candles.length - 1] || null;
      return { candle: last, closed: false };
    }

    const bucket = this._bucketStart(tsSec);
    const last = this.candles[this.candles.length - 1];

    if (!last || bucket > last.time) {
      // New bucket -> previous candle (if any) is now finalized.
      const candle = {
        time: bucket,
        open: p,
        high: p,
        low: p,
        close: p,
        volume: v,
      };
      this.candles.push(candle);
      if (this.candles.length > MAX_CANDLES) {
        this.candles = this.candles.slice(-MAX_CANDLES);
      }
      return { candle, closed: Boolean(last) };
    }

    if (bucket === last.time) {
      // Update the still-forming candle.
      last.high = Math.max(last.high, p);
      last.low = Math.min(last.low, p);
      last.close = p;
      last.volume += v;
      return { candle: last, closed: false };
    }

    // Out-of-order tick that belongs to an older bucket: fold into nearest
    // existing candle if present, otherwise ignore. Keeps process alive.
    const existing = this.candles.find((c) => c.time === bucket);
    if (existing) {
      existing.high = Math.max(existing.high, p);
      existing.low = Math.min(existing.low, p);
      existing.volume += v;
    }
    return { candle: existing || last, closed: false };
  }

  getCandles() {
    // Stored sorted on insert; defensively re-sort + cap.
    return this.candles
      .slice()
      .sort((a, b) => a.time - b.time)
      .slice(-MAX_CANDLES);
  }
}

module.exports = { CandleAggregator, MAX_CANDLES };
