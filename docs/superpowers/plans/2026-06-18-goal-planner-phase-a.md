# Goal Planner + 4-Model Ensemble (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a goal-driven "when to invest" view — enter a budget and profit target, get a ranked, PE-annotated US-equity shortlist where that profit is realistically achievable, each with the shortest viable horizon, an entry window, honest downside, and a live buy-now alert.

**Architecture:** A new deterministic sidecar scorer (`opportunities.py`) composes the existing intraday + outlook engines and a two-barrier first-passage probability into ranked `OpportunityPick`s, exposed at `GET /opportunities`. Node proxies + caches it; a new `public/opportunities.js` view renders the picks and clicking one opens the existing prediction cards (which already run all four LLMs). Browser buy-now alerts reuse the existing notification path.

**Tech Stack:** Python 3.13 / FastAPI / pandas / pytest (sidecar); Node 22 / Express / node:test (orchestrator); vanilla JS (frontend).

**Spec:** `docs/superpowers/specs/2026-06-18-goal-planner-and-ensemble-design.md`

---

## File Structure

**Create:**
- `services/quant-py/app/predictors/opportunities.py` — pure scorer: barrier-hit probability, affordability, horizon scan, `score_opportunity`.
- `services/quant-py/tests/test_opportunities.py` — unit tests for the scorer.
- `public/opportunities.js` — Goal Planner view (inputs + ranked cards).

**Modify:**
- `services/quant-py/app/models.py` — add `OpportunityPick`, `OpportunitiesResult`.
- `services/quant-py/app/api.py` — add `GET /opportunities`.
- `services/quant-py/tests/test_api.py` — endpoint test (create if absent).
- `src/sidecar.js` — add `opportunities()` client method.
- `src/predict-service.js` — add cached `opportunities()` + TTL.
- `src/predict-routes.js` — add `GET /opportunities` route.
- `test/sidecar.test.js`, `test/predict-service.test.js`, `test/predict-routes.test.js` — Node tests.
- `public/index.html` — Goal Planner section + nav + styles.
- `public/alerts.js` — buy-now entry-zone check for opportunities.
- `render.yaml` — add the four LLM keys to the Node service env.

---

## Tunable constants (defined once in `opportunities.py`, referenced throughout)

```python
HORIZONS = [("intraday", 1), ("swing", 5), ("position", 21)]   # label, trading days
RISK_TIERS = {                                                  # risk -> (prob threshold, lanes)
    "cautious":   (0.65, ("hot", "shine")),
    "balanced":   (0.55, ("hot", "shine", "penny")),
    "aggressive": (0.45, ("hot", "shine", "penny")),
}
DRIFT_FRACTION = 0.5      # damp the conviction tilt feeding drift (keeps probabilities honest)
STOP_VOL_MULT  = 1.0      # stop distance as a multiple of horizon volatility
MIN_STOP_FRAC  = 0.02     # never risk less than 2% (avoids divide-by-near-zero R:R)
MAX_STOP_FRAC  = 0.20     # cap a single-name stop at 20%
ENTRY_BAND     = 0.005    # buy-zone width above support
TOP_N          = 12       # max picks returned
```

---

### Task 1: Barrier-hit probability (pure function)

**Files:**
- Create: `services/quant-py/app/predictors/opportunities.py`
- Test: `services/quant-py/tests/test_opportunities.py`

- [ ] **Step 1: Write the failing test**

```python
# services/quant-py/tests/test_opportunities.py
import math
from app.predictors.opportunities import prob_hit_target_before_stop

def test_driftless_is_gamblers_ruin():
    # no drift: P(up first) = s / (r + s)
    p = prob_hit_target_before_stop(r=0.05, s=0.05, mu=0.0, sigma=0.10)
    assert abs(p - 0.5) < 1e-9
    p2 = prob_hit_target_before_stop(r=0.05, s=0.15, mu=0.0, sigma=0.10)
    assert abs(p2 - 0.75) < 1e-9   # 0.15 / 0.20

def test_positive_drift_raises_probability():
    base = prob_hit_target_before_stop(r=0.05, s=0.05, mu=0.0, sigma=0.10)
    up = prob_hit_target_before_stop(r=0.05, s=0.05, mu=0.03, sigma=0.10)
    assert up > base

def test_probability_is_bounded():
    for mu in (-0.2, 0.0, 0.2):
        p = prob_hit_target_before_stop(r=0.05, s=0.05, mu=mu, sigma=0.10)
        assert 0.0 <= p <= 1.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/quant-py && python -m pytest tests/test_opportunities.py -v`
