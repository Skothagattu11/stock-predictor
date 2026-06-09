'use strict';

// Candle shape: { time, open, high, low, close, volume }

const EPS = 1e-9;

function body(c) { return Math.abs(c.close - c.open); }
function range(c) { return c.high - c.low; }
function upperWick(c) { return c.high - Math.max(c.open, c.close); }
function lowerWick(c) { return Math.min(c.open, c.close) - c.low; }
function isBull(c) { return c.close > c.open; }
function isBear(c) { return c.open > c.close; }

// range guarded against divide-by-zero
function safeRange(c) {
  const r = range(c);
  return r > EPS ? r : EPS;
}

function midBody(c) {
  return (c.open + c.close) / 2;
}

// Rough trend helpers using the candles preceding the focus candle.
function priorCloses(candles, beforeIndex, n) {
  const start = Math.max(0, beforeIndex - n);
  return candles.slice(start, beforeIndex).map((c) => c.close);
}

function isDownMove(candles) {
  // Compare close of the candle before the last few against earlier.
  const n = candles.length;
  if (n < 3) return false;
  const refIdx = n - 1; // last candle is the signal; look at what came before
  const before = priorCloses(candles, refIdx, 4);
  if (before.length < 2) return false;
  return before[before.length - 1] < before[0];
}

function isUpMove(candles) {
  const n = candles.length;
  if (n < 3) return false;
  const refIdx = n - 1;
  const before = priorCloses(candles, refIdx, 4);
  if (before.length < 2) return false;
  return before[before.length - 1] > before[0];
}

function approxEqual(a, b, scale) {
  const tol = Math.max(Math.abs(scale) * 0.0015, EPS) + Math.max(Math.abs(a), Math.abs(b)) * 0.0015;
  return Math.abs(a - b) <= tol;
}

