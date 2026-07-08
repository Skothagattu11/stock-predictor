# AI Equity Analyst — Design Spec
**Date:** 2026-07-08
**Project:** candle-signal-dashboard
**Author:** Suryateja Kothagattu
**Status:** Approved — ready for implementation

---

## 1. Overview

Add a new `/analyst.html` page to the existing candle-signal-dashboard that delivers
institutional-grade AI equity research on demand. A user enters a ticker (or multiple
tickers for comparison), the system gathers fundamental and technical data in parallel,
and an LLM generates a structured 6-section report with a BUY / HOLD / SELL verdict
and a 0–100% confidence score.

**Intern level:** Mid-level — comfortable with Node/Express and REST APIs.
**Deployment:** Local only (`localhost:3000`).
**Timeline:** 9–14 working days across 5 milestones.

---

## 2. Use Cases

### UC-1: Single Ticker Report
**Actor:** Any user (no auth required)
**Flow:**
1. User navigates to `/analyst.html`
2. Enters a ticker (e.g. `NVDA`) and clicks Analyse
3. Loading state appears within 200ms
4. Full 6-section report renders with live data
5. BUY/HOLD/SELL badge and confidence meter are displayed
6. Disclaimer line appears at bottom of report
7. Same query within 30 minutes returns instantly from cache

**Success:** Report renders all 6 sections with real data, verdict is one of BUY/HOLD/SELL, confidence is 0–100.

---

### UC-2: Comparison Mode
**Actor:** Any user
**Flow:**
1. User enters two or more tickers separated by commas (e.g. `NVDA, TSLA`)
2. Clicks Compare
3. Side-by-side table renders with one column per ticker
4. Ranked verdict names a winner with a 1-sentence reason

**Success:** Table shows valuation, growth, margins, technical setup, and individual verdict for each ticker. Ranked verdict is present.

---

### UC-3: Wealth Manager Integration
**Actor:** Authenticated wealth manager
**Flow:**
1. Manager logs in to `/manager.html`
2. Opens a client → portfolio → views positions
3. Clicks "Analyst Report" next to any position
4. `/analyst.html?ticker=SYMBOL` opens in a new tab with the ticker pre-filled
5. Full report loads automatically

**Success:** Report opens with correct ticker, pre-filled from the position. No regressions in manager.html.

---

### UC-4: Paper Trade Integration
**Actor:** Any user on main dashboard
**Flow:**
1. User sees a BUY signal on the main dashboard
2. Clicks "Analyst Report" on the signal card in paper.js
3. `/analyst.html?ticker=SYMBOL` opens with ticker pre-filled
4. User reads report, clicks "Place Paper Trade" inside the report
5. Returns to dashboard with ticker pre-selected and paper trade panel open

**Success:** Report opens from paper.js, paper trade button inside report works correctly.

---

### UC-5: Error & Edge Cases
**Actor:** Any user

| Scenario | Expected behaviour |
|---|---|
| Invalid ticker `ZZZZ` | 400 before any API call, friendly error message in UI |
| Empty input | Submit blocked client-side, inline validation message |
| FMP 429 rate limit | Return cached data if available, else 503 with `retryAfter` |
| Yahoo candles empty | Technical section marked unavailable, report still generates from fundamentals |
| LLM timeout >10s | Retry once on fallback model, then 503 with retry button in UI |
| LLM bad schema | Retry with stricter prompt, max 2 retries, then 503 |
| Network disconnected mid-request | Shows timeout error with retry button |

---

## 3. Architecture

### System diagram

```
Browser (analyst.html / admin.html)
    │
    │  POST /api/analyst/report  { ticker, mode, depth }
    │  GET  /api/analyst/health
    │  GET  /api/analyst/metrics
    ▼
src/analyst-routes.js           ← Express router, input validation, rate limiting
    │
    ▼
src/analyst-service.js          ← two-stage pipeline orchestrator
    │
    ├── Stage A: Data gather (Promise.all — parallel)
    │       ├── src/fmp-client.js        → FMP REST API (fundamentals)
    │       ├── src/technicals.js        → Yahoo candles → computed indicators
    │       └── /api/news/:symbol        → reused existing route (no changes)
    │
    └── Stage B: LLM report
            └── src/llm/ (existing, no changes)
                    ├── gemini.js   (primary — has Google Search grounding)
                    ├── anthropic.js (fallback)
                    └── openai.js   (fallback)

src/analyst-observability.js    ← structured logger + in-memory metrics ring buffer
    └── logs/analyst.log        ← append-only NDJSON log file

public/analyst.html + analyst.js   ← report UI
public/admin.html                  ← observability panel (polls /api/analyst/metrics)

cache.js (existing, no changes)    ← TTLs: fundamentals 12h, technicals 2min, reports 30min
```