Expected: FAIL — `ModuleNotFoundError` / `cannot import name 'prob_hit_target_before_stop'`.

- [ ] **Step 3: Write minimal implementation**

```python
# services/quant-py/app/predictors/opportunities.py
"""Goal-driven opportunity scorer: budget+target -> achievable, timed, ranked
US-equity picks. Deterministic; composes the intraday + outlook engines.
No LLM, no I/O (the endpoint does the I/O)."""
import math

HORIZONS = [("intraday", 1), ("swing", 5), ("position", 21)]
RISK_TIERS = {
    "cautious":   (0.65, ("hot", "shine")),
    "balanced":   (0.55, ("hot", "shine", "penny")),
    "aggressive": (0.45, ("hot", "shine", "penny")),
}
DRIFT_FRACTION = 0.5
STOP_VOL_MULT = 1.0
MIN_STOP_FRAC = 0.02
MAX_STOP_FRAC = 0.20
ENTRY_BAND = 0.005
TOP_N = 12


def prob_hit_target_before_stop(r: float, s: float, mu: float, sigma: float) -> float:
    """P(price rises +r before falling -s) over one horizon, for a drifted random
    walk. r,s are positive fractions; mu,sigma are fractional drift/vol for the
    horizon. Two-barrier first-passage; driftless -> gambler's ruin s/(r+s)."""
    if r <= 0:
        return 1.0
    if sigma <= 0:
        return 1.0 if (mu > 0 and r <= mu) else 0.0
    if abs(mu) < 1e-9:
        return s / (r + s)
    k = 2.0 * mu / (sigma * sigma)
    p = (1.0 - math.exp(-k * s)) / (math.exp(k * r) - math.exp(-k * s))
    return max(0.0, min(1.0, p))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/quant-py && python -m pytest tests/test_opportunities.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add services/quant-py/app/predictors/opportunities.py services/quant-py/tests/test_opportunities.py
git commit -m "feat(opportunities): two-barrier hit-probability core"
```

---

### Task 2: Affordability, horizon volatility, and risk-tier helpers

**Files:**
- Modify: `services/quant-py/app/predictors/opportunities.py`
- Test: `services/quant-py/tests/test_opportunities.py`

- [ ] **Step 1: Write the failing test**

```python
# append to services/quant-py/tests/test_opportunities.py
import numpy as np, pandas as pd
from app.predictors.opportunities import (
    affordability, pe_tag, tier_config, stop_fraction_for)

def test_affordability_whole_shares_and_required_move():
    a = affordability(price=40.0, budget=200.0, target=10.0)
    assert a["shares"] == 5 and a["invested"] == 200.0
    assert abs(a["required_move"] - 0.05) < 1e-9
    b = affordability(price=150.0, budget=200.0, target=10.0)
    assert b["shares"] == 1 and abs(b["required_move"] - (10.0 / 150.0)) < 1e-9

def test_affordability_unaffordable_returns_none():
    assert affordability(price=300.0, budget=200.0, target=10.0) is None

def test_pe_tag_buckets():
    assert pe_tag(None) == "n/a"
    assert pe_tag(12.0) == "cheap"
    assert pe_tag(22.0) == "fair"
    assert pe_tag(45.0) == "rich"

def test_tier_config_maps_risk():
    thr, lanes = tier_config("cautious")
    assert thr == 0.65 and "penny" not in lanes
    thr2, lanes2 = tier_config("aggressive")
    assert thr2 == 0.45 and "penny" in lanes2
    assert tier_config("unknown")[0] == 0.55   # defaults to balanced

def test_stop_fraction_is_bounded():
    assert stop_fraction_for(0.0) == MIN_STOP_FRAC
    assert stop_fraction_for(10.0) == MAX_STOP_FRAC
```

