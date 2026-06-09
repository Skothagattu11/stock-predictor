'use strict';

// Signal-scoring layer.
//
// score({ candles, indicators, patterns }) -> {
//   score, confidence, signal, signalLabel, reasons, levels
// }
//
// `indicators` is the precomputed snapshot:
//   { rsi, ema9, ema20, ema50, macd:{macd,signal,hist},
//     bb:{upper,mid,lower}, atr, vwap, volRatio }
//
// Scoring philosophy (extends the reference dashboard's analyze()):
//   - start at a neutral 50, clamp to 0..100
//   - each factor nudges the score and appends a plain-English reason
//   - reasons are ordered most-important-first and capped at ~6
//   - levels are ATR-based with swing fallbacks, robust to NaN ATR

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

const SIGNAL_LABELS = {
  BUY: 'BUY WATCH',
  SELL: 'SELL / AVOID',
  WAIT: 'WAIT',
};

function score(input) {
  const { candles, indicators, patterns } = input || {};
  const ind = indicators || {};
  const pats = Array.isArray(patterns) ? patterns : [];
  const cs = Array.isArray(candles) ? candles : [];

  const last = cs.length ? cs[cs.length - 1] : null;
  const prev = cs.length >= 2 ? cs[cs.length - 2] : null;

  let s = 50;
  // reasons collected with a weight so we can keep the most important first.
  const reasons = [];
  const add = (weight, text) => reasons.push({ weight: Math.abs(weight), text });

  // --- Pattern signals ---------------------------------------------------
  // Buy patterns push up (+18 * strength-weight), sell patterns push down
  // (-22 scaled by strength). strength is 1|2|3 -> weight 1/3, 2/3, 1.
  let netPattern = 0; // >0 net-bullish, <0 net-bearish from patterns
  let topBuy = null;
  let topSell = null;
  for (const p of pats) {
    if (!p || (p.signal !== 'buy' && p.signal !== 'sell')) continue;
    const strength = clamp(Number(p.strength) || 1, 1, 3);
    const w = strength / 3;
    if (p.signal === 'buy') {
      netPattern += strength;
      if (!topBuy || strength > topBuy.strength) topBuy = p;
    } else {
      netPattern -= strength;
      if (!topSell || strength > topSell.strength) topSell = p;
    }
  }
  if (topBuy) {
    const w = clamp(Number(topBuy.strength) || 1, 1, 3) / 3;
    s += 18 * w;
    add(18 * w, `Bullish pattern (${topBuy.name}) detected.`);
  }
  if (topSell) {
    const w = clamp(Number(topSell.strength) || 1, 1, 3) / 3;
    s -= 22 * w;
    add(22 * w, `Bearish pattern (${topSell.name}) detected.`);
  }

  // --- EMA trend ---------------------------------------------------------
  const { ema9, ema20, ema50 } = ind;
  if (isNum(ema9) && isNum(ema20)) {
    if (ema9 > ema20) {
      const strong = isNum(ema50) && ema9 > ema50;
      s += 12;
      add(12, strong
        ? 'EMA 9 above EMA 20 and EMA 50 — clear short-term uptrend.'
        : 'EMA 9 is above EMA 20, showing short-term upward trend.');
    } else if (ema9 < ema20) {
      s -= 12;
      add(12, 'EMA 9 is below EMA 20, showing short-term weakness.');
    }
  }

  // --- MACD histogram ----------------------------------------------------
  const macd = ind.macd || {};
  if (isNum(macd.hist)) {
    if (macd.hist > 0) {
      s += 8;
      add(8, 'MACD histogram is positive, momentum leans bullish.');
    } else if (macd.hist < 0) {
      s -= 8;
      add(8, 'MACD histogram is negative, momentum leans bearish.');
    }
  }

  // --- RSI ---------------------------------------------------------------
  const rsi = ind.rsi;
  if (isNum(rsi)) {
    if (rsi < 35) {
      s += 12;
      add(12, 'RSI is near oversold territory; bounce probability improves.');
    } else if (rsi > 70) {
      s -= 15;
      add(15, 'RSI is overbought; chase risk is elevated.');
    } else {
      add(1, 'RSI is in a neutral/tradable range.');
    }
  }

  // --- Bollinger position (mean-reversion) -------------------------------
  const bb = ind.bb || {};
  if (last && isNum(last.close) && isNum(bb.lower) && isNum(bb.upper)) {
    if (last.close < bb.lower) {
      s += 6;
      add(6, 'Price is below the lower Bollinger band; mean-reversion bounce possible.');
    } else if (last.close > bb.upper) {
      s -= 6;
      add(6, 'Price is above the upper Bollinger band; stretched to the upside.');
    }
  }

  // --- Volume conviction -------------------------------------------------
  // volRatio amplifies the prevailing bias. Net context = sign of score so far
  // relative to neutral 50, combined with pattern bias.
  const volRatio = ind.volRatio;
  if (isNum(volRatio) && volRatio > 1.5) {
    const bullishContext = (s >= 50 && netPattern >= 0) || netPattern > 0;
    if (bullishContext) {
      s += 10;
      add(10, 'Volume is well above average, adding conviction to the bullish case.');
    } else {
      s -= 8;
      add(8, 'Volume is well above average while the setup looks weak — distribution risk.');
    }
  } else if (isNum(volRatio)) {
    add(1, 'Volume is not strong enough for high conviction.');
  }

  // --- Breakout / breakdown vs previous candle ---------------------------
  if (last && prev && isNum(last.close) && isNum(prev.high) && isNum(prev.low)) {
    if (last.close > prev.high) {
      s += 8;
      add(8, 'Latest close broke above the previous candle high.');
    }
    if (last.close < prev.low) {
      s -= 8;
      add(8, 'Latest close broke below the previous candle low.');
    }
  }

  // --- Finalize score / signal ------------------------------------------
  const finalScore = clamp(Math.round(s), 0, 100);

  let signal = 'WAIT';
  if (finalScore >= 68) signal = 'BUY';
  else if (finalScore <= 38) signal = 'SELL';
  const signalLabel = SIGNAL_LABELS[signal];

  const confidence = clamp(Math.round(Math.abs(finalScore - 50) * 2), 0, 100);

  // Most important reasons first, capped at 6.
  const orderedReasons = reasons
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map((r) => r.text);

  const levels = computeLevels(cs, ind.atr);

  return {
    score: finalScore,
    confidence,
    signal,
    signalLabel,
    reasons: orderedReasons,
    levels,
  };
}

