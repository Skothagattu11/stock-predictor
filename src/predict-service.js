'use strict';

// TTL per mode (ms). Modes not listed are uncached pass-throughs.
const TTL = {
  intraday: 120 * 1000,            // 2 min (market hours)
  outlook: 6 * 60 * 60 * 1000,     // 6 h
  macro: 60 * 60 * 1000,           // 1 h
  fundamentals: 12 * 60 * 60 * 1000, // 12 h
  impliedMove: 5 * 60 * 1000,      // 5 min
  setups: 60 * 1000,               // 1 min
  discover: 10 * 60 * 1000,        // 10 min
  statistical: 120 * 1000,          // 2 min
  calibrationStats: 60 * 1000,      // 1 min
  opportunities: 60 * 1000,          // 1 min (market hours)
};

function createPredictService({ sidecar, cache }) {
  const cached = (mode, key, loader) => cache.getOrLoad(`${mode}:${key}`, TTL[mode], loader);
  return {
    intraday: (s) => cached('intraday', s, () => sidecar.intraday(s)),
    outlook: (s) => cached('outlook', s, () => sidecar.outlook(s)),
    macro: () => cached('macro', 'ALL', () => sidecar.macro()),
    fundamentals: (s) => cached('fundamentals', s, () => sidecar.fundamentals(s)),
    impliedMove: (s) => cached('impliedMove', s, () => sidecar.impliedMove(s)),
    position: (symbol, params) => sidecar.position({ symbol, ...params }),  // uncached
    portfolio: (holdings) => sidecar.portfolio(holdings),                   // uncached
    setups: (s, interval) => cached('setups', `${s}:${interval || '1m'}`, () => sidecar.setups(s, interval)),
    discover: () => cached('discover', 'ALL', () => sidecar.discover()),
    statistical: (s, mode) => cached('statistical', `${s}:${mode}`, () => sidecar.statistical(s, mode)),
    calibrationStats: () => cached('calibrationStats', 'ALL', () => sidecar.calibrationStats()),
    opportunities: (budget, target, risk) =>
      cached('opportunities', `${budget}:${target}:${risk || 'balanced'}`,
        () => sidecar.opportunities(budget, target, risk)),
  };
}

module.exports = { createPredictService, TTL };