### New files — complete list

| File | Purpose |
|---|---|
| `src/fmp-client.js` | FMP API wrapper — profile, income statement, key metrics, balance sheet |
| `src/technicals.js` | Indicator engine — RSI, MACD, MAs, Bollinger, S/R detection |
| `src/analyst-service.js` | Two-stage pipeline orchestrator |
| `src/analyst-routes.js` | Express router — `/report`, `/health`, `/metrics` |
| `src/analyst-observability.js` | Structured logger + ring buffer for metrics endpoint |
| `public/analyst.html` | Report page HTML |
| `public/analyst.js` | Report page JS — fetch, render, confidence meter, error states |
| `public/admin.html` | Observability panel — polls health + metrics |
| `tests/unit/technicals.test.js` | Unit tests for indicator math |
| `tests/unit/fmp-client.test.js` | Unit tests for FMP response parsing |
| `tests/unit/analyst-service.test.js` | Unit tests for pipeline assembly + confidence blending |
| `tests/unit/schema.test.js` | Unit tests for LLM output schema validation |
| `tests/integration/fmp.test.js` | Integration test — real FMP API |
| `tests/integration/yahoo.test.js` | Integration test — real Yahoo candles + technicals |
| `tests/integration/report.test.js` | Integration test — full pipeline end-to-end |
| `tests/integration/cache.test.js` | Integration test — cache hit behaviour |
| `tests/integration/comparison.test.js` | Integration test — comparison mode |

### Existing files modified

| File | Change |
|---|---|
| `src/server.js` | Add one line: `app.use('/api/analyst', analystRouter)` |
| `public/index.html` | Add "Analyst" nav pill (matches existing Manager pill style) |
| `public/manager.js` | Add "Analyst Report" button to position rows |
| `public/paper.js` | Add "Analyst Report" button to signal cards |

---

## 4. Data Flow

### Single ticker request lifecycle

```
1. Browser POST /api/analyst/report { ticker: "NVDA", mode: "single", depth: "standard" }

2. analyst-routes.js
   ├── Validate: non-empty, alphanumeric, ≤10 chars → else 400
   ├── Normalise to uppercase
   ├── Check cache → HIT: return immediately (<50ms)
   └── MISS: call analyst-service.js

3. Stage A — Promise.all (target: <3s)

   fmp-client.js (4 calls, cached 12h):
   ├── /profile/:symbol          → name, sector, mktCap, description
   ├── /income-statement/:symbol → revenue, EPS, grossMargin (8 quarters)
   ├── /key-metrics/:symbol      → P/E, P/S, EV/EBITDA, PEG, P/B, FCF
   └── /balance-sheet/:symbol    → debtEquity, cash, interestCoverage

   technicals.js (cached 2min):
   ├── yahoo-client.fetchCandles(symbol, '1D', '1Y') → 252 daily bars
   ├── RSI(14)
   ├── MACD(12, 26, 9) — line, signal, histogram, crossover flag
   ├── SMA(20), SMA(50), SMA(200)
   ├── Bollinger Bands(20, 2) — upper, middle, lower
   ├── Golden/death cross detection (50d vs 200d)
   └── Support/resistance — recent 10 pivot highs + 10 pivot lows

   /api/news/:symbol (cached 10min, reused as-is)

4. Stage B — LLM (target: <5s)
   ├── Build schema-locked prompt from Stage A data bundle
   ├── Call Gemini (primary) with structured output constraint
   ├── Validate response against 6-section schema
   ├── On schema fail: retry with stricter prompt (max 2 retries)
   ├── On timeout >10s: fallback to Anthropic Claude
   └── Cache result 30min

5. Response shape:
   {
     ticker: "NVDA",
     generatedAt: "2026-07-08T14:23:11Z",
     cacheHit: false,
     dataFreshness: { fundamentals: "12h", technicals: "2min" },
     verdict: "BUY",
     confidence: 84,
     report: {
       overview:        { sector, mktCap, thesis },
       financials:      { revenue, eps, margins, fcf, trend, beatMiss },
       strengthsRisks:  { strengths: [...], risks: [...] },
       valuation:       { ratios, vsSector, vsHistory, assessment },
       technical:       { setup, indicators, keyLevels, available },
       recommendation:  { verdict, primaryDrivers, invalidationConditions,
                          confidenceJustification }
     },
     disclaimer: "For research purposes; not personalized investment advice."
   }

6. analyst-observability.js records:
   { ts, ticker, mode, depth, verdict, confidence, cacheHit,
     totalMs, stageAMs, stageBMs, fmpCalls, llmModel, llmRetries, error }
```

