'use strict';
// Structured logger + in-memory metrics ring buffer for the AI Equity Analyst.
// One NDJSON line per request/error to logPath (when set), plus ring buffers that
// back GET /api/analyst/metrics. Pass logPath: null to disable file I/O (unit tests).
const fs = require('node:fs');
const path = require('node:path');

function createObservability({ logPath = 'logs/analyst.log' } = {}) {
  if (logPath) {
    const dir = path.dirname(logPath);
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* best effort */ }
  }

  const requests = []; // ring buffer, newest first, max 50
  const errors = [];   // ring buffer, newest first, max 10
  let totalRequests = 0;
  let totalCacheHits = 0;
  let totalMs = 0;
  let fmpCallsToday = 0;
  let lastDay = new Date().toDateString();

  function resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (today !== lastDay) { fmpCallsToday = 0; lastDay = today; }
  }

  function append(line) {
    if (!logPath) return;
    try { fs.appendFileSync(logPath, JSON.stringify(line) + '\n'); } catch (_) { /* never let logging break a request */ }
  }

  function log(entry) {
    resetDailyIfNeeded();
    const line = { ts: new Date().toISOString(), ...entry };
    append(line);
    requests.unshift(line);
    if (requests.length > 50) requests.pop();
    totalRequests++;
    if (entry.cacheHit) totalCacheHits++;
    if (entry.totalMs) totalMs += entry.totalMs;
    if (entry.fmpCalls) fmpCallsToday += entry.fmpCalls;
  }

  function logError(entry) {
    const line = { ts: new Date().toISOString(), ...entry };
    append(line);
    errors.unshift(line);
    if (errors.length > 10) errors.pop();
  }

  function getMetrics() {
    return {
      requests: requests.slice(0, 20),
      errors: errors.slice(0, 10),
      summary: {
        totalRequests,
        cacheHitRate: totalRequests > 0 ? +(totalCacheHits / totalRequests).toFixed(2) : 0,
        avgTotalMs: totalRequests > 0 ? Math.round(totalMs / totalRequests) : 0,
        fmpCallsToday,
      },
    };
  }

  return { log, logError, getMetrics };
}

module.exports = { createObservability };
