# Manager Agent Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a wealth manager maintain clients, portfolios and positions by typing, dropping a screenshot, or speaking — the model proposes a list of actions, the manager reviews and edits them, approved rows execute.

**Architecture:** One multimodal Gemini call turns input + a compact book snapshot into a Zod-validated `ActionPlan`. Code — never the model — resolves tickers, validates numbers, and checks ownership. The plan is stored as a proposal; a separate executor dispatches approved rows through `manager-actions.js`, the same functions the existing HTTP routes call.

**Tech Stack:** Node 22, Express 4, `node:test` + `node:assert`, Supabase JS (service role), Vercel AI SDK v6 (`ai` + `@ai-sdk/google`), Zod v4, vanilla JS frontend, Playwright for E2E.

**Spec:** `docs/superpowers/specs/2026-09-22-manager-agent-entry-design.md`

## Global Constraints

- **No new npm dependencies.** Everything needed (`ai`, `@ai-sdk/google`, `zod`, `@supabase/supabase-js`, `express`) is already in `package.json`. In particular: no `multer` — image and audio reach the server as base64 in a JSON body (see Deviations).
- **Node's built-in test runner only.** `require('node:test')` + `require('node:assert')`. No Jest, no Vitest, no fixtures framework.
- **Dependency-injected factories.** Every service is `createX({ dep1, dep2 })` returning an object, matching `src/alerts-service.js` and `src/analyst-service.js`. Unit tests run fully offline with stubs — no network, no Supabase, no API keys.
- **`'use strict';` as the first line of every new `.js` file.** Repo-wide convention.
- **CommonJS** (`require` / `module.exports`). The repo is not ESM.
- **The agent never writes.** Only `manager-actions.js` touches data, and only from the executor or an HTTP route, always after a human approval.
- **Ownership is enforced inside every action**, not by the caller.
- **Vanilla JS frontend.** No framework, no bundler, no build step. `public/agent.js` is a plain script tag.
- **Provider:** `gemini-2.5-flash` via `config.GEMINI_MODEL`. Never hardcode a model id in service code.
- **Plan size cap:** 25 actions per proposal.
- **Image cap:** longest edge 1568 px, JPEG quality 0.8, downscaled client-side.
- **Existing behaviour must not change.** `npm test` passes at every commit.

## Deviations from the spec

Two, both recorded here so the spec and the code don't silently disagree:

1. **JSON base64 instead of multipart.** The spec's §4.2 says `multipart`. Multipart in Express needs `multer`, a new dependency, for no gain at one file per request. Instead `/parse` takes `application/json` with `image` and `audio` as data URLs. Costs ~33% body size on the wire; the image is already downscaled to ~200 KB, so this is ~270 KB.
2. **The agent router mounts before the global body parser.** `src/server.js:92` sets `express.json({ limit: '64kb' })` app-wide, which would reject any image. The agent router is mounted ahead of it with its own `express.json({ limit: '12mb' })`. The 64 kb cap stays in force for every other route.

---

## File Structure

**Create:**
- `src/manager-actions.js` — the 8 write operations, each owning its ownership check and history write
- `src/agent-schema.js` — the `ActionPlan` Zod schema + per-op field validation
- `src/agent-service.js` — snapshot, parse, validate, execute
- `src/agent-parts.js` — builds the multimodal content parts array
- `src/agent-routes.js` — `POST /parse`, `POST /execute`
- `public/agent.js` — composer, proposal drawer, image downscale, recorder
- `test/helpers/fake-supabase.js` — chainable Supabase stub for unit tests
- `test/manager-actions.test.js`
- `test/agent-schema.test.js`
- `test/agent-service.test.js`
- `test/agent-parts.test.js`
- `tests/e2e/agent.spec.js`
- `supabase-migration-agent.sql`

**Modify:**
- `src/manager-routes.js` — handlers become thin wrappers over `manager-actions.js`
- `src/llm/adapters/google.js` — `generate()` accepts content parts, not only a string
- `src/server.js:92-97` — mount the agent router ahead of the global JSON parser
- `public/manager.html` — composer bar, proposal drawer, `<script src="agent.js">`
- `CLAUDE.md` — new routes, new files, new env knob
- `docs/WEALTH_MANAGER_GUIDE.md` — a section on agent entry

---

### Task 1: Extract `manager-actions.js`

Pure refactor. No agent code, no behaviour change. Ends with the existing test suite and the existing portal both still working.

**Files:**
- Create: `src/manager-actions.js`
- Create: `test/helpers/fake-supabase.js`
- Create: `test/manager-actions.test.js`
- Modify: `src/manager-routes.js`

**Interfaces:**
- Consumes: `getSupabase()` from `src/supabase.js` (already used by `manager-routes.js`).
- Produces:
  ```js
  createManagerActions({ sb }) -> {
    createClient(managerId, input)    // input: { full_name, email?, phone?, risk_profile?, investment_goal?, notes? }
    updateClient(managerId, input)    // input: { clientId, ...fields }
    deleteClient(managerId, input)    // input: { clientId }
    createPortfolio(managerId, input) // input: { clientId, name, color?, strategy? }
    addPosition(managerId, input)     // input: { portfolioId, symbol, entry_price, shares?, avg_cost?, target_sell_price?, stop_loss_price?, note?, source?, proposalId? }
    updatePosition(managerId, input)  // input: { positionId, ...fields, source?, proposalId? }
    sellPosition(managerId, input)    // input: { positionId, sell_price, note?, source?, proposalId? }
    deletePosition(managerId, input)  // input: { positionId }
  }
  ```
  Every operation resolves to `{ ok: true, data }` or `{ ok: false, error: '<message>', code: <http status> }`. No throwing for expected failures.

- [ ] **Step 1: Write the fake Supabase helper**

Create `test/helpers/fake-supabase.js`:

```js
'use strict';

// Minimal chainable stand-in for the Supabase JS client, covering exactly the
// surface manager-actions.js uses: from().select().eq().order().single(),
// .insert().select().single(), .update().eq().select().single(), .delete().eq().
//
// `tables` maps table name -> array of row objects. Writes are recorded in
// `calls` so tests can assert what would have been sent.
function fakeSupabase(tables = {}) {
  const calls = [];

  function from(table) {
    const state = { table, filters: {}, op: 'select', payload: null };

    function matches(row) {
      return Object.entries(state.filters).every(([col, val]) => {
        // "a.b.c" filters (Supabase embedded-resource filters) are treated as
        // satisfied — ownership in the real client is enforced by the join.
        if (col.includes('.')) return true;
        return row[col] === val;
      });
    }

    function resolve() {
      const rows = (tables[state.table] || []).filter(matches);
      if (state.op === 'insert') {
        const created = { id: `new-${state.table}-${calls.length}`, ...state.payload };
        calls.push({ op: 'insert', table: state.table, row: state.payload });
        // Persist it, so a later query in the same test finds it — the executor
        // threads created ids into dependent rows and re-checks ownership.
        if (!tables[state.table]) tables[state.table] = [];
        tables[state.table].push(created);
        return { data: created, rows: [created] };
      }
      if (state.op === 'update') {
        calls.push({ op: 'update', table: state.table, row: state.payload, filters: { ...state.filters } });
        const updated = { ...(rows[0] || {}), ...state.payload };
        return { data: updated, rows: [updated] };
      }
      if (state.op === 'delete') {
        calls.push({ op: 'delete', table: state.table, filters: { ...state.filters } });
        return { data: null, rows: [] };
      }
      return { data: rows[0] || null, rows };
    }

    const api = {
      select() { return api; },
      order() { return api; },
      limit() { return api; },
      eq(col, val) { state.filters[col] = val; return api; },
      insert(payload) { state.op = 'insert'; state.payload = payload; return api; },
      update(payload) { state.op = 'update'; state.payload = payload; return api; },
      delete() { state.op = 'delete'; return api; },
      async single() {
        const { data } = resolve();
        if (!data) return { data: null, error: { message: 'not found' } };
        return { data, error: null };
      },
      then(onOk, onErr) {
        const { rows } = resolve();
        return Promise.resolve({ data: rows, error: null }).then(onOk, onErr);
      },
    };
    return api;
  }

  return { from, calls };
}

module.exports = { fakeSupabase };
```

- [ ] **Step 2: Write the failing tests**

Create `test/manager-actions.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeSupabase } = require('./helpers/fake-supabase');
const { createManagerActions } = require('../src/manager-actions');

const MANAGER = 'mgr-1';

function seed() {
  return fakeSupabase({
    manager_clients: [{ id: 'c1', manager_id: MANAGER, full_name: 'Jane Smith' }],
    client_portfolios: [{ id: 'p1', client_id: 'c1', name: 'Growth' }],
    portfolio_positions: [{ id: 'pos1', portfolio_id: 'p1', symbol: 'NVDA', entry_price: 100, shares: 10 }],
  });
}

test('createClient requires full_name', async () => {
  const actions = createManagerActions({ sb: seed() });
  const r = await actions.createClient(MANAGER, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
});

test('createClient stamps manager_id from the caller, never the input', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  const r = await actions.createClient(MANAGER, { full_name: 'New Guy', manager_id: 'someone-else' });
  assert.equal(r.ok, true);
  const insert = sb.calls.find((c) => c.op === 'insert' && c.table === 'manager_clients');
  assert.equal(insert.row.manager_id, MANAGER);
});

test('addPosition writes a BUY history event', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  const r = await actions.addPosition(MANAGER, { portfolioId: 'p1', symbol: 'aapl', entry_price: 182.5, shares: 10 });
  assert.equal(r.ok, true);
  const hist = sb.calls.find((c) => c.op === 'insert' && c.table === 'position_history');
  assert.equal(hist.row.event_type, 'BUY');
  assert.equal(hist.row.symbol, 'AAPL');           // uppercased
  assert.equal(hist.row.total_value, 1825);
});

test('addPosition rejects a portfolio the manager does not own', async () => {
  const sb = fakeSupabase({ client_portfolios: [] });   // no rows -> not found
  const actions = createManagerActions({ sb });
  const r = await actions.addPosition(MANAGER, { portfolioId: 'nope', symbol: 'AAPL', entry_price: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
});

test('addPosition requires symbol and entry_price', async () => {
  const actions = createManagerActions({ sb: seed() });
  assert.equal((await actions.addPosition(MANAGER, { portfolioId: 'p1', symbol: 'AAPL' })).code, 400);
  assert.equal((await actions.addPosition(MANAGER, { portfolioId: 'p1', entry_price: 5 })).code, 400);
});

test('sellPosition records gain_pct and deletes the position', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  const r = await actions.sellPosition(MANAGER, { positionId: 'pos1', sell_price: 150 });
  assert.equal(r.ok, true);
  assert.equal(Math.round(r.data.gain_pct), 50);
  const hist = sb.calls.find((c) => c.op === 'insert' && c.table === 'position_history');
  assert.equal(hist.row.event_type, 'SELL');
  assert.ok(sb.calls.some((c) => c.op === 'delete' && c.table === 'portfolio_positions'));
});

test('source defaults to manual and is carried through to history', async () => {
  const sb = seed();
  const actions = createManagerActions({ sb });
  await actions.addPosition(MANAGER, { portfolioId: 'p1', symbol: 'AAPL', entry_price: 10 });
  await actions.addPosition(MANAGER, { portfolioId: 'p1', symbol: 'MSFT', entry_price: 20, source: 'agent', proposalId: 'prop-9' });
  const hists = sb.calls.filter((c) => c.op === 'insert' && c.table === 'position_history');
  assert.equal(hists[0].row.source, 'manual');
  assert.equal(hists[1].row.source, 'agent');
  assert.equal(hists[1].row.proposal_id, 'prop-9');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="manager"`
