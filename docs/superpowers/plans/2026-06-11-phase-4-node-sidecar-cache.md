# Phase 4: Node ↔ Sidecar Wiring + Caching + Scheduler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. `- [ ]` steps, strict TDD, one commit per task.

**Goal:** Wire the existing Node app to the Python sidecar through a typed client, an in-house **TTL cache with single-flight + stale-while-revalidate**, a thin prediction service (TTL-by-horizon), Express `/api/predict/*` routes, and a background **quant-only** scheduler that pre-warms a watchlist.

**Architecture:** Pure, injectable modules tested with `node:test` and no network: `sidecar.js` (fetch wrapper, injectable `fetchImpl`), `cache.js` (`TtlCache`, injectable clock), `predict-service.js` (cache + sidecar, TTL per mode), `scheduler.js` (injectable service + timers). `predict-routes.js` is thin Express glue mounted in `server.js`. No new npm dependencies (Node 22 has global `fetch`).

**Tech Stack:** Node 22, Express 4, `node:test`, CommonJS.

**Builds on:** Phases 1–3 (sidecar endpoints). **Needs at runtime:** `QUANT_SIDECAR_URL` (already auto-wired in `render.yaml`); absent → routes return 503 gracefully.

---

## File structure

```
src/
  config.js            # MODIFY: add QUANT_SIDECAR_URL
  sidecar.js           # NEW: typed fetch client for the Python sidecar
  cache.js             # NEW: TtlCache (single-flight + SWR)
  predict-service.js   # NEW: cache + sidecar, TTL by mode
  scheduler.js         # NEW: background quant-only watchlist refresh
  predict-routes.js    # NEW: Express router for /api/predict/*
  server.js            # MODIFY: mount the predict router + start scheduler
test/
  cache.test.js  sidecar.test.js  predict-service.test.js  scheduler.test.js  predict-routes.test.js   # NEW
```

---

## Task 1: `TtlCache` (single-flight + stale-while-revalidate)

**Files:** Create `src/cache.js`; Test `test/cache.test.js`

- [ ] **Step 1: Failing tests** — `test/cache.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TtlCache } = require('../src/cache');

test('returns fresh value without reloading within ttl', async () => {
  let calls = 0;
  const c = new TtlCache();
  const load = async () => (++calls, 'v1');
  assert.equal(await c.getOrLoad('k', 1000, load), 'v1');
  assert.equal(await c.getOrLoad('k', 1000, load), 'v1');
  assert.equal(calls, 1);
});

test('single-flight: concurrent loads call loader once', async () => {
  let calls = 0;
  const c = new TtlCache();
  const load = () => { calls++; return new Promise((r) => setTimeout(() => r('v'), 10)); };
  const [a, b] = await Promise.all([c.getOrLoad('k', 1000, load), c.getOrLoad('k', 1000, load)]);
  assert.equal(a, 'v'); assert.equal(b, 'v'); assert.equal(calls, 1);
});

test('reloads after full expiry (past stale window)', async () => {
  let t = 0; let calls = 0;
  const c = new TtlCache({ now: () => t, staleTtlMs: 100 });
  const load = async () => `v${++calls}`;
  assert.equal(await c.getOrLoad('k', 100, load), 'v1');
  t = 1000;                                   // past ttl(100)+stale(100)
  assert.equal(await c.getOrLoad('k', 100, load), 'v2');
  assert.equal(calls, 2);
});

test('stale-while-revalidate: returns stale immediately then refreshes', async () => {
  let t = 0; let calls = 0;
  const c = new TtlCache({ now: () => t, staleTtlMs: 1000 });
  const load = async () => `v${++calls}`;
  assert.equal(await c.getOrLoad('k', 100, load), 'v1');     // calls=1
  t = 150;                                                   // expired but within stale window
  assert.equal(await c.getOrLoad('k', 100, load), 'v1');     // serves stale immediately
  await new Promise((r) => setImmediate(r));                 // let background revalidate run
  assert.equal(calls, 2);                                    // refreshed in background
});
```

- [ ] **Step 2: Run → fail** (`node --test test/cache.test.js`)

- [ ] **Step 3: Create `src/cache.js`**

