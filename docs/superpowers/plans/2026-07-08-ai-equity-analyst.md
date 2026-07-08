# AI Equity Analyst Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new `/analyst.html` page that fetches fundamental + technical data for any US ticker and uses an LLM to generate a structured 6-section BUY/HOLD/SELL research report with a 0–100% confidence score.

**Architecture:** Two-stage pipeline — Stage A fetches data in parallel (FMP fundamentals + Yahoo technicals + Finnhub news), Stage B feeds the bundle to Gemini/Claude via the existing LLM adapter layer to produce a schema-locked 6-section report. Caching (existing `cache.js`) prevents redundant API calls.

**Tech Stack:** Node.js 22, Express 4, vanilla JS frontend, Yahoo Finance (keyless), FMP REST API (free tier), existing `src/llm/` adapter layer, existing `cache.js`.

## Global Constraints

- Vanilla JS only — no bundler, no React, no TypeScript
- Do not modify any existing file except: `src/server.js` (one `app.use` line), `public/index.html` (one nav pill), `public/manager.js` (one button per position row), `public/paper.js` (one button per signal card)
- FMP free tier: 250 calls/day — cache fundamentals 12h, technicals 2min, reports 30min
- All tests use Node.js built-in `node:test` runner — no Jest, no Mocha
- Integration tests tagged `@slow` — run via `npm run test:integration` not `npm test`
- `?fresh=1` query param bypasses the 30-min report cache
- Every report ends with: `"For research purposes; not personalized investment advice."`
- Verdict must be exactly one of: `"BUY"`, `"HOLD"`, `"SELL"`
- Confidence must be an integer 0–100

---

## File Map

### New files
| File | Responsibility |
|---|---|
| `src/fmp-client.js` | FMP API wrapper — 4 endpoints, normalised output, throws on 4xx/5xx |
| `src/technicals.js` | Pure indicator math + Yahoo candle fetch. Exports `computeTechnicals(symbol)` |
| `src/analyst-service.js` | Pipeline orchestrator — calls fmp, technicals, news, then LLM |
| `src/analyst-routes.js` | Express router — `/report`, `/health`, `/metrics`. Input validation here |
| `src/analyst-observability.js` | Append-only NDJSON logger + in-memory ring buffer (last 50 req, 10 err) |
| `public/analyst.html` | Page shell — inputs, section containers, confidence meter markup |
| `public/analyst.js` | Fetch, render, error states, `?ticker=` URL param pre-fill |
| `public/admin.html` | Observability panel — polls `/api/analyst/metrics` every 30s |
| `tests/unit/technicals.test.js` | Unit tests for indicator math (no network) |
| `tests/unit/fmp-client.test.js` | Unit tests for FMP response parsing (mocked fetch) |
| `tests/unit/analyst-service.test.js` | Unit tests for pipeline assembly + confidence blending |
| `tests/unit/schema.test.js` | Unit tests for LLM output schema validation |
| `tests/integration/fmp.test.js` | Hits real FMP API |
| `tests/integration/yahoo.test.js` | Hits real Yahoo API + runs technicals |
| `tests/integration/report.test.js` | Full pipeline POST end-to-end |
| `tests/integration/cache.test.js` | Cache hit behaviour |
| `tests/integration/comparison.test.js` | Comparison mode with 2 tickers |

### Modified files
| File | Change |
|---|---|
| `src/server.js` | Add `app.use('/api/analyst', analystRouter)` after other routers |
| `public/index.html` | Add Analyst nav pill matching Manager pill style |
| `public/manager.js` | Add "Analyst Report" button to each position row |
| `public/paper.js` | Add "Analyst Report" button to signal cards |

---

## Milestone 1 — Data Layer

### Task 1: FMP client — unit tests + implementation

**Files:**
- Create: `src/fmp-client.js`
- Create: `tests/unit/fmp-client.test.js`

**Interfaces:**
- Produces:
  - `getFundamentals(symbol, apiKey)` → `Promise<{ profile, income, metrics, balance }>`
  - `getProfile(symbol, apiKey)` → `Promise<ProfileShape>`
  - `getIncomeStatement(symbol, apiKey)` → `Promise<QuarterShape[]>`
  - `getKeyMetrics(symbol, apiKey)` → `Promise<MetricsShape>`
  - `getBalanceSheet(symbol, apiKey)` → `Promise<BalanceShape>`

- [ ] **Step 1: Create test file with failing tests**

Create `tests/unit/fmp-client.test.js`:

```js
'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

// We patch global fetch before requiring the module under test
test('getProfile: maps FMP array response to normalised shape', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => [{
      symbol: 'AAPL', companyName: 'Apple Inc', sector: 'Technology',
      industry: 'Consumer Electronics', mktCap: 3e12, description: 'Makes phones',
      exchangeShortName: 'NASDAQ',
    }],
  }));
  globalThis.fetch = fakeFetch;
  const { getProfile } = require('../../src/fmp-client');
  const result = await getProfile('AAPL', 'testkey');
  assert.equal(result.symbol, 'AAPL');
  assert.equal(result.sector, 'Technology');
  assert.equal(result.mktCap, 3e12);
  mock.restoreAll();
});

test('getProfile: throws when FMP returns empty array', async () => {
  globalThis.fetch = mock.fn(async () => ({ ok: true, json: async () => [] }));
  const { getProfile } = require('../../src/fmp-client');
  await assert.rejects(() => getProfile('ZZZZ', 'testkey'), /no profile/i);
  mock.restoreAll();
});

test('getProfile: throws with status on non-ok response', async () => {
  globalThis.fetch = mock.fn(async () => ({ ok: false, status: 429 }));
  const { getProfile } = require('../../src/fmp-client');
  await assert.rejects(() => getProfile('AAPL', 'testkey'), /429/);
  mock.restoreAll();
});

test('getIncomeStatement: slices to 8 quarters and maps fields', async () => {
  const quarter = { date: '2024-09-30', period: 'Q4', revenue: 94930000000,
    grossProfit: 43047000000, operatingIncome: 29590000000,
    netIncome: 24671000000, eps: 1.64, epsdiluted: 1.64 };
  globalThis.fetch = mock.fn(async () => ({
    ok: true, json: async () => Array(10).fill(quarter),
  }));
  const { getIncomeStatement } = require('../../src/fmp-client');
  const result = await getIncomeStatement('AAPL', 'testkey');
  assert.equal(result.length, 8);
  assert.ok(result[0].grossMargin > 0 && result[0].grossMargin < 1);
  mock.restoreAll();
});

test('getKeyMetrics: returns null for missing fields gracefully', async () => {
  globalThis.fetch = mock.fn(async () => ({
    ok: true, json: async () => [{ peRatioTTM: 28.5 }],
  }));
  const { getKeyMetrics } = require('../../src/fmp-client');
  const result = await getKeyMetrics('AAPL', 'testkey');
  assert.equal(result.peRatio, 28.5);
  assert.equal(result.pegRatio, null);
  mock.restoreAll();
});
```

- [ ] **Step 2: Run tests — confirm they all fail**

```bash
node --test tests/unit/fmp-client.test.js
```

Expected: all 4 tests FAIL with `Cannot find module '../../src/fmp-client'`

- [ ] **Step 3: Implement `src/fmp-client.js`**

```js
'use strict';

const BASE = 'https://financialmodelingprep.com/api/v3';

async function fmpGet(path, key) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}apikey=${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) {
    const err = new Error(`FMP ${path} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getProfile(symbol, key) {
  const data = await fmpGet(`/profile/${encodeURIComponent(symbol)}`, key);
  const p = Array.isArray(data) ? data[0] : data;
  if (!p || !p.symbol) throw new Error(`FMP no profile for ${symbol}`);
  return {
    symbol: p.symbol,
    name: p.companyName || '',
    sector: p.sector || '',
    industry: p.industry || '',
    mktCap: p.mktCap || 0,
    description: p.description || '',
    exchange: p.exchangeShortName || '',
  };
}

async function getIncomeStatement(symbol, key) {
  const data = await fmpGet(
    `/income-statement/${encodeURIComponent(symbol)}?limit=8`, key);
  if (!Array.isArray(data) || !data.length)
    throw new Error(`FMP no income data for ${symbol}`);
  return data.slice(0, 8).map(q => ({
    date: q.date,
    period: q.period,
    revenue: q.revenue || 0,
    grossProfit: q.grossProfit || 0,
    grossMargin: q.revenue ? q.grossProfit / q.revenue : 0,
    operatingIncome: q.operatingIncome || 0,
    netIncome: q.netIncome || 0,
    eps: q.eps || 0,
    epsDiluted: q.epsdiluted || 0,
  }));
}