Expected: FAIL — `Cannot find module '../src/manager-actions'`

- [ ] **Step 4: Write `src/manager-actions.js`**

```js
'use strict';

// Every write operation on the Wealth Manager data model, in one place.
//
// Each function takes the authenticated managerId and does its OWN ownership
// check — callers cannot forget it. Two callers exist: the HTTP routes in
// manager-routes.js, and the agent executor in agent-service.js.
//
// Expected failures return { ok: false, error, code }; they never throw.

function fail(code, error) { return { ok: false, error, code }; }
function done(data) { return { ok: true, data }; }

function createManagerActions({ sb }) {
  // ── ownership helpers ───────────────────────────────────────────────────
  async function ownedClient(managerId, clientId) {
    const { data } = await sb.from('manager_clients')
      .select('id').eq('id', clientId).eq('manager_id', managerId).single();
    return data || null;
  }

  async function ownedPortfolio(managerId, portfolioId) {
    const { data } = await sb.from('client_portfolios')
      .select('id, client_id, manager_clients!inner(manager_id)')
      .eq('id', portfolioId).eq('manager_clients.manager_id', managerId).single();
    return data || null;
  }

  async function ownedPosition(managerId, positionId) {
    const { data } = await sb.from('portfolio_positions')
      .select('id, portfolio_id, symbol, entry_price, shares, client_portfolios!inner(manager_clients!inner(manager_id))')
      .eq('id', positionId)
      .eq('client_portfolios.manager_clients.manager_id', managerId).single();
    return data || null;
  }

  async function history(row) {
    await sb.from('position_history').insert({
      source: row.source || 'manual',
      proposal_id: row.proposalId || null,
      position_id: row.position_id,
      portfolio_id: row.portfolio_id,
      symbol: row.symbol,
      event_type: row.event_type,
      price: row.price,
      shares: row.shares == null ? null : row.shares,
      total_value: row.shares != null && row.price != null ? row.shares * row.price : null,
      gain_pct: row.gain_pct == null ? null : row.gain_pct,
      note: row.note || null,
    });
  }

  const num = (v) => (v === '' || v == null ? null : Number(v));

  // ── clients ─────────────────────────────────────────────────────────────
  async function createClient(managerId, input = {}) {
    if (!input.full_name) return fail(400, 'full_name required');
    const { data, error } = await sb.from('manager_clients').insert({
      manager_id: managerId,                       // from the session, never the input
      full_name: input.full_name,
      email: input.email || null,
      phone: input.phone || null,
      risk_profile: input.risk_profile || 'moderate',
      investment_goal: input.investment_goal || null,
      notes: input.notes || null,
    }).select().single();
    if (error) return fail(500, error.message);
    return done(data);
  }

  async function updateClient(managerId, input = {}) {
    if (!input.clientId) return fail(400, 'clientId required');
    const allowed = ['full_name', 'email', 'phone', 'risk_profile', 'investment_goal', 'notes', 'is_active'];
    const updates = {};
    for (const k of allowed) if (input[k] !== undefined) updates[k] = input[k];
    if (!Object.keys(updates).length) return fail(400, 'no fields to update');

    const { data, error } = await sb.from('manager_clients')
      .update(updates).eq('id', input.clientId).eq('manager_id', managerId).select().single();
    if (error) return fail(500, error.message);
    if (!data) return fail(404, 'Client not found');
    return done(data);
  }

  async function deleteClient(managerId, input = {}) {
    if (!input.clientId) return fail(400, 'clientId required');
    const { error } = await sb.from('manager_clients')
      .delete().eq('id', input.clientId).eq('manager_id', managerId);
    if (error) return fail(500, error.message);
    return done({ ok: true });
  }

  // ── portfolios ──────────────────────────────────────────────────────────
  async function createPortfolio(managerId, input = {}) {
    if (!input.clientId) return fail(400, 'clientId required');
    if (!input.name) return fail(400, 'name required');
    if (!(await ownedClient(managerId, input.clientId))) return fail(404, 'Client not found');

    const { data, error } = await sb.from('client_portfolios').insert({
      client_id: input.clientId,
      name: input.name,
      color: input.color || '#5b8cff',
      strategy: input.strategy || null,
    }).select().single();
    if (error) return fail(500, error.message);
    return done(data);
  }

  // ── positions ───────────────────────────────────────────────────────────
  async function addPosition(managerId, input = {}) {
    if (!input.portfolioId) return fail(400, 'portfolioId required');
    if (!input.symbol) return fail(400, 'symbol required');
    const entry = num(input.entry_price);
    if (!entry || !(entry > 0)) return fail(400, 'entry_price required');
    if (!(await ownedPortfolio(managerId, input.portfolioId))) return fail(404, 'Portfolio not found');

    const symbol = String(input.symbol).toUpperCase();
    const shares = num(input.shares);

    const { data: pos, error } = await sb.from('portfolio_positions').insert({
      portfolio_id: input.portfolioId,
      symbol,
      shares,
      avg_cost: num(input.avg_cost),
      entry_price: entry,
      target_sell_price: num(input.target_sell_price),
      stop_loss_price: num(input.stop_loss_price),
      note: input.note || null,
    }).select().single();
    if (error) return fail(500, error.message);

    await history({
      position_id: pos.id, portfolio_id: input.portfolioId, symbol,
      event_type: 'BUY', price: entry, shares, note: input.note,
      source: input.source, proposalId: input.proposalId,
    });
    return done(pos);
  }

  async function updatePosition(managerId, input = {}) {
    if (!input.positionId) return fail(400, 'positionId required');
    const pos = await ownedPosition(managerId, input.positionId);
    if (!pos) return fail(404, 'Position not found');

    const allowed = ['entry_price', 'shares', 'avg_cost', 'target_sell_price', 'stop_loss_price', 'note'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (input[k] !== undefined) updates[k] = input[k];

    const { data, error } = await sb.from('portfolio_positions')
      .update(updates).eq('id', input.positionId).select().single();
    if (error) return fail(500, error.message);

    const price = input.entry_price != null ? num(input.entry_price) : pos.entry_price;
    const shares = input.shares != null ? num(input.shares) : pos.shares;
    await history({
      position_id: pos.id, portfolio_id: pos.portfolio_id, symbol: pos.symbol,
      event_type: 'REBALANCE', price, shares, note: input.note || 'Position updated',
      source: input.source, proposalId: input.proposalId,
    });
    return done(data);
  }

  async function sellPosition(managerId, input = {}) {
    if (!input.positionId) return fail(400, 'positionId required');
    const pos = await ownedPosition(managerId, input.positionId);
    if (!pos) return fail(404, 'Position not found');

    const sell = num(input.sell_price) || pos.entry_price;
    if (!(sell > 0)) return fail(400, 'sell_price must be positive');
    const gain_pct = pos.entry_price ? ((sell - pos.entry_price) / pos.entry_price) * 100 : 0;

    await history({
      position_id: pos.id, portfolio_id: pos.portfolio_id, symbol: pos.symbol,
      event_type: 'SELL', price: sell, shares: pos.shares, gain_pct, note: input.note,
      source: input.source, proposalId: input.proposalId,
    });

    const { error } = await sb.from('portfolio_positions').delete().eq('id', input.positionId);
    if (error) return fail(500, error.message);
    return done({ ok: true, gain_pct, symbol: pos.symbol });
  }

  async function deletePosition(managerId, input = {}) {
    if (!input.positionId) return fail(400, 'positionId required');
    if (!(await ownedPosition(managerId, input.positionId))) return fail(404, 'Position not found');
    const { error } = await sb.from('portfolio_positions').delete().eq('id', input.positionId);
    if (error) return fail(500, error.message);
    return done({ ok: true });
  }

  return {
    createClient, updateClient, deleteClient,
    createPortfolio,
    addPosition, updatePosition, sellPosition, deletePosition,
  };
}

module.exports = { createManagerActions };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="manager"`
Expected: PASS, 7 tests.

- [ ] **Step 6: Rewrite the matching handlers in `manager-routes.js` as wrappers**

At the top of `createManagerRouter()`, after `const router = express.Router();`, add:

```js
  const { createManagerActions } = require('./manager-actions');

  // Map an action result onto the HTTP response.
  function send(res, result, okStatus = 200) {
    if (!result.ok) return res.status(result.code).json({ error: result.error });
    return res.status(okStatus).json(result.data);
  }
  const actionsFor = () => createManagerActions({ sb: getSupabase() });
```

Replace the body of each of these eight handlers with a wrapper. `POST /clients` becomes:

```js
  router.post('/clients', async (req, res) =>
    send(res, await actionsFor().createClient(req.user.id, req.body || {}), 201));
```

`PUT /clients/:id`:

```js
  router.put('/clients/:id', async (req, res) =>
    send(res, await actionsFor().updateClient(req.user.id, { ...req.body, clientId: req.params.id })));
```

`DELETE /clients/:id`:

```js
  router.delete('/clients/:id', async (req, res) =>
    send(res, await actionsFor().deleteClient(req.user.id, { clientId: req.params.id })));
```

`POST /clients/:clientId/portfolios`:

```js
  router.post('/clients/:clientId/portfolios', async (req, res) =>
    send(res, await actionsFor().createPortfolio(req.user.id, { ...req.body, clientId: req.params.clientId }), 201));
```

`POST /portfolios/:portfolioId/positions`:

```js
  router.post('/portfolios/:portfolioId/positions', async (req, res) =>
    send(res, await actionsFor().addPosition(req.user.id, { ...req.body, portfolioId: req.params.portfolioId }), 201));
```

`PUT /positions/:id`:

```js
  router.put('/positions/:id', async (req, res) =>
    send(res, await actionsFor().updatePosition(req.user.id, { ...req.body, positionId: req.params.id })));
```

`DELETE /positions/:id` keeps its two-mode behaviour — `delete_only` skips the SELL event:

```js
  router.delete('/positions/:id', async (req, res) => {
    const managerId = req.user.id;
    const a = actionsFor();
    if (req.body && req.body.delete_only) {
      return send(res, await a.deletePosition(managerId, { positionId: req.params.id }));
    }
    return send(res, await a.sellPosition(managerId, {
      positionId: req.params.id, sell_price: req.body && req.body.sell_price, note: req.body && req.body.note,
    }));
  });
```

**Leave untouched:** `/auth/*`, `/share/*`, all `GET` handlers, and `DELETE /portfolios/:id`. They are reads, auth, or the deliberately-excluded portfolio delete.

- [ ] **Step 7: Verify the whole suite still passes**

Run: `npm test`
Expected: PASS — all pre-existing tests plus the 7 new ones. No test should change behaviour.

- [ ] **Step 8: Smoke-test the portal by hand**

Run: `npm start`, open `http://localhost:3000/login.html`, sign in, then: add a client, add a portfolio, add a position, edit it, sell it. Each must behave exactly as before, and the history timeline must show BUY / REBALANCE / SELL.

