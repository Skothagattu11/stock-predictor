# Phase 5: LLM Ensemble + Multi-Predictor Consensus — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. `- [ ]` steps, strict TDD, one commit per task.

**Goal:** Run the *same* prediction prompt across every configured LLM (OpenAI/Anthropic/Gemini/Perplexity) in parallel, force schema-valid output, **reconcile any numbers** the models echo against the quant facts, and fold the LLM voices together with the deterministic **quant voice** into a **consensus** (headline stance + agreement % + divergence flag). Exposed at `/api/insight/:mode/:symbol`. Degrades to pure-quant when no keys.

**Architecture:** The untestable part (real provider network calls) is isolated into thin **adapters** behind one `generate(prompt, schema)` interface. Everything else is pure and unit-tested with fake adapters/services: `schemas.js` (Zod), `consensus.js`, `reconcile.js`, `router.js` (fan-out), `insight-service.js` (quant voice + LLM voices → consensus). No network in tests.

**Tech Stack:** Node 22, Express, `node:test`, CommonJS. New deps: `zod`, `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/perplexity`.

**Builds on:** Phase 4 (`predictService`). **Runtime keys (user adds later):** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY` — all optional.

---

## File structure

```
src/llm/
  schemas.js                 # NEW: Zod Read schema
  consensus.js               # NEW: buildConsensus() (pure)
  reconcile.js               # NEW: reconcileNumbers() (pure)
  router.js                  # NEW: createRouter({adapters}).ensemble()
  prompt.js                  # NEW: buildPrompt(mode, symbol, quant)
  adapters/
    openai.js  anthropic.js  google.js  perplexity.js   # NEW: thin AI-SDK wrappers
    index.js                 # NEW: buildAdapters(config)
src/
  config.js                  # MODIFY: add the 4 LLM keys (if missing)
  insight-service.js         # NEW: createInsightService({predictService, router})
  insight-routes.js          # NEW: /api/insight/:mode/:symbol
  server.js                  # MODIFY: mount insight routes
test/
  consensus.test.js  reconcile.test.js  llm-router.test.js  insight-service.test.js   # NEW
```

---

## Task 1: Dependencies + Zod schema

**Files:** Modify `package.json` (via npm); Create `src/llm/schemas.js`; Test `test/schema.test.js`

- [ ] **Step 1: Install deps** (from repo root)
```
npm install zod ai @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/perplexity
```
Expected: installs succeed; `package.json` dependencies updated. (If a provider package fails to resolve, report BLOCKED with the error — do not invent versions.)

- [ ] **Step 2: Failing test** — `test/schema.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ReadSchema } = require('../src/llm/schemas');

test('valid read parses', () => {
  const r = ReadSchema.parse({ stance: 'bullish', confidence: 0.7, rationale: 'up trend',
    keyRisks: ['earnings'], sources: ['https://x'] });
  assert.equal(r.stance, 'bullish');
});

test('invalid stance rejected', () => {
  assert.throws(() => ReadSchema.parse({ stance: 'up', confidence: 0.5, rationale: 'x' }));
});

test('defaults fill arrays', () => {
  const r = ReadSchema.parse({ stance: 'neutral', confidence: 0.5, rationale: 'flat' });
  assert.deepEqual(r.keyRisks, []);
  assert.deepEqual(r.sources, []);
});
```

- [ ] **Step 3: Create `src/llm/schemas.js`**
```js
'use strict';
const { z } = require('zod');

// One schema for every prediction mode's LLM "read". The model NEVER returns
// numbers we rely on — only a stance, a calibrated confidence, prose, risks, sources.
const ReadSchema = z.object({
  stance: z.enum(['bullish', 'neutral', 'bearish']),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  keyRisks: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
});

module.exports = { ReadSchema };
```

- [ ] **Step 4: Run → pass. Commit**
```
git checkout -b feat/phase-5-llm-ensemble
git add package.json package-lock.json src/llm/schemas.js test/schema.test.js
git commit -m "feat(llm): add AI SDK deps + Zod read schema"
```

---

## Task 2: Consensus aggregator (pure)

**Files:** Create `src/llm/consensus.js`; Test `test/consensus.test.js`

- [ ] **Step 1: Failing tests** — `test/consensus.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildConsensus } = require('../src/llm/consensus');

