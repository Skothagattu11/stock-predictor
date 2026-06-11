# Prediction Engine — Master Implementation Plan (Map)

> **For agentic workers:** This is the **map**, not an executable task list. Each phase below has (or will get) its own detailed plan doc under `docs/superpowers/plans/` written with the `superpowers:writing-plans` method (bite-sized TDD steps). Execute one phase plan at a time with `superpowers:subagent-driven-development` or `superpowers:executing-plans`.

**Goal:** Replace the single twitchy verdict with a multi-horizon, multi-predictor, multi-model prediction
engine: a Python quant/ML sidecar (data + indicators + quant cores + statistical/ML predictors +
calibrated uncertainty) orchestrated by the existing Node app (LLM ensemble + consensus + caching + UI).

**Architecture:** Two services. **Node** (`src/`) owns the user app, the LLM router/ensemble, consensus,
caching, scheduler, and UI. **Python** (`services/quant-py/`, FastAPI) owns data aggregation, indicators,
the four quant cores, the statistical/ML predictors, conformal/calibration, and sentiment. Node calls the
sidecar over HTTP. Numbers always come from the sidecar; the LLM only narrates and is reconciled.

**Tech Stack:** Node 20 + Express + `ws` + Vercel AI SDK (`ai`) + Zod; Python 3.11 + FastAPI + uvicorn +
pandas + pandas-ta + httpx + pydantic; OpenBB Platform + Finnhub/FMP/FRED/Yahoo-options/Alpaca; StatsForecast,
MAPIE, FinBERT, qlib (later). Tests: `pytest` (Python), `node --test` (Node).

**Spec:** `docs/2026-06-11-multi-horizon-prediction-engine-design.md` · **Diagram:** `docs/architecture.html`

---

## Cross-cutting conventions (apply to every phase)

- **Secrets:** all keys live only in `.env` (gitignored), server-side only. The Python sidecar reads its own
  env (`FINNHUB_API_KEY`, `FMP_API_KEY`, `FRED_API_KEY`, `ALPACA_KEY`/`ALPACA_SECRET`, `OPENBB_PAT`). Never
  commit `.env`; verify `git status --short` shows no `.env` before every commit.
- **TDD:** write the failing test first, see it fail, implement minimally, see it pass, commit. Small commits.
- **Determinism in tests:** no live network in unit tests — inject clients and use fixtures. One opt-in
  integration test per provider, skipped when its key is absent (`@pytest.mark.skipif`).
- **Schemas are contracts:** every sidecar endpoint returns a pydantic-validated body; the matching Node Zod
  schema must mirror it. When one changes, change both in the same commit.
- **Pure-quant is the floor:** every prediction must be fully computable without any LLM. The LLM is additive.
- **Branching:** this repo's default branch is `main`. Create a feature branch per phase
  (`feat/phase-N-<slug>`), open work there, merge when the phase's acceptance criteria pass.

## Repo layout after all phases

```
candle-signal-dashboard/
  src/                      # Node (existing app, grows)
    agents/  context/  llm/  cache/  scheduler/  sidecar.js
  engine/                   # existing JS indicators (kept for client-side/instant feel)
  public/                   # UI
  services/quant-py/        # NEW Python sidecar (FastAPI)
    app/  (data/ indicators/ models/ forecast/ uncertainty/ sentiment/ ml/ store/ api.py)
    tests/
    pyproject.toml  Dockerfile  README.md
  docs/                     # specs, plans, diagram
```

---

## Phase map