### Comparison mode

```
1. Browser POST { tickers: ["NVDA","TSLA"], mode: "comparison" }
2. Run single-ticker pipeline for each ticker in parallel (Promise.all)
3. Second LLM call: feed both result bundles → ranked side-by-side table
4. Response adds: { comparison: { table: [...], rankedVerdict } }
```

---

## 5. API Contracts

### POST /api/analyst/report

**Request:**
```json
{
  "ticker": "NVDA",
  "tickers": ["NVDA", "TSLA"],
  "mode": "single | comparison",
  "depth": "standard | deep"
}
```
`ticker` used for single mode. `tickers` used for comparison mode.

**Response 200:** See data flow section 5 above.

**Response 400:**
```json
{ "error": "Invalid ticker: must be 1–10 alphanumeric characters" }
```

**Optional query params (single mode only):**
- `?fresh=1` — bypass the 30-minute report cache and force a new generation

**Response 503:**
```json
{ "error": "Report unavailable", "detail": "LLM timeout after 2 retries", "retryAfter": 30 }
```

---

### GET /api/analyst/health

**Response 200:**
```json
{
  "status": "ok | degraded | down",
  "uptime": 3620,
  "connectors": {
    "fmp":   { "status": "ok", "latencyMs": 210, "callsToday": 12, "limitPerDay": 250 },
    "yahoo": { "status": "ok", "latencyMs": 180 },
    "llm":   { "status": "ok", "model": "gemini-2.0-flash", "latencyMs": 2800 }
  },
  "cache": {
    "fundamentals": { "entries": 4, "ttlH": 12 },
    "technicals":   { "entries": 4, "ttlMin": 2 },
    "reports":      { "entries": 3, "ttlMin": 30 }
  },
  "lastReport": { "ticker": "NVDA", "verdict": "BUY", "generatedAt": "..." }
}
```

---

### GET /api/analyst/metrics

**Response 200:**
```json
{
  "requests": [ ...last 50 log entries... ],
  "errors":   [ ...last 10 error entries... ],
  "summary": {
    "totalRequests": 47,
    "cacheHitRate": 0.62,
    "avgTotalMs": 4820,
    "fmpCallsToday": 12
  }
}
```

---

## 6. Environment Variables

Add to `.env`:
```
# Required for AI Equity Analyst
FMP_API_KEY=<your_key>   # Free at financialmodelingprep.com — no credit card required
```

Add to `.env.example`:
```
FMP_API_KEY=your_fmp_api_key_here
```

---

## 7. Testing Strategy

### Layer 1 — Unit Tests (`npm test`)

| File | Covers |
|---|---|
| `tests/unit/technicals.test.js` | RSI(14) on known input array, MACD crossover detection, SMA values, Bollinger band width, S/R pivot detection |
| `tests/unit/fmp-client.test.js` | Response field mapping, null/missing field handling, quarter array slicing |
| `tests/unit/analyst-service.test.js` | Stage A bundle assembly with stubbed dependencies, confidence score blending logic (both bullish = high, conflicting = low) |
| `tests/unit/schema.test.js` | Valid 6-section JSON passes, missing section fails, wrong verdict enum fails |

Target: 20+ test cases. Runtime: <5 seconds. No network calls.

### Layer 2 — Integration Tests (`npm run test:integration`)

| File | Hits | Asserts |
|---|---|---|
| `tests/integration/fmp.test.js` | Real FMP with `AAPL` | revenue > 0, P/E > 0, sector non-empty |
| `tests/integration/yahoo.test.js` | Real Yahoo + technicals for `MSFT` | 200+ bars, RSI in 0–100 |
| `tests/integration/report.test.js` | Full pipeline `POST` with `NVDA` | Valid 6-section JSON, verdict is enum, confidence 0–100 |
| `tests/integration/cache.test.js` | Two identical requests | Second has `cacheHit: true`, returns in <100ms |
| `tests/integration/comparison.test.js` | `POST` with `["AAPL","MSFT"]` | Ranked table with 2 entries, both have verdicts |

Requires `FMP_API_KEY` in `.env`. Tagged `@slow` — excluded from default `npm test`.

### Layer 3 — Manual E2E Checklists (run at each milestone gate)