async function getKeyMetrics(symbol, key) {
  const data = await fmpGet(`/key-metrics-ttm/${encodeURIComponent(symbol)}`, key);
  const m = Array.isArray(data) ? data[0] : data;
  if (!m) throw new Error(`FMP no key metrics for ${symbol}`);
  return {
    peRatio:              m.peRatioTTM              ?? null,
    priceToSalesRatio:    m.priceToSalesRatioTTM    ?? null,
    evToEbitda:           m.enterpriseValueOverEBITDATTM ?? null,
    pegRatio:             m.pegRatioTTM             ?? null,
    pbRatio:              m.pbRatioTTM              ?? null,
    freeCashFlowPerShare: m.freeCashFlowPerShareTTM ?? null,
    debtToEquity:         m.debtToEquityTTM         ?? null,
    interestCoverage:     m.interestCoverageTTM     ?? null,
    returnOnEquity:       m.roeTTM                  ?? null,
  };
}

async function getBalanceSheet(symbol, key) {
  const data = await fmpGet(
    `/balance-sheet-statement/${encodeURIComponent(symbol)}?limit=1`, key);
  const b = Array.isArray(data) ? data[0] : data;
  if (!b) throw new Error(`FMP no balance sheet for ${symbol}`);
  return {
    date: b.date,
    cashAndEquivalents: b.cashAndCashEquivalents || 0,
    totalDebt: b.totalDebt || 0,
    totalAssets: b.totalAssets || 0,
    totalEquity: b.totalStockholdersEquity || 0,
    netCash: (b.cashAndCashEquivalents || 0) - (b.totalDebt || 0),
  };
}

async function getFundamentals(symbol, key) {
  const [profile, income, metrics, balance] = await Promise.all([
    getProfile(symbol, key),
    getIncomeStatement(symbol, key),
    getKeyMetrics(symbol, key),
    getBalanceSheet(symbol, key),
  ]);
  return { profile, income, metrics, balance };
}

module.exports = { getFundamentals, getProfile, getIncomeStatement,
                   getKeyMetrics, getBalanceSheet };
```

- [ ] **Step 4: Run tests — confirm all pass**

```bash
node --test tests/unit/fmp-client.test.js
```

Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/fmp-client.js tests/unit/fmp-client.test.js
git commit -m "feat(analyst): FMP client with unit tests"
```

---

### Task 2: Technical indicators — unit tests + implementation

**Files:**
- Create: `src/technicals.js`
- Create: `tests/unit/technicals.test.js`

**Interfaces:**
- Consumes: `yahoo-client.fetchCandles(symbol, '1D', '1Y')` (existing)
- Produces: `computeTechnicals(symbol)` → `Promise<TechnicalsShape>`
  - Also exports pure functions for testing: `rsi(closes, period)`, `sma(closes, period)`, `macd(closes, fast, slow, signal)`, `bollingerBands(closes, period, stdDev)`

- [ ] **Step 1: Create test file with failing tests**

Create `tests/unit/technicals.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rsi, sma, macd, bollingerBands } = require('../../src/technicals');

test('sma: computes 3-period SMA correctly', () => {
  const closes = [10, 20, 30, 40, 50];
  const result = sma(closes, 3);
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.equal(result[2], 20);  // (10+20+30)/3
  assert.equal(result[3], 30);  // (20+30+40)/3
  assert.equal(result[4], 40);  // (30+40+50)/3
});

test('rsi: returns null for first period bars', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const result = rsi(closes, 14);
  assert.equal(result[0], null);
  assert.equal(result[13], null);
  assert.ok(result[14] !== null);
});

test('rsi: all gains = RSI of 100', () => {
  // 15 bars of pure gains: RSI should approach 100
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
  const result = rsi(closes, 14);
  const lastRsi = result[result.length - 1];
  assert.ok(lastRsi > 90, `expected RSI near 100, got ${lastRsi}`);
});

test('rsi: all losses = RSI near 0', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 200 - i * 2);
  const result = rsi(closes, 14);
  const lastRsi = result[result.length - 1];
  assert.ok(lastRsi < 10, `expected RSI near 0, got ${lastRsi}`);
});

test('macd: detects bullish crossover', () => {
  // Build a close array where fast EMA crosses above slow EMA
  const closes = [
    ...Array.from({ length: 26 }, (_, i) => 100 - i),   // downtrend
    ...Array.from({ length: 20 }, (_, i) => 75 + i * 3), // sharp uptrend
  ];
  const result = macd(closes);
  assert.ok(['bullish', 'above', 'none'].includes(result.crossover));
  assert.ok(result.current.macd !== null);
});

test('bollingerBands: upper > middle > lower', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
  const result = bollingerBands(closes, 20, 2);
  const last = closes.length - 1;
  assert.ok(result.upper[last] > result.middle[last]);
  assert.ok(result.middle[last] > result.lower[last]);
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
node --test tests/unit/technicals.test.js
```

Expected: FAIL — `Cannot find module '../../src/technicals'`

- [ ] **Step 3: Implement `src/technicals.js`**

```js
'use strict';
const yahoo = require('./yahoo-client');

function sma(closes, period) {
  const result = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    result[i] = sum / period;
  }
  return result;
}

function ema(closes, period) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  result[period - 1] = seed / period;
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function rsi(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  result[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    result[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return result;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) =>
    ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null);
  // Build signal EMA over non-null MACD values
  const nonNull = line.map((v, i) => ({ v, i })).filter(x => x.v !== null);
  const sigInput = nonNull.map(x => x.v);
  const sigEma = ema(sigInput, signal);
  const sigLine = new Array(closes.length).fill(null);
  nonNull.forEach(({ i }, idx) => { sigLine[i] = sigEma[idx]; });
  const hist = closes.map((_, i) =>
    line[i] !== null && sigLine[i] !== null ? line[i] - sigLine[i] : null);
  // Find last two valid values for crossover detection
  const lastIdx = line.map((v, i) => v !== null ? i : -1).filter(i => i >= 0);
  const i1 = lastIdx[lastIdx.length - 1];
  const i0 = lastIdx[lastIdx.length - 2];
  let crossover = 'none';
  if (i0 >= 0 && i1 >= 0 && sigLine[i0] !== null && sigLine[i1] !== null) {
    if (line[i1] > sigLine[i1] && line[i0] <= sigLine[i0]) crossover = 'bullish';
    else if (line[i1] < sigLine[i1] && line[i0] >= sigLine[i0]) crossover = 'bearish';
  }
  return { macdLine: line, signalLine: sigLine, histogram: hist,
           current: { macd: line[i1], signal: sigLine[i1] }, crossover };
}

function bollingerBands(closes, period = 20, stdDev = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((a, v) => a + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper[i] = mean + stdDev * std;
    lower[i] = mean - stdDev * std;
  }
  return { upper, middle: mid, lower };
}

function pivots(candles, lookback = 10) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const win = candles.slice(i - lookback, i + lookback + 1);
    if (candles[i].high === Math.max(...win.map(c => c.high))) highs.push(candles[i].high);
    if (candles[i].low === Math.min(...win.map(c => c.low))) lows.push(candles[i].low);
  }
  return { resistance: highs.slice(-5), support: lows.slice(-5) };
}

async function computeTechnicals(symbol) {
  const { candles } = await yahoo.fetchCandles(symbol, '1D', '1Y');
  if (!candles || candles.length < 30)
    return { available: false, reason: 'insufficient candle data' };
  const closes = candles.map(c => c.close);
  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const rsiVals = rsi(closes, 14);
  const macdResult = macd(closes);
  const bb = bollingerBands(closes, 20, 2);
  const piv = pivots(candles);
  const last = candles[candles.length - 1];
  const n = closes.length - 1;
  const prev50 = s50.slice(0, n).reverse().find(v => v !== null);
  const prev200 = s200.slice(0, n).reverse().find(v => v !== null);
  let cross = 'none';
  if (prev50 && prev200) {
    if (s50[n] > s200[n] && prev50 <= prev200) cross = 'golden';
    else if (s50[n] < s200[n] && prev50 >= prev200) cross = 'death';
    else cross = s50[n] > s200[n] ? 'golden_active' : 'death_active';
  }
  return {
    available: true,
    currentPrice: last.close,
    rsi: { value: +(rsiVals[n] || 0).toFixed(2), period: 14 },
    macd: { value: macdResult.current.macd, signal: macdResult.current.signal,
            crossover: macdResult.crossover },
    movingAverages: {
      sma20: s20[n], sma50: s50[n], sma200: s200[n],
      priceVsSma20: last.close > s20[n] ? 'above' : 'below',
      priceVsSma50: last.close > s50[n] ? 'above' : 'below',
      priceVsSma200: last.close > s200[n] ? 'above' : 'below',
    },
    cross,
    bollinger: {
      upper: bb.upper[n], middle: bb.middle[n], lower: bb.lower[n],
      position: last.close > bb.upper[n] ? 'above'
               : last.close < bb.lower[n] ? 'below' : 'inside',
    },
    pivots: piv,
    volume: { last: last.volume,
              avg20: candles.slice(-20).reduce((a, c) => a + c.volume, 0) / 20 },
  };
}

module.exports = { computeTechnicals, rsi, sma, ema, macd, bollingerBands };
```

