'use strict';

function createSidecar({ baseUrl = (process.env.QUANT_SIDECAR_URL || ''), fetchImpl, timeoutMs = 8000 } = {}) {
  const doFetch = fetchImpl || fetch;            // Node 22 global fetch
  const base = baseUrl.replace(/\/$/, '');

  async function request(method, path, body) {
    if (!base) throw new Error('QUANT_SIDECAR_URL not configured');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(base + path, {
        method,
        signal: ctrl.signal,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(`sidecar ${path} -> ${res.status}`);
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function positionQuery(params) {
    const { symbol, ...rest } = params;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    return `/predict/position/${encodeURIComponent(symbol)}?${qs.toString()}`;
  }

  return {
    request,
    health: () => request('GET', '/health'),
    intraday: (s) => request('GET', `/predict/intraday/${encodeURIComponent(s)}`),
    outlook: (s) => request('GET', `/predict/outlook/${encodeURIComponent(s)}`),
    position: (params) => request('GET', positionQuery(params)),
    portfolio: (holdings) => request('POST', '/predict/portfolio', { holdings }),
    macro: () => request('GET', '/context/macro'),
    fundamentals: (s) => request('GET', `/context/fundamentals/${encodeURIComponent(s)}`),
    impliedMove: (s) => request('GET', `/context/implied-move/${encodeURIComponent(s)}`),
  };
}

module.exports = { createSidecar };
