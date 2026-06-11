# Multi-Horizon, Multi-Model Prediction Engine — Design

**Date:** 2026-06-11
**Status:** Approved — router = Vercel AI SDK + in-house consensus; **Python quant/ML sidecar from v1**;
data = OpenBB aggregator **+** direct providers; multi-predictor ensemble. Next: implementation plan.
**Supersedes prediction sections of:** `2026-06-09-candle-signal-dashboard-design.md`

## Problem

The dashboard currently emits **one verdict that re-computes every few seconds**, so it reads as a
twitchy guess rather than an investment view. There is no notion of *horizon* (over what window?) or
*confidence* (how sure?), and personalized advice (based on the user's position) is not separated from
impersonal market forecasts. We want a model/agent layer behind the prediction widgets that produces
distinct, honest predictions for different time horizons and scopes, runnable across multiple LLM
providers for comparison and consensus.

## Core reframe: horizon × scope, not a single verdict

Make **horizon** and **scope** the primary axes. Every prediction always carries horizon + confidence +
freshness. Four predictions answer four different questions:

| # | Widget | Question | Horizon | Scope |
|---|--------|----------|---------|-------|
| **A** | Intraday bias | "Which way today, open→close?" | Today | Market |
| **B** | Outlook | "Where over weeks–months?" | Weeks–months | Market |
| **C** | Position action | "Given *my* entry & size, now what?" | User's horizon | Personal |
| **D** | Portfolio fit | "Does this complement my holdings?" | Ongoing | Personal |

A/B are **impersonal market forecasts**; C/D are **personalized advice**. The UI must visually separate
"Market view" from "Your view" so an intraday "bearish" never panics the user out of a long-term hold.

## Engine principle: numbers in code, words from the model

Every number — scores, levels, probabilities, P/L, correlations — is computed by **deterministic code**
(`quant/`, grown from the existing `engine/`). The LLM **never produces a number**; it only writes the
narrative/recommendation from a compact structured snapshot, and a guardrail reconciles any figure it
echoes against the quant value. Consequences:

- No hallucinated prices/percentages (the documented failure mode of finance LLMs).
- Everything is cacheable and auditable.
- The system can **degrade to pure-quant** output (templated text) when no LLM / key / budget is available.

### The four quant cores (evidence-based)

- **A — Intraday.** Regime classifier first (session VWAP position + ATR percentile + trend slope) →
  regime-gated signals: **volume-filtered Opening-Range Breakout** (the relative-volume "stock-in-play"
  filter is the real edge — Zarattini, Barbon & Aziz 2023), **first-30-min momentum tilt** (Gao, Han, Li
  & Zhou, *Market Intraday Momentum*, JFE 2018), VWAP anchor, ATR-based stops/targets. Output: directional
  bias + **calibrated probability** + **expected-move range** (conformal/ATR units) + invalidation level.
  No single-price targets. Avoid naive indicator stacking (correlated trend/momentum indicators add the
  illusion of agreement, not independent information).
- **B — Outlook.** 200-day **regime gate** (risk-on/off multiplier, *not* a buy trigger — golden/death
  crosses are lagging risk tools), **12-1 month time-series momentum** + relative strength vs sector/index,
  **earnings-estimate-revision direction** (highest-ROI fundamental signal), **PEAD / earnings-date**
  handling, Piotroski-F / CANSLIM-style quality, sector-relative valuation (small mean-reversion weight).
  Output: **base / bull / bear scenarios** with rough probabilities and a confidence band.
- **C — Position.** User cost basis, unrealized P/L, position weight, distance to stop/target, exposure →
  **HOLD / TRIM / ADD / EXIT** with P/L-aware reasoning.
- **D — Portfolio.** Correlation/overlap across saved positions, concentration, diversification gaps →
  e.g. "adds tech concentration / diversifies vs energy."

Composite scoring starts **sector-relative, equal-weighted** (robust, hard to overfit); IC-based
re-weighting only after out-of-sample evidence.

## Differentiator: multi-model ensemble + consensus

Run the **same agent prompt across every available model in parallel**, show each model's call
side-by-side, and compute a **consensus headline** on top.

```
quant snapshot ──► [ fan out same prompt to all available models ]
                      ├─ OpenAI    → {stance, confidence, rationale, sources}
                      ├─ Claude    → {…}
                      ├─ Gemini    → {…}   (cheap, Google-grounded)
                      └─ Perplexity→ {…}   (web-grounded, cited)
                              │
                              ▼
                    [ Consensus aggregator ]
              agreement score · majority stance · divergence flag
                              │
                              ▼
   Headline = consensus;  expandable = each model's individual call
```

- Each model's verdict shown as its own row (provider badge, stance, confidence, rationale, sources).
- **Model divergence is itself a displayed signal**: disagreement → "low conviction / models split."
- Behind a **provider-agnostic router**; ensemble mode fans out to all keys present. Per-job defaults:
  Perplexity = web-grounded news (citations); Gemini Flash = cheap grounded/high-volume; Claude & GPT =
  reasoning/synthesis and schema-bound output.

## LLM router / open-source components

Two layers, chosen separately:

**Layer 1 — provider adapter / gateway. Recommendation: [Vercel AI SDK](https://sdk.vercel.dev/) (`ai`).**
Node-native, unified across OpenAI/Anthropic/Google/Perplexity, **native Zod structured output** (matches
our schema-forced + number-reconciliation guardrail), keeps each provider key direct (Perplexity grounding
works). Alternatives considered:
- [Portkey AI Gateway](https://github.com/Portkey-AI/gateway) — Apache-2.0, self-hostable; fallback/retry/
  circuit-breaker/budget/guardrails as infrastructure. Adopt if we want those as infra not code.
- [LiteLLM](https://github.com/BerriAI/litellm) — 100+ providers but Python proxy (extra service).
- [OpenRouter](https://openrouter.ai/) — one key → 300+ models; fastest path to broad model comparison.
  Hosted (not self-host OSS); optional convenience layer for breadth.
- [Bifrost](https://github.com/maximhq/bifrost) (Go), [RelayPlane](https://relayplane.com/) (Node, MIT) —
  noted for completeness.

**Layer 2 — consensus / ensemble. Recommendation: build in-house (~150 LOC).** No mature *Node* consensus
library; our aggregator must plug into the quant snapshot + reconciliation anyway. Reference designs:
[llm-council](https://virtuslab.com/blog/ai/llm-council) (poll → peer-review → synthesize),
[ConsensusLLM](https://github.com/usefulmove/ConsensusLLM) (consistency threshold ≈ our split flag),
[AISCouncil](https://www.aiscouncil.net/) (Compare / Consensus-Vote / Mixture-of-Agents modes).

## Extensibility (designed-in, built later)

The router treats **every model as an interchangeable adapter behind one interface**, which makes two
future extensions drop-in rather than rewrites:

- **OpenRouter as a provider.** Add one `openrouter` adapter (it speaks the OpenAI-compatible protocol the
  AI SDK already uses) and a config flag. That instantly unlocks 300+ models in the *same* ensemble +
  consensus panel — no pipeline changes. Kept as an optional, off-by-default provider from day one.
- **Your own trained model as just another "model".** A custom model — whether the deferred XGBoost
  intraday scorer or a fine-tuned LLM — is served behind a small inference endpoint and registered as one
  more adapter. It then appears **side-by-side with the frontier models in the consensus panel**, so you
  can benchmark your model head-to-head and let consensus weight it. Two enablers are built in for this:
  1. **Calibration logging** (predictions + realized outcomes + Brier score) is precisely the **labeled
     training dataset** for your own model — the system accumulates training data as it runs.
  2. The **quant cores already emit structured features**; that feature snapshot is the model's input
     vector, so training/serving reuses the existing context builder.

Design rule: nothing downstream of the router (consensus, validation, cache, UI) may assume a fixed set of
providers — provider list is config-driven.

## Data, tooling & mitigations (finalized)

Framing: this is a **market-analysis / prediction tool, not a trade-execution engine**. The bar is
**calibration** ("when it says 65%, it's right ~65% of the time"), not dollar precision. That removes a
whole class of failure modes (slippage, fills, fees, tick-latency) and makes ~70–80% of the gaps
mitigable. The residual ~20–30% is genuine market randomness / tail risk — handled by *displaying*
uncertainty, never hiding it.

### Data sources (use OpenBB **and** direct providers, side by side)
Decision: wire **both** so outputs can be cross-checked and the best source chosen per field. Reliable,
mostly-free; willing to spend a *minimal* amount where it clearly earns its keep.

| Input | Source | Tier |
|---|---|---|
| Aggregation layer (one integration → ~100 sources) | **OpenBB Platform** (REST API) | Free (bring keys) |
| Fundamentals, estimates, earnings calendar, sentiment, insider | **Finnhub** (key already held) + **FMP** | Free; FMP Starter ≈ $19–29/mo if depth/limits needed |
| Macro / regime context (yield curve, rates, VIX, unemployment) | **FRED** | Free |
| Options-implied **expected move** (honest, market-priced ranges) | Yahoo / CBOE options chains | Free |
| Intraday history backfill (beyond Yahoo's ~7–30d of 1-min) | **Alpaca** (free market data); accumulate our own 1-min store daily | Free; optional Polygon Starter ≈ $29/mo if richer history needed |
| News + finance-tuned sentiment | OpenBB/Finnhub news → **FinBERT** scoring | Free |

Rule: **the LLM never sources numbers** — all hard figures come from these feeds; the LLM only narrates
and is reconciled against them.

### Curated repo set (tight and justified — "best and required", not a kitchen sink)

| Purpose | Repo | Why this one |
|---|---|---|
| Data aggregation | **[OpenBB Platform](https://github.com/OpenBB-finance/OpenBB)** | One open-source integration unifies ~100 reliable sources; REST API consumable from Node. |
| AI-quant ML platform + validation | **[microsoft/qlib](https://github.com/microsoft/qlib)** | Full pipeline: features → model (LightGBM/etc.) → **walk-forward backtest**. Home of the validated ML predictor. |
| Indicators (in the sidecar) | **[pandas-ta](https://github.com/twopirllc/pandas-ta)** | Comprehensive, pandas-native; computes the quant-core features efficiently in Python. |
| Statistical forecaster (a *non-LLM* predictor voice) | **[Nixtla StatsForecast](https://github.com/Nixtla/statsforecast)** | Fast, reliable, MIT; the independent statistical vote in the multi-predictor ensemble. |
| Calibrated uncertainty / honest ranges | **[MAPIE](https://github.com/scikit-learn-contrib/MAPIE)** | scikit-learn-contrib conformal prediction → distribution-free intervals + calibration. |
| Finance news sentiment | **[FinBERT](https://huggingface.co/ProsusAI/finbert)** | Purpose-built finance sentiment model; replaces the LLM guessing sentiment. |

Deliberately **not** added as dependencies: `mlfinlab` (now partly commercial) — instead implement the two
pieces we actually need (**triple-barrier labeling** + **purged K-fold/embargo**) as a small in-house
module (well-documented, ~100 LOC) and lean on qlib's own backtest. Keeps the dep set lean and fully OSS.

### Multi-predictor ensemble (the "works in parallel with other predictors" requirement)
Extend consensus from *multi-LLM* to **multi-predictor** — independent voices that fail *independently*,
which is what fixes the correlated-LLM-consensus risk:

```
  Quant score (rule-based, pandas-ta) ┐
  Statistical forecaster (StatsForecast) ┤
  ML model (qlib, when trained)          ┤──► Meta-consensus + divergence flag
  Analyst consensus (Finnhub/FMP)        ┤    (disagreement = honest low-conviction)
  LLM ensemble (OpenAI/Claude/Gemini/Perplexity) ┘
```

## Backend architecture (Node orchestrator + Python quant/ML sidecar)

Two services, deployed side by side (Render): a **Node orchestrator/UI/LLM** service and a **Python
quant/ML/data** sidecar. Node owns the user-facing app and the LLM ensemble; Python owns everything the
mature quant/ML ecosystem does best.

```
NODE  (src/ — orchestrator, LLM, UI, cache)
  agents/        intraday · longTerm · position · portfolio
                 (each: call py-sidecar for quant/predictors → context → LLM ensemble → consensus → validate)
  context/       compact structured snapshot + snapshot hash
  llm/
    router.js        job→provider map, ensemble fan-out, retry/fallback/circuit-breaker, budget meter
    adapters/        openai · anthropic · gemini · perplexity  (via Vercel AI SDK)
    consensus.js     aggregate predictors + models → headline + agreement/divergence
    schemas.js       Zod schema per mode (forced structured output)
    validate.js      schema check + number reconciliation (echoed numbers vs sidecar values)
  cache/         lru-cache w/ single-flight + stale-while-revalidate, TTL by horizon
  scheduler/     background quant-only trend snapshots for watchlist/portfolio
  sidecar.js     typed HTTP client for the Python service

PYTHON  (services/quant-py/ — FastAPI)
  data/          OpenBB client + direct providers (finnhub, fmp, fred, yahoo-options, alpaca)
  indicators/    pandas-ta feature computation
  models/        regime classifier · intraday · outlook · position · portfolio  (rule-based v1)
  ml/            qlib pipeline (features→train→walk-forward) + triple-barrier labels + purged-CV (in-house)
  forecast/      StatsForecast statistical-predictor voice
  uncertainty/   MAPIE conformal intervals + probability calibration
  sentiment/     FinBERT news sentiment
  store/         accumulated 1-min history (grows daily; training data)
  api.py         REST endpoints consumed by Node
```

### Data flow
```
Widget request
  → Cache  ─ hit (fresh) ─────────► return  (instant)
           ─ hit (stale) ─► return stale + background revalidate  (SWR)
           ─ miss/changed
  → (single-flight: one fetch per key)
  → Python sidecar: data feeds → indicators → quant cores + statistical + ML + analyst predictors
                    → calibrated ranges (MAPIE) → structured snapshot + snapshot hash
       └ snapshot-hash unchanged? → reuse last LLM result (NO LLM CALL)
       → LLM router (ensemble fan-out) → retry → fallback → circuit-breaker
            └ budget hit / all down / sidecar-only → DEGRADE to pure-quant templated output
       → Consensus aggregator (all predictors + all models) → Validate + number reconciliation
       → Cache.set(TTL by horizon) → Widget JSON
```

## Cost control & "always-on while idle"

Split the cheap layer from the expensive one:
- A **background job snapshots quant data only — zero LLM calls** — for saved positions + watchlist on a
  slow cadence, so trend history accumulates even when nobody is looking.
- The **LLM ensemble fires only on-demand** when a symbol is viewed, then caches: intraday 1–5 min
  (market hours only), outlook 12–24 h, position 1–6 h, portfolio 6–24 h.
- **Skip the LLM** entirely when the rounded snapshot hasn't changed; skip grounding when no fresh news;
  single-flight dedupe; stale-while-revalidate for instant feel.
- **Hard per-day token budget** in the router → trips into pure-quant mode (extends existing chat
  guardrails: per-IP/min, per-IP/day, global/day caps, max output tokens).

## UI redesign

- **Horizon ribbon** across the top (`Today · Days · Weeks–Months · Position · Portfolio`) so the four
  cards read as points on one timeline, not rival opinions.
- **"Market view" vs "Your view"** section split.
- Four bento cards, each carrying the same four honesty primitives:
  - **HorizonBadge** — fixes the card to a time window.
  - **ConfidenceMeter** — banded Low/Mod/High + rounded % (no false precision); **desaturates the verdict
    when confidence is low**.
  - **FreshnessTag** — "as of HH:MM · Live/Stale/Paused"; dims card when stale.
  - **AIBadge** — "AI estimate · not advice" + sources/citations popover.
- **SignalChip** — 5-state (Strong Buy → Strong Sell) + HOLD / WAIT; **icon + label + color** (never color
  alone — WCAG 1.4.1); amber/blue for HOLD/WAIT so states never rely on red-vs-green; ≥4.5:1 contrast.
- **DriverPills** — `RSI▲ Vol▼ Trend▲`, tap to expand (progressive disclosure).
- **Outlook card** uses a **bull/base/bear fan** (uncertainty visibly widens with horizon).
- **Model-consensus panel** — each provider's call side-by-side + consensus headline (the multi-model
  feature made visible).
- Reuse existing chart, KPIs, position tracker, news, chatbot; total visible cards ≤ ~15 for scannability.

## Honesty / compliance

- Ranges + scenarios over single targets; rounded confidence bands; explicit horizon on every card.
- "AI estimate · not advice" inline pills; sources beneath narrative; one-time methodology modal;
  scannable disclosure accordion.
- **Calibration logging**: record predictions + realized outcomes; track Brier score so the dashboard
  learns whether its confidence is honest over time.

## Phased implementation

1. **Python sidecar + data layer** — FastAPI service; OpenBB + direct providers (Finnhub/FMP/FRED/Yahoo
   options/Alpaca); pandas-ta indicators; the four **rule-based quant cores** + unit tests; REST API.
   (Pure-quant output is already useful and is the degradation path.)
2. **Node ↔ sidecar wiring + caching/scheduler** — typed HTTP client; single-flight, SWR, TTL-by-horizon;
   background quant-only snapshots; begin accumulating the 1-min history store.
3. **LLM router + ensemble + multi-predictor consensus** — Vercel AI SDK adapters, schema-forced,
   number-reconciled; consensus over **all predictor voices + all LLM models** with divergence flagging.
4. **Calibrated uncertainty + sentiment** — MAPIE conformal ranges + probability calibration; FinBERT
   sentiment; StatsForecast statistical-predictor voice; analyst-consensus voice.
5. **UI** — horizon ribbon, Market/Your split, four cards with honesty primitives, multi-predictor panel.
6. **Calibration logging** — predictions + outcomes + Brier scoring (also the training dataset).
7. **Validated ML model (qlib)** — once enough 1-min history has accumulated: features → train →
   walk-forward (purged-CV/triple-barrier) → serve as another predictor voice; benchmark vs the rest.

## Scope / sequencing

- **ML meta-model is now in scope** (via qlib) but **sequenced last** — it needs accumulated 1-min history
  and rigorous walk-forward validation to avoid overfitting/data-mining bias. Rule-based cores ship first
  and remain the degradation path; the ML model is added as one more predictor voice, never the sole one.
- Multi-instance scaling (Redis-backed cache/circuit-breaker/budget) deferred; in-memory is correct for
  the single Node instance. The Python sidecar is a second Render service (within minimal-cost budget).

## Security constraints (persisted)

- All provider API keys live **only in `.env`** (gitignored), **never committed**, **never sent to the
  browser** — all LLM calls proxied server-side. Verify `.env` is not staged before every commit.
- The router degrades gracefully: runs with whatever keys are present (even just Gemini); pure-quant when
  none. Keys can be added incrementally (Gemini today → add OpenAI / Anthropic / Perplexity).

## Authoritative sources

- Gao, Han, Li & Zhou — *Market Intraday Momentum* (JFE 2018).
- Zarattini, Barbon & Aziz — *Can Day Trading Really Be Profitable?* (2023) — volume-filtered ORB.
- López de Prado — *Advances in Financial Machine Learning* (triple-barrier, meta-labeling, purged CV).
- Aronson — *Evidence-Based Technical Analysis* (data-mining bias).
- Chan — *Algorithmic Trading* (regime classification: mean-reversion vs momentum).
- Moskowitz, Ooi & Pedersen — *Time Series Momentum* (2012).
- Jegadeesh & Titman (1993); Fama-French + Carhart momentum; Piotroski F-score; O'Neil CANSLIM.
- Tetlock — *Superforecasting* (calibration over point forecasts).