```js
'use strict';

class TtlCache {
  constructor({ now = Date.now, staleTtlMs = 5 * 60 * 1000 } = {}) {
    this._store = new Map();      // key -> { value, expiresAt }
    this._inflight = new Map();   // key -> Promise
    this._now = now;
    this._staleTtl = staleTtlMs;
  }

  set(key, value, ttlMs) {
    this._store.set(key, { value, expiresAt: this._now() + ttlMs });
  }

  getOrLoad(key, ttlMs, loader) {
    const now = this._now();
    const entry = this._store.get(key);
    if (entry && entry.expiresAt > now) return Promise.resolve(entry.value);          // fresh
    if (entry && entry.expiresAt + this._staleTtl > now) {                            // stale
      this._revalidate(key, ttlMs, loader);
      return Promise.resolve(entry.value);
    }
    return this._load(key, ttlMs, loader);                                            // miss/expired
  }

  _load(key, ttlMs, loader) {
    if (this._inflight.has(key)) return this._inflight.get(key);
    const p = Promise.resolve().then(loader)
      .then((value) => { this.set(key, value, ttlMs); return value; })
      .finally(() => this._inflight.delete(key));
    this._inflight.set(key, p);
    return p;
  }

  _revalidate(key, ttlMs, loader) {
    if (this._inflight.has(key)) return;
    this._load(key, ttlMs, loader).catch(() => {});   // background; keep stale on failure
  }
}

module.exports = { TtlCache };
```

- [ ] **Step 4: Run → pass. Commit**
```
git checkout -b feat/phase-4-node-sidecar
git add src/cache.js test/cache.test.js
git commit -m "feat(node): add TtlCache with single-flight + stale-while-revalidate"
```

---

## Task 2: Sidecar client

**Files:** Create `src/sidecar.js`; Test `test/sidecar.test.js`

- [ ] **Step 1: Failing tests** — `test/sidecar.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSidecar } = require('../src/sidecar');

function fakeFetch(record, payload = { ok: true }, status = 200, httpOk = true) {
  return async (url, opts) => {
    record.url = url; record.opts = opts;
    return { ok: httpOk, status, json: async () => payload };
  };
}

test('intraday issues GET to the right path and parses json', async () => {
  const rec = {};
  const s = createSidecar({ baseUrl: 'http://side', fetchImpl: fakeFetch(rec, { bias: 'Bullish' }) });
  const out = await s.intraday('aapl');
  assert.equal(rec.url, 'http://side/predict/intraday/aapl');
  assert.equal(rec.opts.method, 'GET');
  assert.equal(out.bias, 'Bullish');
});

test('portfolio issues POST with json body', async () => {
  const rec = {};
  const s = createSidecar({ baseUrl: 'http://side', fetchImpl: fakeFetch(rec, { flags: [] }) });
  await s.portfolio([{ symbol: 'AAPL', value: 100 }]);
  assert.equal(rec.opts.method, 'POST');
  assert.deepEqual(JSON.parse(rec.opts.body), { holdings: [{ symbol: 'AAPL', value: 100 }] });
});

test('position builds a query string from params', async () => {
  const rec = {};
  const s = createSidecar({ baseUrl: 'http://side', fetchImpl: fakeFetch(rec, {}) });
  await s.position({ symbol: 'AAPL', current_price: 130, cost_basis: 100, shares: 10 });
  assert.ok(rec.url.startsWith('http://side/predict/position/AAPL?'));
  assert.ok(rec.url.includes('current_price=130'));
  assert.ok(!rec.url.includes('symbol='));   // symbol is in the path, not the query
});

test('non-ok response throws', async () => {
  const s = createSidecar({ baseUrl: 'http://side', fetchImpl: fakeFetch({}, {}, 503, false) });
  await assert.rejects(() => s.intraday('AAPL'), /503/);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `src/sidecar.js`**

```js
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
```

- [ ] **Step 4: Run → pass. Commit**
```
git add src/sidecar.js test/sidecar.test.js
git commit -m "feat(node): add typed sidecar client (fetch, injectable)"
```

---

## Task 3: Prediction service (cache + sidecar, TTL by mode)

**Files:** Create `src/predict-service.js`; Test `test/predict-service.test.js`

- [ ] **Step 1: Failing tests** — `test/predict-service.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TtlCache } = require('../src/cache');
const { createPredictService } = require('../src/predict-service');

function fakeSidecar(counts) {
  return {
    intraday: async (s) => (counts.intraday = (counts.intraday || 0) + 1, { symbol: s, bias: 'Bullish' }),
    outlook: async (s) => ({ symbol: s, stance: 'Constructive' }),
    macro: async () => ({ vix: 15 }),
    fundamentals: async (s) => ({ merged: { symbol: s } }),
    impliedMove: async (s) => ({ symbol: s, high: 1, low: 0, spot: 0.5 }),
    position: async (p) => (counts.position = (counts.position || 0) + 1, { symbol: p.symbol, action: 'HOLD' }),
    portfolio: async (h) => ({ holdings: h }),
  };
}

test('intraday is cached (sidecar hit once within ttl)', async () => {
  const counts = {};
  const svc = createPredictService({ sidecar: fakeSidecar(counts), cache: new TtlCache() });
  await svc.intraday('AAPL');
  await svc.intraday('AAPL');
  assert.equal(counts.intraday, 1);
});

