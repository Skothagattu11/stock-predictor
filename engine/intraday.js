'use strict';

// Intraday (day-trading) confluence scorer.
// Combines the indicators day traders actually rely on — session VWAP, Supertrend,
// Opening-Range Breakout, EMA 9/20, RSI, MACD, relative volume, and candle
// patterns — into one short-term BUY / SELL / WAIT call with a named setup and
// tight ATR-based stop/target for quick in-and-out trades.
//
// Confluence (never a single indicator alone) is the documented best practice:
//   VWAP + Supertrend + ORB + RSI/EMA/volume confirmation.

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);

/**
 * scoreIntraday({ candles, indicators, patterns, vwap, supertrend, orb })
 *  -> { score, confidence, signal, signalLabel, setup, reasons, levels }
 */
function scoreIntraday(ctx) {
  const cs = ctx.candles;
  const ind = ctx.indicators || {};
  const patterns = ctx.patterns || [];
  const vwap = ctx.vwap;
  const st = ctx.supertrend || {};
  const orb = ctx.orb || {};

  const last = cs[cs.length - 1];
  const price = last.close;
  const atr = Number.isFinite(ind.atr) && ind.atr > 0 ? ind.atr : Math.max(last.high - last.low, price * 0.005);

  let score = 50;
  const reasons = [];
  const drivers = [];
  let bull = 0;
  let bear = 0;

  // 1) Session VWAP position — the intraday backbone.
  if (Number.isFinite(vwap)) {
    if (price > vwap) {
      score += 14; bull++;
      reasons.push('Price is above session VWAP ($' + vwap.toFixed(2) + ') — intraday bias is bullish.');
      drivers.push({ k: 'vwap', dir: 1 });
    } else {
      score -= 14; bear++;
      reasons.push('Price is below session VWAP ($' + vwap.toFixed(2) + ') — intraday bias is bearish.');
      drivers.push({ k: 'vwap', dir: -1 });
    }
  }

  // 2) Supertrend (ATR trend filter); a fresh flip is a strong trigger.
  if (st && st.trend) {
    if (st.trend === 'up') {
      score += 14; bull++;
      if (st.flipped) { score += 6; reasons.push('Supertrend just flipped UP — fresh long trigger.'); }
      else reasons.push('Supertrend is up — trend-following long bias.');
      drivers.push({ k: 'supertrend', dir: 1, flip: st.flipped });
    } else {
      score -= 14; bear++;
      if (st.flipped) { score -= 6; reasons.push('Supertrend just flipped DOWN — fresh short trigger.'); }
      else reasons.push('Supertrend is down — trend-following short bias.');
      drivers.push({ k: 'supertrend', dir: -1, flip: st.flipped });
    }
  }

  // 3) Opening-Range Breakout.
  if (Number.isFinite(orb.high) && Number.isFinite(orb.low)) {
    if (price > orb.high) {
      score += 12; bull++;
      reasons.push('Broke above the opening-range high ($' + orb.high.toFixed(2) + ') — momentum breakout.');
      drivers.push({ k: 'orb', dir: 1 });
    } else if (price < orb.low) {
      score -= 12; bear++;
      reasons.push('Broke below the opening-range low ($' + orb.low.toFixed(2) + ') — momentum breakdown.');
      drivers.push({ k: 'orb', dir: -1 });
    }
  }

  // 4) EMA 9/20 short-term trend.
  if (Number.isFinite(ind.ema9) && Number.isFinite(ind.ema20)) {
    if (ind.ema9 > ind.ema20) { score += 8; bull++; reasons.push('EMA 9 above EMA 20 — short-term uptrend.'); }
    else if (ind.ema9 < ind.ema20) { score -= 8; bear++; reasons.push('EMA 9 below EMA 20 — short-term downtrend.'); }
  }

  // 5) RSI — momentum band vs mean-reversion extremes (intraday-tuned).
  if (Number.isFinite(ind.rsi)) {
    if (ind.rsi >= 55 && ind.rsi <= 72) { score += 6; reasons.push('RSI ' + ind.rsi.toFixed(0) + ' supports momentum longs.'); }
    else if (ind.rsi > 72) { score -= 8; reasons.push('RSI ' + ind.rsi.toFixed(0) + ' overbought — chase risk / pullback likely.'); }
    else if (ind.rsi < 28) { score += 6; reasons.push('RSI ' + ind.rsi.toFixed(0) + ' oversold — bounce / mean-reversion setup.'); }
    else if (ind.rsi < 45) { score -= 4; }
  }

  // 6) MACD histogram momentum.
  if (ind.macd && Number.isFinite(ind.macd.hist)) {
    if (ind.macd.hist > 0) score += 6;
    else if (ind.macd.hist < 0) score -= 6;
  }

  // 7) Relative volume — intraday moves need participation.
  if (Number.isFinite(ind.volRatio)) {
    if (ind.volRatio >= 1.3) {
      const netBull = bull >= bear;
      score += netBull ? 8 : -6;
      reasons.push('Relative volume ' + ind.volRatio.toFixed(2) + 'x average — the move has participation.');
    } else {
      reasons.push('Volume is light (' + ind.volRatio.toFixed(2) + 'x) — lower conviction for a breakout.');
    }
  }

  // 8) Candle pattern confirmation.
  const buyPat = patterns.find((p) => p.signal === 'buy');
  const sellPat = patterns.find((p) => p.signal === 'sell');
  if (buyPat) { score += 6; reasons.push('Bullish candle: ' + buyPat.name + '.'); }
  if (sellPat) { score -= 6; reasons.push('Bearish candle: ' + sellPat.name + '.'); }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Intraday thresholds are a touch tighter so it acts faster than the swing model.
  let signal = 'WAIT';
  let signalLabel = 'WAIT';
  if (score >= 64) { signal = 'BUY'; signalLabel = 'BUY / LONG'; }
  else if (score <= 36) { signal = 'SELL'; signalLabel = 'SELL / SHORT'; }

  const confidence = Math.max(0, Math.min(100, Math.round(Math.abs(score - 50) * 2)));
  const setup = nameSetup(drivers, signal, ind);

  // Tight ATR-based levels for quick intraday trades.
  const dir = signal === 'SELL' ? -1 : 1;
  const prevHigh = cs.length > 1 ? cs[cs.length - 2].high : last.high;
  const buyTrigger = Number.isFinite(orb.high) ? Math.max(orb.high, last.high) : Math.max(last.high, prevHigh);
  const levels = {
    buyTrigger: round2(buyTrigger),
    stopLoss: round2(dir > 0 ? price - 1.0 * atr : price + 1.0 * atr),
    sellTarget: round2(dir > 0 ? price + 1.8 * atr : price - 1.8 * atr),
  };

  return { score, confidence, signal, signalLabel, setup, reasons: reasons.slice(0, 7), levels };
}

function nameSetup(drivers, signal, ind) {
  if (signal === 'WAIT') return 'No clean setup — wait for confluence';
  const long = signal === 'BUY';
  const want = long ? 1 : -1; // only name drivers that AGREE with the call
  const has = (k, extra) => drivers.find((d) => d.k === k && d.dir === want && (!extra || extra(d)));
  if (has('supertrend', (d) => d.flip)) return long ? 'Supertrend flip — long' : 'Supertrend flip — short';
  if (has('orb')) return long ? 'Opening-range breakout — long' : 'Opening-range breakdown — short';
  if (Number.isFinite(ind.rsi) && ind.rsi < 30 && long) return 'Oversold bounce — long';
  if (Number.isFinite(ind.rsi) && ind.rsi > 70 && !long) return 'Overbought fade — short';
  if (has('vwap')) return long ? 'Above-VWAP momentum — long' : 'Below-VWAP momentum — short';
  if (has('supertrend')) return long ? 'Supertrend trend — long' : 'Supertrend trend — short';
  return long ? 'Momentum — long' : 'Momentum — short';
}

module.exports = { scoreIntraday };
