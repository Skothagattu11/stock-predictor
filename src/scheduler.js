'use strict';

// Background pre-warm of the watchlist. Quant-only — calls the sidecar (no LLM),
// populating the cache so user views are instant and trend history accumulates.
function createScheduler({ service, symbols = [], intervalMs = 120 * 1000, log = () => {} }) {
  let timer = null;

  async function refreshOnce() {
    for (const s of symbols) {
      try {
        await Promise.all([service.intraday(s), service.outlook(s)]);
      } catch (e) {
        log(`scheduler: ${s} refresh failed: ${e.message}`);
      }
    }
  }

  function start() {
    if (timer || symbols.length === 0) return;
    timer = setInterval(() => { refreshOnce().catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { refreshOnce, start, stop };
}

module.exports = { createScheduler };
