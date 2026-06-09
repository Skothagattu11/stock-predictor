'use strict';

// Single source of truth for Server -> Client WebSocket message shapes.
// See docs/CONTRACTS.md ("Browser <-> Server WebSocket protocol").

// Server -> Client message types
const S2C = Object.freeze({
  SNAPSHOT: 'snapshot',
  CANDLE: 'candle',
  ANALYSIS: 'analysis',
  STATUS: 'status',
  ERROR: 'error',
});

// Client -> Server message types (for reference / validation)
const C2S = Object.freeze({
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  SET_TIMEFRAME: 'setTimeframe',
  SIMULATE: 'simulate',
});

// Mode values
const MODE = Object.freeze({
  LIVE: 'live',
  SIMULATED: 'simulated',
  CLOSED: 'closed',
});

// ---- Builders (return plain objects; caller stringifies) -----------------

function snapshot({ symbol, timeframe, candles, analysis, mode, marketOpen }) {
  return {
    type: S2C.SNAPSHOT,
    symbol,
    timeframe,
    candles: candles || [],
    analysis: analysis || null,
    mode,
    marketOpen: Boolean(marketOpen),
  };
}

function candle(candleObj, closed) {
  return {
    type: S2C.CANDLE,
    candle: candleObj,
    closed: Boolean(closed),
  };
}

function analysis(analysisObj) {
  return {
    type: S2C.ANALYSIS,
    analysis: analysisObj || null,
  };
}

function status({ connected, marketOpen, mode, message }) {
  return {
    type: S2C.STATUS,
    connected: Boolean(connected),
    marketOpen: Boolean(marketOpen),
    mode,
    message: message || '',
  };
}

function error(message) {
  return {
    type: S2C.ERROR,
    message: String(message || 'Unknown error'),
  };
}

module.exports = {
  S2C,
  C2S,
  MODE,
  snapshot,
  candle,
  analysis,
  status,
  error,
};
