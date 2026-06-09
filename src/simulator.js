'use strict';

// Simulated candle generator, adapted from the reference
// mrvl_candle_signal_dashboard.html `generateCandles`. Produces candles in the
// canonical shape (docs/CONTRACTS.md) ending near Date.now(). Used off-hours
// and when no API key is present. Math.random is acceptable here.

function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

// generateCandles(timeframeMinutes, count=120, basePrice=200) -> candle[]
// Deterministic-ish (seeded by index + timeframe) so the chart is reproducible
// for a given timeframe. The last candle's time is the current bucket start.
function generateCandles(timeframeMinutes = 5, count = 120, basePrice = 200) {
  const tf = Number(timeframeMinutes) > 0 ? Number(timeframeMinutes) : 5;
  const n = Number(count) > 0 ? Math.floor(Number(count)) : 120;
  const bucket = tf * 60;
  const out = [];
  let price = Number(basePrice) > 0 ? Number(basePrice) : 200;

  const nowSec = Math.floor(Date.now() / 1000);
  const lastBucket = Math.floor(nowSec / bucket) * bucket;
  const start = lastBucket - (n - 1) * bucket;

  for (let i = 0; i < n; i++) {
    // Phase-based drift to create realistic-looking trends/reversals.
    const phase = i / n;
    const drift =
      phase < 0.25 ? 0.12 : phase < 0.55 ? -0.33 : phase < 0.78 ? -0.08 : 0.22;
    const noise = (seededRandom(i * 13 + tf) - 0.5) * (basePrice * 0.016 + 1);

    const open = price;
    let close = Math.max(1, open + drift + noise);
    let high = Math.max(open, close) + (seededRandom(i * 7 + 3) * (basePrice * 0.014 + 0.5) + 0.35);
    let low = Math.min(open, close) - (seededRandom(i * 11 + 5) * (basePrice * 0.014 + 0.5) + 0.35);
    let volume = Math.round(650000 + seededRandom(i * 17 + 8) * 2100000);

    // Inject a couple of strong-signal candles for pattern interest.
    const big = Math.floor(n * 0.69);
    if (i === big) {
      close = open - basePrice * 0.018;
      low = close - basePrice * 0.043;
      high = open + basePrice * 0.006;
      volume = Math.round(volume * 2.2);
    }
    if (i === big + 1) {
      close = open + basePrice * 0.029;
      high = close + basePrice * 0.012;
      low = open - basePrice * 0.006;
      volume = Math.round(volume * 2.5);
    }

    low = Math.max(0.5, low);
    price = close;
    out.push({
      time: start + i * bucket,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume,
    });
  }
  return out;
}

// nextSimCandle(prevCandles, tf) -> one plausible next candle following the
// last candle in prevCandles. Uses Math.random for live-ish streaming jitter.
function nextSimCandle(prevCandles, tf = 5) {
  const bucket = (Number(tf) > 0 ? Number(tf) : 5) * 60;
  const cs = Array.isArray(prevCandles) ? prevCandles : [];
  const last = cs[cs.length - 1];

  const nowSec = Math.floor(Date.now() / 1000);
  let time;
  let open;
  let basePrice;
  if (last) {
    time = Math.max(last.time + bucket, Math.floor(nowSec / bucket) * bucket);
    open = last.close;
    basePrice = last.close;
  } else {
    time = Math.floor(nowSec / bucket) * bucket;
    open = 200;
    basePrice = 200;
  }

  const vol = basePrice * 0.012 + 0.5;
  const change = (Math.random() - 0.48) * vol * 2;
  const close = Math.max(1, open + change);
  const high = Math.max(open, close) + Math.random() * vol;
  const low = Math.max(0.5, Math.min(open, close) - Math.random() * vol);
  const volume = Math.round(650000 + Math.random() * 2100000);

  return {
    time,
    open: +open.toFixed(2),
    high: +high.toFixed(2),
    low: +low.toFixed(2),
    close: +close.toFixed(2),
    volume,
  };
}

module.exports = { generateCandles, nextSimCandle, seededRandom };