// ATR-based levels with robust swing fallbacks.
//   buyTrigger = max(last.high, prev.high)
//   stopLoss   = min(swingLow(~10), last.close - 1.5*ATR)
//   sellTarget = max(swingHigh(~18), last.close + 2*ATR)
// If ATR is NaN/unavailable, fall back to swing levels only.
function computeLevels(candles, atr) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { buyTrigger: NaN, stopLoss: NaN, sellTarget: NaN };
  }

  const last = candles[candles.length - 1];
  const prev = candles.length >= 2 ? candles[candles.length - 2] : last;

  const lows10 = candles.slice(-10).map((c) => c.low).filter(isNum);
  const highs18 = candles.slice(-18).map((c) => c.high).filter(isNum);

  const swingLow = lows10.length ? Math.min(...lows10) : last.low;
  const swingHigh = highs18.length ? Math.max(...highs18) : last.high;

  const buyTrigger = Math.max(
    isNum(last.high) ? last.high : -Infinity,
    isNum(prev.high) ? prev.high : -Infinity
  );

  let stopLoss;
  let sellTarget;
  if (isNum(atr) && isNum(last.close)) {
    stopLoss = Math.min(swingLow, last.close - 1.5 * atr);
    sellTarget = Math.max(swingHigh, last.close + 2 * atr);
  } else {
    // ATR unavailable -> swing levels only.
    stopLoss = swingLow;
    sellTarget = swingHigh;
  }

  return {
    buyTrigger: round2(buyTrigger),
    stopLoss: round2(stopLoss),
    sellTarget: round2(sellTarget),
  };
}

module.exports = { score };
