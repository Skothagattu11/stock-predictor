'use strict';
// Express router for the AI Equity Analyst: POST /report, GET /health, GET /metrics.
//
// Dependency-injected (svc, obs, probes) so it is unit-testable offline with a stub
// service and stub probes — and so it does NOT hard-require ./fmp-client, which is
// still pending the FMP key. server.js constructs the real service and wires it in.

const express = require('express');

const TICKER_RE = /^[A-Z0-9.]{1,10}$/;

function validateTicker(t) {
  if (!t || typeof t !== 'string') return 'ticker is required';
  if (!TICKER_RE.test(t.trim().toUpperCase())) return 'ticker must be 1–10 alphanumeric characters';
  return null;
}

// Remove the non-public _diag field before sending a report to the client.
function stripDiag(result) {
  if (!result || typeof result !== 'object') return result;
  const { _diag, ...body } = result;
  return body;
}

// Real FMP calls this request made: 0 on a report-cache hit; else the service's
// measured count (fundamentals sub-cache aware), falling back to the wiring constant.
function fmpCallsOf(result, fallback) {
  if (!result || result.cacheHit) return 0;
  return result._diag && typeof result._diag.fmpCalls === 'number' ? result._diag.fmpCalls : fallback;
}

// Map a thrown pipeline error to an HTTP status + body (spec UC-5).
function errorResponse(e) {
  // Match rate-limit phrases specifically — NOT the bare substring "rate", which
  // also appears in words like "moderated"/"inaccurate"/"separate".
  const rate = (e && e.status === 429) || /rate[\s-]?limit|429|too many requests/i.test((e && e.message) || '');
  if (e && e.status === 400) return { status: 400, body: { error: e.message } };
  return { status: 503, body: { error: 'Report unavailable', detail: e && e.message, retryAfter: rate ? 60 : 30 } };
}

function createAnalystRouter({ svc, obs, config = {}, probes, healthTtlMs = 30 * 1000, fmpCallsPerReport = 0, cache = null, llmModel = '', now = () => Date.now() } = {}) {
  if (!svc || !obs) throw new Error('createAnalystRouter requires { svc, obs }');

  const startedAt = now();
  const hasLlm = !!(config.ANTHROPIC_API_KEY || config.OPENAI_API_KEY || config.GEMINI_API_KEY);
  const P = probes || {
    // Report FMP configuration WITHOUT a live API call: the free tier is 250/day and
    // admin.html polls /health every 30s, so a live probe per poll would exhaust the
    // quota reports depend on. Real FMP failures still surface via /report (503) and
    // the error ring buffer in /metrics.
    fmp: async () => (config.FMP_API_KEY
      ? { ok: true }
      : { ok: false, reason: 'FMP_API_KEY not configured' }),
    yahoo: async () => fetch('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => ({ ok: r.ok })).catch(() => ({ ok: false })),
    llm: async () => ({ ok: hasLlm }),
  };

  let healthCache = null; // { at, payload }

  const router = express.Router();

  // POST /api/analyst/report
  router.post('/report', async (req, res) => {
    const t0 = now();
    try {
      const body = req.body || {};
      const mode = body.mode === 'comparison' ? 'comparison' : 'single';
      const depth = body.depth === 'deep' ? 'deep' : 'standard';
      const fresh = req.query.fresh === '1';

      if (mode === 'comparison') {
        const tickers = Array.isArray(body.tickers) ? body.tickers : [];
        if (tickers.length < 2) return res.status(400).json({ error: 'comparison mode requires at least 2 tickers' });
        const bad = tickers.map(validateTicker).find(Boolean);
        if (bad) return res.status(400).json({ error: bad });
        const result = await svc.comparison(tickers.map((t) => t.trim().toUpperCase()), depth, fresh);
        // Sum the real FMP calls from each sub-report's diagnostics, then strip _diag.
        const cmpFmpCalls = result.results.reduce((n, r) => n + fmpCallsOf(r, fmpCallsPerReport), 0);
        result.results = result.results.map(stripDiag);
        obs.log({ path: '/report', mode, depth, cacheHit: false, fmpCalls: cmpFmpCalls, totalMs: now() - t0 });
        return res.json(result);
      }

      const err = validateTicker(body.ticker);
      if (err) return res.status(400).json({ error: err });
      const result = await svc.report(body.ticker.trim().toUpperCase(), mode, depth, fresh);
      const diag = result._diag || {};
      obs.log({
        path: '/report', ticker: result.ticker, mode, depth, verdict: result.verdict, confidence: result.confidence,
        cacheHit: result.cacheHit, fmpCalls: fmpCallsOf(result, fmpCallsPerReport), totalMs: now() - t0,
        stageAMs: diag.stageAMs, stageBMs: diag.stageBMs, llmModel: diag.llmModel, llmRetries: diag.llmRetries,
      });
      return res.json(stripDiag(result));
    } catch (e) {
      obs.logError({ path: '/report', error: e && e.message, totalMs: now() - t0 });
      const { status, body } = errorResponse(e);
      return res.status(status).json(body);
    }
  });

  // GET /api/analyst/health (probes cached ~30s to avoid burning FMP quota)
  router.get('/health', async (_req, res) => {
    if (healthCache && now() - healthCache.at < healthTtlMs) return res.json(healthCache.payload);
    const timed = async (fn) => { const t = now(); try { const r = await fn(); return { ...r, latencyMs: now() - t }; } catch { return { ok: false, latencyMs: now() - t }; } };
    const [fmp, yahoo, llm] = await Promise.all([timed(P.fmp), timed(P.yahoo), timed(P.llm)]);
    const metrics = obs.getMetrics();
    const summary = metrics.summary;
    const lastReport = (metrics.requests || []).find((r) => r && r.ticker && r.verdict) || null;
    const status = fmp.ok && yahoo.ok && llm.ok ? 'ok' : (yahoo.ok || llm.ok ? 'degraded' : 'down');
    const payload = {
      status,
      uptimeSec: Math.round((now() - startedAt) / 1000),
      connectors: {
        fmp: { status: fmp.ok ? 'ok' : 'unavailable', reason: fmp.reason, callsToday: summary.fmpCallsToday, limitPerDay: 250 },
        yahoo: { status: yahoo.ok ? 'ok' : 'down', latencyMs: yahoo.latencyMs },
        llm: { status: llm.ok ? 'ok' : 'down', model: llmModel || undefined },
      },
      cache: cache && typeof cache.sizeByPrefix === 'function' ? {
        entries: cache.size(),
        reports: { entries: cache.sizeByPrefix('analyst:'), ttlMin: 30 },
        fundamentals: { entries: cache.sizeByPrefix('fmp:'), ttlH: 12 },
        technicals: { entries: cache.sizeByPrefix('tech:'), ttlMin: 2 },
      } : { reports: { ttlMin: 30 } },
      lastReport: lastReport ? { ticker: lastReport.ticker, verdict: lastReport.verdict, confidence: lastReport.confidence, ts: lastReport.ts } : null,
      summary,
    };
    healthCache = { at: now(), payload };
    return res.json(payload);
  });

  // GET /api/analyst/metrics
  router.get('/metrics', (_req, res) => res.json(obs.getMetrics()));

  return router;
}

module.exports = { createAnalystRouter, validateTicker };