| # | Phase | Delivers (testable on its own) | Depends on | Plan doc |
|---|-------|-------------------------------|------------|----------|
| 1 | **Sidecar foundation + intraday core** | FastAPI service; Yahoo candle client; pandas-ta indicators; regime classifier; intraday quant core; `/predict/intraday/{symbol}` returns calibrated pure-quant output | — | `2026-06-11-phase-1-python-sidecar-foundation.md` ✅ |
| 2 | **Data layer expansion** | Provider interface + OpenBB, Finnhub, FMP, FRED, Yahoo-options, Alpaca adapters; fundamentals/macro/implied-move into a shared context; cross-check harness | 1 | TBD |
| 3 | **Remaining quant cores** | Outlook (regime gate + momentum + earnings-revision + quality + valuation), Position (P/L-aware), Portfolio (correlation/concentration) cores + endpoints | 1, 2 | TBD |
| 4 | **Node ↔ sidecar + caching/scheduler** | Typed Node sidecar client; LRU cache w/ single-flight + SWR + TTL-by-horizon; background quant-only snapshot scheduler; 1-min history store | 1 | TBD |
| 5 | **LLM router + ensemble + consensus** | Vercel AI SDK adapters (OpenAI/Claude/Gemini/Perplexity); schema-forced output; multi-predictor consensus aggregator (quant/statistical/ML/analyst/LLM) + divergence; number reconciliation; graceful degradation | 3, 4 | TBD |
| 6 | **Calibrated uncertainty + extra predictor voices** | MAPIE conformal ranges + probability calibration; FinBERT sentiment; StatsForecast statistical voice; analyst-consensus voice wired into consensus | 2, 3, 5 | TBD |
| 7 | **UI redesign** | Horizon ribbon; Market/Your split; four cards with HorizonBadge/ConfidenceMeter/FreshnessTag/AIBadge; SignalChip (WCAG); DriverPills; outlook bull/base/bear fan; multi-predictor panel | 5, 6 | TBD |
| 8 | **Calibration logging** | Persist predictions + realized outcomes; Brier score job; surfaced calibration stats (also the ML training dataset) | 4, 5 | TBD |
| 9 | **Validated ML model (qlib)** | qlib pipeline: feature gen → triple-barrier labels → purged-CV walk-forward train → serve as one more predictor voice; benchmarked vs the rest. Runs only once enough 1-min history has accumulated. | 4, 6, 8 | TBD |

**Critical path:** 1 → 2 → 3 → 5 → 7 (a usable multi-horizon dashboard). 4 can run parallel to 2/3.
6, 8, 9 layer quality on top. Ship a working pure-quant + LLM dashboard after phase 7; ML (9) is the
last, evidence-gated upgrade.

## Per-phase acceptance criteria (definition of done)

- **P1:** `pytest` green; `uvicorn` serves `/health` 200 and `/predict/intraday/AAPL` returns a valid
  `IntradayPrediction` (bias, probability, expected-move range, regime, drivers, invalidation) computed with
  **no LLM**.
- **P2:** each provider adapter has a unit test (fixture) + a skip-unless-key integration test; a
  `cross_check` returns the same fundamental field from ≥2 sources with a discrepancy flag.
- **P3:** `/predict/{outlook,position,portfolio}` endpoints return validated bodies; position math verified
  against hand-computed P/L; portfolio correlation verified on synthetic returns.
- **P4:** Node `sidecar.get(...)` typed client; cache hit returns instantly; SWR serves stale + revalidates;
  scheduler writes 1-min snapshots for the watchlist with zero LLM calls.
- **P5:** consensus aggregator merges N predictor voices + M LLM models → headline + agreement %, flags
  divergence; with no keys it returns pure-quant; number-reconciliation strips any mismatched figure.
- **P6:** MAPIE intervals have ≥ nominal empirical coverage on a holdout; FinBERT sentiment unit-tested on
  labeled headlines; StatsForecast voice returns a forecast for a fixture series.
- **P7:** UI renders all four cards + multi-predictor panel; low-confidence verdicts visibly desaturate;
  stale cards dim; color never sole cue (automated contrast check).
- **P8:** a prediction + its realized outcome round-trip to storage; Brier score computed over a fixture log.
- **P9:** walk-forward backtest report produced with purged-CV; the ML voice appears in the consensus panel
  and its historical calibration is shown alongside the others.

## Self-review (spec coverage)

Every spec section maps to a phase: four cores → P1/P3; multi-model ensemble + consensus → P5; data/tooling
(OpenBB + providers) → P2; calibrated uncertainty/honesty → P6/P7; cost control/caching/scheduler → P4;
extensibility (OpenRouter, own model) → P5 adapter config + P9; calibration logging → P8; validated ML → P9.
No spec requirement is unassigned.