#### UC-1: Single Ticker
```
□ /analyst.html loads without errors
□ Type "NVDA" → click Analyse
□ Loading state appears within 200ms
□ All 6 report sections render with real data
□ Verdict badge shows BUY / HOLD / SELL in correct colour
□ Confidence meter shows 0–100 value
□ Disclaimer line present at bottom
□ Same query again → instant response (cache hit)
```

#### UC-2: Comparison Mode
```
□ Type "NVDA, TSLA" → click Compare
□ Side-by-side table renders with both tickers
□ Each column: valuation, growth, margins, technical, verdict
□ Ranked verdict names a winner with reason
```

#### UC-3: Wealth Manager Integration
```
□ Log in at /manager.html
□ Open client → portfolio → position row
□ "Analyst Report" button is visible
□ Click it → /analyst.html?ticker=SYMBOL opens in new tab
□ Report auto-loads with correct ticker
□ No regressions in existing manager functionality
```

#### UC-4: Paper Trade Integration
```
□ Main dashboard shows a signal
□ "Analyst Report" button visible on signal card
□ Click it → /analyst.html?ticker=SYMBOL opens in new tab
□ "Place Paper Trade" button inside report → returns to dashboard correctly
□ No regressions in paper.js functionality
```

#### UC-5: Error & Edge Cases
```
□ "ZZZZZZ" → friendly error message, no crash, no blank screen
□ Empty submit → blocked client-side with inline message
□ /api/analyst/health → all 3 connectors show green status
□ health endpoint responds in <500ms
□ admin.html loads and shows request history
□ Simulate FMP 429: set FMP_API_KEY to an exhausted key →
    cached ticker returns instantly; uncached ticker shows
    503 with retryAfter, not a blank screen or crash
□ Simulate LLM timeout: set LLM timeout to 1ms in config →
    UI shows "Report temporarily unavailable" with retry button,
    not a blank screen; server logs show retry attempt
```

---

## 8. Observability

### Structured logging (`analyst-observability.js`)

- One NDJSON line per request appended to `logs/analyst.log`
- Separate error line on any caught exception
- Ring buffer in memory (last 50 requests, last 10 errors) for `/api/analyst/metrics`
- Intern tails live: `tail -f logs/analyst.log`

### Health endpoint (`GET /api/analyst/health`)

- Probes FMP, Yahoo, LLM on each call with lightweight requests
- Response cached 30 seconds (avoids consuming FMP quota)
- Returns `status: "ok" | "degraded" | "down"` at top level

### Admin panel (`/admin.html`)

- Standalone vanilla JS page — no auth for local dev
- Polls `/api/analyst/metrics` every 30 seconds
- Displays: connector status cards, recent request table (last 20), error log (last 10)
- Confidence colour coding: green ≥80%, amber 50–79%, red <50%

---

## 9. Milestone Plan

### M1 — Data Layer (2–3 days)
**Deliverable:** FMP client + technicals engine passing all unit + integration tests.

Tasks:
1. Register FMP free account → add `FMP_API_KEY` to `.env` and `.env.example`
2. Implement `src/fmp-client.js` — 4 FMP endpoints, error handling, response normalisation
3. Implement `src/technicals.js` — RSI, MACD, SMA(20/50/200), Bollinger, S/R pivots
4. Write `tests/unit/technicals.test.js` and `tests/unit/fmp-client.test.js`
5. Write `tests/integration/fmp.test.js` and `tests/integration/yahoo.test.js`

Exit criteria:
```
□ npm test → all unit tests green
□ npm run test:integration → FMP AAPL revenue > 0
□ npm run test:integration → Yahoo MSFT RSI in 0–100
□ node -e "require('./src/fmp-client').getProfile('NVDA').then(console.log)" prints live data
```

---

### M2 — Backend API (2–3 days)
**Deliverable:** `POST /api/analyst/report` returns valid 6-section JSON.

Tasks:
1. Implement `src/analyst-service.js` — Stage A + Stage B pipeline
2. Implement `src/analyst-routes.js` — validation, caching, error handling, `?fresh=1` bypass
3. Implement `src/analyst-observability.js` — logger + ring buffer + metrics endpoint
4. Mount router in `src/server.js`
5. Add `GET /api/analyst/health`
6. Write `tests/unit/analyst-service.test.js` and `tests/unit/schema.test.js`
7. Write `tests/integration/report.test.js` and `tests/integration/cache.test.js`