test('unanimous => full agreement, no divergence', () => {
  const c = buildConsensus([
    { name: 'quant', stance: 'bullish', confidence: 0.8 },
    { name: 'openai', stance: 'bullish', confidence: 0.7 }]);
  assert.equal(c.stance, 'bullish');
  assert.equal(c.agreement, 1);
  assert.equal(c.divergence, false);
});

test('split => divergence flagged', () => {
  const c = buildConsensus([
    { name: 'quant', stance: 'bullish', confidence: 0.6 },
    { name: 'openai', stance: 'bearish', confidence: 0.6 }]);
  assert.equal(c.divergence, true);
  assert.ok(c.agreement <= 0.6);
});

test('confidence-weighted majority wins', () => {
  const c = buildConsensus([
    { name: 'a', stance: 'bearish', confidence: 0.9 },
    { name: 'b', stance: 'bullish', confidence: 0.2 },
    { name: 'c', stance: 'bullish', confidence: 0.2 }]);
  assert.equal(c.stance, 'bearish');   // 0.9 weight beats 0.4
});

test('empty => neutral, divergent', () => {
  const c = buildConsensus([]);
  assert.equal(c.stance, 'neutral');
  assert.equal(c.divergence, true);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `src/llm/consensus.js`**
```js
'use strict';

const AGREEMENT_FLOOR = 0.6;   // below this, surface as "models split / low conviction"

function buildConsensus(votes) {
  if (!votes.length) return { stance: 'neutral', agreement: 0, divergence: true, votes: [] };

  const weight = (v) => (typeof v.confidence === 'number' ? v.confidence : 1);
  const tally = {};
  for (const v of votes) tally[v.stance] = (tally[v.stance] || 0) + weight(v);

  const stance = Object.keys(tally).reduce((a, b) => (tally[b] > tally[a] ? b : a));
  const total = votes.reduce((s, v) => s + weight(v), 0);
  const agree = votes.filter((v) => v.stance === stance).reduce((s, v) => s + weight(v), 0);
  const agreement = total ? agree / total : 0;

  return {
    stance,
    agreement: Math.round(agreement * 1000) / 1000,
    divergence: agreement < AGREEMENT_FLOOR,
    votes,
  };
}

module.exports = { buildConsensus, AGREEMENT_FLOOR };
```

- [ ] **Step 4: Run → pass. Commit**
```
git add src/llm/consensus.js test/consensus.test.js
git commit -m "feat(llm): add confidence-weighted consensus with divergence flag"
```

---

## Task 3: Number reconciliation (pure)

**Files:** Create `src/llm/reconcile.js`; Test `test/reconcile.test.js`

- [ ] **Step 1: Failing tests** — `test/reconcile.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reconcileNumbers } = require('../src/llm/reconcile');

test('numbers matching facts are clean', () => {
  const r = reconcileNumbers('Trading at $150.25 with RSI 70.5.', [150.25, 70.5]);
  assert.equal(r.clean, true);
  assert.deepEqual(r.unverified, []);
});

test('fabricated price is flagged', () => {
  const r = reconcileNumbers('Target is $999.99 soon.', [150.25]);
  assert.equal(r.clean, false);
  assert.deepEqual(r.unverified, [999.99]);
});

test('tolerance allows tiny rounding', () => {
  const r = reconcileNumbers('about $150.24', [150.25]);   // within 1%
  assert.equal(r.clean, true);
});

test('plain small integers are ignored (not price/percent-looking)', () => {
  const r = reconcileNumbers('over the next 3 days', [150.25]);
  assert.equal(r.clean, true);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `src/llm/reconcile.js`**
```js
'use strict';

// Advisory guard: extract price/percent-looking numbers from LLM prose and flag any
// that don't match a quant fact (within tolerance). Bare small integers (days, counts)
// are ignored to avoid false positives. The LLM should reference, not invent, figures.
const TOKEN = /\$\s?\d+(?:\.\d+)?|\d+(?:\.\d+)?\s?%|\d+\.\d+/g;

function reconcileNumbers(text, facts, tol = 0.01) {
  const found = (text.match(TOKEN) || []).map((t) => parseFloat(t.replace(/[$%\s]/g, '')));
  const unverified = found.filter((n) =>
    !facts.some((f) => f !== 0 && Math.abs(n - f) / Math.abs(f) <= tol) && !facts.includes(n));
  return { clean: unverified.length === 0, unverified };
}

module.exports = { reconcileNumbers };
```

- [ ] **Step 4: Run → pass. Commit**
```
git add src/llm/reconcile.js test/reconcile.test.js
git commit -m "feat(llm): add advisory number reconciliation vs quant facts"
```

---

## Task 4: Router (ensemble fan-out)

**Files:** Create `src/llm/router.js`; Test `test/llm-router.test.js`

- [ ] **Step 1: Failing tests** — `test/llm-router.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRouter } = require('../src/llm/router');

test('ensemble fans out to all adapters', async () => {
  const adapters = [
    { name: 'a', generate: async () => ({ stance: 'bullish', confidence: 0.7, rationale: 'x' }) },
    { name: 'b', generate: async () => ({ stance: 'bearish', confidence: 0.6, rationale: 'y' }) },
  ];
  const r = createRouter({ adapters });
  const out = await r.ensemble('prompt', {});
  assert.equal(r.size, 2);
  assert.equal(out.length, 2);
  assert.equal(out.find((x) => x.name === 'a').ok, true);
  assert.equal(out.find((x) => x.name === 'a').result.stance, 'bullish');
});

test('a failing adapter is captured, not thrown', async () => {
  const adapters = [
    { name: 'good', generate: async () => ({ stance: 'neutral', confidence: 0.5, rationale: 'z' }) },
    { name: 'bad', generate: async () => { throw new Error('429 rate limit'); } },
  ];
  const out = await createRouter({ adapters }).ensemble('p', {});
  assert.equal(out.find((x) => x.name === 'good').ok, true);
  const bad = out.find((x) => x.name === 'bad');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /429/);
});