- [ ] **Step 4: Run tests — confirm all pass**

```bash
node --test tests/unit/technicals.test.js
```

Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/technicals.js tests/unit/technicals.test.js
git commit -m "feat(analyst): technical indicators engine with unit tests"
```

---

### Task 3: Integration tests — FMP and Yahoo

**Files:**
- Create: `tests/integration/fmp.test.js`
- Create: `tests/integration/yahoo.test.js`

**Requires:** `FMP_API_KEY` in `.env`. Register free at financialmodelingprep.com.

- [ ] **Step 1: Add FMP_API_KEY to .env and .env.example**

In `.env` add:
```
FMP_API_KEY=your_actual_key_here
```

In `.env.example` add:
```
FMP_API_KEY=your_fmp_api_key_here
```

- [ ] **Step 2: Add test:integration script to package.json**

Open `package.json`, find the `"scripts"` block. Add:
```json
"test:integration": "node --test tests/integration/*.test.js"
```

- [ ] **Step 3: Create integration tests**

Create `tests/integration/fmp.test.js`:
```js
'use strict';
// @slow — requires FMP_API_KEY in .env and network access
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getFundamentals, getProfile } = require('../../src/fmp-client');

const KEY = process.env.FMP_API_KEY;
if (!KEY) { console.warn('Skipping FMP integration tests: FMP_API_KEY not set'); process.exit(0); }

test('getProfile: returns real AAPL sector', async () => {
  const p = await getProfile('AAPL', KEY);
  assert.equal(p.symbol, 'AAPL');
  assert.ok(p.sector.length > 0, 'sector should be non-empty');
  assert.ok(p.mktCap > 0, 'mktCap should be positive');
});

test('getFundamentals: AAPL income has positive revenue', async () => {
  const { income } = await getFundamentals('AAPL', KEY);
  assert.ok(income.length > 0, 'should have at least one quarter');
  assert.ok(income[0].revenue > 0, 'revenue should be positive');
  assert.ok(income[0].grossMargin > 0 && income[0].grossMargin < 1,
    'gross margin should be 0–1');
});

test('getFundamentals: AAPL metrics has peRatio', async () => {
  const { metrics } = await getFundamentals('AAPL', KEY);
  assert.ok(metrics.peRatio !== null, 'P/E should be present');
  assert.ok(metrics.peRatio > 0, 'P/E should be positive');
});
```

Create `tests/integration/yahoo.test.js`:
```js
'use strict';
// @slow — requires network access
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeTechnicals } = require('../../src/technicals');

test('computeTechnicals: MSFT returns RSI in valid range', async () => {
  const result = await computeTechnicals('MSFT');
  assert.equal(result.available, true);
  assert.ok(result.rsi.value >= 0 && result.rsi.value <= 100,
    `RSI should be 0–100, got ${result.rsi.value}`);
  assert.ok(result.movingAverages.sma20 > 0, 'SMA20 should be positive');
  assert.ok(result.movingAverages.sma200 > 0, 'SMA200 should be positive');
});

test('computeTechnicals: returns Bollinger bands upper > lower', async () => {
  const result = await computeTechnicals('MSFT');
  assert.ok(result.bollinger.upper > result.bollinger.lower,
    'upper band should be above lower');
});
```

- [ ] **Step 4: Run integration tests**

```bash
npm run test:integration
```

Expected: All 5 tests PASS. If FMP key is missing, tests skip with a warning (not a failure).

- [ ] **Step 5: Verify FMP data manually**

```bash
node -e "require('dotenv').config(); const {getFundamentals}=require('./src/fmp-client'); getFundamentals('NVDA', process.env.FMP_API_KEY).then(d => console.log(JSON.stringify(d.profile, null, 2)))"
```

Expected: JSON with NVDA name, sector, mktCap printed to terminal.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/fmp.test.js tests/integration/yahoo.test.js package.json .env.example
git commit -m "test(analyst): FMP + Yahoo integration tests, add test:integration script"
```

---

## Milestone 2 — Backend API

### Task 4: Observability module

**Files:**
- Create: `src/analyst-observability.js`

**Interfaces:**
- Produces:
  - `createObservability({ logPath })` → `{ log(entry), logError(entry), getMetrics() }`
  - `log(entry)` — appends NDJSON line to file + adds to ring buffer
  - `logError(entry)` — same for errors
  - `getMetrics()` → `{ requests: [...last50], errors: [...last10], summary }`

- [ ] **Step 1: Implement `src/analyst-observability.js`**

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createObservability({ logPath = 'logs/analyst.log' } = {}) {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const requests = [];   // ring buffer, max 50
  const errors = [];     // ring buffer, max 10
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
    try { fs.appendFileSync(logPath, JSON.stringify(line) + '\n'); } catch (_) {}
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
        cacheHitRate: totalRequests > 0
          ? +(totalCacheHits / totalRequests).toFixed(2) : 0,
        avgTotalMs: totalRequests > 0
          ? Math.round(totalMs / totalRequests) : 0,
        fmpCallsToday,
      },
    };
  }

  return { log, logError, getMetrics };
}

module.exports = { createObservability };
```

- [ ] **Step 2: Quick smoke test**

```bash
node -e "
const {createObservability} = require('./src/analyst-observability');
const obs = createObservability({ logPath: 'logs/test-obs.log' });
obs.log({ ticker: 'TEST', verdict: 'BUY', confidence: 80, totalMs: 1234, cacheHit: false, fmpCalls: 4 });
obs.logError({ ticker: 'BAD', error: 'FMP_404' });
console.log(JSON.stringify(obs.getMetrics(), null, 2));
"
```

Expected: JSON printed with 1 request entry, 1 error entry, summary with totalRequests=1.

- [ ] **Step 3: Commit**

```bash
git add src/analyst-observability.js
git commit -m "feat(analyst): observability module — structured logger + metrics ring buffer"
```

---

### Task 5: Analyst service — unit tests + implementation

**Files:**
- Create: `src/analyst-service.js`
- Create: `tests/unit/analyst-service.test.js`
- Create: `tests/unit/schema.test.js`

**Interfaces:**
- Consumes: `getFundamentals(symbol, key)`, `computeTechnicals(symbol)`, `fetch('/api/news/:symbol')`
- Produces: `createAnalystService({ fmp, technicals, cache, llm, config, obs })` → `{ report(ticker, mode, depth, fresh) }`

- [ ] **Step 1: Write failing unit tests**

Create `tests/unit/schema.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateReport } = require('../../src/analyst-service');

test('validateReport: accepts valid 6-section report', () => {
  const valid = {
    overview: { sector: 'Tech', mktCap: 1e12, thesis: 'AI leader' },
    financials: { revenue: 90e9, eps: 1.5, margins: 0.75, fcf: 60e9,
                  trend: 'improving', beatMiss: 'beat' },
    strengthsRisks: { strengths: ['CUDA moat'], risks: ['China ban'] },
    valuation: { ratios: { pe: 35 }, vsSector: 'premium',
                 vsHistory: 'mid-range', assessment: 'fair' },
    technical: { setup: 'bullish', indicators: {}, keyLevels: {}, available: true },
    recommendation: { verdict: 'BUY', primaryDrivers: ['growth', 'moat'],
                      invalidationConditions: ['margin <70%'],
                      confidenceJustification: 'both signals aligned' },
  };
  assert.doesNotThrow(() => validateReport(valid));
});

test('validateReport: throws on missing section', () => {
  const bad = { overview: {}, financials: {} }; // missing 4 sections
  assert.throws(() => validateReport(bad), /missing/i);
});

