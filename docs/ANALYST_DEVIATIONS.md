# AI Equity Analyst — Deviations from Spec/Plan

Deliberate, reviewed deviations from `docs/AI_Equity_Analyst_Plan.md` and
`docs/superpowers/{specs,plans}/2026-07-08-ai-equity-analyst*`. Each was signed off
during implementation. Anything not listed here follows the docs.

---

## 1. LLM provider order — Gemini-primary → Claude-primary/OpenAI-fallback

**Spec (design §11):** Gemini primary, Claude/OpenAI fallback.
**Implemented:** Claude (Anthropic) primary, OpenAI fallback.

**Why:** No `GEMINI_API_KEY` is provisioned in this environment; `ANTHROPIC_API_KEY`
and `OPENAI_API_KEY` are live. The spec's stated reason for Gemini (Google Search
grounding) does not materialize through the existing `generateObject()` adapter, which
does no tool use. The spec itself calls Claude "more reliable on schema." Provider
order is injected (`src/server.js`), so this is a wiring choice, not a lock-in — the
order flips back the moment a Gemini key is added.

Recorded in code: `src/analyst-service.js` header comment.

---

## 2. UC-4 (paper-trade flow) — now fully wired in app.js (approved)

**Spec UC-4 intent:** From a fresh **BUY signal card on the main dashboard**, click
"Analyst Report" → `/analyst.html?ticker=SYM`; inside the report, "Place Paper Trade"
returns to the dashboard with the ticker preselected and the paper panel open.

**Implemented (full parity):** `public/app.js` edits were explicitly approved. The
change is minimal and additive (no existing behavior altered):
- "Analyst Report" button on the dashboard signal card (`public/index.html` `#signalBox`),
  wired in `app.js` to open `/analyst.html?ticker=<current symbol>`.
- On load, `app.js` reads `?ticker=SYM` (preselects the symbol before `connect()`) and
  `?action=paper` (scrolls to `#paperPanel`).
- Entry points also on `manager.js` position rows and `paper.js` open-position rows.

---

## 3. Fundamentals via FMP "stable" API (not the plan's legacy /api/v3 endpoints)

**Plan (Task 1) code:** `https://financialmodelingprep.com/api/v3/...` path endpoints.
**Implemented:** `https://financialmodelingprep.com/stable/...?symbol=` endpoints.

**Why:** FMP retired the legacy v3 endpoints — new free keys get `403 "Legacy Endpoint
… only available for legacy users"` on all of them. The current free tier serves the
same data on the `/stable/` API. `src/fmp-client.js` uses `profile`, `income-statement`,
`key-metrics-ttm`, `ratios-ttm`, and `cash-flow-statement` (5 calls/report).

Also: `financials.fcf` now carries **true free cash flow** (cash-flow-statement
`freeCashFlow` = operating cash flow − capex), not free-cash-flow-to-equity.

Data-source split (per directive): **FMP = fundamentals only; Yahoo = price / candles /
technicals only.** News = Finnhub when `FINNHUB_API_KEY` is set, else keyless Yahoo
(via `src/news-client.js`, injected — the service never calls the app's own HTTP route).

**Free-tier constraint:** FMP income-statement is fetched at `limit=5` — `limit=8`
returns `402 Payment Required` on the free key, so the doc's "4–8 quarter" trailing
trend is capped at 5 annual periods. `deep` mode adds a `stock-peers` call (peers fed
into the LLM prompt). Per-source caches: fundamentals 12h, technicals 2min, news 10min.

**FMP → Yahoo fundamentals fallback:** FMP's free tier gates financial statements
per-symbol (many tickers return `402 "premium/special endpoint"` — e.g. SNDK — where
only `profile` is free). `src/fundamentals.js` is the injected provider: FMP primary,
and when FMP returns `limited: true` (or errors), it falls back to `src/yahoo-fundamentals.js`
(keyless Yahoo `quoteSummary`, normalised to the identical shape) and merges, preferring
FMP fields where present. Result: major tickers use FMP; FMP-gated tickers get full
fundamentals from Yahoo instead of "pending". Yahoo `quoteSummary` is an unofficial API
(cookie+crumb handshake) — same dependency class as the app's Yahoo candles.

---

## Deferred / remaining

- Live integration tests (`tests/integration/*`) remain `@slow`/skipped in `npm test`;
  run them with a live server + keys via `npm run test:integration`.