- [ ] **Step 9: Commit**

```bash
git add src/manager-actions.js src/manager-routes.js test/manager-actions.test.js test/helpers/fake-supabase.js
git commit -m "refactor(manager): extract write operations into manager-actions

Ownership checks and history writes move inside each action, so callers
cannot forget the manager_id filter. Routes become thin wrappers. No
behaviour change."
```

---

### Task 2: The `ActionPlan` contract and validation

No LLM yet. This task defines the schema and the code-side validation that makes a model's output safe to show a human.

**Files:**
- Create: `src/agent-schema.js`
- Create: `test/agent-schema.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```js
  OPS                                  // string[] of the 8 allowed ops
  ActionPlanSchema                     // Zod schema
  MAX_ACTIONS = 25
  validatePlan(plan, snapshot) -> { actions: ValidatedAction[], errors: string[] }
  // ValidatedAction = action + { valid: boolean, problems: string[] }
  // snapshot = { clients: [{id, full_name, risk_profile}],
  //              portfolios: [{id, client_id, name}],
  //              positions: [{id, portfolio_id, symbol}] }
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/agent-schema.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ActionPlanSchema, validatePlan, MAX_ACTIONS } = require('../src/agent-schema');

const SNAP = {
  clients: [{ id: 'c1', full_name: 'Jane Smith', risk_profile: 'moderate' }],
  portfolios: [{ id: 'p1', client_id: 'c1', name: 'Growth' }],
  positions: [{ id: 'pos1', portfolio_id: 'p1', symbol: 'NVDA' }],
};

function action(over = {}) {
  return {
    op: 'addPosition', ref: 'a1', dependsOn: null,
    target: { clientId: null, portfolioId: 'p1', positionId: null },
    fields: { symbol: 'AAPL', entry_price: 182.5, shares: 10 },
    confidence: 0.9, source: 'row 1 of the screenshot', reasoning: 'holdings table',
    ...over,
  };
}
const plan = (actions) => ({ actions, clarification: null, summary: 's', transcript: null });

test('an op outside the enum is rejected by the schema', () => {
  const r = ActionPlanSchema.safeParse(plan([action({ op: 'dropTable' })]));
  assert.equal(r.success, false);
});

test('a well-formed plan validates clean', () => {
  const { actions, errors } = validatePlan(ActionPlanSchema.parse(plan([action()])), SNAP);
  assert.deepEqual(errors, []);
  assert.equal(actions[0].valid, true);
});

test('an invented portfolioId is rejected', () => {
  const a = action({ target: { clientId: null, portfolioId: 'p-nope', positionId: null } });
  const { actions } = validatePlan(plan([a]), SNAP);
  assert.equal(actions[0].valid, false);
  assert.match(actions[0].problems.join(' '), /portfolioId/);
});

test('a non-numeric entry_price is rejected', () => {
  const a = action({ fields: { symbol: 'AAPL', entry_price: 'abc' } });
  const { actions } = validatePlan(plan([a]), SNAP);
  assert.equal(actions[0].valid, false);
  assert.match(actions[0].problems.join(' '), /entry_price/);
});

test('a negative entry_price is rejected', () => {
  const a = action({ fields: { symbol: 'AAPL', entry_price: -5 } });
  const { actions } = validatePlan(plan([a]), SNAP);
  assert.equal(actions[0].valid, false);
});

test('createClient without full_name is rejected', () => {
  const a = action({ op: 'createClient', target: { clientId: null, portfolioId: null, positionId: null }, fields: {} });
  const { actions } = validatePlan(plan([a]), SNAP);
  assert.equal(actions[0].valid, false);
  assert.match(actions[0].problems.join(' '), /full_name/);
});

test('a target may be a ref of an earlier create in the same plan', () => {
  const p = plan([
    action({ op: 'createClient', ref: 'a1', target: { clientId: null, portfolioId: null, positionId: null }, fields: { full_name: 'New Guy' } }),
    action({ op: 'createPortfolio', ref: 'a2', dependsOn: 'a1', target: { clientId: '@a1', portfolioId: null, positionId: null }, fields: { name: 'Growth' } }),
  ]);
  const { actions } = validatePlan(p, SNAP);
  assert.equal(actions[0].valid, true);
  assert.equal(actions[1].valid, true);
});

test('dependsOn pointing at an unknown ref is rejected', () => {
  const a = action({ dependsOn: 'a9' });
  const { actions } = validatePlan(plan([a]), SNAP);
  assert.equal(actions[0].valid, false);
  assert.match(actions[0].problems.join(' '), /dependsOn/);
});

test('a dependency cycle is rejected', () => {
  const p = plan([
    action({ ref: 'a1', dependsOn: 'a2' }),
    action({ ref: 'a2', dependsOn: 'a1' }),
  ]);
  const { errors } = validatePlan(p, SNAP);
  assert.match(errors.join(' '), /cycle/i);
});

test('a plan over MAX_ACTIONS is rejected wholesale', () => {
  const many = Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => action({ ref: `a${i}` }));
  const { errors } = validatePlan(plan(many), SNAP);
  assert.match(errors.join(' '), /25/);
});

test('sellPosition needs a positive sell_price and a known positionId', () => {
  const ok = action({ op: 'sellPosition', target: { clientId: null, portfolioId: null, positionId: 'pos1' }, fields: { sell_price: 190 } });
  const bad = action({ op: 'sellPosition', target: { clientId: null, portfolioId: null, positionId: 'pos1' }, fields: { sell_price: 0 } });
  assert.equal(validatePlan(plan([ok]), SNAP).actions[0].valid, true);
  assert.equal(validatePlan(plan([bad]), SNAP).actions[0].valid, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/agent-schema.test.js`
Expected: FAIL — `Cannot find module '../src/agent-schema'`

- [ ] **Step 3: Write `src/agent-schema.js`**

```js
'use strict';
const { z } = require('zod');

// The contract between the model and the portal. The model proposes; this file
// decides whether a proposal is even showable to a human.

const OPS = [
  'createClient', 'updateClient', 'deleteClient',
  'createPortfolio',
  'addPosition', 'updatePosition', 'sellPosition', 'deletePosition',
];

const MAX_ACTIONS = 25;

const ActionSchema = z.object({
  op: z.enum(OPS),
  ref: z.string().min(1),
  dependsOn: z.string().nullable().default(null),
  target: z.object({
    clientId: z.string().nullable().default(null),
    portfolioId: z.string().nullable().default(null),
    positionId: z.string().nullable().default(null),
  }),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  confidence: z.number().min(0).max(1),
  source: z.string().default(''),
  reasoning: z.string().default(''),
});

const ActionPlanSchema = z.object({
  actions: z.array(ActionSchema).default([]),
  clarification: z.string().nullable().default(null),
  summary: z.string().default(''),
  transcript: z.string().nullable().default(null),
});

// Which target ids each op needs, and which fields are mandatory.
const RULES = {
  createClient:    { needs: [],              required: ['full_name'] },
  updateClient:    { needs: ['clientId'],    required: [] },
  deleteClient:    { needs: ['clientId'],    required: [] },
  createPortfolio: { needs: ['clientId'],    required: ['name'] },
  addPosition:     { needs: ['portfolioId'], required: ['symbol', 'entry_price'] },
  updatePosition:  { needs: ['positionId'],  required: [] },
  sellPosition:    { needs: ['positionId'],  required: ['sell_price'] },
  deletePosition:  { needs: ['positionId'],  required: [] },
};

// Numeric fields and their constraint. A field absent is fine; a field present
// and unparseable is not.
const NUMERIC = {
  entry_price:       (n) => n > 0,
  sell_price:        (n) => n > 0,
  shares:            (n) => n >= 0,
  avg_cost:          (n) => n > 0,
  target_sell_price: (n) => n > 0,
  stop_loss_price:   (n) => n > 0,
};

// "@a1" means "the id created by the action with ref a1" — resolved at execute
// time, so it is valid here as long as a1 exists in this plan.
const isRef = (v) => typeof v === 'string' && v.startsWith('@');

function detectCycle(actions) {
  const byRef = new Map(actions.map((a) => [a.ref, a]));
  for (const start of actions) {
    const seen = new Set();
    let cur = start;
    while (cur && cur.dependsOn) {
      if (seen.has(cur.ref)) return true;
      seen.add(cur.ref);
      cur = byRef.get(cur.dependsOn);
      if (cur && cur.ref === start.ref) return true;
    }
  }
  return false;
}

function validatePlan(plan, snapshot) {
  const errors = [];
  const actions = Array.isArray(plan && plan.actions) ? plan.actions : [];

  if (actions.length > MAX_ACTIONS) {
    return { actions: [], errors: [`Plan has ${actions.length} actions; the limit is ${MAX_ACTIONS}.`] };
  }
  if (detectCycle(actions)) {
    return { actions: [], errors: ['Plan contains a dependency cycle.'] };
  }

  const refs = new Set(actions.map((a) => a.ref));
  const clientIds = new Set((snapshot.clients || []).map((c) => c.id));
  const portfolioIds = new Set((snapshot.portfolios || []).map((p) => p.id));
  const positionIds = new Set((snapshot.positions || []).map((p) => p.id));
  const known = { clientId: clientIds, portfolioId: portfolioIds, positionId: positionIds };

  const validated = actions.map((a) => {
    const problems = [];
    const rule = RULES[a.op];
    if (!rule) problems.push(`Unknown op "${a.op}".`);

    if (a.dependsOn && !refs.has(a.dependsOn)) {
      problems.push(`dependsOn "${a.dependsOn}" is not a ref in this plan.`);
    }

    if (rule) {
      for (const key of rule.needs) {
        const val = a.target && a.target[key];
        if (!val) problems.push(`${key} is required for ${a.op}.`);
        else if (isRef(val)) {
          if (!refs.has(val.slice(1))) problems.push(`${key} refers to "${val}", which is not in this plan.`);
        } else if (!known[key].has(val)) {
          problems.push(`${key} "${val}" is not one of your records.`);
        }
      }
      for (const key of rule.required) {
        const v = a.fields ? a.fields[key] : undefined;
        if (v === undefined || v === null || v === '') problems.push(`${key} is required for ${a.op}.`);
      }
    }

    for (const [key, ok] of Object.entries(NUMERIC)) {
      if (!a.fields || a.fields[key] === undefined || a.fields[key] === null) continue;
      const n = Number(a.fields[key]);
      if (!Number.isFinite(n)) problems.push(`${key} "${a.fields[key]}" is not a number.`);
      else if (!ok(n)) problems.push(`${key} ${n} is out of range.`);
    }

    return { ...a, valid: problems.length === 0, problems };
  });

  return { actions: validated, errors };
}

module.exports = { OPS, MAX_ACTIONS, ActionSchema, ActionPlanSchema, validatePlan };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/agent-schema.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent-schema.js test/agent-schema.test.js
git commit -m "feat(agent): ActionPlan schema and code-side validation

Closed op enum, per-op required fields, numeric range checks, entity ids
checked against the caller's own snapshot, in-plan @ref dependencies and
cycle detection."
```

---

### Task 3: `agent-service.js` — snapshot, parse, execute (text only)

The core, tested entirely offline against a stub adapter and the fake Supabase client.

**Files:**
- Create: `src/agent-service.js`
- Create: `test/agent-service.test.js`

**Interfaces:**
- Consumes: `createManagerActions` (Task 1), `ActionPlanSchema` / `validatePlan` (Task 2).
- Produces:
  ```js
  createAgentService({ sb, adapter, actions, searchSymbols, buildParts }) -> {
    buildSnapshot(managerId) -> { clients, portfolios, positions }
    parse({ managerId, text, image, audio, context }) -> { proposalId, plan, actions, errors, snapshot }
    execute({ managerId, proposalId, rows }) -> { results: [{ ref, op, ok, error?, data? }] }
  }
  ```
  `adapter` is `{ name, generate(promptOrParts, schema) }` — the existing adapter shape.
  `searchSymbols(q)` resolves to `[{ symbol, description }]`.
  `buildParts` is Task 4's; in this task it defaults to returning the prompt string unchanged.

- [ ] **Step 1: Write the failing tests**

Create `test/agent-service.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeSupabase } = require('./helpers/fake-supabase');
const { createAgentService } = require('../src/agent-service');
const { createManagerActions } = require('../src/manager-actions');

const MANAGER = 'mgr-1';

function seedSb() {
  return fakeSupabase({
    manager_clients: [{ id: 'c1', manager_id: MANAGER, full_name: 'Jane Smith', risk_profile: 'moderate' }],
    client_portfolios: [{ id: 'p1', client_id: 'c1', name: 'Growth' }],
    portfolio_positions: [{ id: 'pos1', portfolio_id: 'p1', symbol: 'NVDA', entry_price: 100, shares: 10 }],
  });
}

function svc({ plan, sb = seedSb(), searchSymbols = async (q) => [{ symbol: String(q).toUpperCase(), description: 'x' }] }) {
  let calls = 0;
  const adapter = { name: 'stub', async generate() { calls++; return plan; } };
  const service = createAgentService({
    sb, adapter, actions: createManagerActions({ sb }), searchSymbols,
  });
  return { service, sb, adapterCalls: () => calls };
}

const basePlan = (actions, over = {}) => ({ actions, clarification: null, summary: 'ok', transcript: null, ...over });

test('buildSnapshot returns ids and names only — no money', async () => {
  const { service } = svc({ plan: basePlan([]) });
  const snap = await service.buildSnapshot(MANAGER);
  assert.deepEqual(Object.keys(snap).sort(), ['clients', 'portfolios', 'positions']);
  assert.equal(snap.clients[0].full_name, 'Jane Smith');
  assert.equal(snap.positions[0].entry_price, undefined);
  assert.equal(snap.positions[0].shares, undefined);
});

test('parse validates the model output against the snapshot', async () => {
  const plan = basePlan([{
    op: 'addPosition', ref: 'a1', dependsOn: null,
    target: { clientId: null, portfolioId: 'p1', positionId: null },
    fields: { symbol: 'AAPL', entry_price: 182.5, shares: 10 },
    confidence: 0.92, source: '"bought 10 AAPL at 182.50"', reasoning: 'explicit buy',
  }]);
  const { service } = svc({ plan });
  const out = await service.parse({ managerId: MANAGER, text: 'bought 10 AAPL at 182.50', context: { selectedPortfolioId: 'p1' } });
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].valid, true);
  assert.ok(out.proposalId);
});