test('validateReport: throws on invalid verdict', () => {
  const bad = {
    overview: {}, financials: {}, strengthsRisks: {}, valuation: {},
    technical: {}, recommendation: { verdict: 'STRONG BUY' },
  };
  assert.throws(() => validateReport(bad), /verdict/i);
});
```

Create `tests/unit/analyst-service.test.js`:
```js
'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

test('createAnalystService: returns cached report on second call', async () => {
  const { createAnalystService } = require('../../src/analyst-service');
  const fakeReport = {
    overview: { sector: 'Tech', mktCap: 1e12, thesis: 't' },
    financials: { revenue: 1, eps: 1, margins: 0.5, fcf: 1, trend: 'up', beatMiss: 'beat' },
    strengthsRisks: { strengths: ['s'], risks: ['r'] },
    valuation: { ratios: {}, vsSector: 'ok', vsHistory: 'ok', assessment: 'fair' },
    technical: { setup: 'bullish', indicators: {}, keyLevels: {}, available: true },
    recommendation: { verdict: 'BUY', primaryDrivers: ['a'],
                      invalidationConditions: ['b'], confidenceJustification: 'c' },
  };
  let llmCalls = 0;
  const fakeLlm = { generate: async () => { llmCalls++; return JSON.stringify(fakeReport); } };
  const fakeFmp = { getFundamentals: async () => ({ profile: {}, income: [], metrics: {}, balance: {} }) };
  const fakeTech = { computeTechnicals: async () => ({ available: false }) };
  const fakeCache = (() => { const m = new Map(); return {
    getOrLoad: async (k, _ttl, fn) => { if (m.has(k)) return m.get(k); const v = await fn(); m.set(k, v); return v; }
  }; })();
  const fakeObs = { log: () => {}, logError: () => {} };
  const fakeConfig = { FMP_API_KEY: 'x', GEMINI_API_KEY: 'x' };

  const svc = createAnalystService({ fmp: fakeFmp, technicals: fakeTech,
    cache: fakeCache, llm: fakeLlm, config: fakeConfig, obs: fakeObs });

  await svc.report('AAPL', 'single', 'standard', false);
  await svc.report('AAPL', 'single', 'standard', false);  // should hit cache
  assert.equal(llmCalls, 1, 'LLM should only be called once when cached');
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
node --test tests/unit/analyst-service.test.js tests/unit/schema.test.js
```

Expected: FAIL — `Cannot find module '../../src/analyst-service'`

- [ ] **Step 3: Implement `src/analyst-service.js`**

```js
'use strict';

const REQUIRED_SECTIONS = ['overview','financials','strengthsRisks',
                           'valuation','technical','recommendation'];
const VALID_VERDICTS = new Set(['BUY','HOLD','SELL']);

function validateReport(report) {
  const missing = REQUIRED_SECTIONS.filter(s => !(s in report));
  if (missing.length) throw new Error(`Report missing sections: ${missing.join(', ')}`);
  const v = report.recommendation && report.recommendation.verdict;
  if (!VALID_VERDICTS.has(v)) throw new Error(`Invalid verdict: "${v}" must be BUY, HOLD, or SELL`);
}

function buildPrompt(symbol, fundamentals, technicals, news) {
  return `You are an institutional equity research analyst. Analyse ${symbol}.

FUNDAMENTAL DATA:
${JSON.stringify(fundamentals, null, 2)}

TECHNICAL DATA:
${JSON.stringify(technicals, null, 2)}

RECENT NEWS HEADLINES:
${JSON.stringify((news || []).slice(0, 5).map(n => n.headline), null, 2)}

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "overview": { "sector": string, "mktCap": number, "thesis": string },
  "financials": { "revenue": number, "eps": number, "margins": number, "fcf": number, "trend": string, "beatMiss": string },
  "strengthsRisks": { "strengths": [string], "risks": [string] },
  "valuation": { "ratios": object, "vsSector": string, "vsHistory": string, "assessment": string },
  "technical": { "setup": string, "indicators": object, "keyLevels": object, "available": boolean },
  "recommendation": { "verdict": "BUY"|"HOLD"|"SELL", "primaryDrivers": [string], "invalidationConditions": [string], "confidenceJustification": string }
}

Rules:
- verdict MUST be exactly one of: BUY, HOLD, SELL
- Lead with conclusion, quantify every claim ("margins expanded 240bps YoY")
- No hype, no guarantees`;
}

function blendConfidence(fundamentals, technicals) {
  // Simple heuristic: count bullish/bearish signals, return 0-100
  let bullish = 0, total = 0;
  if (technicals.available) {
    total += 4;
    if (technicals.rsi && technicals.rsi.value < 70 && technicals.rsi.value > 30) bullish++;
    if (technicals.macd && technicals.macd.crossover === 'bullish') bullish += 2;
    if (technicals.movingAverages) {
      const ma = technicals.movingAverages;
      if (ma.priceVsSma200 === 'above') bullish++;
    }
  }
  if (fundamentals.metrics) {
    total += 3;
    if (fundamentals.metrics.peRatio && fundamentals.metrics.peRatio < 40) bullish++;
    if (fundamentals.metrics.debtToEquity && fundamentals.metrics.debtToEquity < 1) bullish++;
    if (fundamentals.income && fundamentals.income.length > 1 &&
        fundamentals.income[0].revenue > fundamentals.income[1].revenue) bullish++;
  }
  if (total === 0) return 50; // no data
  return Math.round((bullish / total) * 100);
}

function createAnalystService({ fmp, technicals: techModule, cache, llm, config, obs }) {
  async function stageA(symbol) {
    const [fundamentals, tech, newsRes] = await Promise.allSettled([
      fmp.getFundamentals(symbol, config.FMP_API_KEY),
      techModule.computeTechnicals(symbol),
      fetch(`http://localhost:${config.PORT || 3000}/api/news/${encodeURIComponent(symbol)}`)
        .then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    return {
      fundamentals: fundamentals.status === 'fulfilled' ? fundamentals.value : {},
      tech: tech.status === 'fulfilled' ? tech.value : { available: false },
      news: newsRes.status === 'fulfilled' ? newsRes.value : [],
    };
  }

  async function stageB(symbol, fundamentals, tech, news, retries = 2) {
    const prompt = buildPrompt(symbol, fundamentals, tech, news);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const raw = await llm.generate(prompt);
        const text = typeof raw === 'string' ? raw : (raw && raw.text) || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in LLM response');
        const parsed = JSON.parse(jsonMatch[0]);
        validateReport(parsed);
        return parsed;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`LLM stage failed after ${retries + 1} attempts: ${lastErr.message}`);
  }

  async function report(ticker, mode = 'single', depth = 'standard', fresh = false) {
    const cacheKey = `analyst:${ticker}:${mode}:${depth}`;
    const ttl = 30 * 60 * 1000; // 30 min
    const t0 = Date.now();

    if (!fresh) {
      const cached = cache.get && cache.get(cacheKey);
      if (cached) {
        obs.log({ ticker, mode, cacheHit: true, totalMs: Date.now() - t0 });
        return { ...cached, cacheHit: true };
      }
    }

    const tA = Date.now();
    const { fundamentals, tech, news } = await stageA(ticker);
    const stageAMs = Date.now() - tA;

    const tB = Date.now();
    const reportSections = await stageB(ticker, fundamentals, tech, news);
    const stageBMs = Date.now() - tB;

    const confidence = blendConfidence(fundamentals, tech);
    const verdict = reportSections.recommendation.verdict;

    const result = {
      ticker,
      generatedAt: new Date().toISOString(),
      cacheHit: false,
      dataFreshness: { fundamentals: '12h', technicals: '2min' },
      verdict,
      confidence,
      report: reportSections,
      disclaimer: 'For research purposes; not personalized investment advice.',
    };

    if (cache.set) cache.set(cacheKey, result, ttl);
    obs.log({ ticker, mode, verdict, confidence, cacheHit: false,
              totalMs: Date.now() - t0, stageAMs, stageBMs, fmpCalls: 4 });
    return result;
  }

  return { report };
}

module.exports = { createAnalystService, validateReport, blendConfidence };
```

- [ ] **Step 4: Run unit tests — confirm all pass**

```bash
node --test tests/unit/analyst-service.test.js tests/unit/schema.test.js
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/analyst-service.js tests/unit/analyst-service.test.js tests/unit/schema.test.js
git commit -m "feat(analyst): pipeline service + schema validation with unit tests"
```

---

### Task 6: Analyst routes + server wiring + integration tests

**Files:**
- Create: `src/analyst-routes.js`
- Modify: `src/server.js`
- Create: `tests/integration/report.test.js`
- Create: `tests/integration/cache.test.js`

**Interfaces:**
- Consumes: `createAnalystService(...)`, `createObservability(...)`
- Produces: Express router mounted at `/api/analyst`
  - `POST /api/analyst/report`
  - `GET /api/analyst/health`
  - `GET /api/analyst/metrics`

- [ ] **Step 1: Implement `src/analyst-routes.js`**

```js
'use strict';
const express = require('express');
const { getFundamentals } = require('./fmp-client');
const { computeTechnicals } = require('./technicals');
const { createAnalystService } = require('./analyst-service');
const { createObservability } = require('./analyst-observability');
const cache = require('./cache');
const config = require('./config');

const obs = createObservability({ logPath: 'logs/analyst.log' });

// Wire up LLM: reuse existing Gemini adapter (primary)
function buildLlm() {
  if (!config.hasGemini) return null;
  return {
    generate: async (prompt) => {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(config.GEMINI_MODEL) +
        ':generateContent?key=' + encodeURIComponent(config.GEMINI_API_KEY);
      const payload = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
      };
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`Gemini error ${r.status}`);
      const data = await r.json();
      const parts = (data?.candidates?.[0]?.content?.parts) || [];
      return parts.map(p => p.text || '').join('');
    },
  };
}

const llm = buildLlm();
const svc = createAnalystService({
  fmp: { getFundamentals },
  technicals: { computeTechnicals },
  cache,
  llm,
  config,
  obs,
});

const TICKER_RE = /^[A-Z0-9.]{1,10}$/;

function validateTicker(t) {
  if (!t || typeof t !== 'string') return 'ticker is required';
  const u = t.trim().toUpperCase();
  if (!TICKER_RE.test(u)) return 'ticker must be 1–10 alphanumeric characters';
  return null;
}

function createAnalystRouter() {
  const router = express.Router();

  // POST /api/analyst/report
  router.post('/report', async (req, res) => {
    try {
      const body = req.body || {};
      const mode = body.mode === 'comparison' ? 'comparison' : 'single';
      const depth = body.depth === 'deep' ? 'deep' : 'standard';
      const fresh = req.query.fresh === '1';

      if (mode === 'comparison') {
        const tickers = Array.isArray(body.tickers) ? body.tickers : [];
        if (tickers.length < 2)
          return res.status(400).json({ error: 'comparison mode requires at least 2 tickers' });
        const errors = tickers.map(validateTicker).filter(Boolean);
        if (errors.length) return res.status(400).json({ error: errors[0] });
        const results = await Promise.all(
          tickers.map(t => svc.report(t.trim().toUpperCase(), 'single', depth, fresh))
        );
        return res.json({ mode: 'comparison', results });
      }

      const err = validateTicker(body.ticker);
      if (err) return res.status(400).json({ error: err });
      const ticker = body.ticker.trim().toUpperCase();
      const result = await svc.report(ticker, mode, depth, fresh);
      return res.json(result);
    } catch (e) {
      obs.logError({ path: '/report', error: e.message });
      const retryAfter = e.message.includes('rate') ? 60 : 30;
      return res.status(503).json({
        error: 'Report unavailable', detail: e.message, retryAfter,
      });
    }
  });

  // GET /api/analyst/health
  router.get('/health', async (_req, res) => {
    const checks = await Promise.allSettled([
      // FMP probe — lightweight
      config.FMP_API_KEY
        ? fetch(`https://financialmodelingprep.com/api/v3/profile/AAPL?apikey=${config.FMP_API_KEY}`)
            .then(r => ({ ok: r.ok, status: r.status }))
        : Promise.resolve({ ok: false, status: 0 }),
      // Yahoo probe
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d',
        { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => ({ ok: r.ok })),
      // LLM check
      Promise.resolve({ ok: !!config.hasGemini }),
    ]);
    const [fmp, yahoo, llmCheck] = checks.map(c =>
      c.status === 'fulfilled' ? c.value : { ok: false, error: c.reason?.message });
    const allOk = fmp.ok && yahoo.ok && llmCheck.ok;
    return res.json({
      status: allOk ? 'ok' : 'degraded',
      connectors: {
        fmp: { status: fmp.ok ? 'ok' : 'down', callsToday: obs.getMetrics().summary.fmpCallsToday, limitPerDay: 250 },
        yahoo: { status: yahoo.ok ? 'ok' : 'down' },
        llm: { status: llmCheck.ok ? 'ok' : 'down', model: config.GEMINI_MODEL || 'none' },
      },
      cache: { reports: { ttlMin: 30 } },
      ...obs.getMetrics().summary,
    });
  });

  // GET /api/analyst/metrics
  router.get('/metrics', (_req, res) => res.json(obs.getMetrics()));

  return router;
}

module.exports = { createAnalystRouter };
```

- [ ] **Step 2: Wire up in `src/server.js`**

Open `src/server.js`. Find where other routers are mounted (look for `app.use('/api/...`). Add directly after:

```js
const { createAnalystRouter } = require('./analyst-routes');
app.use('/api/analyst', createAnalystRouter());
```

- [ ] **Step 3: Start server and smoke test**

```bash
npm start
```

In another terminal:
```bash
curl -X POST http://localhost:3000/api/analyst/report \
  -H "Content-Type: application/json" \
  -d '{"ticker":"AAPL","mode":"single","depth":"standard"}'
```

Expected: JSON response with `verdict`, `confidence`, and `report` fields. May take 5–8 seconds first time.

- [ ] **Step 4: Create integration tests**

Create `tests/integration/report.test.js`:
```js
'use strict';
// @slow — requires running server + FMP_API_KEY + GEMINI_API_KEY
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');

const BASE = 'http://localhost:3000/api/analyst';

test('POST /report: NVDA returns valid 6-section report', async () => {
  const res = await fetch(`${BASE}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticker: 'NVDA', mode: 'single', depth: 'standard' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(['BUY','HOLD','SELL'].includes(data.verdict), `bad verdict: ${data.verdict}`);
  assert.ok(data.confidence >= 0 && data.confidence <= 100);
  assert.ok(data.report.overview);
  assert.ok(data.report.recommendation);
  assert.match(data.disclaimer, /research purposes/i);
});