test('position is uncached pass-through (param-specific)', async () => {
  const counts = {};
  const svc = createPredictService({ sidecar: fakeSidecar(counts), cache: new TtlCache() });
  await svc.position('AAPL', { current_price: 130, cost_basis: 100 });
  await svc.position('AAPL', { current_price: 131, cost_basis: 100 });
  assert.equal(counts.position, 2);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `src/predict-service.js`**

```js
'use strict';

// TTL per mode (ms). Modes not listed are uncached pass-throughs.
const TTL = {
  intraday: 120 * 1000,            // 2 min (market hours)
  outlook: 6 * 60 * 60 * 1000,     // 6 h
  macro: 60 * 60 * 1000,           // 1 h
  fundamentals: 12 * 60 * 60 * 1000, // 12 h
  impliedMove: 5 * 60 * 1000,      // 5 min
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
  };
}

module.exports = { createPredictService, TTL };
```

- [ ] **Step 4: Run → pass. Commit**
```
git add src/predict-service.js test/predict-service.test.js
git commit -m "feat(node): add prediction service (cache + sidecar, TTL by mode)"
```

---

## Task 4: Background scheduler (quant-only watchlist pre-warm)

**Files:** Create `src/scheduler.js`; Test `test/scheduler.test.js`

- [ ] **Step 1: Failing tests** — `test/scheduler.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createScheduler } = require('../src/scheduler');

test('refreshOnce warms intraday+outlook for each symbol', async () => {
  const hits = [];
  const service = {
    intraday: async (s) => hits.push(`i:${s}`),
    outlook: async (s) => hits.push(`o:${s}`),
  };
  const sch = createScheduler({ service, symbols: ['AAPL', 'MSFT'] });
  await sch.refreshOnce();
  assert.deepEqual(hits.sort(), ['i:AAPL', 'i:MSFT', 'o:AAPL', 'o:MSFT']);
});

test('one failing symbol does not stop the others', async () => {
  const hits = [];
  const service = {
    intraday: async (s) => { if (s === 'BAD') throw new Error('boom'); hits.push(s); },
    outlook: async () => {},
  };
  const sch = createScheduler({ service, symbols: ['BAD', 'AAPL'], log: () => {} });
  await sch.refreshOnce();
  assert.deepEqual(hits, ['AAPL']);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `src/scheduler.js`**

```js
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
```

- [ ] **Step 4: Run → pass. Commit**
```
git add src/scheduler.js test/scheduler.test.js
git commit -m "feat(node): add quant-only watchlist scheduler"
```

---

## Task 5: Config + Express routes + server wiring

**Files:** Modify `src/config.js`, `src/server.js`; Create `src/predict-routes.js`; Test `test/predict-routes.test.js`

- [ ] **Step 1: Add `QUANT_SIDECAR_URL` to `src/config.js`** — inside the exported config object, add:
```js
QUANT_SIDECAR_URL: (process.env.QUANT_SIDECAR_URL || '').trim(),
```
(Leave all existing fields intact.)

- [ ] **Step 2: Failing test** — `test/predict-routes.test.js` (spins up the real router on an ephemeral port; no supertest)

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { createPredictRouter } = require('../src/predict-routes');

function appWith(service) {
  const app = express();
  app.use(express.json());
  app.use('/api/predict', createPredictRouter({ service }));
  return app;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

test('GET /api/predict/intraday/:symbol returns sidecar json', async () => {
  const service = { intraday: async (s) => ({ symbol: s, bias: 'Bullish' }) };
  const { server, base } = await listen(appWith(service));
  try {
    const r = await fetch(`${base}/api/predict/intraday/aapl`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).symbol, 'AAPL');   // upper-cased by route
  } finally { server.close(); }
});

test('sidecar failure surfaces as 503', async () => {
  const service = { intraday: async () => { throw new Error('down'); } };
  const { server, base } = await listen(appWith(service));
  try {
    const r = await fetch(`${base}/api/predict/intraday/AAPL`);
    assert.equal(r.status, 503);
  } finally { server.close(); }
});

test('POST /api/predict/portfolio passes holdings through', async () => {
  const service = { portfolio: async (h) => ({ count: h.length }) };
  const { server, base } = await listen(appWith(service));
  try {
    const r = await fetch(`${base}/api/predict/portfolio`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holdings: [{ symbol: 'AAPL', value: 1 }] }),
    });
    assert.equal((await r.json()).count, 1);
  } finally { server.close(); }
});
```

- [ ] **Step 3: Create `src/predict-routes.js`**

```js
'use strict';
const express = require('express');

function createPredictRouter({ service }) {
  const router = express.Router();

  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      res.status(503).json({ error: 'prediction service unavailable', detail: e.message });
    }
  };

  router.get('/intraday/:symbol', wrap((req) => service.intraday(req.params.symbol.toUpperCase())));
  router.get('/outlook/:symbol', wrap((req) => service.outlook(req.params.symbol.toUpperCase())));
  router.get('/macro', wrap(() => service.macro()));
  router.get('/fundamentals/:symbol', wrap((req) => service.fundamentals(req.params.symbol.toUpperCase())));
  router.get('/implied-move/:symbol', wrap((req) => service.impliedMove(req.params.symbol.toUpperCase())));

  router.get('/position/:symbol', wrap((req) => {
    const q = req.query;
    const num = (v) => (v === undefined ? undefined : Number(v));
    return service.position(req.params.symbol.toUpperCase(), {
      current_price: num(q.current_price), cost_basis: num(q.cost_basis),
      shares: num(q.shares), portfolio_value: num(q.portfolio_value),
      intraday_bias: q.intraday_bias, outlook_stance: q.outlook_stance,
    });
  }));

  router.post('/portfolio', wrap((req) => service.portfolio(req.body.holdings || [])));

  return router;
}

module.exports = { createPredictRouter };
```

- [ ] **Step 4: Wire into `src/server.js`** — near the other route setup (after `express.json()` middleware is registered and `app` exists), add:

```js
const { createSidecar } = require('./sidecar');
const { TtlCache } = require('./cache');
const { createPredictService } = require('./predict-service');
const { createPredictRouter } = require('./predict-routes');
const { createScheduler } = require('./scheduler');

const sidecar = createSidecar({ baseUrl: config.QUANT_SIDECAR_URL });
const predictCache = new TtlCache();
const predictService = createPredictService({ sidecar, cache: predictCache });
app.use('/api/predict', createPredictRouter({ service: predictService }));

const WATCHLIST = (process.env.WATCHLIST || 'AAPL,MSFT,NVDA,SPY').split(',').map((s) => s.trim()).filter(Boolean);
if (config.QUANT_SIDECAR_URL) {
  createScheduler({ service: predictService, symbols: WATCHLIST,
                    log: (m) => console.log('[scheduler]', m) }).start();
}
```
(Insert where `app` and `config` are already in scope, alongside the existing route registrations. Do not remove existing routes/WS setup.)

- [ ] **Step 5: Run the FULL node suite → green**
```
node --test
```
Expected: existing engine tests + the 5 new Phase 4 test files all pass.

- [ ] **Step 6: Commit**
```
git add src/config.js src/predict-routes.js src/server.js test/predict-routes.test.js
git commit -m "feat(node): mount /api/predict routes + start quant-only scheduler"
```

---

## Acceptance criteria
- [ ] `node --test` green (existing tests + cache/sidecar/predict-service/scheduler/predict-routes).
- [ ] Cache: single-flight (concurrent → one load), TTL freshness, SWR serves stale + refreshes.
- [ ] Sidecar client: correct method/path/body; non-ok → throws; no `QUANT_SIDECAR_URL` → throws.
- [ ] Service: intraday/outlook/macro/fundamentals/implied-move cached; position/portfolio pass-through.
- [ ] Routes: 200 with sidecar json; 503 when sidecar fails; symbols upper-cased.
- [ ] Scheduler pre-warms watchlist quant-only; a failing symbol doesn't stop others; only starts when `QUANT_SIDECAR_URL` set.
- [ ] No new npm dependencies; `.env` never staged.
- [ ] Branch `feat/phase-4-node-sidecar` ready to merge.

## Self-review notes
- **Spec coverage:** implements spec §"Cost control & always-on while idle" (single-flight, SWR, TTL-by-horizon, quant-only background scheduler) and §"Backend architecture" Node side (`sidecar.js`, `cache/`, `scheduler/`).
- **Determinism:** cache clock and sidecar `fetchImpl` are injected; scheduler timers `unref`'d; route tests use ephemeral servers, no external network.
- **Graceful degradation:** missing `QUANT_SIDECAR_URL` → routes 503 and scheduler doesn't start; a down sidecar surfaces as 503, never crashes the Node app.
- **No new deps:** uses Node 22 global `fetch`, `AbortController`, `URLSearchParams`, and a hand-rolled cache — nothing added to `package.json`.
- **Type consistency:** `createSidecar`, `TtlCache.getOrLoad(key, ttlMs, loader)`, `createPredictService({sidecar,cache})`, `createScheduler({service,symbols})`, `createPredictRouter({service})` signatures match across modules, server wiring, and tests.

## Note for Phase 5/7
The Node app now owns a `predictService`. Phase 5 (LLM ensemble) consumes the same sidecar/quant outputs to build context; Phase 7 (UI) calls `/api/predict/*`. Keep `predictService` the single integration point.