test('parse flags an action whose ticker does not resolve', async () => {
  const plan = basePlan([{
    op: 'addPosition', ref: 'a1', dependsOn: null,
    target: { clientId: null, portfolioId: 'p1', positionId: null },
    fields: { symbol: 'ZZZZZZ', entry_price: 10 },
    confidence: 0.5, source: '', reasoning: '',
  }]);
  const { service } = svc({ plan, searchSymbols: async () => [] });
  const out = await service.parse({ managerId: MANAGER, text: 'buy ZZZZZZ' });
  assert.equal(out.actions[0].valid, false);
  assert.match(out.actions[0].problems.join(' '), /ZZZZZZ/);
});

test('parse normalises a resolved ticker to its canonical symbol', async () => {
  const plan = basePlan([{
    op: 'addPosition', ref: 'a1', dependsOn: null,
    target: { clientId: null, portfolioId: 'p1', positionId: null },
    fields: { symbol: 'apple', entry_price: 10 },
    confidence: 0.6, source: '', reasoning: '',
  }]);
  const { service } = svc({ plan, searchSymbols: async () => [{ symbol: 'AAPL', description: 'Apple Inc' }] });
  const out = await service.parse({ managerId: MANAGER, text: 'buy apple' });
  assert.equal(out.actions[0].fields.symbol, 'AAPL');
  assert.equal(out.actions[0].valid, true);
});

test('parse retries once when the model returns something unparseable', async () => {
  let n = 0;
  const sb = seedSb();
  const adapter = { name: 'stub', async generate() {
    n++;
    if (n === 1) return { actions: [{ op: 'nope' }] };
    return basePlan([]);
  } };
  const service = createAgentService({ sb, adapter, actions: createManagerActions({ sb }), searchSymbols: async () => [] });
  const out = await service.parse({ managerId: MANAGER, text: 'hi' });
  assert.equal(n, 2);
  assert.equal(out.actions.length, 0);
});

test('parse surfaces a clarification with no actions', async () => {
  const { service } = svc({ plan: basePlan([], { clarification: 'Which client?' }) });
  const out = await service.parse({ managerId: MANAGER, text: 'add 10 NVDA at 182' });
  assert.equal(out.plan.clarification, 'Which client?');
  assert.equal(out.actions.length, 0);
});

test('execute runs approved rows and reports per row', async () => {
  const { service, sb } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-1', rows: [
    { op: 'addPosition', ref: 'a1', dependsOn: null, target: { portfolioId: 'p1' }, fields: { symbol: 'AAPL', entry_price: 10, shares: 2 } },
  ] });
  assert.equal(out.results[0].ok, true);
  const hist = sb.calls.find((c) => c.op === 'insert' && c.table === 'position_history');
  assert.equal(hist.row.source, 'agent');
  assert.equal(hist.row.proposal_id, 'prop-1');
});

test('execute rejects an edited row pointing at a portfolio the manager does not own', async () => {
  const { service } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-1', rows: [
    { op: 'addPosition', ref: 'a1', dependsOn: null, target: { portfolioId: 'someone-elses' }, fields: { symbol: 'AAPL', entry_price: 10 } },
  ] });
  assert.equal(out.results[0].ok, false);
});

test('execute threads a created id into dependent rows', async () => {
  const { service, sb } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-2', rows: [
    { op: 'createClient', ref: 'a1', dependsOn: null, target: {}, fields: { full_name: 'New Guy' } },
    { op: 'createPortfolio', ref: 'a2', dependsOn: 'a1', target: { clientId: '@a1' }, fields: { name: 'Growth' } },
  ] });
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[1].ok, true);
  const pf = sb.calls.find((c) => c.op === 'insert' && c.table === 'client_portfolios');
  assert.equal(pf.row.client_id, out.results[0].data.id);
});

test('execute skips dependents when their dependency fails', async () => {
  const { service } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-3', rows: [
    { op: 'createClient', ref: 'a1', dependsOn: null, target: {}, fields: {} },             // no full_name -> fails
    { op: 'createPortfolio', ref: 'a2', dependsOn: 'a1', target: { clientId: '@a1' }, fields: { name: 'Growth' } },
  ] });
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[1].ok, false);
  assert.match(out.results[1].error, /skipped/i);
});