Exit criteria:
```
□ curl -X POST http://localhost:3000/api/analyst/report \
    -H "Content-Type: application/json" \
    -d '{"ticker":"NVDA","mode":"single","depth":"standard"}' \
  → valid 6-section JSON, verdict is BUY/HOLD/SELL, confidence 0–100
□ Same curl twice → second has cacheHit: true, <100ms
□ curl http://localhost:3000/api/analyst/health → all connectors green
□ logs/analyst.log has one structured line per request
□ "ZZZZ" ticker → 400 with error message
```

---

### M3 — Frontend: Single Ticker (2–3 days)
**Deliverable:** `/analyst.html` renders full report in browser with confidence meter.

Tasks:
1. Implement `public/analyst.html` — layout, inputs, section containers
2. Implement `public/analyst.js` — fetch, loading state, render, error states, URL param pre-fill
3. Add "Analyst" nav pill to `public/index.html`
4. Implement `public/admin.html` — connector cards, request table, error log
5. Add `GET /api/analyst/metrics` endpoint

Exit criteria:
```
□ UC-1 manual E2E checklist passes (all 8 boxes)
□ /admin.html loads with live connector status
□ All 6 report sections visible with real NVDA data
□ BUY = green badge, HOLD = amber, SELL = red
□ Spinner shows during fetch, disappears on complete
□ Mobile-responsive layout
```

---

### M4 — Integrations (1–2 days)
**Deliverable:** Analyst report accessible from manager.html and paper.js.

Tasks:
1. Add "Analyst Report" button to position rows in `public/manager.js`
2. Add "Analyst Report" button to signal cards in `public/paper.js`
3. Handle `?ticker=` URL param in `analyst.js` — auto-trigger report on load
4. Add "Place Paper Trade" button inside analyst report UI

Exit criteria:
```
□ UC-3 manual E2E checklist passes
□ UC-4 manual E2E checklist passes
□ Ticker pre-fills and report loads automatically from URL param
□ No regressions in manager.html or paper.js
```

---

### M5 — Full Test Suite + Comparison Mode (2–3 days)
**Deliverable:** All tests green, comparison mode working, all 5 use cases verified.

Tasks:
1. Implement comparison mode in `analyst-service.js` + `analyst-routes.js`
2. Add comparison UI to `analyst.html` — comma-separated input, side-by-side table
3. Write `tests/integration/comparison.test.js`
4. Complete any remaining unit tests to reach 20+ test cases
5. Run full 5-use-case manual E2E checklist

Exit criteria:
```
□ npm test → all unit tests green (≥20 test cases)
□ npm run test:integration → all integration tests green
□ UC-2 comparison mode checklist passes
□ UC-5 error/edge case checklist passes
□ All 5 use case checklists pass in a single sitting
□ /admin.html shows accurate counts matching actual test runs
□ logs/analyst.log has no unhandled errors from any milestone
```

---

## 10. Skills Reference

| Skill | Used in milestone | Purpose |
|---|---|---|
| `technical-analysis` | M1 | RSI, MACD, MA computation patterns |
| `nodejs-backend-patterns` | M2 | Express route + service architecture |
| `llm-structured-output` | M2 | Schema-locked 6-section report generation |
| `chart-visualization` | M3 | Confidence meter, admin panel charts |
| `edge-hint-extractor` | M2 | Signal quality scoring for confidence % |

To invoke a skill while implementing, type the skill name as a slash command in Claude Code:
- `/technical-analysis` — ask for RSI/MACD/Bollinger computation help
- `/nodejs-backend-patterns` — ask for Express route or middleware patterns
- `/llm-structured-output` — ask for help locking LLM output to a JSON schema
- `/chart-visualization` — ask for confidence meter or chart rendering help
- `/edge-hint-extractor` — ask for signal scoring or alpha hint patterns

---

## 11. Key Decisions

| Decision | Rationale |
|---|---|
| Vanilla JS frontend | Matches existing project — no bundler, no framework, zero new tooling for intern |
| FMP free tier (250 calls/day) | No credit card, sufficient for local dev with 12h cache |
| Gemini primary, Claude fallback | Gemini has Google Search grounding for news context; Claude is more reliable on schema |
| Cache reports 30min | Balances freshness with LLM cost; `?fresh=1` query param bypasses cache (specified in API contract §5) |
| No auth on /analyst.html | Matches existing public dashboard — analyst feature is public |
| No auth on /admin.html | Local only — auth adds complexity with zero security benefit locally |
| position_id nullable in history | Already established pattern in this codebase — don't change |
| All existing files untouched except 4 | `server.js`, `index.html`, `manager.js`, `paper.js` each get minimal additions only |

---

*Spec approved: 2026-07-08 | Ready for implementation plan*
