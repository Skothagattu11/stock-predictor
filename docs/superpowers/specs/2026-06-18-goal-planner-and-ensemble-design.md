# Goal Planner + 4-Model Ensemble (Phase A) — Design

**Status:** Approved scope, pending spec review
**Date:** 2026-06-18
**Author:** brainstorming session

## Goal

Give the user a **goal-driven "when to invest" layer**: enter a budget ($100–200)
and a profit target ($10–15), and get a ranked, PE-annotated shortlist of US
equities where that profit is *realistically achievable*, each labelled with the
shortest viable horizon, an entry window, and an honest downside — plus a
live "buy-now" alert when a pick enters its entry zone. Predictions are
strengthened by an ensemble of all four LLMs (Claude + Gemini + OpenAI +
Perplexity) voting alongside the deterministic quant voices.

This is **Phase A** of a larger roadmap. It is analysis + alerts only — **no
order execution, no crypto.** Those are explicitly out of scope here (Phases B–D).

## Roadmap context (for reference, not built here)

- **Phase A (this spec):** Smarter predictions + Goal Planner, US equities, no money at risk.
- **Phase B:** Paper trading (Alpaca paper API + Hyperliquid testnet) + crypto data and a crypto Goal Planner.
- **Phase C:** Live execution, human-confirm each order, hard safety rails (size caps, daily loss limit, kill switch), keys server-side only.
- **Phase D (optional):** Bounded autonomy, only after Phase C proves an edge on paper.

## Out of scope (Phase A)

- Any order placement (paper or live), broker/wallet integration.
- Crypto / Hyperliquid market data or scoring.
- Fractional shares (whole shares only in v1; fractional is a later toggle).
- Training a new ML model (the probability estimator is a swappable function so
  ML can replace the heuristic later without touching callers).

---

## Core idea — the math that makes it the user's goal

For each candidate at price `px`, given budget `B` and target profit `P`:

```
shares        = floor(B / px)                  # whole shares
invested      = shares * px                     # <= B
required_move = P / invested                    # fraction the stock must rise to make $P
```