test('execute runs independent rows even when a sibling fails', async () => {
  const { service } = svc({ plan: basePlan([]) });
  const out = await service.execute({ managerId: MANAGER, proposalId: 'prop-4', rows: [
    { op: 'addPosition', ref: 'a1', dependsOn: null, target: { portfolioId: 'p1' }, fields: { symbol: 'AAPL' } },  // no entry_price
    { op: 'addPosition', ref: 'a2', dependsOn: null, target: { portfolioId: 'p1' }, fields: { symbol: 'MSFT', entry_price: 20 } },
  ] });
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[1].ok, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/agent-service.test.js`
Expected: FAIL — `Cannot find module '../src/agent-service'`

- [ ] **Step 3: Write `src/agent-service.js`**

```js
'use strict';

const { ActionPlanSchema, validatePlan, MAX_ACTIONS, OPS } = require('./agent-schema');

// The agent layer. Produces proposals; never writes. Writes go through the
// injected `actions` (src/manager-actions.js), which is also what the HTTP
// routes use, so agent entries and manual entries are the same operation.

function systemPrompt(snapshot, context) {
  return [
    'You are a data-entry assistant for a wealth manager\'s portfolio book.',
    'Turn the manager\'s input into a list of proposed actions. A human reviews',
    'every action before anything is saved, so propose what the input actually says —',
    'do not invent positions, prices, or people.',
    '',
    'RULES:',
    `- Use only these ops: ${OPS.join(', ')}.`,
    '- Every clientId / portfolioId / positionId MUST be an id from the RECORDS below,',
    '  or "@<ref>" naming an earlier action in this same plan that creates it.',
    '- If you cannot tell which client or portfolio is meant, return no actions and',
    '  set "clarification" to the single question that would resolve it.',
    '- If a name is ambiguous, still propose the action but set confidence below 0.6',
    '  and list the candidate ids in fields._candidates as a comma-separated string.',
    '- "source" must quote the words or describe the part of the image each action came from.',
    `- At most ${MAX_ACTIONS} actions.`,
    '- If audio was provided, put what you heard in "transcript".',
    '',
    'RECORDS:',
    JSON.stringify(snapshot),
    '',
    'CURRENT SELECTION (use when the input does not name a client or portfolio):',
    JSON.stringify(context || {}),
  ].join('\n');
}

function createAgentService({ sb, adapter, actions, searchSymbols, buildParts }) {
  const toParts = buildParts || ((prompt) => prompt);

  // ── snapshot ────────────────────────────────────────────────────────────
  // Ids and names only. No prices, no share counts — the model never needs the
  // money to identify a record, and every token here is paid for on every parse.
  async function buildSnapshot(managerId) {
    const { data: clients } = await sb.from('manager_clients')
      .select('id, full_name, risk_profile').eq('manager_id', managerId);

    const clientList = (clients || []).map((c) => ({ id: c.id, full_name: c.full_name, risk_profile: c.risk_profile }));
    const ids = new Set(clientList.map((c) => c.id));

    const { data: portfolios } = await sb.from('client_portfolios').select('id, client_id, name');
    const portfolioList = (portfolios || [])
      .filter((p) => ids.has(p.client_id))
      .map((p) => ({ id: p.id, client_id: p.client_id, name: p.name }));
    const pids = new Set(portfolioList.map((p) => p.id));

    const { data: positions } = await sb.from('portfolio_positions').select('id, portfolio_id, symbol');
    const positionList = (positions || [])
      .filter((p) => pids.has(p.portfolio_id))
      .map((p) => ({ id: p.id, portfolio_id: p.portfolio_id, symbol: p.symbol }));

    return { clients: clientList, portfolios: portfolioList, positions: positionList };
  }

  // ── ticker resolution — deterministic, in code, never the model's job ────
  async function resolveTickers(validated) {
    const wanted = new Set();
    for (const a of validated) {
      if (a.fields && a.fields.symbol) wanted.add(String(a.fields.symbol));
    }
    const resolved = new Map();
    await Promise.all([...wanted].map(async (raw) => {
      try {
        const hits = await searchSymbols(raw);
        const exact = (hits || []).find((h) => h.symbol.toUpperCase() === raw.toUpperCase());
        resolved.set(raw, exact ? exact.symbol : (hits && hits[0] ? hits[0].symbol : null));
      } catch (_) {
        resolved.set(raw, null);   // search down: flag the row, don't guess
      }
    }));

    return validated.map((a) => {
      if (!a.fields || !a.fields.symbol) return a;
      const raw = String(a.fields.symbol);
      const sym = resolved.get(raw);
      if (!sym) {
        return { ...a, valid: false, problems: [...a.problems, `Could not resolve ticker "${raw}".`] };
      }
      return { ...a, fields: { ...a.fields, symbol: sym } };
    });
  }

  // ── parse ───────────────────────────────────────────────────────────────
  async function parse({ managerId, text, image, audio, context }) {
    const snapshot = await buildSnapshot(managerId);
    const prompt = `${systemPrompt(snapshot, context)}\n\nMANAGER INPUT:\n${text || '(see attached media)'}`;

    async function ask(extra) {
      const input = toParts({ prompt: extra ? `${prompt}\n\n${extra}` : prompt, image, audio });
      return adapter.generate(input, ActionPlanSchema);
    }

    let plan;
    try {
      plan = ActionPlanSchema.parse(await ask());
    } catch (err) {
      // One retry with the validator's complaint appended — the pattern in
      // src/llm/reconcile.js. Then give up rather than loop.
      plan = ActionPlanSchema.parse(
        await ask(`Your previous reply did not match the required schema: ${err.message}. Reply with valid JSON only.`)
      );
    }

    const { actions: checked, errors } = validatePlan(plan, snapshot);
    const withTickers = await resolveTickers(checked);

    const { data: proposal } = await sb.from('agent_proposals').insert({
      manager_id: managerId,
      input_text: text || null,
      input_kind: audio ? 'voice' : image ? 'image' : 'text',
      transcript: plan.transcript || null,
      plan: { ...plan, actions: withTickers },
      status: 'pending',
    }).select().single();

    return { proposalId: proposal && proposal.id, plan, actions: withTickers, errors, snapshot };
  }

  // ── execute ─────────────────────────────────────────────────────────────
  // Rows arrive from the browser after human edits. They are input, not truth:
  // each one is re-checked against the snapshot and re-run through the same
  // ownership-enforcing action the manual routes use.
  async function execute({ managerId, proposalId, rows }) {
    const snapshot = await buildSnapshot(managerId);
    const list = Array.isArray(rows) ? rows.slice(0, MAX_ACTIONS) : [];
    const created = new Map();     // ref -> created id
    const failed = new Set();      // refs that failed, so dependents are skipped
    const results = [];

    for (const row of list) {
      if (row.dependsOn && failed.has(row.dependsOn)) {
        failed.add(row.ref);
        results.push({ ref: row.ref, op: row.op, ok: false, error: `Skipped — it depends on "${row.dependsOn}", which failed.` });
        continue;
      }

      // Resolve @refs into ids created earlier in this run.
      const target = { ...(row.target || {}) };
      for (const key of ['clientId', 'portfolioId', 'positionId']) {
        const v = target[key];
        if (typeof v === 'string' && v.startsWith('@')) target[key] = created.get(v.slice(1)) || null;
      }

      const single = { ...row, target };
      const { actions: [checked] } = validatePlan({ actions: [single] }, {
        clients: [...snapshot.clients, ...[...created.values()].map((id) => ({ id }))],
        portfolios: [...snapshot.portfolios, ...[...created.values()].map((id) => ({ id }))],
        positions: snapshot.positions,
      });

      if (!checked || !checked.valid) {
        failed.add(row.ref);
        results.push({ ref: row.ref, op: row.op, ok: false, error: (checked ? checked.problems.join(' ') : 'Invalid action.') });
        continue;
      }

      const fn = actions[row.op];
      if (!fn) {
        failed.add(row.ref);
        results.push({ ref: row.ref, op: row.op, ok: false, error: `Unsupported op "${row.op}".` });
        continue;
      }

      const input = {
        ...row.fields,
        clientId: target.clientId || undefined,
        portfolioId: target.portfolioId || undefined,
        positionId: target.positionId || undefined,
        source: 'agent',
        proposalId,
      };
      delete input._candidates;

      const out = await fn(managerId, input);
      if (out.ok) {
        if (out.data && out.data.id) created.set(row.ref, out.data.id);
        results.push({ ref: row.ref, op: row.op, ok: true, data: out.data });
      } else {
        failed.add(row.ref);
        results.push({ ref: row.ref, op: row.op, ok: false, error: out.error });
      }
    }

    if (proposalId) {
      await sb.from('agent_proposals')
        .update({ status: 'executed', results, executed_at: new Date().toISOString() })
        .eq('id', proposalId).eq('manager_id', managerId);
    }

    return { results };
  }

  return { buildSnapshot, parse, execute };
}

module.exports = { createAgentService, systemPrompt };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/agent-service.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, nothing regressed.

- [ ] **Step 6: Commit**

```bash
git add src/agent-service.js test/agent-service.test.js
git commit -m "feat(agent): snapshot, parse and execute

One model call produces a plan; code validates it against the caller's own
records, resolves tickers deterministically, and stores it as a proposal.
Execute re-validates every row and dispatches through manager-actions."
```

---

### Task 4: Multimodal content parts

Teaches the Google adapter to accept image and audio alongside text, and builds the parts array.

**Files:**
- Create: `src/agent-parts.js`
- Create: `test/agent-parts.test.js`
- Modify: `src/llm/adapters/google.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```js
  buildParts({ prompt, image, audio }) -> string | { role: 'user', content: Part[] }
  // image/audio are data URLs: "data:image/jpeg;base64,...."
  // Returns the bare prompt string when there is no media, so the text path is unchanged.
  ```
  `createGoogleAdapter().generate(promptOrMessage, schema)` now accepts either.

- [ ] **Step 1: Write the failing tests**

Create `test/agent-parts.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildParts, parseDataUrl } = require('../src/agent-parts');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const WEBM = 'data:audio/webm;base64,GkXfo0=';

test('text only returns the bare prompt string', () => {
  assert.equal(buildParts({ prompt: 'hello' }), 'hello');
});

test('parseDataUrl splits media type and payload', () => {
  assert.deepEqual(parseDataUrl(PNG), { mediaType: 'image/png', data: 'iVBORw0KGgo=' });
  assert.equal(parseDataUrl('not-a-data-url'), null);
});

test('an image becomes a user message with a text part and an image part', () => {
  const msg = buildParts({ prompt: 'read this', image: PNG });
  assert.equal(msg.role, 'user');
  assert.equal(msg.content[0].type, 'text');
  assert.equal(msg.content[1].type, 'image');
  assert.equal(msg.content[1].mediaType, 'image/png');
});

test('audio becomes a file part with its media type', () => {
  const msg = buildParts({ prompt: 'hear this', audio: WEBM });
  assert.equal(msg.content[1].type, 'file');
  assert.equal(msg.content[1].mediaType, 'audio/webm');
});

test('image and audio together produce three parts', () => {
  const msg = buildParts({ prompt: 'both', image: PNG, audio: WEBM });
  assert.equal(msg.content.length, 3);
});

test('a malformed data url is ignored rather than sent', () => {
  assert.equal(buildParts({ prompt: 'p', image: 'garbage' }), 'p');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/agent-parts.test.js`
Expected: FAIL — `Cannot find module '../src/agent-parts'`

- [ ] **Step 3: Write `src/agent-parts.js`**

```js
'use strict';

// Assembles the AI SDK message for a parse call. Text-only input stays a plain
// string so the existing adapter path is untouched; media promotes it to a
// single user message with content parts.

function parseDataUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

function buildParts({ prompt, image, audio }) {
  const img = parseDataUrl(image);
  const aud = parseDataUrl(audio);
  if (!img && !aud) return prompt;

  const content = [{ type: 'text', text: prompt }];
  if (img) content.push({ type: 'image', image: img.data, mediaType: img.mediaType });
  if (aud) content.push({ type: 'file', data: aud.data, mediaType: aud.mediaType });
  return { role: 'user', content };
}

module.exports = { buildParts, parseDataUrl };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/agent-parts.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Teach the Google adapter to take a message**

Replace `src/llm/adapters/google.js` with:

```js
'use strict';
const { generateObject } = require('ai');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');

function createGoogleAdapter({ apiKey, model = 'gemini-2.5-flash' }) {
  const provider = createGoogleGenerativeAI({ apiKey });
  return {
    name: 'gemini',
    // `input` is either a prompt string (every existing caller) or a single
    // user message with content parts (the agent's multimodal path).
    async generate(input, schema) {
      const call = typeof input === 'string'
        ? { model: provider(model), schema, prompt: input }
        : { model: provider(model), schema, messages: [input] };
      const { object } = await generateObject(call);
      return object;
    },
  };
}
module.exports = { createGoogleAdapter };
```

- [ ] **Step 6: Verify existing adapter tests still pass**

Run: `node --test test/llm-router.test.js test/schema.test.js`
Expected: PASS. The string path is unchanged, so nothing should move.

- [ ] **Step 7: Commit**

```bash
git add src/agent-parts.js test/agent-parts.test.js src/llm/adapters/google.js
git commit -m "feat(agent): multimodal content parts for image and audio

buildParts keeps text-only calls a bare string; media promotes the call to
a single user message. The Google adapter now accepts either."
```

---

### Task 5: Migration, routes, and server wiring

**Files:**
- Create: `supabase-migration-agent.sql`
- Create: `src/agent-routes.js`
- Modify: `src/server.js:92-97`

**Interfaces:**
- Consumes: `createAgentService` (Task 3), `buildParts` (Task 4), `createManagerActions` (Task 1), `requireAuth` from `src/auth-middleware.js`, `searchSymbols` from `src/yahoo-client.js`, `buildAdapters` from `src/llm/adapters`.
- Produces:
  - `POST /api/manager/agent/parse` — body `{ text?, image?, audio?, context? }` → `{ proposalId, plan, actions, errors }`
  - `POST /api/manager/agent/execute` — body `{ proposalId, rows }` → `{ results }`
  - `createAgentRouter()` — an Express router, auth-gated.

- [ ] **Step 1: Write the migration**

Create `supabase-migration-agent.sql`:

```sql
-- Manager Agent Entry — run in the Supabase SQL Editor after supabase-migration.sql.

CREATE TABLE IF NOT EXISTS agent_proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  input_text   text,
  input_kind   text NOT NULL DEFAULT 'text',   -- text | image | voice | mixed
  transcript   text,                            -- what the model heard, when voice
  plan         jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending', -- pending | executed | discarded
  results      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  executed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_proposals_manager ON agent_proposals(manager_id);

ALTER TABLE agent_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "proposals_own" ON agent_proposals;
CREATE POLICY "proposals_own" ON agent_proposals
  FOR ALL USING (manager_id = auth.uid()) WITH CHECK (manager_id = auth.uid());

-- Distinguish agent-originated entries in the existing audit trail.
ALTER TABLE position_history ADD COLUMN IF NOT EXISTS source      text DEFAULT 'manual';
ALTER TABLE position_history ADD COLUMN IF NOT EXISTS proposal_id uuid;
```

- [ ] **Step 2: Run the migration**

Paste the file into the Supabase SQL Editor for project `drcehombkpiyhrckbadz` and run it.
Expected: `Success. No rows returned.` Confirm under Table Editor that `agent_proposals` exists and `position_history` has `source` and `proposal_id`.

- [ ] **Step 3: Write `src/agent-routes.js`**

```js
'use strict';

const express = require('express');
const { requireAuth } = require('./auth-middleware');
const { getSupabase } = require('./supabase');
const { createManagerActions } = require('./manager-actions');
const { createAgentService } = require('./agent-service');
const { buildParts } = require('./agent-parts');
const { createGoogleAdapter } = require('./llm/adapters');
const { searchSymbols } = require('./yahoo-client');
const config = require('./config');

// Gemini is primary; Claude is the fallback when Gemini errors. Both come from
// the existing adapter layer, so model ids stay in config.
function pickAdapters() {
  const list = [];
  if (config.GEMINI_API_KEY) {
    list.push(createGoogleAdapter({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL }));
  }
  if (config.ANTHROPIC_API_KEY) {
    const { createAnthropicAdapter } = require('./llm/adapters');
    list.push(createAnthropicAdapter({ apiKey: config.ANTHROPIC_API_KEY }));
  }
  return list;
}

// Try each adapter in order; the first that answers wins.
function failoverAdapter(adapters) {
  return {
    name: 'agent-failover',
    async generate(input, schema) {
      let last;
      for (const a of adapters) {
        try { return await a.generate(input, schema); }
        catch (err) { last = err; }
      }
      throw last || new Error('No LLM provider configured');
    },
  };
}

function createAgentRouter() {
  const router = express.Router();

  // Images and audio arrive as base64 data URLs, so this router needs a larger
  // body limit than the app-wide 64kb. Scoped here only.
  router.use(express.json({ limit: '12mb' }));
  router.use(requireAuth);

  function serviceFor() {
    const sb = getSupabase();
    return createAgentService({
      sb,
      adapter: failoverAdapter(pickAdapters()),
      actions: createManagerActions({ sb }),
      searchSymbols,
      buildParts,
    });
  }

  router.post('/parse', async (req, res) => {
    const { text, image, audio, context } = req.body || {};
    if (!text && !image && !audio) return res.status(400).json({ error: 'Nothing to read — send text, an image, or audio.' });
    if (!getSupabase()) return res.status(503).json({ error: 'Service not configured' });
    if (!pickAdapters().length) return res.status(503).json({ error: 'No LLM provider configured' });

    try {
      const out = await serviceFor().parse({ managerId: req.user.id, text, image, audio, context });
      return res.json(out);
    } catch (err) {
      return res.status(502).json({ error: `Could not read that: ${err.message}` });
    }
  });

  router.post('/execute', async (req, res) => {
    const { proposalId, rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows approved' });
    if (!getSupabase()) return res.status(503).json({ error: 'Service not configured' });

    try {
      const out = await serviceFor().execute({ managerId: req.user.id, proposalId, rows });
      return res.json(out);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAgentRouter };
```

- [ ] **Step 4: Mount it ahead of the global body parser**

In `src/server.js`, the current block at line 90-97 is:

```js
const app = express();
app.set('trust proxy', true); // correct client IP behind Render's proxy (rate limiting)
app.use(express.json({ limit: '64kb' })); // cap request body size
app.use('/api', createRouter());

// ── Wealth Manager routes ─────────────────────────────────────────────────
const { createManagerRouter } = require('./manager-routes');
app.use('/api/manager', createManagerRouter());
```

Replace it with:

```js
const app = express();
app.set('trust proxy', true); // correct client IP behind Render's proxy (rate limiting)

// ── Agent entry — mounted BEFORE the 64kb global parser because it carries
//    base64 images and audio. It brings its own 12mb parser, scoped to itself.
const { createAgentRouter } = require('./agent-routes');
app.use('/api/manager/agent', createAgentRouter());

app.use(express.json({ limit: '64kb' })); // cap request body size
app.use('/api', createRouter());

// ── Wealth Manager routes ─────────────────────────────────────────────────
const { createManagerRouter } = require('./manager-routes');
app.use('/api/manager', createManagerRouter());
```

- [ ] **Step 5: Verify the server boots and both routes are auth-gated**

Run: `npm start` in one terminal, then in another:

```bash
curl -s -X POST http://localhost:3000/api/manager/agent/parse -H 'Content-Type: application/json' -d '{"text":"hi"}'
```
Expected: `{"error":"Not authenticated"}`

```bash
curl -s -X POST http://localhost:3000/api/manager/agent/execute -H 'Content-Type: application/json' -d '{}'
```
Expected: `{"error":"Not authenticated"}`

- [ ] **Step 6: Verify a real parse end to end**

Get a token by signing in through `/login.html` and copying `wm_token` from the browser's localStorage, then:

```bash
TOKEN=<paste>
curl -s -X POST http://localhost:3000/api/manager/agent/parse \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"add 10 shares of AAPL at 182.50 for Jane"}' | head -40
```
Expected: JSON with `proposalId`, and `actions[0].op === "addPosition"` with `symbol: "AAPL"`, `entry_price: 182.5`, `shares: 10`. If Jane has more than one portfolio, expect either a `clarification` or a low-confidence action with `_candidates`.

- [ ] **Step 7: Verify the 64kb cap still holds elsewhere**

```bash
python -c "print('{\"q\":\"' + 'x'*70000 + '\"}')" > /tmp/big.json
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/manager/auth/login -H 'Content-Type: application/json' --data-binary @/tmp/big.json
```
Expected: `413`

- [ ] **Step 8: Commit**

```bash
git add supabase-migration-agent.sql src/agent-routes.js src/server.js
git commit -m "feat(agent): parse and execute routes, agent_proposals migration

Router mounts ahead of the global 64kb parser with its own 12mb limit so
base64 media can reach it; every other route keeps the 64kb cap."
```

---

### Task 6: Composer and proposal drawer (text only)

First user-visible increment. At the end of this task the portal is usable by typing.

**Files:**
- Modify: `public/manager.html`
- Create: `public/agent.js`

**Interfaces:**
- Consumes: `POST /api/manager/agent/parse`, `POST /api/manager/agent/execute` (Task 5).
- Produces: `window.agentContext = () => ({ selectedClientId, selectedPortfolioId })` — read by `agent.js`, set by `manager.js`. Also `window.refreshAfterAgent()` — `agent.js` calls it after a successful execute.

- [ ] **Step 1: Add the composer and drawer markup**

In `public/manager.html`, immediately before `<div class="toast" id="toast"></div>`, add:

```html
  <!-- ── Agent composer ──────────────────────────────────────────────── -->
  <div class="agent-drawer" id="agentDrawer" hidden>
    <div class="agent-drawer-head">
      <b id="agentSummary">Proposed changes</b>
      <div>
        <button class="btn" onclick="agentApproveAll(true)">Approve all</button>
        <button class="btn" onclick="agentApproveAll(false)">Reject all</button>
        <button class="btn" onclick="agentClose()">Close</button>
      </div>
    </div>
    <div id="agentRows"></div>
    <div class="agent-drawer-foot">
      <span id="agentCount">0 selected</span>
      <button class="btn primary" id="agentRunBtn" onclick="agentExecute()">Apply selected</button>
    </div>
  </div>

  <div class="agent-composer">
    <div class="agent-clarify" id="agentClarify" hidden></div>
    <div class="agent-input-row">
      <input id="agentText" placeholder="Describe a change — &quot;bought 10 NVDA at 182 for Jane&quot;" onkeydown="if(event.key==='Enter')agentSend()" />
      <button class="btn primary" id="agentSendBtn" onclick="agentSend()">Send</button>
    </div>
    <div class="agent-status" id="agentStatus"></div>
  </div>
```

In the same file's `<style>` block, append:

```css
  .agent-composer{position:fixed;left:0;right:0;bottom:0;z-index:40;background:var(--panel);
    border-top:1px solid var(--line);padding:10px 14px}
  .agent-input-row{display:flex;gap:8px;max-width:1100px;margin:0 auto}
  .agent-input-row input{flex:1;background:#0a1220;border:1px solid var(--line);color:var(--text);
    border-radius:10px;padding:11px 12px;font-size:13px;outline:none}
  .agent-status{max-width:1100px;margin:6px auto 0;font-size:12px;color:var(--muted);min-height:16px}
  .agent-clarify{max-width:1100px;margin:0 auto 8px;font-size:13px;color:var(--text);
    background:#14203a;border:1px solid var(--line);border-radius:10px;padding:9px 12px}
  .agent-drawer{position:fixed;left:0;right:0;bottom:64px;z-index:39;max-height:56vh;overflow:auto;
    background:var(--panel);border-top:1px solid var(--line)}
  .agent-drawer-head,.agent-drawer-foot{display:flex;justify-content:space-between;align-items:center;
    gap:10px;padding:10px 14px;max-width:1100px;margin:0 auto}
  .agent-row{max-width:1100px;margin:0 auto;border-top:1px solid var(--line);padding:10px 14px;display:flex;gap:10px}
  .agent-row.bad{background:rgba(255,90,90,.06)}
  .agent-row.warn{background:rgba(255,190,80,.06)}
  .agent-row-body{flex:1}
  .agent-op{font-weight:700;font-size:13px}
  .agent-src{font-size:11px;color:var(--muted);margin-top:3px}
  .agent-problem{font-size:11px;color:var(--red);margin-top:3px}
  .agent-fields{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  .agent-fields label{font-size:11px;color:var(--muted);display:flex;flex-direction:column;gap:2px}
  .agent-fields input,.agent-fields select{background:#0a1220;border:1px solid var(--line);color:var(--text);
    border-radius:7px;padding:5px 7px;font-size:12px;min-width:110px}
  body{padding-bottom:78px}
```

Add the script tag alongside the existing `manager.js` one, at the bottom of `<body>`:

```html
  <script src="agent.js"></script>
```

- [ ] **Step 2: Expose the current selection from `manager.js`**

In `public/manager.js`, find the module-level state where `selectedClientId` / the selected portfolio id are held (they are set in `selectClient()` around line 179 and `selectPortfolio()` around line 275). At the end of the IIFE, alongside the other `window.` exports the file already makes for its `onclick` handlers, add:

```js
  window.agentContext = () => ({
    selectedClientId: currentClientId || null,
    selectedPortfolioId: currentPortfolioId || null,
  });
  window.refreshAfterAgent = async () => {
    await loadClients();
    if (currentClientId) await selectClient(currentClientId);
    if (currentPortfolioId) await selectPortfolio(currentPortfolioId);
  };
```

If the variables carry different names in the file, use the actual ones — do not rename them.

- [ ] **Step 3: Write `public/agent.js`**

```js
'use strict';
// Agent composer — turns a description into a reviewable list of changes.
// Nothing here writes: it posts to /parse, renders rows, and posts the rows the
// manager approved to /execute.

(function () {
  const $ = (id) => document.getElementById(id);
  const token = () => localStorage.getItem('wm_token') || '';

  let current = { proposalId: null, rows: [] };
  let lastInput = null;     // kept so a clarification answer can resend it

  function status(msg, busy) {
    $('agentStatus').textContent = msg || '';
    $('agentSendBtn').disabled = Boolean(busy);
  }

  async function post(path, body) {
    const res = await fetch(`/api/manager/agent/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({ error: 'Bad response' }));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const VERB = {
    createClient: 'Create client', updateClient: 'Update client', deleteClient: 'Delete client',
    createPortfolio: 'Create portfolio',
    addPosition: 'Add position', updatePosition: 'Update position',
    sellPosition: 'Sell position', deletePosition: 'Remove position',
  };

  function rowHtml(row, i) {
    const cls = !row.valid ? 'bad' : row.confidence < 0.6 ? 'warn' : '';
    const fields = Object.entries(row.fields || {})
      .filter(([k]) => k !== '_candidates')
      .map(([k, v]) => `<label>${esc(k)}
        <input data-row="${i}" data-field="${esc(k)}" value="${esc(v)}" oninput="agentEdit(this)" /></label>`)
      .join('');

    const candidates = row.fields && row.fields._candidates
      ? `<label>which record
           <select data-row="${i}" data-target="clientId" onchange="agentPick(this)">
             <option value="">choose…</option>
             ${String(row.fields._candidates).split(',').map((id) =>
               `<option value="${esc(id.trim())}">${esc(id.trim())}</option>`).join('')}
           </select></label>`
      : '';

    return `<div class="agent-row ${cls}">
      <input type="checkbox" data-check="${i}" ${row.valid ? 'checked' : ''} onchange="agentCount()" />
      <div class="agent-row-body">
        <div class="agent-op">${esc(VERB[row.op] || row.op)}</div>
        <div class="agent-src">${esc(row.source || row.reasoning || '')}</div>
        ${row.problems && row.problems.length ? `<div class="agent-problem">${esc(row.problems.join(' '))}</div>` : ''}
        <div class="agent-fields">${fields}${candidates}</div>
      </div>
    </div>`;
  }

  function render(out) {
    current = { proposalId: out.proposalId, rows: out.actions || [] };
    $('agentSummary').textContent = out.plan && out.plan.summary ? out.plan.summary : 'Proposed changes';
    $('agentRows').innerHTML = current.rows.map(rowHtml).join('') ||
      '<div class="agent-row"><div class="agent-row-body">Nothing actionable found in that.</div></div>';
    $('agentDrawer').hidden = false;
    agentCount();

    const clar = out.plan && out.plan.clarification;
    $('agentClarify').hidden = !clar;
    $('agentClarify').textContent = clar || '';
    if (out.plan && out.plan.transcript) status(`Heard: “${out.plan.transcript}”`);
  }

  window.agentEdit = (el) => {
    const row = current.rows[Number(el.dataset.row)];
    if (row) row.fields[el.dataset.field] = el.value;
  };

  window.agentPick = (el) => {
    const row = current.rows[Number(el.dataset.row)];
    if (!row) return;
    row.target = { ...row.target, [el.dataset.target]: el.value };
    row.valid = Boolean(el.value);
  };

  window.agentCount = () => {
    const n = document.querySelectorAll('#agentRows input[data-check]:checked').length;
    $('agentCount').textContent = `${n} selected`;
    $('agentRunBtn').disabled = n === 0;
  };

  window.agentApproveAll = (on) => {
    document.querySelectorAll('#agentRows input[data-check]').forEach((c) => { c.checked = on; });
    agentCount();
  };

  window.agentClose = () => { $('agentDrawer').hidden = true; };

  window.agentSend = async () => {
    const text = $('agentText').value.trim();
    const clarifying = !$('agentClarify').hidden;
    if (!text && !clarifying) return;

    // A clarification answer resends the original input with the reply appended,
    // so the manager never retypes and media is never re-uploaded.
    const body = clarifying && lastInput
      ? { ...lastInput, text: `${lastInput.text || ''}\n${text}`.trim() }
      : { text, context: (window.agentContext ? window.agentContext() : {}) };

    status('Reading…', true);
    try {
      const out = await post('parse', body);
      lastInput = body;
      $('agentText').value = '';
      render(out);
      status('');
    } catch (err) {
      status(err.message);       // input is left in the box on purpose
      $('agentSendBtn').disabled = false;
    }
  };

  window.agentExecute = async () => {
    const picked = [...document.querySelectorAll('#agentRows input[data-check]:checked')]
      .map((c) => current.rows[Number(c.dataset.check)]);
    if (!picked.length) return;

    $('agentRunBtn').disabled = true;
    status('Applying…', true);
    try {
      const out = await post('execute', { proposalId: current.proposalId, rows: picked });
      const ok = out.results.filter((r) => r.ok).length;
      const bad = out.results.filter((r) => !r.ok);

      $('agentRows').innerHTML = out.results.map((r) =>
        `<div class="agent-row ${r.ok ? '' : 'bad'}"><div class="agent-row-body">
           <div class="agent-op">${r.ok ? '✓' : '✕'} ${esc(VERB[r.op] || r.op)}</div>
           ${r.ok ? '' : `<div class="agent-problem">${esc(r.error)}</div>`}
         </div></div>`).join('');

      status(`${ok} applied${bad.length ? `, ${bad.length} failed` : ''}`);
      $('agentRunBtn').disabled = true;
      if (window.refreshAfterAgent) await window.refreshAfterAgent();
    } catch (err) {
      status(err.message);
      $('agentRunBtn').disabled = false;
    }
  };
})();
```

- [ ] **Step 4: Manual test — happy path**

Run `npm start`, sign in, select a client and a portfolio. Type: `bought 12 shares of MSFT at 410.25`. Press Enter.
Expected: drawer opens with one `Add position` row, `symbol MSFT`, `entry_price 410.25`, `shares 12`, checkbox ticked. Click **Apply selected**.
Expected: row becomes `✓ Add position`, status says `1 applied`, and the position appears in the table behind without a page reload.

- [ ] **Step 5: Manual test — edit before applying**

Type: `bought 5 AAPL at 1`. In the drawer, change `entry_price` to `182.50`. Apply.
Expected: the created position shows 182.50, not 1.

- [ ] **Step 6: Manual test — clarification**

Deselect any client (reload `/manager.html` without picking one). Type: `add 10 NVDA at 182`.
Expected: no rows, and the clarify bar asks which client. Type `Jane` and press Enter — the original text is resent with the answer appended and an action appears.

- [ ] **Step 7: Manual test — partial failure**

Type: `bought 5 AAPL at 182 and 3 of ZZZZQQ at 10`.
Expected: the AAPL row is valid, the ZZZZQQ row is flagged red with a ticker problem and is unchecked. Applying reports `1 applied`.

- [ ] **Step 8: Commit**

```bash
git add public/agent.js public/manager.html public/manager.js
git commit -m "feat(agent): composer bar and proposal drawer

