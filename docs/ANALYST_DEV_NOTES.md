# AI Equity Analyst — Dev Notes

Short, practical notes on how the analyst feature is built, what it uses, and why.
For the exact spec-vs-code deviations, see [`ANALYST_DEVIATIONS.md`](./ANALYST_DEVIATIONS.md).

---

## What it is

An on-demand equity research feature. Enter a US ticker → get a 6-section report
(overview · financials · strengths/risks · valuation · technicals · recommendation)
with a **BUY / HOLD / SELL** verdict and a **0–100 confidence** score.

**Pages**
| URL | Purpose |
|-----|---------|
| `/analyst.html` | Generate an AI research report (single ticker, or `A, B` for a side-by-side comparison). |
| `/admin.html` | Feature health, request metrics, cache activity, and recent errors (auto-refresh 30s). |

**API:** `POST /api/analyst/report`, `GET /api/analyst/health`, `GET /api/analyst/metrics`.

---

## How it works (two-stage pipeline)

```
POST /api/analyst/report {ticker}
        │
   Stage A  (parallel, each cached at its own TTL)
     ├─ fundamentals   → FMP (primary) → Yahoo (fallback)
     ├─ technicals      → Yahoo candles (keyless)
     ├─ news            → Finnhub (if key) → Yahoo search
     └─ peers           → FMP (deep mode only)
        │
   Stage B  (LLM — narrative only, schema-locked, primary→fallback, retry)
     └─ Claude (Anthropic) primary → OpenAI fallback
        │
   Merge:  Stage-A numbers  +  LLM narrative
   Score:  confidence = deterministic blend of technical + fundamental signals
   Verdict: LLM-owned, with one documented override → confidence < 50 forces HOLD
        │
   6-section report (numbers never invented by the model)
```

**Key rule:** the LLM writes prose only. All numbers (revenue, P/E, RSI, …) come from
Stage-A data and are merged in — so the model can't hallucinate figures.

---

## Data sources & fallbacks

| Need | Primary | Fallback | Key? |
|------|---------|----------|------|
| **Fundamentals** | FMP stable API | **Yahoo `quoteSummary`** | FMP key; Yahoo keyless |
| **Price / candles / technicals** | Yahoo chart API | seeded simulator (off-hours) | keyless |
| **News headlines** | Finnhub | Yahoo search | Finnhub optional |
| **LLM narrative** | Claude (Anthropic) | OpenAI | key required |

**Why the fundamentals fallback?** FMP's free tier gates financial statements
per-symbol (many tickers return `402 "premium/special endpoint"` — e.g. `SNDK` — where
only the basic `profile` is free). When FMP comes back `limited`, we fall back to Yahoo
and **merge into the identical shape**, so major tickers use FMP and gated tickers still
get full data (revenue, EPS, margins, FCF) instead of "pending". Both sources normalise
to one object before the pipeline sees them, so scoring + the LLM are **source-agnostic**.

**Caches** (avoid re-fetching / re-spending): fundamentals **12h**, technicals **2min**,
news **10min**, final report **30min**. `?fresh=1` bypasses the report cache.

---

## Files added

| File | Role |
|------|------|
| `src/analyst-service.js` | The pipeline: Stage A/B, merge, confidence, verdict, caching. |
| `src/analyst-routes.js` | `/report`, `/health`, `/metrics`; validation; error mapping. |
| `src/analyst-schema.js` | Zod schema for the LLM's narrative output. |
| `src/analyst-observability.js` | Structured logger + metrics ring buffer. |
| `src/fmp-client.js` | FMP stable-API fundamentals + peers. |
| `src/yahoo-fundamentals.js` | Yahoo fundamentals fallback (normalised to FMP shape). |
| `src/fundamentals.js` | Provider: FMP → Yahoo fallback/merge. |
| `src/technicals.js` | RSI / MACD / MAs / Bollinger / pivots from Yahoo candles. |
| `src/news-client.js` | Finnhub → Yahoo news headlines. |
| `public/analyst.html` · `analyst.js` | Report UI + comparison table. |
| `public/admin.html` | Observability panel. |
| `tests/unit/*`, `tests/integration/*` | 190 unit tests + `@slow` live integration tests. |

**Touched existing files (minimal, additive):** `server.js` (wiring), `config.js`
(`FMP_API_KEY`), `cache.js` (`peek`/`size`), `index.html` (nav pill + signal-card
button), `app.js` (UC-4: `?ticker=`/`?action=paper`), `manager.js` / `paper.js`
("Analyst Report" buttons).

---

## Key decisions & why

- **LLM = Claude primary, not Gemini** (spec said Gemini). No Gemini key here; Gemini's
  only spec advantage (search grounding) doesn't work through the structured-output
  adapter; Claude is more reliable on schema.
- **FMP stable API, not legacy `/api/v3`** — v3 now 403s for new free keys.
- **Numbers merged from Stage A, LLM does narrative only** — no hallucinated figures.
- **Confidence is deterministic; verdict is LLM-owned** with a single documented
  `<50 → HOLD` guard — no invented BUY/SELL thresholds.
- **Graceful degradation** — a gated/failed non-core source degrades to `null`, it never
  fails the whole report; only a missing `profile` (or rate-limit) errors out.

---

## Run & test

```bash
npm start                 # http://localhost:3000  → /analyst.html, /admin.html
npm test                  # 190 unit tests, offline, ~5s
npm run test:integration  # live tests (need running server + keys); skip cleanly otherwise
```

**Env vars** (`.env`): `FMP_API_KEY` (fundamentals) and at least one of
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (LLM) are required; `FINNHUB_API_KEY` is optional
(richer news). Yahoo needs no key.

---

## Known limits

- **Free FMP tier**: statements gated for many symbols (→ Yahoo fallback), income capped
  at 5 annual periods, 250 calls/day. A paid FMP plan removes the gating.
- **Yahoo `quoteSummary`** is an unofficial API (cookie+crumb) — same dependency class as
  the app's existing Yahoo candles; can break if Yahoo changes it.
- **`/health` FMP status** is key-presence based (no live probe) to protect the 250/day
  quota; real FMP failures still surface via `/report` and the error log.
- **`deep` mode** adds a peer set to the prompt; it is not a full peer-by-peer analysis.