function detectPatterns(candles) {
  const out = [];
  if (!Array.isArray(candles) || candles.length === 0) {
    return [fallback()];
  }

  const n = candles.length;
  const c = candles[n - 1];
  const p = candles[n - 2];
  const p2 = candles[n - 3];

  if (!c) return [fallback()];

  const b = body(c);
  const r = safeRange(c);
  const up = upperWick(c);
  const low = lowerWick(c);
  const bRatio = b / r;

  const downMove = isDownMove(candles);
  const upMove = isUpMove(candles);

  // --- Single-candle patterns ---

  // Doji
  if (bRatio < 0.12) {
    out.push(mk('Doji', 'Open and close are nearly equal. Market is undecided.', 'wait', 1));
  }

  // Marubozu (strong dominant body)
  if (bRatio > 0.82 && isBull(c)) {
    out.push(mk('Bullish marubozu', 'Strong buying pressure with little rejection.', 'buy', 2));
  }
  if (bRatio > 0.82 && isBear(c)) {
    out.push(mk('Bearish marubozu', 'Strong selling pressure with little recovery.', 'sell', 2));
  }

  // Hammer: long lower wick, small upper wick, bullish, ideally after a downmove
  if (low >= 2 * b && up <= b && isBull(c)) {
    if (downMove || !upMove) {
      out.push(mk('Hammer', 'Sellers pushed price down but buyers recovered strongly. Best near support.', 'buy', 2));
    }
  }

  // Hanging man: hammer shape (long lower wick) but bearish / after an up move
  if (low >= 2 * b && up <= b && (isBear(c) || upMove)) {
    if (upMove) {
      out.push(mk('Hanging man', 'Long lower wick after an advance warns buyers may be losing control.', 'sell', 2));
    }
  }

  // Inverted hammer: long upper wick, small lower wick, bullish, in a downmove
  if (up >= 2 * b && low <= b && isBull(c) && downMove) {
    out.push(mk('Inverted hammer', 'Buyers tested higher after a decline; potential bottoming attempt.', 'buy', 2));
  }

  // Shooting star: long upper wick, small lower wick, bearish
  if (up >= 2 * b && low <= b && isBear(c)) {
    out.push(mk('Shooting star', 'Upside was rejected. Warning of a top, best near resistance.', 'sell', 2));
  }

  // --- Two-candle patterns ---
  if (p) {
    const bp = body(p);

    // Bullish engulfing: bull c engulfs bear p body
    if (isBull(c) && isBear(p) && c.open <= p.close && c.close >= p.open && b > bp) {
      out.push(mk('Bullish engulfing', 'Buyers fully overtook the previous red candle.', 'buy', 3));
    }

    // Bearish engulfing: bear c engulfs bull p body
    if (isBear(c) && isBull(p) && c.open >= p.close && c.close <= p.open && b > bp) {
      out.push(mk('Bearish engulfing', 'Sellers fully overtook the previous green candle.', 'sell', 3));
    }

    // Bullish harami: small bull c inside large bear p body
    if (isBear(p) && isBull(c) && b < bp &&
        Math.max(c.open, c.close) <= Math.max(p.open, p.close) &&
        Math.min(c.open, c.close) >= Math.min(p.open, p.close)) {
      out.push(mk('Bullish harami', 'A small green candle held inside a large red body hints at fading selling.', 'buy', 2));
    }

    // Bearish harami: small bear c inside large bull p body
    if (isBull(p) && isBear(c) && b < bp &&
        Math.max(c.open, c.close) <= Math.max(p.open, p.close) &&
        Math.min(c.open, c.close) >= Math.min(p.open, p.close)) {
      out.push(mk('Bearish harami', 'A small red candle held inside a large green body hints at fading buying.', 'sell', 2));
    }

    // Piercing line: bear p, bull c opens below p.low/close & closes above midpoint of p body
    if (isBear(p) && isBull(c) && c.open < Math.min(p.low, p.close) &&
        c.close > midBody(p) && c.close < p.open) {
      out.push(mk('Piercing line', 'A gap-down open recovered above the prior midpoint; bullish reversal attempt.', 'buy', 2));
    }

    // Dark cloud cover: bull p, bear c opens above p.high/close & closes below midpoint of p body
    if (isBull(p) && isBear(c) && c.open > Math.max(p.high, p.close) &&
        c.close < midBody(p) && c.close > p.open) {
      out.push(mk('Dark cloud cover', 'A gap-up open faded below the prior midpoint; bearish reversal warning.', 'sell', 2));
    }

    // Tweezer bottom: two candles with ~equal lows after a down move
    if (approxEqual(c.low, p.low, c.close) && downMove) {
      out.push(mk('Tweezer bottom', 'Two candles bottomed at the same level, marking support.', 'buy', 2));
    }

    // Tweezer top: two candles with ~equal highs after an up move
    if (approxEqual(c.high, p.high, c.close) && upMove) {
      out.push(mk('Tweezer top', 'Two candles topped at the same level, marking resistance.', 'sell', 2));
    }
  }

  // --- Three-candle patterns ---
  if (p2 && p) {
    const rp = safeRange(p);

    // Morning star: bear p2, small-body p, bull c closing above midpoint of p2 body
    if (isBear(p2) && body(p) < rp * 0.4 && isBull(c) && c.close > midBody(p2)) {
      out.push(mk('Morning star', 'Downtrend may be reversing after seller exhaustion.', 'buy', 3));
    }

    // Evening star: bull p2, small-body p, bear c closing below midpoint of p2 body
    if (isBull(p2) && body(p) < rp * 0.4 && isBear(c) && c.close < midBody(p2)) {
      out.push(mk('Evening star', 'Uptrend may be reversing after buyer exhaustion.', 'sell', 3));
    }

    // Three white soldiers: 3 consecutive rising bull candles
    if (isBull(p2) && isBull(p) && isBull(c) &&
        c.close > p.close && p.close > p2.close &&
        c.open > p2.open && p.open > p2.open) {
      out.push(mk('Three white soldiers', 'Three strong rising green candles confirm building momentum.', 'buy', 3));
    }

    // Three black crows: 3 consecutive falling bear candles
    if (isBear(p2) && isBear(p) && isBear(c) &&
        c.close < p.close && p.close < p2.close &&
        c.open < p2.open && p.open < p2.open) {
      out.push(mk('Three black crows', 'Three strong falling red candles confirm building downside.', 'sell', 3));
    }
  }

  if (out.length === 0) {
    return [fallback()];
  }
  return out;
}

function mk(name, meaning, signal, strength) {
  return { name, meaning, signal, strength };
}

function fallback() {
  return mk(
    'No strong pattern',
    'Current candle does not show a clean high-probability structure.',
    'wait',
    1
  );
}

module.exports = {
  detectPatterns,
  body,
  range,
  upperWick,
  lowerWick,
  isBull,
  isBear,
};