Type a change, review per-row proposals with editable fields, apply the
ones approved. Clarification answers resend the original input."
```

---

### Task 7: Image input

**Files:**
- Modify: `public/agent.js`
- Modify: `public/manager.html`

**Interfaces:**
- Consumes: `buildParts` handling of `image` (Task 4), `/parse` accepting `image` (Task 5).
- Produces: `downscale(file) -> Promise<dataUrl>` inside `agent.js` — longest edge 1568 px, JPEG q0.8.

- [ ] **Step 1: Add the attach control**

In `public/manager.html`, inside `.agent-input-row`, before the `<input id="agentText">`:

```html
      <input type="file" id="agentFile" accept="image/*" hidden onchange="agentAttach(this)" />
      <button class="btn" onclick="document.getElementById('agentFile').click()" title="Attach a screenshot">📎</button>
```

And directly after the `.agent-input-row` div, inside `.agent-composer`:

```html
    <div class="agent-attach" id="agentAttach" hidden>
      <img id="agentThumb" alt="attached screenshot" />
      <button class="btn" onclick="agentClearAttach()">Remove</button>
    </div>
```

In the `<style>` block append:

```css
  .agent-attach{max-width:1100px;margin:8px auto 0;display:flex;align-items:center;gap:10px}
  .agent-attach img{height:46px;border-radius:8px;border:1px solid var(--line)}