test('empty adapters => size 0, empty ensemble', async () => {
  const r = createRouter({ adapters: [] });
  assert.equal(r.size, 0);
  assert.deepEqual(await r.ensemble('p', {}), []);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `src/llm/router.js`**
```js
'use strict';

// Fan one prompt out to every configured adapter in parallel. A failing provider is
// captured (never sinks the others). Adapters share the { name, generate(prompt, schema) } shape.
function createRouter({ adapters = [] } = {}) {
  async function ensemble(prompt, schema) {
    const settled = await Promise.allSettled(adapters.map((a) => a.generate(prompt, schema)));
    return settled.map((s, i) => (s.status === 'fulfilled'
      ? { name: adapters[i].name, ok: true, result: s.value }
      : { name: adapters[i].name, ok: false, error: String((s.reason && s.reason.message) || s.reason) }));
  }
  return { ensemble, size: adapters.length };
}

module.exports = { createRouter };
```

- [ ] **Step 4: Run → pass. Commit**
```
git add src/llm/router.js test/llm-router.test.js
git commit -m "feat(llm): add ensemble router (parallel fan-out, fault-isolated)"
```

---

## Task 5: Prompt builder + provider adapters

**Files:** Create `src/llm/prompt.js`, `src/llm/adapters/{openai,anthropic,google,perplexity,index}.js`

- [ ] **Step 1: Create `src/llm/prompt.js`**
```js
'use strict';

// Build a compact, fact-pinned prompt from the quant prediction. The model is told to
// reason over (never restate as new facts) the numbers provided, and to cite sources.
function buildPrompt(mode, symbol, quant) {
  const facts = JSON.stringify(quant);
  return [
    `You are a market analyst. A deterministic quant engine produced this ${mode} read for ${symbol}:`,
    facts,
    'Give a concise stance (bullish/neutral/bearish), a calibrated confidence (0-1), a 2-3 sentence',
    'rationale, key risks, and sources. Do NOT invent prices or figures — reason only over the numbers',
    'above. If you reference a number, use the ones provided.',
  ].join('\n');
}

module.exports = { buildPrompt };
```

- [ ] **Step 2: Create the four adapters** (thin wrappers — not unit-tested; exercised only with live keys)

`src/llm/adapters/openai.js`
```js
'use strict';
const { generateObject } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');

function createOpenAIAdapter({ apiKey, model = 'gpt-4o-mini' }) {
  const provider = createOpenAI({ apiKey });
  return {
    name: 'openai',
    async generate(prompt, schema) {
      const { object } = await generateObject({ model: provider(model), schema, prompt });
      return object;
    },
  };
}
module.exports = { createOpenAIAdapter };
```

`src/llm/adapters/anthropic.js`
```js
'use strict';
const { generateObject } = require('ai');
const { createAnthropic } = require('@ai-sdk/anthropic');

function createAnthropicAdapter({ apiKey, model = 'claude-3-5-haiku-latest' }) {
  const provider = createAnthropic({ apiKey });
  return {
    name: 'anthropic',
    async generate(prompt, schema) {
      const { object } = await generateObject({ model: provider(model), schema, prompt });
      return object;
    },
  };
}
module.exports = { createAnthropicAdapter };
```

`src/llm/adapters/google.js`
```js
'use strict';
const { generateObject } = require('ai');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');

function createGoogleAdapter({ apiKey, model = 'gemini-2.5-flash' }) {
  const provider = createGoogleGenerativeAI({ apiKey });
  return {
    name: 'gemini',
    async generate(prompt, schema) {
      const { object } = await generateObject({ model: provider(model), schema, prompt });
      return object;
    },
  };
}
module.exports = { createGoogleAdapter };
```

`src/llm/adapters/perplexity.js`
```js
'use strict';
const { generateObject } = require('ai');
const { createPerplexity } = require('@ai-sdk/perplexity');

function createPerplexityAdapter({ apiKey, model = 'sonar' }) {
  const provider = createPerplexity({ apiKey });
  return {
    name: 'perplexity',
    async generate(prompt, schema) {
      const { object } = await generateObject({ model: provider(model), schema, prompt });
      return object;
    },
  };
}
module.exports = { createPerplexityAdapter };
```

`src/llm/adapters/index.js`
```js
'use strict';
const { createOpenAIAdapter } = require('./openai');
const { createAnthropicAdapter } = require('./anthropic');
const { createGoogleAdapter } = require('./google');
const { createPerplexityAdapter } = require('./perplexity');

// Only build an adapter when its key is present, so the ensemble auto-sizes to configured providers.
function buildAdapters(config) {
  const a = [];
  if (config.OPENAI_API_KEY) a.push(createOpenAIAdapter({ apiKey: config.OPENAI_API_KEY }));
  if (config.ANTHROPIC_API_KEY) a.push(createAnthropicAdapter({ apiKey: config.ANTHROPIC_API_KEY }));
  if (config.GEMINI_API_KEY) a.push(createGoogleAdapter({ apiKey: config.GEMINI_API_KEY }));
  if (config.PERPLEXITY_API_KEY) a.push(createPerplexityAdapter({ apiKey: config.PERPLEXITY_API_KEY }));
  return a;
}
module.exports = { buildAdapters, createOpenAIAdapter, createAnthropicAdapter, createGoogleAdapter, createPerplexityAdapter };
```

- [ ] **Step 3: Commit** (no test for thin adapters; verify they at least `require` without throwing: `node -e "require('./src/llm/adapters')"`)
```
git add src/llm/prompt.js src/llm/adapters
git commit -m "feat(llm): add prompt builder + OpenAI/Anthropic/Gemini/Perplexity adapters"
```

---

## Task 6: Insight service (quant voice + LLM voices → consensus)

**Files:** Create `src/insight-service.js`; Test `test/insight-service.test.js`

- [ ] **Step 1: Failing tests** — `test/insight-service.test.js`
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createInsightService } = require('../src/insight-service');

const fakePredict = {
  intraday: async (s) => ({ symbol: s, bias: 'Bullish', probability_up: 0.7, expected_move: { base: 100 } }),
  outlook: async (s) => ({ symbol: s, stance: 'Constructive', confidence: 0.6 }),
};

test('no LLM adapters => pure-quant consensus from the quant voice', async () => {
  const router = { size: 0, ensemble: async () => [] };
  const svc = createInsightService({ predictService: fakePredict, router });
  const out = await svc.insight('intraday', 'AAPL');
  assert.equal(out.models.length, 0);
  assert.equal(out.consensus.stance, 'bullish');     // mapped from quant bias
  assert.equal(out.quant.symbol, 'AAPL');
});

test('LLM voices join the quant voice in consensus', async () => {
  const router = {
    size: 2,
    ensemble: async () => [
      { name: 'openai', ok: true, result: { stance: 'bullish', confidence: 0.7, rationale: 'r', sources: [] } },
      { name: 'gemini', ok: true, result: { stance: 'bullish', confidence: 0.6, rationale: 'r', sources: [] } },
    ],
  };
  const svc = createInsightService({ predictService: fakePredict, router });
  const out = await svc.insight('intraday', 'AAPL');
  assert.equal(out.models.length, 2);
  assert.equal(out.consensus.stance, 'bullish');
  assert.equal(out.consensus.votes.length, 3);       // quant + 2 models
  assert.equal(out.consensus.divergence, false);
});

test('outlook maps Cautious => bearish quant vote', async () => {
  const router = { size: 0, ensemble: async () => [] };
  const svc = createInsightService({ predictService: {
    outlook: async (s) => ({ symbol: s, stance: 'Cautious', confidence: 0.5 }) }, router });
  const out = await svc.insight('outlook', 'AAPL');
  assert.equal(out.consensus.stance, 'bearish');
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `src/insight-service.js`**
```js
'use strict';
const { buildConsensus } = require('./llm/consensus');
const { buildPrompt } = require('./llm/prompt');
const { ReadSchema } = require('./llm/schemas');

function quantStance(mode, q) {
  if (mode === 'intraday') {
    const b = (q.bias || '').toLowerCase();
    return b === 'bullish' ? 'bullish' : b === 'bearish' ? 'bearish' : 'neutral';
  }
  // outlook
  const s = (q.stance || '').toLowerCase();
  return s === 'constructive' ? 'bullish' : s === 'cautious' ? 'bearish' : 'neutral';
}

function quantConfidence(mode, q) {
  if (mode === 'intraday' && typeof q.probability_up === 'number') {
    return Math.abs(q.probability_up - 0.5) * 2;     // 0.5 => 0 conviction, 1.0 => full
  }
  return typeof q.confidence === 'number' ? q.confidence : 0.5;
}

function createInsightService({ predictService, router }) {
  async function insight(mode, symbol) {
    const quant = await predictService[mode](symbol);
    const quantVote = { name: 'quant', stance: quantStance(mode, quant), confidence: quantConfidence(mode, quant) };

    let models = [];
    if (router.size > 0) {
      const raw = await router.ensemble(buildPrompt(mode, symbol, quant), ReadSchema);
      models = raw.filter((r) => r.ok).map((r) => ({ name: r.name, ...r.result }));
    }

    const votes = [quantVote, ...models.map((m) => ({ name: m.name, stance: m.stance, confidence: m.confidence }))];
    return { mode, symbol, quant, models, consensus: buildConsensus(votes) };
  }
  return { insight };
}

module.exports = { createInsightService, quantStance, quantConfidence };
```

- [ ] **Step 4: Run → pass. Commit**
```
git add src/insight-service.js test/insight-service.test.js
git commit -m "feat(llm): add insight service (quant + LLM voices -> consensus)"
```

---

## Task 7: Config + routes + server wiring

**Files:** Modify `src/config.js`, `src/server.js`; Create `src/insight-routes.js`

- [ ] **Step 1: Add LLM keys to `src/config.js`** — ensure the exported config object includes (add any that are missing; keep existing fields):
```js
OPENAI_API_KEY: (process.env.OPENAI_API_KEY || '').trim(),
ANTHROPIC_API_KEY: (process.env.ANTHROPIC_API_KEY || '').trim(),
GEMINI_API_KEY: (process.env.GEMINI_API_KEY || '').trim(),
PERPLEXITY_API_KEY: (process.env.PERPLEXITY_API_KEY || '').trim(),
```

- [ ] **Step 2: Create `src/insight-routes.js`**
```js
'use strict';
const express = require('express');

function createInsightRouter({ insightService }) {
  const router = express.Router();
  router.get('/:mode/:symbol', async (req, res) => {
    const mode = req.params.mode;
    if (!['intraday', 'outlook'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be intraday or outlook' });
    }
    try {
      res.json(await insightService.insight(mode, req.params.symbol.toUpperCase()));
    } catch (e) {
      res.status(503).json({ error: 'insight unavailable', detail: e.message });
    }
  });
  return router;
}
module.exports = { createInsightRouter };
```

- [ ] **Step 3: Wire into `src/server.js`** — next to the Phase 4 predict wiring (where `predictService` and `config` are in scope), add:
```js
const { buildAdapters } = require('./llm/adapters');
const { createRouter } = require('./llm/router');
const { createInsightService } = require('./insight-service');
const { createInsightRouter } = require('./insight-routes');

const llmRouter = createRouter({ adapters: buildAdapters(config) });
const insightService = createInsightService({ predictService, router: llmRouter });
app.use('/api/insight', createInsightRouter({ insightService }));
console.log(`[llm] ensemble providers configured: ${llmRouter.size}`);
```
(Additive — do not disturb existing routes/WS/start logic.)

- [ ] **Step 4: Run FULL suite → green**
```
node --test
```
Expected: all prior tests + Phase 5 (schema, consensus, reconcile, llm-router, insight-service) pass.

- [ ] **Step 5: Commit**
```
git add src/config.js src/insight-routes.js src/server.js
git commit -m "feat(llm): mount /api/insight ensemble+consensus routes"
```

---

## Acceptance criteria
- [ ] `node --test` green (all prior + Phase 5 tests).
- [ ] Consensus: unanimous→agreement 1/no divergence; split→divergence; confidence-weighted majority; empty→neutral.
- [ ] Reconcile: matching numbers clean; fabricated price flagged; rounding tolerant; bare small ints ignored.
- [ ] Router: parallel fan-out; failing provider captured; empty→size 0.
- [ ] Insight: no adapters→pure-quant consensus from the quant voice; with adapters→quant+model votes; outlook Cautious→bearish.
- [ ] Adapters `require()` without throwing; `buildAdapters` returns only providers whose key is set.
- [ ] `/api/insight/:mode/:symbol` returns `{quant, models, consensus}`; bad mode→400; failure→503.
- [ ] `.env` never staged.
- [ ] Branch `feat/phase-5-llm-ensemble` ready to merge.

## Self-review notes
- **Spec coverage:** implements spec §"Differentiator: multi-model ensemble + consensus" (fan-out, per-model rows, consensus headline, divergence as a signal) and §"numbers in code, words from the models" (reconciliation; LLM returns stance/prose, never relied-upon numbers).
- **Testable core / isolated network:** consensus, reconcile, router, insight-service are pure and fully tested with fakes; only the four thin adapters touch the network and are exercised solely when keys exist.
- **Graceful degradation:** `buildAdapters` returns `[]` with no keys → router size 0 → pure-quant consensus. A failing provider is captured by `Promise.allSettled`. Sidecar/predict failure → 503.
- **Multi-predictor ready:** consensus consumes generic `{name, stance, confidence}` votes — the quant voice is in now; statistical/ML/analyst voices (Phase 6/9) drop in the same way.
- **Type consistency:** `buildConsensus(votes)`, `reconcileNumbers(text, facts)`, `createRouter({adapters}).ensemble(prompt, schema)`, `createInsightService({predictService, router}).insight(mode, symbol)`, adapter `{name, generate(prompt, schema)}` are consistent across modules, wiring, and tests.

## Notes / follow-ups
- Number reconciliation is currently advisory (computed, surfaced) — wiring it to actually strip/annotate flagged figures in the UI is a Phase 7 concern.
- Perplexity is the web-grounded voice; enabling its search/citations options (beyond the default) can be tuned in `perplexity.js` later.
- Model ids are sensible defaults; adjust per cost/quality once keys are live.