test('POST /report: invalid ticker returns 400', async () => {
  const res = await fetch(`${BASE}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticker: 'ZZZZ!@#$', mode: 'single' }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error);
});

test('GET /health: returns ok status with connectors', async () => {
  const res = await fetch(`${BASE}/health`);
  assert.ok(res.ok);
  const data = await res.json();
  assert.ok(['ok','degraded','down'].includes(data.status));
  assert.ok(data.connectors.fmp);
  assert.ok(data.connectors.yahoo);
  assert.ok(data.connectors.llm);
});
```

Create `tests/integration/cache.test.js`:
```js
'use strict';
// @slow — requires running server
const { test } = require('node:test');
const assert = require('node:assert/strict');

const BASE = 'http://localhost:3000/api/analyst';

test('cache: second identical request returns cacheHit: true in <200ms', async () => {
  const body = JSON.stringify({ ticker: 'MSFT', mode: 'single', depth: 'standard' });
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };

  await fetch(`${BASE}/report`, opts); // warm the cache

  const t0 = Date.now();
  const res = await fetch(`${BASE}/report`, opts);
  const elapsed = Date.now() - t0;
  const data = await res.json();
  assert.equal(data.cacheHit, true, 'second request should be a cache hit');
  assert.ok(elapsed < 200, `cache hit should be <200ms, took ${elapsed}ms`);
});

test('cache: ?fresh=1 bypasses cache', async () => {
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticker: 'MSFT', mode: 'single', depth: 'standard' }) };
  await fetch(`${BASE}/report`, opts); // warm
  const res = await fetch(`${BASE}/report?fresh=1`, opts);
  const data = await res.json();
  assert.equal(data.cacheHit, false, '?fresh=1 should bypass cache');
});
```

- [ ] **Step 5: Run integration tests (server must be running)**

```bash
npm run test:integration
```

Expected: All tests pass (report test may take 5–8s for LLM).

- [ ] **Step 6: Commit**

```bash
git add src/analyst-routes.js src/server.js \
  tests/integration/report.test.js tests/integration/cache.test.js
git commit -m "feat(analyst): Express routes + server wiring + integration tests"
```

---

## Milestone 3 — Frontend

### Task 7: Analyst page HTML + JS

**Files:**
- Create: `public/analyst.html`
- Create: `public/analyst.js`
- Modify: `public/index.html`

- [ ] **Step 1: Create `public/analyst.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Analyst — Equity Research</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 24px 16px; }
    .header { display: flex; align-items: center; gap: 16px; margin-bottom: 32px; }
    .header h1 { font-size: 1.4rem; font-weight: 600; }
    .back-link { color: #94a3b8; text-decoration: none; font-size: 0.85rem; }
    .back-link:hover { color: #e2e8f0; }
    .input-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 24px; }
    .input-row input { flex: 1; min-width: 200px; padding: 10px 14px;
      background: #1e2433; border: 1px solid #334155; border-radius: 8px;
      color: #e2e8f0; font-size: 1rem; }
    .input-row input:focus { outline: none; border-color: #3b82f6; }
    .input-row select { padding: 10px 14px; background: #1e2433;
      border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; }
    .btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer;
      font-size: 0.95rem; font-weight: 500; transition: opacity 0.15s; }
    .btn:hover { opacity: 0.85; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-secondary { background: #1e2433; color: #94a3b8;
      border: 1px solid #334155; }
    #status { margin-bottom: 16px; min-height: 24px; }
    .spinner { display: inline-block; width: 18px; height: 18px;
      border: 2px solid #334155; border-top-color: #3b82f6;
      border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error-box { background: #2d1515; border: 1px solid #ef4444;
      border-radius: 8px; padding: 12px 16px; color: #fca5a5; }
    .verdict-banner { display: flex; align-items: center; gap: 16px;
      padding: 20px 24px; border-radius: 12px; margin-bottom: 24px; }
    .verdict-banner.BUY { background: #0f2e1a; border: 1px solid #16a34a; }
    .verdict-banner.HOLD { background: #2d2400; border: 1px solid #d97706; }
    .verdict-banner.SELL { background: #2d1515; border: 1px solid #dc2626; }
    .verdict-label { font-size: 2rem; font-weight: 700; }
    .verdict-banner.BUY .verdict-label { color: #22c55e; }
    .verdict-banner.HOLD .verdict-label { color: #f59e0b; }
    .verdict-banner.SELL .verdict-label { color: #ef4444; }
    .confidence-wrap { flex: 1; }
    .confidence-bar { height: 8px; background: #1e2433; border-radius: 4px;
      overflow: hidden; margin-top: 6px; }
    .confidence-fill { height: 100%; border-radius: 4px; transition: width 0.6s; }
    .BUY .confidence-fill { background: #22c55e; }
    .HOLD .confidence-fill { background: #f59e0b; }
    .SELL .confidence-fill { background: #ef4444; }
    .report-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 16px; }
    .section-card { background: #1a1f2e; border: 1px solid #2d3748;
      border-radius: 12px; padding: 20px; }
    .section-card h3 { font-size: 0.75rem; text-transform: uppercase;
      letter-spacing: 0.08em; color: #64748b; margin-bottom: 12px; }
    .section-card .content { color: #cbd5e1; font-size: 0.9rem; line-height: 1.6; }
    .tag-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .tag { padding: 3px 10px; border-radius: 20px; font-size: 0.8rem; }
    .tag.strength { background: #0f2e1a; color: #22c55e; }
    .tag.risk { background: #2d1515; color: #f87171; }
    .disclaimer { margin-top: 24px; text-align: center; font-size: 0.78rem;
      color: #475569; font-style: italic; }
    #comparison-table { overflow-x: auto; margin-top: 16px; }
    #comparison-table table { width: 100%; border-collapse: collapse; }
    #comparison-table th, #comparison-table td {
      padding: 10px 14px; text-align: left; border-bottom: 1px solid #2d3748;
      font-size: 0.88rem; }
    #comparison-table th { color: #64748b; font-weight: 500; }
    #report, #comparison-table { display: none; }
    @media (max-width: 600px) { .input-row { flex-direction: column; }
      .verdict-banner { flex-direction: column; text-align: center; } }
  </style>
</head>
<body>
  <div class="header">
    <a href="/" class="back-link">← Dashboard</a>
    <h1>AI Equity Analyst</h1>
  </div>

  <div class="input-row">
    <input id="ticker-input" type="text" placeholder="Ticker or NVDA, TSLA for comparison"
      autocomplete="off" autocapitalize="characters" spellcheck="false" />
    <select id="depth-select">
      <option value="standard">Standard</option>
      <option value="deep">Deep</option>
    </select>
    <button class="btn btn-primary" onclick="runAnalysis()">Analyse</button>
  </div>

  <div id="status"></div>
  <div id="report"></div>
  <div id="comparison-table"></div>

  <script src="/analyst.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/analyst.js`**

```js
'use strict';

(function () {
  const $ = id => document.getElementById(id);

  // Pre-fill ticker from ?ticker= URL param and auto-run
  const params = new URLSearchParams(location.search);
  const paramTicker = params.get('ticker');
  if (paramTicker) {
    document.addEventListener('DOMContentLoaded', () => {
      $('ticker-input').value = paramTicker.toUpperCase();
      runAnalysis();
    });
  }

  window.runAnalysis = async function () {
    const raw = ($('ticker-input').value || '').trim().toUpperCase();
    if (!raw) { showError('Please enter a ticker symbol.'); return; }

    const tickers = raw.split(/[,\s]+/).filter(Boolean);
    const mode = tickers.length > 1 ? 'comparison' : 'single';
    const depth = $('depth-select').value;
    const fresh = params.get('fresh') === '1';

    $('status').innerHTML = '<span class="spinner"></span> Generating report…';
    $('report').style.display = 'none';
    $('comparison-table').style.display = 'none';

    try {
      const body = mode === 'comparison'
        ? { tickers, mode, depth }
        : { ticker: tickers[0], mode, depth };
      const url = '/api/analyst/report' + (fresh ? '?fresh=1' : '');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Report unavailable.'); return; }

      $('status').innerHTML = '';
      if (mode === 'comparison') renderComparison(data.results);
      else renderReport(data);
    } catch (e) {
      showError('Request failed. Check your connection and try again.');
    }
  };

  function showError(msg) {
    $('status').innerHTML = `<div class="error-box">${msg} <button class="btn btn-secondary" style="margin-left:8px" onclick="runAnalysis()">Retry</button></div>`;
  }

  function renderReport(data) {
    const r = data.report;
    const v = data.verdict;
    $('report').style.display = 'block';
    $('report').innerHTML = `
      <div class="verdict-banner ${v}">
        <div class="verdict-label">${v}</div>
        <div class="confidence-wrap">
          <div style="color:#94a3b8;font-size:0.85rem">Confidence: <strong>${data.confidence}%</strong>
            ${data.cacheHit ? '<span style="color:#475569;font-size:0.75rem;margin-left:6px">(cached)</span>' : ''}
          </div>
          <div class="confidence-bar"><div class="confidence-fill" style="width:${data.confidence}%"></div></div>
        </div>
      </div>
      <div class="report-grid">
        ${card('Company Overview', overviewHtml(r.overview))}
        ${card('Financial Performance', financialsHtml(r.financials))}
        ${card('Strengths & Risks', strengthsRisksHtml(r.strengthsRisks))}
        ${card('Valuation', valuationHtml(r.valuation))}
        ${card('Technical Trend', technicalHtml(r.technical))}
        ${card('Recommendation', recommendationHtml(r.recommendation))}
      </div>
      <div class="disclaimer">${data.disclaimer}</div>`;
  }

  function card(title, body) {
    return `<div class="section-card"><h3>${title}</h3><div class="content">${body}</div></div>`;
  }

  function overviewHtml(o) {
    if (!o) return '—';
    return `<strong>${o.sector || ''}</strong>${o.mktCap ? ` · $${(o.mktCap/1e9).toFixed(1)}B mkt cap` : ''}<br><br>${o.thesis || ''}`;
  }

  function financialsHtml(f) {
    if (!f) return '—';
    return `Revenue: <strong>$${f.revenue ? (f.revenue/1e9).toFixed(1)+'B' : '—'}</strong>
    &nbsp;·&nbsp; EPS: <strong>${f.eps || '—'}</strong>
    &nbsp;·&nbsp; Margins: <strong>${f.margins ? (f.margins*100).toFixed(1)+'%' : '—'}</strong>
    <br><br>${f.trend || ''} — <em>${f.beatMiss || ''}</em>`;
  }

  function strengthsRisksHtml(sr) {
    if (!sr) return '—';
    const s = (sr.strengths || []).map(t => `<span class="tag strength">${t}</span>`).join('');
    const r = (sr.risks || []).map(t => `<span class="tag risk">${t}</span>`).join('');
    return `<div class="tag-list">${s}${r}</div>`;
  }

  function valuationHtml(v) {
    if (!v) return '—';
    const ratios = v.ratios ? Object.entries(v.ratios)
      .map(([k, val]) => `${k}: <strong>${val}</strong>`).join(' &nbsp;·&nbsp; ') : '';
    return `${ratios}<br><br>${v.assessment || ''}`;
  }

  function technicalHtml(t) {
    if (!t || !t.available) return '<em>Technical data unavailable</em>';
    return `Setup: <strong>${t.setup || '—'}</strong><br><br>${
      t.keyLevels ? Object.entries(t.keyLevels)
        .map(([k, v]) => `${k}: <strong>${v}</strong>`).join(' · ') : ''}`;
  }

  function recommendationHtml(r) {
    if (!r) return '—';
    const drivers = (r.primaryDrivers || []).map(d => `<li>${d}</li>`).join('');
    const inv = (r.invalidationConditions || []).map(i => `<li>${i}</li>`).join('');
    return `<strong>Drivers:</strong><ul style="margin:6px 0 10px 16px">${drivers}</ul>
    <strong>Invalidation:</strong><ul style="margin:6px 0 10px 16px">${inv}</ul>
    <em>${r.confidenceJustification || ''}</em>`;
  }

  function renderComparison(results) {
    $('comparison-table').style.display = 'block';
    const headers = ['Ticker', 'Verdict', 'Confidence', 'Sector', 'P/E', 'Margins'];
    const rows = results.map(d => [
      d.ticker,
      `<span style="color:${d.verdict==='BUY'?'#22c55e':d.verdict==='SELL'?'#ef4444':'#f59e0b'}">${d.verdict}</span>`,
      `${d.confidence}%`,
      d.report?.overview?.sector || '—',
      d.report?.valuation?.ratios?.pe || '—',
      d.report?.financials?.margins ? (d.report.financials.margins*100).toFixed(1)+'%' : '—',
    ]);
    $('comparison-table').innerHTML = `<table>
      <thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  }
})();
```

- [ ] **Step 3: Add Analyst nav pill to `public/index.html`**

Open `public/index.html`. Find the nav pill for "Manager" (search for `manager.html`). Add immediately after it:

```html
<a href="/analyst.html" class="pill">Analyst</a>
```

Match the exact class and style of the Manager pill.

- [ ] **Step 4: Start server and run manual E2E checklist UC-1**

```bash
npm start
```

Open http://localhost:3000/analyst.html and run the UC-1 checklist from the spec:
```
□ /analyst.html loads without errors
□ Type "NVDA" → click Analyse
□ Loading spinner appears within 200ms
□ All 6 report sections render with real data
□ BUY = green, HOLD = amber, SELL = red
□ Confidence meter fills correctly
□ Disclaimer present at bottom
□ Same query again → instant (cache hit label appears)
```

- [ ] **Step 5: Commit**

```bash
git add public/analyst.html public/analyst.js public/index.html
git commit -m "feat(analyst): analyst page UI — 6-section report, confidence meter, comparison mode"
```

---

### Task 8: Admin observability panel

**Files:**
- Create: `public/admin.html`

- [ ] **Step 1: Create `public/admin.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Analyst Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0f1117; color: #e2e8f0; padding: 24px 16px; }
    h1 { font-size: 1.2rem; margin-bottom: 24px; color: #94a3b8; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit,minmax(200px,1fr));
      gap: 12px; margin-bottom: 24px; }
    .card { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 10px; padding: 16px; }
    .card h3 { font-size: 0.7rem; text-transform: uppercase; color: #64748b;
      letter-spacing: 0.08em; margin-bottom: 8px; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      margin-right: 6px; }
    .dot.ok { background: #22c55e; }
    .dot.degraded { background: #f59e0b; }
    .dot.down { background: #ef4444; }
    .metric { font-size: 1.4rem; font-weight: 600; }
    .sub { font-size: 0.78rem; color: #64748b; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; background: #1a1f2e;
      border-radius: 10px; overflow: hidden; margin-bottom: 24px; }
    th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #2d3748;
      font-size: 0.85rem; }
    th { color: #64748b; font-weight: 500; }
    .v-buy { color: #22c55e; } .v-hold { color: #f59e0b; } .v-sell { color: #ef4444; }
    .refresh-row { display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 16px; }
    .btn { padding: 6px 14px; background: #1e2433; border: 1px solid #334155;
      border-radius: 6px; color: #94a3b8; cursor: pointer; font-size: 0.82rem; }
    .last-updated { font-size: 0.75rem; color: #475569; }
    h2 { font-size: 0.9rem; color: #94a3b8; margin-bottom: 10px; }
  </style>
</head>
<body>
  <h1>AI Analyst — Observability Panel</h1>
  <div id="connector-cards" class="cards"></div>
  <div class="refresh-row">
    <h2>Recent Requests</h2>
    <div>
      <span class="last-updated" id="last-updated"></span>
      <button class="btn" onclick="load()">Refresh</button>
    </div>
  </div>
  <table id="req-table">
    <thead><tr><th>Ticker</th><th>Verdict</th><th>Conf</th><th>Total ms</th><th>Cache</th><th>Time</th></tr></thead>
    <tbody id="req-body"></tbody>
  </table>
  <h2>Recent Errors</h2>
  <table>
    <thead><tr><th>Time</th><th>Ticker</th><th>Error</th></tr></thead>
    <tbody id="err-body"></tbody>
  </table>
  <script>
    async function load() {
      try {
        const [health, metrics] = await Promise.all([
          fetch('/api/analyst/health').then(r => r.json()),
          fetch('/api/analyst/metrics').then(r => r.json()),
        ]);
        renderHealth(health);
        renderRequests(metrics.requests || []);
        renderErrors(metrics.errors || []);
        document.getElementById('last-updated').textContent =
          'Updated ' + new Date().toLocaleTimeString();
      } catch(e) {
        console.error('Admin load failed', e);
      }
    }

    function dot(status) {
      return `<span class="dot ${status}"></span>${status}`;
    }

    function renderHealth(h) {
      const c = h.connectors || {};
      document.getElementById('connector-cards').innerHTML = `
        <div class="card"><h3>FMP</h3>${dot(c.fmp?.status||'down')}
          <div class="sub">${c.fmp?.callsToday||0} / ${c.fmp?.limitPerDay||250} calls today</div></div>
        <div class="card"><h3>Yahoo</h3>${dot(c.yahoo?.status||'down')}</div>
        <div class="card"><h3>LLM</h3>${dot(c.llm?.status||'down')}
          <div class="sub">${c.llm?.model||'—'}</div></div>
        <div class="card"><h3>Total Requests</h3>
          <div class="metric">${h.totalRequests||0}</div>
          <div class="sub">Cache hit rate: ${((h.cacheHitRate||0)*100).toFixed(0)}%</div></div>
        <div class="card"><h3>Avg Response</h3>
          <div class="metric">${h.avgTotalMs||0}ms</div></div>`;
    }

    function renderRequests(reqs) {
      document.getElementById('req-body').innerHTML = reqs.map(r => `<tr>
        <td>${r.ticker||'—'}</td>
        <td class="v-${(r.verdict||'').toLowerCase()}">${r.verdict||'—'}</td>
        <td>${r.confidence != null ? r.confidence+'%' : '—'}</td>
        <td>${r.totalMs||'—'}</td>
        <td>${r.cacheHit ? '✓' : '—'}</td>
        <td>${r.ts ? new Date(r.ts).toLocaleTimeString() : '—'}</td>
      </tr>`).join('') || '<tr><td colspan="6" style="color:#475569">No requests yet</td></tr>';
    }

    function renderErrors(errs) {
      document.getElementById('err-body').innerHTML = errs.map(e => `<tr>
        <td>${e.ts ? new Date(e.ts).toLocaleTimeString() : '—'}</td>
        <td>${e.ticker||'—'}</td>
        <td style="color:#f87171">${e.error||'—'}</td>
      </tr>`).join('') || '<tr><td colspan="3" style="color:#475569">No errors</td></tr>';
    }

    load();
    setInterval(load, 30000);
  </script>
</body>
</html>
```

- [ ] **Step 2: Open admin panel and verify**

Navigate to http://localhost:3000/admin.html

```
□ Connector status cards appear (FMP, Yahoo, LLM)
□ Request table shows recent requests after running a report
□ Error table shows any errors from previous testing
□ Auto-refreshes every 30 seconds (check timestamp updates)
```

- [ ] **Step 3: Commit**

```bash
git add public/admin.html
git commit -m "feat(analyst): admin observability panel"
```

---

## Milestone 4 — Integrations

### Task 9: Wealth Manager + paper trade integration

**Files:**
- Modify: `public/manager.js`
- Modify: `public/paper.js`

- [ ] **Step 1: Add Analyst Report button to manager.js**

Open `public/manager.js`. Find where position rows are rendered (search for `position` and look for the HTML template that builds each row). Add this button to the action buttons for each position row:

```js
// Add inside the position row template, alongside existing action buttons:
`<button class="btn-sm" onclick="window.open('/analyst.html?ticker=${encodeURIComponent(pos.symbol)}','_blank')">Analyst Report</button>`
```

Match the class name of other action buttons in that row (e.g. `btn-sm` or `btn-icon` — check the existing code).

- [ ] **Step 2: Add Analyst Report button to paper.js**

Open `public/paper.js`. Find where signal cards or trade picks are rendered (search for `BUY` signal rendering or pick card template). Add:

```js
// Add to each signal card or pick item:
`<button onclick="window.open('/analyst.html?ticker=${encodeURIComponent(symbol)}','_blank')" style="margin-left:8px;padding:4px 10px;background:#1e2433;border:1px solid #334155;border-radius:6px;color:#94a3b8;cursor:pointer;font-size:0.8rem">Analyst Report</button>`
```

- [ ] **Step 3: Add Place Paper Trade button inside analyst.js**

Open `public/analyst.js`. Find `renderReport`. In the verdict banner section, add after the confidence meter:

```js
// Add to verdict-banner HTML in renderReport():
`<a href="/?ticker=${encodeURIComponent(data.ticker)}&action=paper" 
   style="padding:8px 16px;background:#1e2433;border:1px solid #334155;
   border-radius:8px;color:#94a3b8;text-decoration:none;font-size:0.85rem;white-space:nowrap">
   Place Paper Trade →
</a>`
```

- [ ] **Step 4: Run manual E2E checklists UC-3 and UC-4**

UC-3 — Wealth Manager:
```
□ Log in at /manager.html
□ Open a client → portfolio → position row
□ "Analyst Report" button is visible
□ Click → /analyst.html?ticker=SYMBOL opens in new tab
□ Report loads automatically for that ticker
□ No regressions in existing manager.html functionality
```

UC-4 — Paper Trade:
```
□ Go to main dashboard /
□ "Analyst Report" button visible on a signal card
□ Click → /analyst.html?ticker=SYMBOL opens in new tab
□ "Place Paper Trade →" button visible in the verdict banner
□ Clicking it returns to dashboard
□ No regressions in paper.js
```

- [ ] **Step 5: Commit**

```bash
git add public/manager.js public/paper.js public/analyst.js
git commit -m "feat(analyst): Analyst Report button in manager + paper trade; Place Paper Trade link"
```

---

## Milestone 5 — Full Test Suite + Comparison Mode

### Task 10: Comparison mode backend + integration test

**Files:**
- Modify: `src/analyst-service.js`
- Create: `tests/integration/comparison.test.js`

- [ ] **Step 1: Add comparison support to analyst-service.js**

Open `src/analyst-service.js`. Add `comparison` function and export it:

```js
// Add inside createAnalystService, after `report`:
async function comparison(tickers, depth, fresh) {
  const results = await Promise.all(
    tickers.map(t => report(t, 'single', depth, fresh))
  );
  // Second LLM call for ranked verdict
  const summaries = results.map(r => ({
    ticker: r.ticker,
    verdict: r.verdict,
    confidence: r.confidence,
    assessment: r.report?.valuation?.assessment,
    thesis: r.report?.overview?.thesis,
  }));
  const rankPrompt = `Given these equity analysis results, rank them from best to worst investment opportunity and explain in 1-2 sentences why. Return JSON: {"ranked": ["TICK1","TICK2",...], "rationale": "string"}\n\n${JSON.stringify(summaries)}`;
  let rankedVerdict = { ranked: tickers, rationale: 'See individual reports.' };
  try {
    const raw = await llm.generate(rankPrompt);
    const text = typeof raw === 'string' ? raw : (raw?.text || '');
    const match = text.match(/\{[\s\S]*\}/);
    if (match) rankedVerdict = JSON.parse(match[0]);
  } catch (_) { /* fallback already set */ }
  return { mode: 'comparison', results, rankedVerdict };
}

return { report, comparison };
```

- [ ] **Step 2: Wire comparison into analyst-routes.js**

Open `src/analyst-routes.js`. In the `POST /report` handler, the comparison branch currently calls `Promise.all` directly. Replace it to use `svc.comparison`:

```js
// Replace the comparison branch in router.post('/report'):
if (mode === 'comparison') {
  const tickers = Array.isArray(body.tickers) ? body.tickers : [];
  if (tickers.length < 2)
    return res.status(400).json({ error: 'comparison mode requires at least 2 tickers' });
  const errors = tickers.map(validateTicker).filter(Boolean);
  if (errors.length) return res.status(400).json({ error: errors[0] });
  const result = await svc.comparison(
    tickers.map(t => t.trim().toUpperCase()), depth, fresh
  );
  return res.json(result);
}
```

- [ ] **Step 3: Create comparison integration test**

Create `tests/integration/comparison.test.js`:
```js
'use strict';
// @slow — requires running server + API keys
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('comparison: AAPL vs MSFT returns ranked table', async () => {
  const res = await fetch('http://localhost:3000/api/analyst/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tickers: ['AAPL', 'MSFT'], mode: 'comparison', depth: 'standard' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mode, 'comparison');
  assert.equal(data.results.length, 2);
  assert.ok(data.results.every(r => ['BUY','HOLD','SELL'].includes(r.verdict)));
  assert.ok(data.rankedVerdict.ranked.length > 0);
  assert.ok(data.rankedVerdict.rationale.length > 0);
});

test('comparison: requires at least 2 tickers', async () => {
  const res = await fetch('http://localhost:3000/api/analyst/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tickers: ['AAPL'], mode: 'comparison' }),
  });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 4: Run tests**

```bash
npm run test:integration
```

Expected: All integration tests pass.

- [ ] **Step 5: Run UC-2 manual checklist**

```
□ Type "NVDA, TSLA" → click Analyse
□ Side-by-side table renders with both tickers
□ Each column: Ticker, Verdict, Confidence, Sector, P/E, Margins
□ Ranked verdict names a winner with reason
```

- [ ] **Step 6: Commit**

```bash
git add src/analyst-service.js src/analyst-routes.js tests/integration/comparison.test.js
git commit -m "feat(analyst): comparison mode — parallel reports + ranked LLM verdict"
```

---

### Task 11: Final UC-5 error checklist + full test run

- [ ] **Step 1: Run full unit test suite**

```bash
npm test
```

Expected: All unit tests PASS. Count should be ≥ 20 test cases.

- [ ] **Step 2: Run full integration test suite (server running)**

```bash
npm run test:integration
```

Expected: All integration tests PASS.

- [ ] **Step 3: Run UC-5 error/edge case checklist**

```
□ Type "ZZZZZZ!@#" → submit → 400 error message appears, no crash
□ Empty field → click Analyse → inline message "Please enter a ticker"
□ GET http://localhost:3000/api/analyst/health → status ok, all connectors green
□ GET http://localhost:3000/admin.html → panel shows request history
□ Simulate FMP 429:
    - Temporarily set FMP_API_KEY=badkey in .env, restart server
    - Request a ticker NOT in cache → expect friendly 503 with retryAfter
    - Request a ticker IN cache → expect instant cached response
    - Restore correct key, restart
□ Simulate LLM timeout:
    - In src/analyst-routes.js temporarily set timeout: 1 inside buildLlm()
    - Make a fresh request → UI shows "Report temporarily unavailable" with Retry
    - No blank screen, no crash, server logs show error entry
    - Restore and restart
```

- [ ] **Step 4: Run all 5 use case E2E checklists in one sitting**

Run UC-1, UC-2, UC-3, UC-4, UC-5 checklists from the spec doc at:
`docs/superpowers/specs/2026-07-08-ai-equity-analyst-design.md`

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(analyst): complete AI Equity Analyst — all milestones, all tests green"
```

---

*Plan complete. Spec at: `docs/superpowers/specs/2026-07-08-ai-equity-analyst-design.md`*