```

- [ ] **Step 2: Add downscaling and attachment to `agent.js`**

Inside the IIFE, after the `post` helper, add:

```js
  let attached = null;    // data URL of the downscaled image

  const MAX_EDGE = 1568;  // beyond this the model gains nothing and you pay for it

  function downscale(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file'));
      reader.onload = () => { img.src = reader.result; };
      img.onerror = () => reject(new Error('That does not look like an image'));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      reader.readAsDataURL(file);
    });
  }

  window.agentAttach = async (el) => {
    const file = el.files && el.files[0];
    el.value = '';
    if (!file) return;
    try {
      attached = await downscale(file);
      document.getElementById('agentThumb').src = attached;
      document.getElementById('agentAttach').hidden = false;
      status('Screenshot attached — add a note if you like, then Send.');
    } catch (err) { status(err.message); }
  };

  window.agentClearAttach = () => {
    attached = null;
    document.getElementById('agentAttach').hidden = true;
  };
```

- [ ] **Step 3: Send the image and allow an empty text box**

In `window.agentSend`, replace the guard and the body construction with:

```js
    const text = $('agentText').value.trim();
    const clarifying = !$('agentClarify').hidden;
    if (!text && !attached && !clarifying) return;

    const body = clarifying && lastInput
      ? { ...lastInput, text: `${lastInput.text || ''}\n${text}`.trim() }
      : { text, image: attached, context: (window.agentContext ? window.agentContext() : {}) };
```

And in the success branch, after `$('agentText').value = '';`, add:

```js
      agentClearAttach();
```

- [ ] **Step 4: Add paste-to-attach**

At the end of the IIFE:

```js
  // Ctrl+V a screenshot straight into the composer.
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    downscale(file).then((url) => {
      attached = url;
      document.getElementById('agentThumb').src = url;
      document.getElementById('agentAttach').hidden = false;
      status('Screenshot pasted — press Send.');
    }).catch((err) => status(err.message));
  });
```

- [ ] **Step 5: Manual test — a holdings screenshot**

Select a client and portfolio. Take a screenshot of any brokerage or watchlist table showing symbols, share counts, and cost basis. Attach it and press Send with no text.
Expected: one `Add position` row per holding, each with a `source` naming the row it came from. Verify at least one price against the image, correct any that are wrong, apply.

- [ ] **Step 6: Verify the downscale actually fires**

With the image attached, in DevTools console run:

```js
document.getElementById('agentThumb').src.length
```
Expected: a few hundred thousand characters at most (~200-400 KB), not several million — confirming the canvas resize ran.

- [ ] **Step 7: Manual test — image plus a note**

Attach the same screenshot and type `only the tech names`.
Expected: fewer rows, and each `source` refers to the matching image row.

- [ ] **Step 8: Commit**

```bash
git add public/agent.js public/manager.html
git commit -m "feat(agent): image input with client-side downscaling