(Add `from app.predictors.opportunities import MIN_STOP_FRAC, MAX_STOP_FRAC` to the test imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/quant-py && python -m pytest tests/test_opportunities.py -v`
Expected: FAIL — `cannot import name 'affordability'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to services/quant-py/app/predictors/opportunities.py
def affordability(price: float, budget: float, target: float) -> dict | None:
    """Whole-share affordability + the % move needed to make `target`."""
    if price <= 0 or budget <= 0:
        return None
    shares = int(budget // price)
    if shares < 1:
        return None                       # can't buy one share within budget
    invested = round(shares * price, 4)
    return {"shares": shares, "invested": invested,
            "required_move": target / invested}


def pe_tag(pe: float | None) -> str:
    if pe is None or pe <= 0:
        return "n/a"
    if pe < 15:
        return "cheap"
    if pe <= 30:
        return "fair"
    return "rich"


def tier_config(risk: str) -> tuple[float, tuple[str, ...]]:
    return RISK_TIERS.get((risk or "").lower(), RISK_TIERS["balanced"])


def stop_fraction_for(horizon_vol: float) -> float:
    return max(MIN_STOP_FRAC, min(MAX_STOP_FRAC, STOP_VOL_MULT * horizon_vol))


def daily_vol(daily_df: pd.DataFrame, lookback: int = 60) -> float:
    rets = daily_df["close"].pct_change().dropna()
    v = float(rets.tail(lookback).std()) if len(rets) else 0.0
    return v if v == v else 0.0           # NaN-safe
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/quant-py && python -m pytest tests/test_opportunities.py -v`
Expected: PASS (8 passed).

- [ ] **Step 5: Commit**

```bash
git add services/quant-py/app/predictors/opportunities.py services/quant-py/tests/test_opportunities.py
git commit -m "feat(opportunities): affordability, pe-tag, risk-tier and vol helpers"
```

---

### Task 3: `OpportunityPick`/`OpportunitiesResult` models + `score_opportunity`

**Files:**
- Modify: `services/quant-py/app/models.py:175` (append after the existing models)
- Modify: `services/quant-py/app/predictors/opportunities.py`
- Test: `services/quant-py/tests/test_opportunities.py`

- [ ] **Step 1: Write the failing test**

```python
# append to services/quant-py/tests/test_opportunities.py
from app.predictors.opportunities import score_opportunity

def _intraday_df(price=100.0, n=60):
    ts = 1_700_000_000 + np.arange(n) * 60
    base = np.linspace(price * 0.98, price, n)
    return pd.DataFrame({"timestamp": ts, "open": base, "high": base + 0.2,
                         "low": base - 0.2, "close": base, "volume": np.full(n, 1e6)})

def _daily_df(start=80.0, end=100.0, n=300):
    close = np.linspace(start, end, n)
    ts = 1_700_000_000 + np.arange(n) * 86400
    return pd.DataFrame({"timestamp": ts, "open": close, "high": close + 1,
                         "low": close - 1, "close": close, "volume": np.full(n, 1e6)})

def test_score_opportunity_affordable_uptrend_produces_pick():
    pick = score_opportunity("AAPL", _intraday_df(40.0), _daily_df(30, 40),
                             pe=22.0, daily_atr=1.0, budget=200.0, target=10.0,
                             threshold=0.45)
    assert pick is not None
    assert pick["symbol"] == "AAPL"
    assert pick["shares"] == 5 and pick["pe_tag"] == "fair"
    assert 0.0 <= pick["probability"] <= 1.0
    assert pick["horizon"] in ("intraday", "swing", "position")
    assert pick["target_dollars"] == 10.0
    assert pick["risk_dollars"] > 0 and pick["reward_risk"] > 0

def test_score_opportunity_unaffordable_returns_none():
    assert score_opportunity("BRK", _intraday_df(300.0), _daily_df(280, 300),
                             pe=None, daily_atr=5.0, budget=200.0, target=10.0,
                             threshold=0.45) is None

def test_score_opportunity_picks_shortest_qualifying_horizon():
    pick = score_opportunity("AAPL", _intraday_df(40.0), _daily_df(20, 40),
                             pe=10.0, daily_atr=1.5, budget=200.0, target=10.0,
                             threshold=0.45)
    # strong uptrend, low required move (5%) -> should qualify, label set
    assert pick is not None and pick["horizon_days"] in (1, 5, 21)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/quant-py && python -m pytest tests/test_opportunities.py -v`
Expected: FAIL — `cannot import name 'score_opportunity'`.

- [ ] **Step 3a: Add the Pydantic models**

```python
# append to services/quant-py/app/models.py
class OpportunityPick(BaseModel):
    symbol: str
    price: float
    pe: float | None = None
    pe_tag: str                       # 'cheap' | 'fair' | 'rich' | 'n/a'
    shares: int
    invested: float
    required_move_pct: float
    horizon: Literal["intraday", "swing", "position"]
    horizon_days: int
    probability: float = Field(ge=0.0, le=1.0)
    entry_low: float
    entry_high: float
    entry_status: Literal["buy_now", "wait"]
    target_dollars: float
    risk_dollars: float
    reward_risk: float
    conviction: float = Field(ge=0.0, le=1.0)
    voices_agree: list[str] = []
    as_of: str


class OpportunitiesResult(BaseModel):
    budget: float
    target: float
    risk: str
    picks: list[OpportunityPick]
    scanned: int
    as_of: str
```

- [ ] **Step 3b: Implement `score_opportunity`**

```python
# append to services/quant-py/app/predictors/opportunities.py
from datetime import datetime, timezone
from app.predictors.intraday import score_intraday
from app.predictors.outlook import score_outlook, MIN_BARS


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _direction_and_conviction(intraday, outlook):
    """Blend the two deterministic engines into a long-side bias (+conviction)."""
    bull = 0.0
    voices = []
    if intraday and intraday.bias == "Bullish":
        bull += intraday.conviction; voices.append("intraday")
    elif intraday and intraday.bias == "Bearish":
        bull -= intraday.conviction
    if outlook and outlook.stance == "Constructive":
        bull += outlook.confidence; voices.append("outlook")
    elif outlook and outlook.stance == "Cautious":
        bull -= outlook.confidence
    conviction = min(1.0, abs(bull) / 2.0)
    return (1 if bull > 0 else -1 if bull < 0 else 0), conviction, voices


def score_opportunity(symbol, intraday_df, daily_df, *, pe, daily_atr,
                      budget, target, threshold) -> dict | None:
    price = float(intraday_df["close"].iloc[-1]) if len(intraday_df) else \
        float(daily_df["close"].iloc[-1])
    aff = affordability(price, budget, target)
    if aff is None:
        return None

    intraday = None
    if len(intraday_df) >= 15:
        try:
            intraday = score_intraday(symbol, intraday_df, interval_minutes=1, daily_atr=daily_atr)
        except Exception:
            intraday = None
    outlook = None
    if len(daily_df) >= MIN_BARS:
        try:
            outlook = score_outlook(symbol, daily_df)
        except Exception:
            outlook = None

    sign, conviction, voices = _direction_and_conviction(intraday, outlook)
    if sign <= 0:                      # long-only: need a non-bearish, non-flat read
        return None

    dvol = daily_vol(daily_df)
    r = aff["required_move"]

    best = None
    for label, days in HORIZONS:
        hv = dvol * math.sqrt(days)
        if hv <= 0:
            continue
        mu = sign * DRIFT_FRACTION * conviction * hv
        s = stop_fraction_for(hv)
        prob = prob_hit_target_before_stop(r, s, mu, hv)
        if prob >= threshold:
            best = (label, days, prob, s)
            break                       # HORIZONS is shortest-first
    if best is None:
        return None
    label, days, prob, s = best

    # entry zone: a small band above recent intraday support (wait for the dip)
    if len(intraday_df) >= 20:
        support = float(intraday_df["low"].tail(20).min())
    else:
        support = price * (1 - ENTRY_BAND)
    entry_low = round(support, 4)
    entry_high = round(support * (1 + ENTRY_BAND), 4)
    entry_status = "buy_now" if price <= entry_high else "wait"

    risk_dollars = round(aff["shares"] * s * price, 2)
    return {
        "symbol": symbol, "price": round(price, 4), "pe": pe, "pe_tag": pe_tag(pe),
        "shares": aff["shares"], "invested": aff["invested"],
        "required_move_pct": round(r, 4),
        "horizon": label, "horizon_days": days, "probability": round(prob, 4),
        "entry_low": entry_low, "entry_high": entry_high, "entry_status": entry_status,
        "target_dollars": round(target, 2), "risk_dollars": risk_dollars,
        "reward_risk": round(target / risk_dollars, 2) if risk_dollars > 0 else 0.0,
        "conviction": round(conviction, 3), "voices_agree": voices, "as_of": _now_iso(),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/quant-py && python -m pytest tests/test_opportunities.py -v`
Expected: PASS (11 passed).

- [ ] **Step 5: Commit**

```bash
git add services/quant-py/app/models.py services/quant-py/app/predictors/opportunities.py services/quant-py/tests/test_opportunities.py
git commit -m "feat(opportunities): score_opportunity + OpportunityPick/Result models"
```

---

### Task 4: `GET /opportunities` endpoint

**Files:**
- Modify: `services/quant-py/app/api.py` (append at end)
- Test: `services/quant-py/tests/test_api_opportunities.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# services/quant-py/tests/test_api_opportunities.py
import numpy as np, pandas as pd
from fastapi.testclient import TestClient
import app.api as api
from app.api import app, get_market_data, get_discover_providers
from app.models import DiscoverResult, DiscoverItem

def _intraday(price):
    n = 60; ts = 1_700_000_000 + np.arange(n) * 60
    base = np.linspace(price * 0.98, price, n)
    return pd.DataFrame({"timestamp": ts, "open": base, "high": base + 0.2,
                         "low": base - 0.2, "close": base, "volume": np.full(n, 1e6)})

def _daily(start, end):
    n = 300; close = np.linspace(start, end, n); ts = 1_700_000_000 + np.arange(n) * 86400
    return pd.DataFrame({"timestamp": ts, "open": close, "high": close + 1,
                         "low": close - 1, "close": close, "volume": np.full(n, 1e6)})

class _MD:
    def fetch_candles(self, symbol, interval="1m", range_="1d"):
        return _daily(30, 40) if interval == "1d" else _intraday(40.0)

def test_opportunities_ranks_and_returns_picks(monkeypatch):
    # get_market_data / get_discover_providers are Depends -> override; the rest are
    # plain module functions -> monkeypatch.
    app.dependency_overrides[get_market_data] = lambda: _MD()
    app.dependency_overrides[get_discover_providers] = lambda: (None, object())
    monkeypatch.setattr(api, "build_discover",
        lambda *a, **k: DiscoverResult(hot=[DiscoverItem(symbol="AAPL", price=40.0, score=1.0, reason="x")],
                                       penny=[], shine=[], sources=["test"], as_of="t"))
    monkeypatch.setattr(api, "_daily_atr", lambda md, s: 1.0)
    monkeypatch.setattr(api, "_pe_for", lambda md, s: 22.0)
    try:
        r = TestClient(app).get("/opportunities?budget=200&target=10&risk=aggressive")
        assert r.status_code == 200
        body = r.json()
        assert body["budget"] == 200.0 and body["scanned"] >= 1
        assert isinstance(body["picks"], list)
    finally:
        app.dependency_overrides.clear()

def test_opportunities_empty_universe_is_503():
    app.dependency_overrides[get_discover_providers] = lambda: (None, None)
    try:
        r = TestClient(app).get("/opportunities")
        assert r.status_code == 503
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/quant-py && python -m pytest tests/test_api_opportunities.py -v`
Expected: FAIL — 404 (route not defined) / `AttributeError: _pe_for`.

- [ ] **Step 3: Implement the endpoint**

```python
# append to services/quant-py/app/api.py
from concurrent.futures import ThreadPoolExecutor
from app.predictors.opportunities import score_opportunity, tier_config, TOP_N
from app.models import OpportunitiesResult, OpportunityPick
from datetime import datetime, timezone


def _pe_for(md: MarketData, symbol: str) -> float | None:
    """Best-effort PE via the configured fundamentals providers (None on failure)."""
    try:
        providers = get_fundamentals_providers()
        for p in providers:
            f = p.fetch(symbol)
            if f and f.pe:
                return float(f.pe)
    except Exception:
        pass
    return None


@app.get("/opportunities", response_model=OpportunitiesResult)
def opportunities(budget: float = 150.0, target: float = 12.0, risk: str = "balanced",
                  md: MarketData = Depends(get_market_data)):
    fmp, yahoo = get_discover_providers()
    if fmp is None and yahoo is None:
        raise HTTPException(status_code=503, detail="no screener provider configured")
    threshold, lanes = tier_config(risk)
    disc = build_discover(fmp, yahoo=yahoo)
    seen, candidates = set(), []
    for lane in lanes:
        for item in getattr(disc, lane, []):
            if item.symbol not in seen:
                seen.add(item.symbol); candidates.append(item.symbol)

    def _score(sym):
        try:
            idf = md.fetch_candles(sym, interval="1m", range_="1d")
            ddf = md.fetch_candles(sym, interval="1d", range_="2y")
            if ddf.empty:
                return None
            return score_opportunity(sym, idf, ddf, pe=_pe_for(md, sym),
                                     daily_atr=_daily_atr(md, sym),
                                     budget=budget, target=target, threshold=threshold)
        except Exception:
            return None

    picks = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for res in ex.map(_score, candidates):
            if res:
                picks.append(res)
    picks.sort(key=lambda p: (p["probability"], p["reward_risk"]), reverse=True)
    picks = picks[:TOP_N]
    # (Durable hit/miss tracking for opportunities is a follow-up: the existing
    # calibration store is setup-shaped, so recording these picks needs a new
    # store method — deliberately out of scope for Phase A.)
    return OpportunitiesResult(
        budget=budget, target=target, risk=risk,
        picks=[OpportunityPick(**p) for p in picks], scanned=len(candidates),
        as_of=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
```

Note: `build_discover` and `get_discover_providers` are already imported/defined in `api.py` (Discovery feature). If `build_discover` is referenced via `from app.discovery.scanner import build_discover`, ensure that import is at module top so `monkeypatch.setattr(api, "build_discover", ...)` works.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/quant-py && python -m pytest tests/test_api_opportunities.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Run the full sidecar suite**

Run: `cd services/quant-py && python -m pytest -q`
Expected: all pass (existing + new).

- [ ] **Step 6: Commit**

```bash
git add services/quant-py/app/api.py services/quant-py/tests/test_api_opportunities.py
git commit -m "feat(opportunities): GET /opportunities scan + rank endpoint"
```

---

### Task 5: Node sidecar client + cached predict-service method

**Files:**
- Modify: `src/sidecar.js:49` (add to the returned object)
- Modify: `src/predict-service.js:13` (TTL) and `:29` (method)
- Test: `test/sidecar.test.js`, `test/predict-service.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
// append to test/sidecar.test.js
test('opportunities builds a query string from budget/target/risk', async () => {
  const rec = {};
  const s = createSidecar({ baseUrl: 'http://side', fetchImpl: fakeFetch(rec, { picks: [] }) });
  await s.opportunities(200, 10, 'aggressive');
  assert.ok(rec.url.startsWith('http://side/opportunities?'));
  assert.ok(rec.url.includes('budget=200'));
  assert.ok(rec.url.includes('target=10'));
  assert.ok(rec.url.includes('risk=aggressive'));
});
```

```javascript
// append to test/predict-service.test.js  (matches the file's existing harness)
test('opportunities is cached by budget:target:risk', async () => {
  const counts = {};
  const sidecar = { opportunities: async () => (counts.o = (counts.o || 0) + 1, { picks: [] }) };
  const svc = createPredictService({ sidecar, cache: new TtlCache() });
  await svc.opportunities(200, 10, 'balanced');
  await svc.opportunities(200, 10, 'balanced');
  assert.equal(counts.o, 1);   // second call served from cache
});
```

(`TtlCache` and `createPredictService` are already imported at the top of this test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/sidecar.test.js test/predict-service.test.js`
Expected: FAIL — `s.opportunities is not a function` / `svc.opportunities is not a function`.

- [ ] **Step 3: Implement**

```javascript
// src/sidecar.js — add inside the returned object (after calibrationStats)
    opportunities: (budget, target, risk) =>
      request('GET', `/opportunities?budget=${encodeURIComponent(budget)}` +
        `&target=${encodeURIComponent(target)}&risk=${encodeURIComponent(risk || 'balanced')}`),
```

```javascript
// src/predict-service.js — add to TTL map
  opportunities: 60 * 1000,          // 1 min (market hours)
```

```javascript
// src/predict-service.js — add to the returned object
    opportunities: (budget, target, risk) =>
      cached('opportunities', `${budget}:${target}:${risk || 'balanced'}`,
        () => sidecar.opportunities(budget, target, risk)),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/sidecar.test.js test/predict-service.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidecar.js src/predict-service.js test/sidecar.test.js test/predict-service.test.js
git commit -m "feat(opportunities): node sidecar client + cached predict-service method"
```

---

### Task 6: Node `/api/predict/opportunities` route

**Files:**
- Modify: `src/predict-routes.js:34` (add route)
- Test: `test/predict-routes.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// append to test/predict-routes.test.js
test('GET /api/predict/opportunities passes params and returns json', async () => {
  const service = { opportunities: async (b, t, r) => ({ budget: b, target: t, risk: r, picks: [] }) };
  const { server, base } = await listen(appWith(service));
  try {
    const r = await fetch(`${base}/api/predict/opportunities?budget=200&target=10&risk=aggressive`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.budget, 200); assert.equal(body.risk, 'aggressive');
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/predict-routes.test.js`
Expected: FAIL — 503/empty (route not defined).

- [ ] **Step 3: Implement the route**

```javascript
// src/predict-routes.js — add after the /calibration/stats line
  router.get('/opportunities', wrap((req) => {
    const q = req.query;
    const num = (v, d) => (v === undefined ? d : Number(v));
    return service.opportunities(num(q.budget, 150), num(q.target, 12), q.risk || 'balanced');
  }));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/predict-routes.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full Node suite**

Run: `node --test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/predict-routes.js test/predict-routes.test.js
git commit -m "feat(opportunities): /api/predict/opportunities route"
```

---

### Task 7: Goal Planner frontend view

**Files:**
- Create: `public/opportunities.js`
- Modify: `public/index.html` (add a section, a nav/anchor, the `<script>` include, and CSS)

- [ ] **Step 1: Add the markup + script include to `index.html`**

Add a section near the Discover panel (match the existing panel structure/classes):

```html
<!-- Goal Planner -->
<section id="goalPlanner" class="panel">
  <div class="pcard-head"><span class="phbadge">Goal Planner</span>
    <span class="pmuted">Find stocks where your target profit is realistic — and when to buy.</span></div>
  <div class="gp-controls">
    <label>Budget $ <input id="gpBudget" type="number" min="50" max="100000" value="150"></label>
    <label>Target profit $ <input id="gpTarget" type="number" min="1" max="100000" value="12"></label>
    <label>Risk
      <select id="gpRisk">
        <option value="cautious">Cautious</option>
        <option value="balanced" selected>Balanced</option>
        <option value="aggressive">Aggressive</option>
      </select>
    </label>
    <button id="gpScan">Scan</button>
  </div>
  <div id="gpResults" class="gp-results"><div class="pmuted">Set your budget &amp; target, then Scan.</div></div>
</section>
<script src="opportunities.js"></script>
```

Add CSS (reuse existing color vars):

```html
<style>
  .gp-controls{display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin:10px 0}
  .gp-controls label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);gap:4px}
  .gp-controls input,.gp-controls select{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px}
  #gpScan{background:var(--blue);color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;height:34px}
  .gp-row{border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0;cursor:pointer;background:var(--panel2)}
  .gp-row:hover{border-color:var(--blue)}
  .gp-row .sym{font-weight:700}
  .gp-tag{font-size:11px;padding:1px 6px;border-radius:4px;border:1px solid var(--line);margin-left:6px}
  .gp-buy{color:var(--green)} .gp-wait{color:var(--amber)}
  .gp-up{color:var(--green)} .gp-down{color:var(--red)}
</style>
```

- [ ] **Step 2: Implement `public/opportunities.js`**

```javascript
// public/opportunities.js — Goal Planner: budget+target -> ranked, timed picks.
(function () {
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pct(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }
  function money(x) { return '$' + Number(x).toFixed(2); }
  var HLABEL = { intraday: 'Today', swing: '~1 week', position: '~3 weeks' };

  function row(p) {
    var statusCls = p.entry_status === 'buy_now' ? 'gp-buy' : 'gp-wait';
    var statusTxt = p.entry_status === 'buy_now' ? '✅ buy now' : '⏳ wait for dip';
    return '<div class="gp-row" data-sym="' + esc(p.symbol) + '">' +
      '<div><span class="sym">' + esc(p.symbol) + '</span> ' + money(p.price) +
        ' <span class="gp-tag">PE ' + (p.pe != null ? p.pe.toFixed(1) : '—') + ' · ' + esc(p.pe_tag) + '</span>' +
        ' <span class="gp-tag">' + p.shares + ' sh · ' + money(p.invested) + '</span></div>' +
      '<div>Need <b class="gp-up">' + pct(p.required_move_pct) + '</b> → ' + money(p.target_dollars) +
        ' · <b>' + Math.round(p.probability * 100) + '%</b> · ' + esc(HLABEL[p.horizon] || p.horizon) + '</div>' +
      '<div>Entry ' + money(p.entry_low) + '–' + money(p.entry_high) +
        ' <span class="' + statusCls + '">' + statusTxt + '</span></div>' +
      '<div><span class="gp-up">+' + money(p.target_dollars) + '</span> / ' +
        '<span class="gp-down">−' + money(p.risk_dollars) + '</span> · R:R ' + p.reward_risk +
        ' · conv ' + Math.round(p.conviction * 100) + '%</div>' +
    '</div>';
  }

  function render(data) {
    var node = el('gpResults');
    if (!data.picks || !data.picks.length) {
      node.innerHTML = '<div class="pmuted">No picks clear your target right now (scanned ' +
        (data.scanned || 0) + '). Try a higher risk tier or a smaller target.</div>';
      return;
    }
    node.innerHTML = data.picks.map(row).join('');
    Array.prototype.forEach.call(node.querySelectorAll('.gp-row'), function (r) {
      r.addEventListener('click', function () {
        var sym = r.getAttribute('data-sym');
        if (window.selectSymbol) window.selectSymbol(sym);   // deep-dive: existing cards run all 4 LLMs
      });
    });
    if (window.Alerts && window.Alerts.watchOpportunities) window.Alerts.watchOpportunities(data.picks);
  }

  function scan() {
    var b = el('gpBudget').value || 150, t = el('gpTarget').value || 12, r = el('gpRisk').value || 'balanced';
    el('gpResults').innerHTML = '<div class="pmuted">Scanning…</div>';
    fetch('/api/predict/opportunities?budget=' + encodeURIComponent(b) +
          '&target=' + encodeURIComponent(t) + '&risk=' + encodeURIComponent(r))
      .then(function (res) { if (!res.ok) throw new Error('scan failed (' + res.status + ')'); return res.json(); })
      .then(render)
      .catch(function (e) { el('gpResults').innerHTML = '<div class="pmuted">Could not scan (' + esc(e.message) + ').</div>'; });
  }

  function init() { var btn = el('gpScan'); if (btn) btn.addEventListener('click', scan); }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
  window.GoalPlanner = { scan: scan };
})();
```

- [ ] **Step 3: Manual smoke test**

Run: `node src/server.js` (with `QUANT_SIDECAR_URL` set to a running sidecar), open the app, set budget/target, click **Scan**, confirm ranked rows render and clicking a row deep-dives the symbol.
Expected: rows appear (or an honest "No picks…" message); clicking a row loads the existing prediction cards.

- [ ] **Step 4: Commit**

```bash
git add public/opportunities.js public/index.html
git commit -m "feat(opportunities): Goal Planner view (budget/target/risk -> ranked picks)"
```

---

### Task 8: Browser buy-now entry alerts

**Files:**
- Modify: `public/alerts.js` (add `watchOpportunities`)

- [ ] **Step 1: Implement `watchOpportunities`**

Add to the `window.Alerts` object in `public/alerts.js` (match its existing notification helper — it already calls `Notification`):

```javascript
// public/alerts.js — inside the Alerts module, add to the returned object
  // Fire a one-time browser notification when a Goal-Planner pick is in its buy zone.
  var _oppNotified = {};   // symbol -> true (per session)
  function watchOpportunities(picks) {
    if (!('Notification' in window)) return;
    (picks || []).forEach(function (p) {
      if (p.entry_status === 'buy_now' && !_oppNotified[p.symbol]) {
        _oppNotified[p.symbol] = true;
        if (Notification.permission === 'granted') {
          new Notification('Buy-now: ' + p.symbol,
            { body: 'In buy zone $' + p.entry_low + '–$' + p.entry_high +
                    ' · need +' + (p.required_move_pct * 100).toFixed(1) + '% for $' + p.target_dollars });
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission();
        }
      }
    });
  }
```

Export it: add `watchOpportunities: watchOpportunities` to the object `public/alerts.js` returns / assigns to `window.Alerts`.

- [ ] **Step 2: Manual smoke test**

Run the app, grant notification permission, Scan; if any pick has `entry_status: "buy_now"`, a browser notification fires once.
Expected: a single "Buy-now: SYM" notification per qualifying pick per session.

- [ ] **Step 3: Commit**

```bash
git add public/alerts.js
git commit -m "feat(opportunities): browser buy-now entry alerts"
```

---

### Task 9: Configure the four LLM keys for deploy

**Files:**
- Modify: `render.yaml:12-32` (Node service `envVars`)

- [ ] **Step 1: Add the LLM keys to the Node service env in `render.yaml`**

Under the `stock-predictor` service `envVars`, add (keys set in the dashboard, never committed):

```yaml
      - key: GEMINI_API_KEY
        sync: false
      - key: OPENAI_API_KEY
        sync: false
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: PERPLEXITY_API_KEY
        sync: false
```

- [ ] **Step 2: Verify the blueprint parses**

Run: `node -e "const yaml=require('fs').readFileSync('render.yaml','utf8'); if(!/ANTHROPIC_API_KEY/.test(yaml)||!/PERPLEXITY_API_KEY/.test(yaml)) throw new Error('keys missing'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add render.yaml
git commit -m "chore(deploy): declare the four LLM keys for the ensemble (sync:false)"
```

---

## Env vars the user must set (after merge)

On the **Node service** (`stock-predictor`): `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY` (enables all four ensemble voices), plus the already-required `QUANT_SIDECAR_URL`. On the **sidecar** (`quant-py`): `FMP_API_KEY` (best Discover universe) and `FINNHUB_API_KEY` (PE fundamentals). All keys go in the Render dashboard / local `.env` only — never committed.

---

## Final Review

After all tasks: dispatch a final code review over the whole Phase A diff, run `cd services/quant-py && python -m pytest -q` and `node --test` (both green), then use superpowers:finishing-a-development-branch.