This naturally favors affordable names: a $40 stock with $200 → 5 shares →
needs **+5%**; a $150 stock → 1 share → needs **+6.7%**; a $300 stock is
**filtered out** (can't buy one share within budget).

### Achievability — probability of hitting the target before the stop

Each candidate already has a structural **stop distance** `s` (fraction) from the
intraday/outlook engines' `TradeLevels`. We estimate, per candidate **horizon**,
the probability of price reaching `+required_move` **before** `-s`, within that
horizon, using the classic two-barrier first-passage probability for a drifted
random walk:

```
# drift mu and vol sigma are fractional, scaled to the horizon (see below)
def prob_hit_target_before_stop(r, s, mu, sigma):
    # r = required upside fraction (>0), s = stop distance fraction (>0)
    if sigma <= 0:
        return 1.0 if mu > 0 and r <= mu else 0.0
    if abs(mu) < 1e-9:                          # driftless: gambler's ruin
        return s / (r + s)
    k = 2.0 * mu / (sigma * sigma)
    # P(hit +r before -s) for BM with drift over the horizon
    return (1.0 - math.exp(-k * s)) / (math.exp(k * r) - math.exp(-k * s))
```

- `mu` (horizon drift) comes from the existing engines' expected move, signed and
  scaled by the **quant** bias/conviction (`score_intraday` probability,
  `score_outlook` score). The sidecar stays purely deterministic — the LLM
  ensemble is layered on at the Node level (see "4-model ensemble"), never inside
  this function. Bullish quant raises `mu`; bearish/neutral lowers or zeroes it.
- `sigma` (horizon vol) comes from ATR/realized-vol, scaled by `sqrt(horizon_days)`
  (same approach as `outlook.py`'s `horizon_vol`).
- This is **one pure function** — the single swap point for a future Monte-Carlo
  or ML estimator. Everything downstream depends only on its output.

### Horizon selection ("any timeframe")

Evaluate a fixed set of horizons and pick the **shortest** that clears the user's
probability bar:

```
HORIZONS = [("intraday", 1), ("swing", 5), ("position", 21)]   # trading days
```

For each, scale `mu`/`sigma` to `horizon_days`, compute the probability, and
choose the first (shortest) horizon with `prob >= threshold`. If none clear,
the candidate is excluded (or flagged `stretch` when the user opts to see them).

### Risk slider → threshold (and universe)

A single user knob maps to the probability bar and how aggressive the universe is:

| Risk    | prob threshold | universe                         |
|---------|----------------|----------------------------------|
| Cautious| 0.65           | established names (skip penny)    |
| Balanced| 0.55           | hot + shine lanes                 |
| Aggressive | 0.45        | all lanes incl. penny/movers      |

### Output per pick (honest both-sides)

```
target_dollars = P                                   # +$10..$15
risk_dollars   = shares * s * px                      # what you lose if the stop hits
reward_risk    = target_dollars / risk_dollars
```

Each pick also carries `pe`, a cheap/fair/rich tag (reuse `outlook.py`'s
valuation tilt vs ~25x), the entry window, conviction, and which voices agree.

---

## Architecture

Fits the existing two-service layout. New pieces are additive; no rewrites.

### Python sidecar

**New:** `services/quant-py/app/predictors/opportunities.py`

```python
def score_opportunity(symbol, df, daily_df, fundamentals, *,
                      budget, target, threshold) -> OpportunityPick | None:
    """Pure, deterministic. Reuses score_intraday + score_outlook + ATR.
    Returns None when unaffordable or no horizon clears `threshold`."""
```

It composes the existing `score_intraday` (entry/target/stop, expected move) and
`score_outlook` (drift, horizon vol, valuation), computes affordability +
required move, runs `prob_hit_target_before_stop` across `HORIZONS`, picks the
shortest qualifying horizon, and assembles the pick (with `pe` from `fundamentals`).

**New endpoint:** `GET /opportunities?budget=&target=&risk=`

- Pulls the candidate universe from the existing `build_discover` (lanes filtered
  by the `risk` level), de-duplicated.
- Fetches candles + daily candles + fundamentals per candidate **in parallel**
  (`ThreadPoolExecutor`, same pattern as discovery).
- Scores each via `score_opportunity`, drops `None`, ranks by probability
  (tie-break by reward:risk), returns top N.
- Records the produced picks into the existing calibration store so the
  track-record can later score whether targets were actually hit.

**New models** in `app/models.py`:

```python
class OpportunityPick(BaseModel):
    symbol: str
    price: float
    pe: float | None = None
    pe_tag: str                     # 'cheap' | 'fair' | 'rich' | 'n/a'
    shares: int
    invested: float
    required_move_pct: float
    horizon: str                    # 'intraday' | 'swing' | 'position'
    horizon_days: int
    probability: float              # 0..1, from the barrier model
    entry_low: float                # buy-zone bounds
    entry_high: float
    entry_status: str               # 'buy_now' | 'wait'
    target_dollars: float
    risk_dollars: float
    reward_risk: float
    conviction: float               # quant-derived, 0..1 (Node may enrich for display)
    voices_agree: list[str]         # quant/statistical voices; Node appends LLM agreement
    as_of: str

class OpportunitiesResult(BaseModel):
    budget: float
    target: float
    risk: str
    picks: list[OpportunityPick]
    scanned: int                    # universe size scanned
    as_of: str
```

### Node orchestrator

- `src/sidecar.js`: add `opportunities(budget, target, risk)` → GET with query.
- `src/predict-service.js`: add `opportunities(...)` with a short TTL
  (~60s, market-hours) via the existing `TtlCache`.
- `src/predict-routes.js`: add `GET /opportunities` (already forwards upstream
  4xx after the recent fix, so a 422/empty-universe surfaces honestly).
- **Ensemble narrative (optional, on-demand):** an insight-style call that runs
  the 4-model ensemble on the **top** pick(s) for a short rationale. Reuses the
  existing `router.ensemble` + `buildConsensus`; not run for every candidate
  (cost control).
- **Alerts:** extend `src/alerts-service.js` to watch the current Goal-Planner
  picks' entry windows. When a listed pick's live price enters `[entry_low,
  entry_high]`, fire a browser + (opt-in) email "buy-now" alert, deduped, active
  while the pick remains on the list.

### 4-model ensemble

Already auto-sizes from configured keys (`buildAdapters`). Phase A work:

- Confirm all four adapters are wired (they are) and document the required keys.
- Feed the ensemble's consensus stance + confidence into `mu`/conviction for the
  Goal Planner (via the request: the Node layer passes a conviction hint, or the
  sidecar stays quant-only and Node blends — **decision: Node blends**, so the
  sidecar remains deterministic/testable and the LLM influence is layered on in
  `predict-service`/insight before ranking display). The sidecar's
  `probability` is quant-only; Node may surface an ensemble-adjusted conviction
  and re-rank ties. This keeps the sidecar pure and the LLM cost in Node.

### Frontend

**New:** `public/opportunities.js` + a section/nav entry in `index.html`.

- Inputs: **Budget** and **Target profit** (defaults $150 / $12, ranges
  100–200 / 10–15), a **risk** select (Cautious/Balanced/Aggressive).
- Renders ranked cards: symbol · price · **PE (tag)** · shares · $ invested ·
  "Need +X% → $P · prob% · horizon" · entry zone + status · **+$target / −$risk**
  · conviction · voices agreeing.
- Click a pick → `window.selectSymbol(symbol)` to deep-dive in the existing
  prediction cards. Wires `window.Alerts` for buy-now notifications.

---

## Data flow

```
User sets budget/target/risk
  → GET /api/opportunities (Node, cached)
    → GET /opportunities (sidecar)
      → build_discover (universe, lane-filtered by risk)
      → parallel per candidate: candles + daily + fundamentals
      → score_opportunity → prob_hit_target_before_stop over horizons
      → rank, top N, record to calibration store
  ← OpportunitiesResult
  → Node optionally blends ensemble conviction, re-ranks ties
  → render ranked cards; register picks with alerts-service
Alerts loop: live price ∈ entry zone → browser/email "buy-now"
```

## Error handling

- Unaffordable candidate (`px > B`) or no qualifying horizon → omitted from results.
- Empty universe / screener down → sidecar 503 (already surfaced honestly by the
  Node route); UI shows "No opportunities right now (scanner unavailable)".
- Missing PE → `pe_tag = 'n/a'`, pick still shown (PE is informative, not a gate).
- LLM provider failure → ensemble degrades gracefully (router already isolates
  failures); ranking falls back to quant-only probability.
- Insufficient candles for a candidate → that candidate skipped, scan continues.

## Testing

**Sidecar (pytest):**
- `prob_hit_target_before_stop`: driftless case equals `s/(r+s)`; positive drift
  raises probability; symmetric sanity; bounds in [0,1].
- Affordability math: shares/invested/required_move for several price/budget combos;
  `px > B` → `None`.
- Horizon selection: picks the shortest horizon clearing the threshold; returns
  `None` when none clear.
- Risk → threshold/universe mapping.
- `risk_dollars` / `reward_risk` correctness.
- `/opportunities` endpoint: ranked, top-N, records to calibration store
  (monkeypatched), empty-universe → 503.

**Node (node:test):**
- `sidecar.opportunities` builds the right query string.
- `predict-service.opportunities` caches by `(budget,target,risk)`.
- `/api/opportunities` route returns ranked json; upstream 422/503 forwarded.
- alerts-service: a pick entering its entry zone triggers exactly one buy-now
  alert (deduped); leaving/clearing the list stops alerts.

## Security

- The four LLM keys and all future broker/wallet keys live **only** in gitignored
  `.env`, proxied server-side, never sent to the browser. `.env` verified unstaged
  before every commit (existing constraint, unchanged).
- No new secrets are introduced by Phase A beyond the LLM keys already planned.

## Extensibility

- `prob_hit_target_before_stop` is the single swap point: heuristic now →
  Monte-Carlo → calibrated ML, with no caller changes.
- `OpportunityPick` schema is asset-agnostic enough that the Phase B crypto
  planner can reuse it (PE becomes optional/`n/a`; entry/horizon semantics hold).
- The same ranked-pick interface is what Phase B's paper-execution layer will
  consume to place simulated orders.