Attach or paste a screenshot; it is resized to 1568px/q80 in a canvas
before upload, which is the largest single token cost in a parse."
```

---

### Task 8: Voice input

**Files:**
- Modify: `public/agent.js`
- Modify: `public/manager.html`

**Interfaces:**
- Consumes: `buildParts` handling of `audio` (Task 4), `/parse` accepting `audio` (Task 5).
- Produces: nothing new for other tasks.

- [ ] **Step 1: Add the mic button**

In `public/manager.html`, inside `.agent-input-row`, after the 📎 button:

```html
      <button class="btn" id="agentMic" onclick="agentMic()" title="Record a note">🎙</button>
```

In the `<style>` block append:

```css
  #agentMic.recording{background:var(--red);color:#fff}
```

- [ ] **Step 2: Add the recorder to `agent.js`**

Inside the IIFE, after the image code:

```js
  let recorder = null;
  let chunks = [];
  let recordedAudio = null;   // data URL

  const MAX_RECORD_MS = 120000;   // a 2-minute cap; past that it is a document, not a note

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error('Could not read the recording'));
      r.onload = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
  }

  window.agentMic = async () => {
    const btn = document.getElementById('agentMic');

    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }

    if (!navigator.mediaDevices || !window.MediaRecorder) {
      status('This browser cannot record audio — type the note instead.');
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      status('Microphone permission denied — type the note instead.');
      return;
    }

    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove('recording');
      try {
        recordedAudio = await blobToDataUrl(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        status('Recorded — press Send.');
      } catch (err) { status(err.message); }
    };

    recorder.start();
    btn.classList.add('recording');
    status('Recording… tap the mic again to stop.');
    setTimeout(() => { if (recorder && recorder.state === 'recording') recorder.stop(); }, MAX_RECORD_MS);
  };
```

- [ ] **Step 3: Send the audio**

In `window.agentSend`, update the guard and body once more:

```js
    if (!text && !attached && !recordedAudio && !clarifying) return;

    const body = clarifying && lastInput
      ? { ...lastInput, text: `${lastInput.text || ''}\n${text}`.trim() }
      : { text, image: attached, audio: recordedAudio, context: (window.agentContext ? window.agentContext() : {}) };
```

And in the success branch, alongside `agentClearAttach()`:

```js
      recordedAudio = null;
```

- [ ] **Step 4: Manual test — a spoken instruction**

Select Jane's portfolio. Tap 🎙, say *"Sold all of the NVDA at one ninety and set her risk profile to aggressive"*, tap 🎙 again, press Send.
Expected: the status line shows the transcript, and two rows appear — `Sell position` with `sell_price 190`, and `Update client` with `risk_profile aggressive`. Check the transcript matches what you said before applying.

- [ ] **Step 5: Manual test — denied permission**

In Chrome site settings, block the microphone for `localhost:3000`, reload, tap 🎙.
Expected: `Microphone permission denied — type the note instead.` and no crash. Re-enable the permission afterwards.

- [ ] **Step 6: Manual test — a rejected recording**

With DevTools Network throttling off, record a 1-second silent clip and Send.
Expected: either an empty plan with "Nothing actionable found in that." or a clarification — never an unhandled error, and the composer stays usable.

- [ ] **Step 7: Commit**

```bash
git add public/agent.js public/manager.html
git commit -m "feat(agent): voice input via MediaRecorder

Audio rides the same multimodal call as text and images — no separate
transcription service. The model returns what it heard for confirmation."
```

---

### Task 9: E2E coverage and documentation

**Files:**
- Create: `tests/e2e/agent.spec.js`
- Modify: `docs/WEALTH_MANAGER_GUIDE.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Read the existing E2E setup**

Run: `cat playwright.config.js && cat tests/e2e/admin.spec.js`
Note how the existing specs sign in and what base URL they use — the new spec must follow the same pattern rather than inventing one.

- [ ] **Step 2: Write the E2E spec**

Create `tests/e2e/agent.spec.js`, using the same sign-in helper style as `tests/e2e/admin.spec.js`:

```js
'use strict';
const { test, expect } = require('@playwright/test');

// Stubs the agent endpoints so the spec exercises the UI contract — compose,
// review, edit, approve, report — without spending a model call or touching
// live client data.
async function stubAgent(page) {
  await page.route('**/api/manager/agent/parse', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      proposalId: 'prop-test',
      plan: { summary: 'Two changes', clarification: null, transcript: null },
      errors: [],
      actions: [
        { op: 'addPosition', ref: 'a1', dependsOn: null, target: { portfolioId: 'p1' },
          fields: { symbol: 'AAPL', entry_price: 182.5, shares: 10 },
          confidence: 0.95, source: '"10 AAPL at 182.50"', reasoning: '', valid: true, problems: [] },
        { op: 'addPosition', ref: 'a2', dependsOn: null, target: { portfolioId: 'p1' },
          fields: { symbol: 'MSFT', entry_price: 410 },
          confidence: 0.9, source: '"MSFT at 410"', reasoning: '', valid: true, problems: [] },
      ],
    }),
  }));

  await page.route('**/api/manager/agent/execute', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    expect(body.rows.length).toBe(1);                      // one row was unchecked
    expect(Number(body.rows[0].fields.entry_price)).toBe(200);  // the edit was sent
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ results: [{ ref: 'a1', op: 'addPosition', ok: true, data: { id: 'new' } }] }),
    });
  });
}

test('compose, edit a field, drop a row, apply', async ({ page }) => {
  await signIn(page);                       // same helper the other specs use
  await stubAgent(page);
  await page.goto('/manager.html');

  await page.fill('#agentText', 'bought 10 AAPL at 182.50 and MSFT at 410');
  await page.click('#agentSendBtn');

  await expect(page.locator('#agentDrawer')).toBeVisible();
  await expect(page.locator('.agent-row')).toHaveCount(2);

  await page.fill('.agent-row >> nth=0 >> input[data-field="entry_price"]', '200');
  await page.uncheck('input[data-check="1"]');
  await expect(page.locator('#agentCount')).toHaveText('1 selected');

  await page.click('#agentRunBtn');
  await expect(page.locator('#agentStatus')).toContainText('1 applied');
});

test('a flagged row is unchecked and shows why', async ({ page }) => {
  await signIn(page);
  await page.route('**/api/manager/agent/parse', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      proposalId: 'p', plan: { summary: 'One problem', clarification: null, transcript: null }, errors: [],
      actions: [{ op: 'addPosition', ref: 'a1', dependsOn: null, target: { portfolioId: 'p1' },
        fields: { symbol: 'ZZZZQQ', entry_price: 10 }, confidence: 0.3, source: '', reasoning: '',
        valid: false, problems: ['Could not resolve ticker "ZZZZQQ".'] }],
    }),
  }));
  await page.goto('/manager.html');

  await page.fill('#agentText', 'buy ZZZZQQ');
  await page.click('#agentSendBtn');

  await expect(page.locator('.agent-row.bad')).toHaveCount(1);
  await expect(page.locator('.agent-problem')).toContainText('ZZZZQQ');
  await expect(page.locator('input[data-check="0"]')).not.toBeChecked();
  await expect(page.locator('#agentRunBtn')).toBeDisabled();
});
```

Replace `signIn(page)` with whatever `tests/e2e/admin.spec.js` actually uses — copy that helper rather than writing a new one.

- [ ] **Step 3: Run the E2E specs**

Run: `npx playwright test tests/e2e/agent.spec.js`
Expected: 2 passed.

- [ ] **Step 4: Run everything**

Run: `npm test && npx playwright test`
Expected: all unit tests and all E2E specs pass.

- [ ] **Step 5: Document it in the manager guide**

Append to `docs/WEALTH_MANAGER_GUIDE.md`:

```markdown
---

## Agent entry — describe a change instead of filling in forms

The composer bar sits at the bottom of the Wealth Manager. Type a change, attach
or paste a screenshot, or record a voice note. Nothing is saved until you approve it.

### Typing
`bought 12 MSFT at 410.25` — with a client and portfolio selected, that is enough.
Name the client if none is selected: `bought 12 MSFT at 410.25 for Jane Smith`.

You can describe several changes at once, and mix kinds:
`sold all of Jane's NVDA at 190 and set her risk profile to aggressive`

### Screenshots
Click 📎 or press Ctrl+V with an image in the clipboard. A brokerage holdings
table usually becomes one row per holding. The image is resized in your browser
before it is sent.

### Voice
Tap 🎙, speak, tap it again. The transcript of what was heard is shown above the
composer so you can check it before approving.

### Reviewing
Every proposal is a row showing the change, the values, and the words or image
region it came from. You can edit any value inline, and untick anything you don't
want. **Apply selected** runs only the ticked rows.

- **Amber row** — the agent is not certain which record you meant. Pick from the
  dropdown before approving.
- **Red row** — something is wrong (an unrecognised ticker, a missing price). It
  cannot be approved until you fix it.

If the agent cannot tell which client or portfolio you meant, it asks. Type the
answer and press Enter — you do not need to retype the original note or re-attach
the image.

### What it can and cannot do
Creates, updates and deletes clients, creates portfolios, and adds, edits, sells
and removes positions. It cannot delete a whole portfolio — do that by hand.

Everything it applies is recorded in the portfolio history exactly like manual
entry, marked as agent-entered.
```

- [ ] **Step 6: Update `CLAUDE.md`**

Add to the **Added: Wealth Manager** section:

```markdown
### Added: Agent entry
- **Composer + drawer**: `public/agent.js`, markup in `public/manager.html`
- **Routes**: `src/agent-routes.js` mounted at `/api/manager/agent` — note it mounts
  BEFORE the app-wide 64kb JSON parser in `src/server.js` and brings its own 12mb limit
- **Service**: `src/agent-service.js` (snapshot → parse → validate → execute)
- **Contract**: `src/agent-schema.js` (ActionPlan, per-op validation)
- **Multimodal**: `src/agent-parts.js`, plus `src/llm/adapters/google.js` accepting message parts
- **Shared writes**: `src/manager-actions.js` — the 8 write operations, used by both
  the HTTP routes and the agent executor. All new write paths go here.
- **Migration**: `supabase-migration-agent.sql` (agent_proposals, position_history.source)
- **Model**: `GEMINI_MODEL` (default `gemini-2.5-flash`), Claude as failover
```

And to the API routes table:

```markdown
### Agent (JWT required)
- `POST /api/manager/agent/parse` — `{ text?, image?, audio?, context? }` → proposal
- `POST /api/manager/agent/execute` — `{ proposalId, rows }` → per-row results
```

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/agent.spec.js docs/WEALTH_MANAGER_GUIDE.md CLAUDE.md
git commit -m "test(agent): E2E coverage for compose/review/apply, plus docs"
```

---

## Verification Checklist

Run before calling this done:

- [ ] `npm test` — all unit tests pass
- [ ] `npx playwright test` — all E2E specs pass
- [ ] Manual: the pre-existing portal still works — add/edit/sell a position through the normal forms, history shows BUY/REBALANCE/SELL
- [ ] Manual: a typed instruction, a screenshot, and a voice note each produce a reviewable proposal
- [ ] Manual: an edited value in the drawer is what gets saved
- [ ] Manual: an unchecked row is not applied
- [ ] Manual: `position_history` rows created by the agent carry `source = 'agent'` and a `proposal_id`
- [ ] `curl` an oversized body at `/api/manager/auth/login` → still `413`
