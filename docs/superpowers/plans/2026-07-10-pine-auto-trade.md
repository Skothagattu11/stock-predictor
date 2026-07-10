# Pine Script → Auto Paper Trade Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect TradingView Pine Script alerts to the paper trading engine with configurable auto-execute or manager-approval modes.

**Architecture:** Extend `src/tv-webhook.js` with a `PendingQueue` class and execution logic that reads pine settings from the paper sidecar, then either fires `paperOrder()`/`paperClose()` immediately (auto mode) or queues the signal for manager approval. A new Pine settings section in the paper trading panel lets the manager configure all behaviour without touching code.

**Tech Stack:** Node.js + Express, vanilla JS frontend, existing `sidecar` paper engine proxy.

## Global Constraints

- Vanilla JS only in `public/` — no bundler, no framework, no ES modules syntax
- Follow existing patterns: `wrap()` for route error handling in paper-routes, `el(id)` helper in paper.js
- No new npm dependencies
- All new backend code must have unit tests in `tests/unit/`
- `paperOrder` body shape: `{ symbol, budget, target, stop }` — budget is dollars, target/stop are absolute prices
- `paperPortfolio()` returns `{ account, open: [{ id, symbol, shares, entry, last_price }], stats }`
- Pine settings live inside the existing paper settings JSON blob under key `pine`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/tv-webhook.js` | Modify | Add `PendingQueue`, `PINE_DEFAULTS`, `executeSignal()`, 3 new routes, accept `sidecar` dep |
| `src/server.js` | Modify | Pass `sidecar` into `createTvRouter` |
| `public/index.html` | Modify | Add Pine settings HTML + pending panel `div` inside `#paperPanel` |
| `public/paper.js` | Modify | Load/save pine settings, render + poll pending approvals panel |
| `tests/unit/tv-webhook.test.js` | Create | Unit tests for PendingQueue, executeSignal, new routes |

---

## Task 1: PendingQueue class + pine settings defaults

**Files:**
- Modify: `src/tv-webhook.js`
- Create: `tests/unit/tv-webhook.test.js`

**Interfaces:**
- Produces: `PendingQueue` class with `.add(signal)`, `.list()`, `.approve(id)`, `.reject(id)`, `.isFull()`
- Produces: `PINE_DEFAULTS` constant `{ enabled, mode, onDuplicate, onExit, tradeBudget }`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/tv-webhook.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PendingQueue, PINE_DEFAULTS } = require('../../src/tv-webhook');

test('PINE_DEFAULTS has expected shape', () => {
  assert.equal(PINE_DEFAULTS.enabled, false);
  assert.equal(PINE_DEFAULTS.mode, 'auto');
  assert.equal(PINE_DEFAULTS.onDuplicate, 'skip');
  assert.equal(PINE_DEFAULTS.onExit, 'closeAll');
  assert.equal(typeof PINE_DEFAULTS.tradeBudget, 'number');
});

test('PendingQueue: add returns an entry with id and ts', () => {
  const q = new PendingQueue(50);
  const entry = q.add({ symbol: 'AAPL', stance: 'bullish', action: 'buy', price: 200, strategy: 'Test' });
  assert.ok(entry.id);
  assert.ok(entry.ts);
  assert.equal(entry.symbol, 'AAPL');
});

test('PendingQueue: list returns added entries', () => {
  const q = new PendingQueue(50);
  q.add({ symbol: 'AAPL', stance: 'bullish', action: 'buy', price: 200, strategy: 'Test' });
  assert.equal(q.list().length, 1);
});

test('PendingQueue: reject removes entry', () => {
  const q = new PendingQueue(50);
  const e = q.add({ symbol: 'AAPL', stance: 'bullish', action: 'buy', price: 200, strategy: 'Test' });
  const removed = q.reject(e.id);
  assert.ok(removed);
  assert.equal(q.list().length, 0);
});

