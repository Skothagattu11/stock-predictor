# Multi-Horizon, Multi-Model Prediction Engine — Design

**Date:** 2026-06-11
**Status:** Approved — router stack locked (Vercel AI SDK + in-house consensus); next: implementation plan
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

## Backend architecture (single Render instance, in-memory)

```
src/
  agents/        intraday · longTerm · position · portfolio
                 (each: data → quant → context → ensemble → validate)
  quant/         indicators, signals, portfolioMath  (pure, unit-tested; grows from engine/)
  context/       compact structured snapshot + snapshot hash
  llm/
    router.js        job→provider map, ensemble fan-out, retry/fallback/circuit-breaker, budget meter
    adapters/        openai · anthropic · gemini · perplexity  (via Vercel AI SDK)
    consensus.js     aggregate N model outputs → headline + agreement/divergence
    schemas.js       JSON/Zod schema per mode (forced structured output)
    validate.js      schema check + number reconciliation
  cache/         lru-cache w/ single-flight + stale-while-revalidate, TTL by horizon
  scheduler/     background quant-only trend snapshots for watchlist/portfolio
```

### Data flow
```
Widget request
  → Cache  ─ hit (fresh) ─────────► return  (instant)
           ─ hit (stale) ─► return stale + background revalidate  (SWR)
           ─ miss/changed
  → (single-flight: one fetch per key)
  → Data feed → Quant engine → Context builder
       └ snapshot-hash unchanged? → reuse last LLM result (NO LLM CALL)
       → LLM router (ensemble fan-out) → retry → fallback → circuit-breaker
            └ budget hit / all down → DEGRADE to pure-quant templated output
       → Validate + number reconciliation (re-ask on fail)
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

1. **Quant cores** — grow `engine/` into the four deterministic models + unit tests (no LLM yet; pure-quant
   output already useful and is the degradation path).
2. **LLM router + adapters + ensemble + consensus** — provider-agnostic (Vercel AI SDK), schema-forced,
   number-reconciled; ensemble fan-out + consensus aggregator.
3. **Caching / scheduler** — single-flight, SWR, TTL-by-horizon, background quant-only snapshots.
4. **UI** — horizon ribbon, Market/Your split, four cards with honesty primitives, consensus panel.
5. **Calibration logging** — predictions + outcomes + Brier scoring.

## Scope / deferrals

- **ML meta-model deferred** (XGBoost/LightGBM + triple-barrier labeling + meta-labeling + purged K-fold +
  embargo + walk-forward). It needs bulk historical 1-min data Yahoo won't provide and carries real
  overfitting/data-pipeline risk. Ship the **rule-based regime-gated scorer first** — it captures most of
  the documented intraday edge. Revisit once we accumulate our own 1-min history.
- Multi-instance scaling (Redis-backed cache/circuit-breaker/budget) deferred; in-memory is correct for a
  single Render instance.

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