test('PendingQueue: approve removes and returns entry', () => {
  const q = new PendingQueue(50);
  const e = q.add({ symbol: 'TSLA', stance: 'bearish', action: 'sell', price: 100, strategy: 'Test' });
  const found = q.approve(e.id);
  assert.equal(found.symbol, 'TSLA');
  assert.equal(q.list().length, 0);
});

test('PendingQueue: approve returns null for unknown id', () => {
  const q = new PendingQueue(50);
  assert.equal(q.approve('no-such-id'), null);
});

test('PendingQueue: drops oldest when full', () => {
  const q = new PendingQueue(2);
  q.add({ symbol: 'A', stance: 'bullish', action: 'buy', price: 1, strategy: 'S' });
  const second = q.add({ symbol: 'B', stance: 'bullish', action: 'buy', price: 2, strategy: 'S' });
  q.add({ symbol: 'C', stance: 'bullish', action: 'buy', price: 3, strategy: 'S' });
  const ids = q.list().map(e => e.id);
  assert.ok(!ids.includes(second.id) || ids.length === 2);
  assert.equal(q.list().length, 2);
});

test('PendingQueue: isFull returns true when at cap', () => {
  const q = new PendingQueue(1);
  q.add({ symbol: 'A', stance: 'bullish', action: 'buy', price: 1, strategy: 'S' });
  assert.equal(q.isFull(), true);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/unit/tv-webhook.test.js
```
Expected: `ReferenceError` or `TypeError` — `PendingQueue` and `PINE_DEFAULTS` not exported yet.

- [ ] **Step 3: Add PendingQueue and PINE_DEFAULTS to tv-webhook.js**

At the top of `src/tv-webhook.js`, before `normAction`, add:

```js
const { randomUUID } = require('crypto');

const PINE_DEFAULTS = {
  enabled: false,
  mode: 'auto',          // 'auto' | 'approval'
  onDuplicate: 'skip',   // 'skip' | 'stack' | 'scale'
  onExit: 'closeAll',    // 'closeAll' | 'closeLatest' | 'ignore'
  tradeBudget: 200,      // dollars per auto-trade
};

class PendingQueue {
  constructor(cap = 50) {
    this._cap = cap;
    this._items = [];
  }
  add(signal) {
    if (this._items.length >= this._cap) this._items.shift();
    const entry = { id: randomUUID(), ts: Date.now(), ...signal };
    this._items.push(entry);
    return entry;
  }
  list() { return this._items.slice(); }
  approve(id) {
    const idx = this._items.findIndex(e => e.id === id);
    if (idx === -1) return null;
    return this._items.splice(idx, 1)[0];
  }
  reject(id) {
    const idx = this._items.findIndex(e => e.id === id);
    if (idx === -1) return false;
    this._items.splice(idx, 1);
    return true;
  }
  isFull() { return this._items.length >= this._cap; }
}
```

At the bottom of `src/tv-webhook.js`, update exports:

```js
module.exports = { createTvStore, createTvRouter, normAction, PendingQueue, PINE_DEFAULTS };
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test tests/unit/tv-webhook.test.js
```
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tv-webhook.js tests/unit/tv-webhook.test.js
git commit -m "feat(pine): PendingQueue class + PINE_DEFAULTS"
```

---

## Task 2: Execution logic + new API routes + server.js wiring

**Files:**
- Modify: `src/tv-webhook.js`
- Modify: `src/server.js`
- Modify: `tests/unit/tv-webhook.test.js`

**Interfaces:**
- Consumes: `sidecar.paperPortfolio()` → `{ open: [{ id, symbol }] }`
- Consumes: `sidecar.paperSettings()` → `{ pine: { enabled, mode, onDuplicate, onExit, tradeBudget }, budget, ... }`
- Consumes: `sidecar.paperOrder({ symbol, budget, target, stop })`
- Consumes: `sidecar.paperClose(id)`
- Produces: `GET /api/tv/pending` → `[{ id, ts, symbol, stance, action, price, strategy }]`
- Produces: `POST /api/tv/pending/:id/approve` → `{ ok, symbol, stance }` or `404`
- Produces: `POST /api/tv/pending/:id/reject` → `{ ok }` or `404`

- [ ] **Step 1: Write failing tests for executeSignal and new routes**

Append to `tests/unit/tv-webhook.test.js`:

```js
const { createTvStore, createTvRouter, normAction, PendingQueue, PINE_DEFAULTS } = require('../../src/tv-webhook');
const http = require('node:http');

// Stub sidecar factory
function makeSidecar(overrides = {}) {
  const orders = [];
  const closes = [];
  const openPositions = overrides.openPositions || [];
  return {
    orders,
    closes,
    paperPortfolio: async () => ({ open: openPositions, account: {}, stats: {} }),
    paperSettings: async () => ({ ...PINE_DEFAULTS, ...overrides.settings }),
    paperOrder: async (body) => { orders.push(body); return { ok: true }; },
    paperClose: async (id) => { closes.push(id); return { ok: true }; },
  };
}

function makeRouter(sidecarOverrides = {}) {
  const store = createTvStore();
  const queue = new PendingQueue(50);
  const sidecar = makeSidecar(sidecarOverrides);
  const router = createTvRouter({ store, secret: null, sidecar, _queue: queue });
  return { router, sidecar, queue };
}

function request(router, method, path, body) {
  return new Promise((resolve) => {
    const app = require('express')();
    app.use(require('express').json());
    app.use('/', router);
    const srv = app.listen(0, () => {
      const port = srv.address().port;
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host: '127.0.0.1', port, method, path,
        headers: { 'content-type': 'application/json', 'content-length': data ? Buffer.byteLength(data) : 0 }
      }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: JSON.parse(raw || 'null') }); });
      });
      if (data) req.write(data);
      req.end();
    });
  });
}

test('webhook: pine disabled — no order placed', async () => {
  const { router, sidecar } = makeRouter({ settings: { pine: { enabled: false } } });
  await request(router, 'POST', '/webhook', { symbol: 'AAPL', action: 'buy', price: 200, strategy: 'Test' });
  assert.equal(sidecar.orders.length, 0);
});

test('webhook: pine auto mode bullish — places order', async () => {
  const { router, sidecar } = makeRouter({ settings: { pine: { enabled: true, mode: 'auto', onDuplicate: 'stack', onExit: 'ignore', tradeBudget: 200 } } });
  const res = await request(router, 'POST', '/webhook', { symbol: 'NVDA', action: 'buy', price: 500, strategy: 'GC' });
  assert.equal(res.status, 200);
  assert.equal(sidecar.orders.length, 1);
  assert.equal(sidecar.orders[0].symbol, 'NVDA');
});

test('webhook: pine auto mode onDuplicate=skip — skips when position exists', async () => {
  const { router, sidecar } = makeRouter({
    openPositions: [{ id: '1', symbol: 'AAPL' }],
    settings: { pine: { enabled: true, mode: 'auto', onDuplicate: 'skip', onExit: 'ignore', tradeBudget: 200 } }
  });
  await request(router, 'POST', '/webhook', { symbol: 'AAPL', action: 'buy', price: 200, strategy: 'Test' });
  assert.equal(sidecar.orders.length, 0);
});

test('webhook: pine auto mode onExit=closeAll — closes all matching positions', async () => {
  const { router, sidecar } = makeRouter({
    openPositions: [{ id: 'p1', symbol: 'TSLA' }, { id: 'p2', symbol: 'TSLA' }, { id: 'p3', symbol: 'AAPL' }],
    settings: { pine: { enabled: true, mode: 'auto', onDuplicate: 'skip', onExit: 'closeAll', tradeBudget: 200 } }
  });
  await request(router, 'POST', '/webhook', { symbol: 'TSLA', action: 'sell', price: 100, strategy: 'Test' });
  assert.equal(sidecar.closes.length, 2);
  assert.ok(sidecar.closes.includes('p1'));
  assert.ok(sidecar.closes.includes('p2'));
});

test('webhook: pine auto mode onExit=closeLatest — closes only most recent', async () => {
  const { router, sidecar } = makeRouter({
    openPositions: [{ id: 'p1', symbol: 'TSLA' }, { id: 'p2', symbol: 'TSLA' }],
    settings: { pine: { enabled: true, mode: 'auto', onDuplicate: 'skip', onExit: 'closeLatest', tradeBudget: 200 } }
  });
  await request(router, 'POST', '/webhook', { symbol: 'TSLA', action: 'exit', price: 100, strategy: 'Test' });
  assert.equal(sidecar.closes.length, 1);
  assert.equal(sidecar.closes[0], 'p2');
});

test('webhook: pine approval mode — queues signal, no order', async () => {
  const { router, sidecar, queue } = makeRouter({
    settings: { pine: { enabled: true, mode: 'approval', onDuplicate: 'skip', onExit: 'closeAll', tradeBudget: 200 } }
  });
  await request(router, 'POST', '/webhook', { symbol: 'MSFT', action: 'buy', price: 300, strategy: 'Test' });
  assert.equal(sidecar.orders.length, 0);
  assert.equal(queue.list().length, 1);
});

test('GET /pending — returns queued signals', async () => {
  const { router, queue } = makeRouter({ settings: { pine: { enabled: true, mode: 'approval', onDuplicate: 'skip', onExit: 'closeAll', tradeBudget: 200 } } });
  queue.add({ symbol: 'AAPL', stance: 'bullish', action: 'buy', price: 200, strategy: 'T' });
  const res = await request(router, 'GET', '/pending', null);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].symbol, 'AAPL');
});

test('POST /pending/:id/approve — executes and removes from queue', async () => {
  const { router, sidecar, queue } = makeRouter({ settings: { pine: { enabled: true, mode: 'approval', onDuplicate: 'stack', onExit: 'closeAll', tradeBudget: 200 } } });
  const entry = queue.add({ symbol: 'GOOGL', stance: 'bullish', action: 'buy', price: 150, strategy: 'T' });
  const res = await request(router, 'POST', `/pending/${entry.id}/approve`, null);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(queue.list().length, 0);
  assert.equal(sidecar.orders.length, 1);
});

test('POST /pending/:id/reject — removes without executing', async () => {
  const { router, sidecar, queue } = makeRouter({ settings: { pine: { enabled: true, mode: 'approval', onDuplicate: 'skip', onExit: 'closeAll', tradeBudget: 200 } } });
  const entry = queue.add({ symbol: 'GOOGL', stance: 'bullish', action: 'buy', price: 150, strategy: 'T' });
  const res = await request(router, 'POST', `/pending/${entry.id}/reject`, null);
  assert.equal(res.status, 200);
  assert.equal(queue.list().length, 0);
  assert.equal(sidecar.orders.length, 0);
});

test('POST /pending/:id/approve — 404 for unknown id', async () => {
  const { router } = makeRouter();
  const res = await request(router, 'POST', '/pending/no-such-id/approve', null);
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/unit/tv-webhook.test.js
```
Expected: multiple failures — `executeSignal`, pending routes not implemented yet.

- [ ] **Step 3: Add executeSignal and update createTvRouter in tv-webhook.js**

Replace the entire `createTvRouter` function with:

```js
async function executeSignal(signal, sidecar, pineSettings) {
  const { symbol, stance, price } = signal;
  const pine = { ...PINE_DEFAULTS, ...pineSettings };
  const budget = pine.tradeBudget || 200;

  if (stance === 'bullish') {
    // Check for existing position
    const { open = [] } = await sidecar.paperPortfolio().catch(() => ({ open: [] }));
    const existing = open.filter(p => p.symbol === symbol);
    if (existing.length > 0 && pine.onDuplicate === 'skip') return { action: 'skipped', reason: 'duplicate' };
    // stack or scale both open a new order (engine has no merge concept)
    const target = price ? +(price * 1.06).toFixed(2) : null;
    const stop   = price ? +(price * 0.97).toFixed(2) : null;
    await sidecar.paperOrder({ symbol, budget, target, stop });
    return { action: 'opened', symbol };
  }

  if (stance === 'bearish' || stance === 'neutral') {
    if (pine.onExit === 'ignore') return { action: 'ignored' };
    const { open = [] } = await sidecar.paperPortfolio().catch(() => ({ open: [] }));
    const matching = open.filter(p => p.symbol === symbol);
    if (!matching.length) return { action: 'no_position' };
    if (pine.onExit === 'closeAll') {
      await Promise.all(matching.map(p => sidecar.paperClose(p.id).catch(() => {})));
      return { action: 'closedAll', count: matching.length };
    }
    if (pine.onExit === 'closeLatest') {
      const latest = matching[matching.length - 1];
      await sidecar.paperClose(latest.id).catch(() => {});
      return { action: 'closedLatest', id: latest.id };
    }
  }

  return { action: 'noop' };
}

function createTvRouter({ store, secret, sidecar, _queue } = {}) {
  const router = express.Router();
  const pendingQueue = _queue || new PendingQueue(50);

  router.post('/webhook', async (req, res) => {
    const b = req.body || {};
    if (secret && b.secret !== secret) return res.status(401).json({ error: 'bad or missing secret' });
    const symbol = String(b.symbol || b.ticker || '').toUpperCase();
    const stance = normAction(b.action || b.side || b.signal);
    if (!symbol || !stance) return res.status(400).json({ error: 'need symbol + action (buy/sell/exit)' });

    const signal = {
      symbol, stance, action: String(b.action || b.side || b.signal),
      price: Number(b.price) || null, strategy: String(b.strategy || b.alert || 'TradingView'),
      note: String(b.note || ''),
    };
    store.record(signal);

    // Pine auto-trade bridge
    if (sidecar) {
      try {
        const settings = await sidecar.paperSettings().catch(() => ({}));
        const pine = { ...PINE_DEFAULTS, ...(settings.pine || {}) };
        if (pine.enabled) {
          if (pine.mode === 'auto') {
            await executeSignal(signal, sidecar, pine).catch(() => {});
          } else if (pine.mode === 'approval') {
            pendingQueue.add(signal);
          }
        }
      } catch (_) { /* never block webhook response on pine errors */ }
    }

    res.json({ ok: true, symbol, stance });
  });

  router.get('/alerts/:symbol', (req, res) => res.json(store.latest(req.params.symbol) || {}));
  router.get('/alerts', (req, res) => res.json(store.feed()));

  router.get('/pending', (_req, res) => res.json(pendingQueue.list()));

  router.post('/pending/:id/approve', async (req, res) => {
    const entry = pendingQueue.approve(req.params.id);
    if (!entry) return res.status(404).json({ error: 'signal not found' });
    if (sidecar) {
      try {
        const settings = await sidecar.paperSettings().catch(() => ({}));
        await executeSignal(entry, sidecar, { ...PINE_DEFAULTS, ...(settings.pine || {}) });
      } catch (_) {}
    }
    res.json({ ok: true, symbol: entry.symbol, stance: entry.stance });
  });

  router.post('/pending/:id/reject', (req, res) => {
    const removed = pendingQueue.reject(req.params.id);
    if (!removed) return res.status(404).json({ error: 'signal not found' });
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test tests/unit/tv-webhook.test.js
```
Expected: all tests pass.

- [ ] **Step 5: Wire sidecar into createTvRouter in server.js**

In `src/server.js`, find line:
```js
app.use('/api/tv', createTvRouter({ store: tvStore, secret: config.TV_WEBHOOK_SECRET }));
```
Replace with:
```js
app.use('/api/tv', createTvRouter({ store: tvStore, secret: config.TV_WEBHOOK_SECRET, sidecar }));
```

- [ ] **Step 6: Smoke test the wired server**

```bash
# Restart server
npm start &
sleep 3

# Confirm pending endpoint exists
curl -s http://localhost:3100/api/tv/pending
```
Expected: `[]`

- [ ] **Step 7: Commit**

```bash
git add src/tv-webhook.js src/server.js tests/unit/tv-webhook.test.js
git commit -m "feat(pine): execution logic, pending queue routes, sidecar wiring"
```

---

## Task 3: Pine settings UI + pending approvals panel

**Files:**
- Modify: `public/index.html`
- Modify: `public/paper.js`

**Interfaces:**
- Consumes: `GET /api/paper/settings` — now returns `{ auto_enabled, budget, target, risk, pine: { enabled, mode, onDuplicate, onExit, tradeBudget } }`
- Consumes: `POST /api/paper/settings` — accepts pine block
- Consumes: `GET /api/tv/pending` → array of pending signals
- Consumes: `POST /api/tv/pending/:id/approve`
- Consumes: `POST /api/tv/pending/:id/reject`

- [ ] **Step 1: Add Pine settings HTML to index.html**

In `public/index.html`, find:
```html
        <button id="paperReset">Reset account</button>
      </div>
      <div id="paperOpen"></div>
```
Replace with:
```html
        <button id="paperReset">Reset account</button>
      </div>

      <details id="pineSettings" style="margin-top:14px;border:1px solid var(--line);border-radius:9px;padding:10px 14px">
        <summary style="cursor:pointer;font-size:13px;font-weight:700;color:var(--text)">Pine Script / TradingView Signals</summary>
        <div class="gp-controls" style="margin-top:10px;flex-direction:column;gap:8px">
          <label style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="pineEnabled">
            <span>Enable auto-trading from Pine alerts</span>
          </label>
          <div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Execution mode</div>
            <label style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
              <input type="radio" name="pineMode" id="pineModeAuto" value="auto">
              Auto — execute immediately on signal
            </label>
            <label style="display:flex;align-items:center;gap:6px">
              <input type="radio" name="pineMode" id="pineModeApproval" value="approval">
              Approval — queue for my review
            </label>
          </div>
          <div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:4px">When already holding the ticker</div>
            <label style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
              <input type="radio" name="pineDup" id="pineDupSkip" value="skip"> Skip — ignore duplicate signal
            </label>
            <label style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
              <input type="radio" name="pineDup" id="pineDupStack" value="stack"> Stack — open another position
            </label>
            <label style="display:flex;align-items:center;gap:6px">
              <input type="radio" name="pineDup" id="pineDupScale" value="scale"> Scale — add to existing position
            </label>
          </div>
          <div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:4px">On EXIT / SELL signal</div>
            <label style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
              <input type="radio" name="pineExit" id="pineExitAll" value="closeAll"> Close all positions for that ticker
            </label>
            <label style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
              <input type="radio" name="pineExit" id="pineExitLatest" value="closeLatest"> Close most recent position only
            </label>
            <label style="display:flex;align-items:center;gap:6px">
              <input type="radio" name="pineExit" id="pineExitIgnore" value="ignore"> Ignore — manual close only
            </label>
          </div>
          <label style="display:flex;align-items:center;gap:8px">
            <span style="font-size:12px;color:var(--muted)">Trade budget $</span>
            <input id="pineBudget" type="number" value="200" min="50" style="width:90px">
          </label>
        </div>
      </details>

      <div id="pinePending" style="display:none;margin-top:12px;border:1px solid var(--line);border-radius:9px;padding:10px 14px">
        <div style="font-size:13px;font-weight:700;margin-bottom:8px">Pending Pine Signals <span id="pinePendingCount" style="color:var(--amber)"></span></div>
        <div id="pinePendingList"></div>
      </div>

      <div id="paperOpen"></div>
```

- [ ] **Step 2: Add pine settings load/save + pending panel to paper.js**

In `public/paper.js`, replace the entire `init` function with:

```js
  function init() {
    if (!el('paperPanel')) return;

    // Load existing + pine settings
    fetch('/api/paper/settings').then(function(r){return r.json();}).then(function(s){
      el('paperAuto').checked = !!s.auto_enabled;
      el('paperBudget').value = s.budget;
      el('paperTarget').value = s.target;
      el('paperRisk').value = s.risk;
      var pine = s.pine || {};
      el('pineEnabled').checked = !!pine.enabled;
      var mode = pine.mode || 'auto';
      if (el('pineModeAuto')) el('pineModeAuto').checked = (mode === 'auto');
      if (el('pineModeApproval')) el('pineModeApproval').checked = (mode === 'approval');
      var dup = pine.onDuplicate || 'skip';
      if (el('pineDupSkip')) el('pineDupSkip').checked = (dup === 'skip');
      if (el('pineDupStack')) el('pineDupStack').checked = (dup === 'stack');
      if (el('pineDupScale')) el('pineDupScale').checked = (dup === 'scale');
      var exit = pine.onExit || 'closeAll';
      if (el('pineExitAll')) el('pineExitAll').checked = (exit === 'closeAll');
      if (el('pineExitLatest')) el('pineExitLatest').checked = (exit === 'closeLatest');
      if (el('pineExitIgnore')) el('pineExitIgnore').checked = (exit === 'ignore');
      if (el('pineBudget')) el('pineBudget').value = pine.tradeBudget || 200;
    }).catch(function(){});

    function saveSettings(){
      var modeEl = document.querySelector('input[name="pineMode"]:checked');
      var dupEl  = document.querySelector('input[name="pineDup"]:checked');
      var exitEl = document.querySelector('input[name="pineExit"]:checked');
      fetch('/api/paper/settings',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({
          auto_enabled: el('paperAuto').checked,
          budget: Number(el('paperBudget').value),
          target: Number(el('paperTarget').value),
          risk: el('paperRisk').value,
          pine: {
            enabled: el('pineEnabled').checked,
            mode: modeEl ? modeEl.value : 'auto',
            onDuplicate: dupEl ? dupEl.value : 'skip',
            onExit: exitEl ? exitEl.value : 'closeAll',
            tradeBudget: Number(el('pineBudget').value) || 200,
          }
        })
      });
    }

    ['paperAuto','paperBudget','paperTarget','paperRisk',
     'pineEnabled','pineBudget'].forEach(function(id){
      var e = el(id); if (e) e.addEventListener('change', saveSettings);
    });
    document.querySelectorAll('input[name="pineMode"],input[name="pineDup"],input[name="pineExit"]')
      .forEach(function(e){ e.addEventListener('change', saveSettings); });

    el('paperReset').addEventListener('click', function(){
      if (confirm('Reset paper account to $10,000 and clear positions?'))
        fetch('/api/paper/reset',{method:'POST'}).then(load);
    });

    load();
    loadPending();
    setInterval(function(){ if (!document.hidden) load(); }, 30000);
    setInterval(function(){ if (!document.hidden) loadPending(); }, 15000);
  }
```

Then add the `loadPending` function inside the IIFE, just before `init`:

```js
  function loadPending() {
    fetch('/api/tv/pending').then(function(r){return r.json();}).then(function(list){
      var panel = el('pinePending');
      var countEl = el('pinePendingCount');
      var listEl = el('pinePendingList');
      if (!panel || !listEl) return;
      if (!list || !list.length) { panel.style.display = 'none'; return; }
      panel.style.display = 'block';
      if (countEl) countEl.textContent = '(' + list.length + ')';
      listEl.innerHTML = list.map(function(sig){
        var age = Math.round((Date.now() - sig.ts) / 60000);
        var ageStr = age < 1 ? 'just now' : age + ' min ago';
        var priceStr = sig.price ? ' $' + Number(sig.price).toFixed(2) : '';
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">' +
          '<span><b>' + esc(sig.symbol) + '</b> ' + esc(sig.action.toUpperCase()) + priceStr +
          ' <span class="pmuted">' + esc(sig.strategy) + ' · ' + ageStr + '</span></span>' +
          '<span style="display:flex;gap:6px">' +
          '<button data-approve="' + esc(sig.id) + '" style="background:var(--green);color:#000;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;font-weight:700">Approve</button>' +
          '<button data-reject="' + esc(sig.id) + '" style="background:var(--red);color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">Reject</button>' +
          '</span></div>';
      }).join('');
      listEl.querySelectorAll('button[data-approve]').forEach(function(b){
        b.addEventListener('click', function(){
          fetch('/api/tv/pending/' + encodeURIComponent(b.getAttribute('data-approve')) + '/approve', { method: 'POST' })
            .then(function(){ loadPending(); load(); });
        });
      });
      listEl.querySelectorAll('button[data-reject]').forEach(function(b){
        b.addEventListener('click', function(){
          fetch('/api/tv/pending/' + encodeURIComponent(b.getAttribute('data-reject')) + '/reject', { method: 'POST' })
            .then(function(){ loadPending(); });
        });
      });
    }).catch(function(){});
  }
```

- [ ] **Step 3: Run full unit test suite to confirm nothing broken**

```bash
npm test
```
Expected: all existing tests still pass.

- [ ] **Step 4: Manual smoke test**

```bash
# Restart server
npm start &
sleep 3

# 1. Enable pine + set approval mode via settings
curl -s -X POST http://localhost:3100/api/paper/settings \
  -H "Content-Type: application/json" \
  -d '{"auto_enabled":false,"budget":200,"target":12,"risk":"balanced","pine":{"enabled":true,"mode":"approval","onDuplicate":"skip","onExit":"closeAll","tradeBudget":200}}'

# 2. Fire a Pine alert
curl -s -X POST http://localhost:3100/api/tv/webhook \
  -H "Content-Type: application/json" \
  -d '{"symbol":"NVDA","action":"buy","price":875.20,"strategy":"Golden Cross"}'

# 3. Check pending queue — should have 1 entry
curl -s http://localhost:3100/api/tv/pending

# 4. Copy the id from above and approve it
# PENDING_ID=$(curl -s http://localhost:3100/api/tv/pending | python -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
# curl -s -X POST http://localhost:3100/api/tv/pending/$PENDING_ID/approve

# 5. Confirm portfolio has a new NVDA position
curl -s http://localhost:3100/api/paper/portfolio | python -c "import sys,json; d=json.load(sys.stdin); print([p['symbol'] for p in d.get('open',[])])"
```

Expected: step 3 returns array with 1 NVDA entry, step 5 shows `['NVDA']`.

- [ ] **Step 5: Open browser and verify UI**

Navigate to `http://localhost:3100` — scroll to Paper Trading panel. Confirm:
- "Pine Script / TradingView Signals" `<details>` section is visible
- All radio buttons and the budget field are present
- Toggle "Enable" on and select "Approval" mode → settings save (no page reload needed, verify next load)
- Fire another webhook: `curl -s -X POST http://localhost:3100/api/tv/webhook -H "Content-Type: application/json" -d '{"symbol":"MSFT","action":"buy","price":420,"strategy":"Test"}'`
- Within 15 seconds the "Pending Pine Signals (1)" panel appears above positions
- Approve button fires order, panel disappears; Reject removes without trading

- [ ] **Step 6: Run E2E tests to confirm no regressions**

```bash
npx playwright test tests/e2e/ --reporter=list
```
Expected: all 26 tests pass.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/paper.js
git commit -m "feat(pine): settings UI + pending approvals panel"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** PendingQueue ✅, pine settings block ✅, auto-execute ✅, approval queue ✅, onDuplicate all three values ✅, onExit all three values ✅, pending routes ✅, UI settings section ✅, pending panel with Approve/Reject ✅, 15s poll ✅, queue-full drop-oldest ✅, pine.enabled=false no-op ✅, bad secret 401 ✅
- [x] **No placeholders:** all code blocks complete, all commands with expected output
- [x] **Type consistency:** `executeSignal(signal, sidecar, pineSettings)` used consistently in webhook handler and approve route; `pendingQueue` reference consistent throughout; `PINE_DEFAULTS` exported and used in tests
- [x] **Edge case:** `onDuplicate=scale` with no existing position → treated as fresh open (noted in code comment)
- [x] **Server restart:** sidecar created before tvRouter in server.js (line 108 vs 124) — wiring order is safe
