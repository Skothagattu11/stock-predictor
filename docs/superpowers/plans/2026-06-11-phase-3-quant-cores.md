# Phase 3: Remaining Quant Cores (Outlook / Position / Portfolio) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes. Strict TDD: failing test → see it fail → implement → pass → commit (one commit per task).

**Goal:** Add the three remaining deterministic, LLM-free prediction cores to the sidecar — **Outlook** (weeks–months), **Position** (P/L-aware action), **Portfolio** (correlation/concentration) — each with a pydantic model and a `/predict/*` endpoint.

**Architecture:** Pure functions over inputs (daily candles + optional Phase-2 fundamentals for outlook; position params; holdings list). Reuse the Phase 1 `YahooMarketData` client (daily candles) and the Phase 2 fundamentals providers. All math is unit-tested on synthetic data; clients/inputs are injected.

**Tech Stack:** Python 3.13, FastAPI, pandas, numpy, pydantic, pytest (already present).

**Builds on:** Phase 1 (`YahooMarketData`, `Driver`, indicators) and Phase 2 (`Fundamentals`, providers).

---

## File structure

```
services/quant-py/app/
  models.py                      # MODIFY: add Scenario, OutlookPrediction, PositionPrediction,
                                 #         Holding, CorrelationPair, PortfolioAssessment
  predictors/
    outlook.py                   # NEW: score_outlook()
    position.py                  # NEW: assess_position()
    portfolio.py                 # NEW: assess_portfolio()
  api.py                         # MODIFY: add /predict/outlook, /predict/position, /predict/portfolio
services/quant-py/tests/
  test_outlook.py  test_position.py  test_portfolio.py  test_phase3_api.py   # NEW
```

---

## Task 1: Prediction models

**Files:** Modify `app/models.py`; Test `tests/test_phase3_models.py`

- [ ] **Step 1: Failing test** — `tests/test_phase3_models.py`

```python
from app.models import (Scenario, OutlookPrediction, PositionPrediction,
                        Holding, CorrelationPair, PortfolioAssessment, Driver)

def test_outlook_model():
    o = OutlookPrediction(symbol="AAPL", stance="Constructive", score=68.0, confidence=0.6,
        regime="risk_on", scenarios=[Scenario(case="base", probability=0.5,
        target_return_pct=0.04, target_price=208.0)], drivers=[Driver(name="12-1 momentum", direction="up")],
        as_of="2026-06-11T00:00:00Z")
    assert o.source == "quant" and o.horizon == "weeks_months"

def test_position_model():
    p = PositionPrediction(symbol="AAPL", action="HOLD", unrealized_pnl_pct=0.14,
        unrealized_pnl_abs=140.0, weight_pct=0.08, drivers=[], as_of="2026-06-11T00:00:00Z")
    assert p.action == "HOLD" and p.source == "quant"

def test_portfolio_model():
    pa = PortfolioAssessment(holdings=[Holding(symbol="AAPL", value=1000.0)],
        weights={"AAPL": 1.0}, concentration_hhi=1.0,
        correlations=[CorrelationPair(a="AAPL", b="MSFT", correlation=0.8)],
        flags=["single-name concentration"], as_of="2026-06-11T00:00:00Z")
    assert pa.concentration_hhi == 1.0
```

- [ ] **Step 2: Run → fail** (`.venv\Scripts\python -m pytest tests/test_phase3_models.py`)

- [ ] **Step 3: Append to `app/models.py`**

```python
class Scenario(BaseModel):
    case: Literal["bull", "base", "bear"]
    probability: float = Field(ge=0.0, le=1.0)
    target_return_pct: float
    target_price: float


class OutlookPrediction(BaseModel):
    symbol: str
    horizon: Literal["weeks_months"] = "weeks_months"
    stance: Literal["Constructive", "Neutral", "Cautious"]
    score: float = Field(ge=0.0, le=100.0)
    confidence: float = Field(ge=0.0, le=1.0)
    regime: str                       # 'risk_on' | 'risk_off'
    scenarios: list[Scenario]
    drivers: list[Driver]
    as_of: str
    source: Literal["quant"] = "quant"


class PositionPrediction(BaseModel):
    symbol: str
    action: Literal["HOLD", "TRIM", "ADD", "EXIT"]
    unrealized_pnl_pct: float
    unrealized_pnl_abs: float
    weight_pct: float | None = None
    drivers: list[Driver]
    as_of: str
    source: Literal["quant"] = "quant"


class Holding(BaseModel):
    symbol: str
    value: float
    returns: list[float] | None = None    # optional daily returns for correlation


class CorrelationPair(BaseModel):
    a: str
    b: str
    correlation: float


class PortfolioAssessment(BaseModel):
    holdings: list[Holding]
    weights: dict[str, float]
    concentration_hhi: float
    correlations: list[CorrelationPair]
    flags: list[str]
    as_of: str
    source: Literal["quant"] = "quant"
```

- [ ] **Step 4: Run → pass. Commit**
```
git checkout -b feat/phase-3-quant-cores
git add app/models.py tests/test_phase3_models.py
git commit -m "feat(predict): add outlook/position/portfolio models"
```

---

## Task 2: Position core (P/L-aware action)

**Files:** Create `app/predictors/position.py`; Test `tests/test_position.py`

- [ ] **Step 1: Failing tests** — `tests/test_position.py`

```python
from app.predictors.position import assess_position

def test_profit_and_overweight_trims():
    p = assess_position("AAPL", current_price=130.0, cost_basis=100.0, shares=100,
                        portfolio_value=50000.0)  # +30%, weight 26%
    assert p.action == "TRIM"
    assert round(p.unrealized_pnl_pct, 2) == 0.30
    assert p.unrealized_pnl_abs == 3000.0

def test_cautious_outlook_in_profit_exits():
    p = assess_position("AAPL", current_price=120.0, cost_basis=100.0, shares=10,
                        portfolio_value=100000.0, outlook_stance="Cautious")
    assert p.action == "EXIT"

def test_loss_with_constructive_outlook_adds():
    p = assess_position("AAPL", current_price=90.0, cost_basis=100.0, shares=10,
                        portfolio_value=100000.0, outlook_stance="Constructive")
    assert p.action == "ADD"
    assert p.unrealized_pnl_pct == -0.10

def test_default_hold():
    p = assess_position("AAPL", current_price=102.0, cost_basis=100.0, shares=10,
                        portfolio_value=100000.0)
    assert p.action == "HOLD"

def test_weight_none_when_no_portfolio_value():
    p = assess_position("AAPL", current_price=102.0, cost_basis=100.0, shares=10)
    assert p.weight_pct is None
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `app/predictors/position.py`**

```python
"""P/L-aware position action. Deterministic; no LLM, no I/O."""
from datetime import datetime, timezone
from app.models import PositionPrediction, Driver

OVERWEIGHT = 0.20          # >20% of portfolio is overweight
BIG_GAIN = 0.25            # +25% unrealized
STOP_LOSS = -0.15          # -15% unrealized


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def assess_position(symbol: str, current_price: float, cost_basis: float,
                    shares: float | None = None, portfolio_value: float | None = None,
                    intraday_bias: str | None = None,
                    outlook_stance: str | None = None) -> PositionPrediction:
    pnl_pct = (current_price - cost_basis) / cost_basis if cost_basis else 0.0
    pnl_abs = (current_price - cost_basis) * (shares if shares else 1.0)
    weight = None
    if shares and portfolio_value:
        weight = (current_price * shares) / portfolio_value

    drivers: list[Driver] = []
    action = "HOLD"

    if pnl_pct > 0:
        drivers.append(Driver(name=f"Up {pnl_pct*100:.0f}% vs entry", direction="up"))
    elif pnl_pct < 0:
        drivers.append(Driver(name=f"Down {abs(pnl_pct)*100:.0f}% vs entry", direction="down"))

    # decision precedence: protect on downside / trim risk, then add on conviction
    if outlook_stance == "Cautious" and pnl_pct > 0:
        action = "EXIT"
        drivers.append(Driver(name="Cautious outlook — take profit", direction="down"))
    elif pnl_pct <= STOP_LOSS and outlook_stance != "Constructive":
        action = "EXIT"
        drivers.append(Driver(name="Below stop, no constructive outlook", direction="down"))
    elif weight is not None and weight > OVERWEIGHT and pnl_pct > 0:
        action = "TRIM"
        drivers.append(Driver(name=f"Overweight ({weight*100:.0f}% of book)", direction="down"))
    elif pnl_pct >= BIG_GAIN:
        action = "TRIM"
        drivers.append(Driver(name="Large gain — lock some in", direction="down"))
    elif pnl_pct < 0 and outlook_stance == "Constructive":
        action = "ADD"
        drivers.append(Driver(name="Weakness + constructive outlook", direction="up"))
    elif intraday_bias == "Bearish" and pnl_pct > 0:
        action = "TRIM"
        drivers.append(Driver(name="Intraday bearish — reduce", direction="down"))

    return PositionPrediction(
        symbol=symbol, action=action, unrealized_pnl_pct=round(pnl_pct, 4),
        unrealized_pnl_abs=round(pnl_abs, 4),
        weight_pct=round(weight, 4) if weight is not None else None,
        drivers=drivers, as_of=_now_iso())
```

- [ ] **Step 4: Run → pass. Commit**
```
git add app/predictors/position.py tests/test_position.py
git commit -m "feat(predict): add P/L-aware position core (HOLD/TRIM/ADD/EXIT)"
```

---

## Task 3: Portfolio core (concentration + correlation)

**Files:** Create `app/predictors/portfolio.py`; Test `tests/test_portfolio.py`

- [ ] **Step 1: Failing tests** — `tests/test_portfolio.py`

```python
from app.models import Holding
from app.predictors.portfolio import assess_portfolio

def test_weights_and_hhi():
    pa = assess_portfolio([Holding(symbol="AAPL", value=6000.0),
                           Holding(symbol="MSFT", value=4000.0)])
    assert abs(pa.weights["AAPL"] - 0.6) < 1e-9
    assert abs(pa.concentration_hhi - (0.6**2 + 0.4**2)) < 1e-9

def test_single_name_concentration_flagged():
    pa = assess_portfolio([Holding(symbol="AAPL", value=9000.0),
                           Holding(symbol="MSFT", value=1000.0)])
    assert any("concentration" in f.lower() for f in pa.flags)

def test_high_correlation_pair_detected():
    up = [0.01, 0.02, -0.01, 0.03, 0.01]
    pa = assess_portfolio([
        Holding(symbol="AAPL", value=5000.0, returns=up),
        Holding(symbol="MSFT", value=5000.0, returns=up)])   # identical => corr 1.0
    pair = next(c for c in pa.correlations if {c.a, c.b} == {"AAPL", "MSFT"})
    assert pair.correlation > 0.95
    assert any("correlat" in f.lower() for f in pa.flags)

def test_no_returns_means_no_correlations():
    pa = assess_portfolio([Holding(symbol="AAPL", value=5000.0),
                           Holding(symbol="MSFT", value=5000.0)])
    assert pa.correlations == []
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `app/predictors/portfolio.py`**

```python
"""Portfolio concentration + correlation assessment. Deterministic."""
from datetime import datetime, timezone
from itertools import combinations
import numpy as np
from app.models import Holding, CorrelationPair, PortfolioAssessment

CONCENTRATION_WEIGHT = 0.35     # any single name above this is flagged
HIGH_CORRELATION = 0.80


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def assess_portfolio(holdings: list[Holding]) -> PortfolioAssessment:
    total = sum(h.value for h in holdings) or 1.0
    weights = {h.symbol: h.value / total for h in holdings}
    hhi = sum(w * w for w in weights.values())

    flags: list[str] = []
    top = max(weights, key=weights.get) if weights else None
    if top and weights[top] > CONCENTRATION_WEIGHT:
        flags.append(f"single-name concentration: {top} {weights[top]*100:.0f}%")

    correlations: list[CorrelationPair] = []
    series = {h.symbol: h.returns for h in holdings if h.returns}
    for a, b in combinations(series.keys(), 2):
        ra, rb = series[a], series[b]
        n = min(len(ra), len(rb))
        if n < 2:
            continue
        corr = float(np.corrcoef(ra[:n], rb[:n])[0, 1])
        if np.isnan(corr):
            continue
        correlations.append(CorrelationPair(a=a, b=b, correlation=round(corr, 4)))
        if corr > HIGH_CORRELATION:
            flags.append(f"high correlation: {a}/{b} {corr:.2f}")

    return PortfolioAssessment(
        holdings=holdings, weights={k: round(v, 4) for k, v in weights.items()},
        concentration_hhi=round(hhi, 4), correlations=correlations,
        flags=flags, as_of=_now_iso())
```

- [ ] **Step 4: Run → pass. Commit**
```
git add app/predictors/portfolio.py tests/test_portfolio.py
git commit -m "feat(predict): add portfolio concentration/correlation core"
```

---

## Task 4: Outlook core (weeks–months)

**Files:** Create `app/predictors/outlook.py`; Test `tests/test_outlook.py`

Inputs: a daily-candle DataFrame (columns timestamp, open, high, low, close, volume; ~252+ rows), an optional benchmark daily DataFrame (SPY), and optional Phase-2 `Fundamentals`. Logic: 200-day regime gate, 12-1 month momentum, relative strength vs benchmark, optional valuation tilt → 0–100 score → stance + base/bull/bear scenarios from realized volatility over a ~63-trading-day (3-month) horizon.

- [ ] **Step 1: Failing tests** — `tests/test_outlook.py`

```python
import numpy as np, pandas as pd
from app.predictors.outlook import score_outlook
from app.context.models import Fundamentals

def _daily(close):
    close = np.asarray(close, dtype=float); n = len(close)
    ts = 1_700_000_000 + np.arange(n) * 86400
    return pd.DataFrame({"timestamp": ts, "open": close, "high": close + 1,
                         "low": close - 1, "close": close, "volume": np.full(n, 1e6)})

def test_strong_uptrend_is_constructive():
    df = _daily(np.linspace(100, 200, 300))   # above rising 200d, strong 12-1 momentum
    o = score_outlook("AAPL", df)
    assert o.stance == "Constructive"
    assert o.regime == "risk_on"
    assert o.score > 60
    assert {s.case for s in o.scenarios} == {"bull", "base", "bear"}
    assert abs(sum(s.probability for s in o.scenarios) - 1.0) < 1e-6

def test_downtrend_is_cautious_risk_off():
    df = _daily(np.linspace(200, 100, 300))
    o = score_outlook("AAPL", df)
    assert o.stance == "Cautious"
    assert o.regime == "risk_off"

def test_relative_strength_vs_benchmark_lifts_score():
    sym = _daily(np.linspace(100, 160, 300))
    weak_bench = _daily(np.linspace(100, 105, 300))
    strong_bench = _daily(np.linspace(100, 200, 300))
    s_weak = score_outlook("AAPL", sym, benchmark_df=weak_bench).score
    s_strong = score_outlook("AAPL", sym, benchmark_df=strong_bench).score
    assert s_weak > s_strong   # outperforming a weak benchmark scores higher

def test_scenarios_bracket_base_and_use_volatility():
    df = _daily(np.linspace(100, 130, 300))
    o = score_outlook("AAPL", df)
    base = next(s for s in o.scenarios if s.case == "base")
    bull = next(s for s in o.scenarios if s.case == "bull")
    bear = next(s for s in o.scenarios if s.case == "bear")
    assert bear.target_price < base.target_price < bull.target_price

def test_insufficient_history_raises():
    import pytest
    with pytest.raises(ValueError):
        score_outlook("AAPL", _daily(np.linspace(100, 110, 50)))   # <220 bars
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Create `app/predictors/outlook.py`**

```python
"""Weeks-to-months outlook: regime gate + 12-1 momentum + relative strength +
optional valuation tilt -> 0-100 score, stance, and bull/base/bear scenarios.
Deterministic; no LLM, no I/O."""
import math
from datetime import datetime, timezone
import numpy as np
import pandas as pd
from app.models import OutlookPrediction, Scenario, Driver
from app.context.models import Fundamentals

MIN_BARS = 220
HORIZON_DAYS = 63          # ~3 trading months
MOM_LOOKBACK = 252         # 12 months
MOM_SKIP = 21              # exclude most recent month (12-1 momentum)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _period_return(close: pd.Series, lookback: int, skip: int) -> float:
    if len(close) < lookback + 1:
        lookback = len(close) - 1
    start = close.iloc[-(lookback + 1)]
    end = close.iloc[-(skip + 1)] if skip < len(close) else close.iloc[-1]
    return (end - start) / start if start else 0.0


def score_outlook(symbol: str, daily_df: pd.DataFrame,
                  benchmark_df: pd.DataFrame | None = None,
                  fundamentals: Fundamentals | None = None) -> OutlookPrediction:
    close = daily_df["close"].reset_index(drop=True)
    if len(close) < MIN_BARS:
        raise ValueError(f"need >= {MIN_BARS} daily bars, got {len(close)}")

    price = float(close.iloc[-1])
    sma200 = float(close.rolling(200).mean().iloc[-1])
    sma200_prev = float(close.rolling(200).mean().iloc[-21])
    rising = sma200 >= sma200_prev
    risk_on = price > sma200 and rising
    regime = "risk_on" if risk_on else "risk_off"

    mom = _period_return(close, MOM_LOOKBACK, MOM_SKIP)

    drivers: list[Driver] = []
    score = 50.0

    # regime gate (multiplicative-ish, expressed additively for transparency)
    if risk_on:
        score += 12; drivers.append(Driver(name="Above rising 200-day", direction="up"))
    else:
        score -= 12; drivers.append(Driver(name="Below/!rising 200-day", direction="down"))

    # 12-1 momentum
    score += float(np.clip(mom * 60, -22, 22))
    drivers.append(Driver(name="12-1 momentum", direction="up" if mom > 0 else "down"))

    # relative strength vs benchmark
    if benchmark_df is not None and len(benchmark_df) >= MIN_BARS:
        bench_mom = _period_return(benchmark_df["close"].reset_index(drop=True), MOM_LOOKBACK, MOM_SKIP)
        rel = mom - bench_mom
        score += float(np.clip(rel * 50, -12, 12))
        drivers.append(Driver(name="Relative strength vs benchmark", direction="up" if rel > 0 else "down"))

    # optional valuation tilt (cheap PE = small positive; rich = small negative)
    if fundamentals is not None and fundamentals.pe is not None and fundamentals.pe > 0:
        tilt = float(np.clip((25.0 - fundamentals.pe) / 25.0, -1, 1)) * 6.0
        score += tilt
        drivers.append(Driver(name="Valuation vs ~25x", direction="up" if tilt > 0 else "down"))

    score = float(np.clip(score, 0.0, 100.0))
    if score >= 60:
        stance = "Constructive"
    elif score <= 40:
        stance = "Cautious"
    else:
        stance = "Neutral"
    confidence = round(abs(score - 50) / 50.0, 3)

    # scenarios from realized volatility over the horizon
    rets = close.pct_change().dropna()
    daily_vol = float(rets.tail(MOM_LOOKBACK).std()) if len(rets) else 0.02
    horizon_vol = daily_vol * math.sqrt(HORIZON_DAYS)
    drift = (score - 50) / 50.0 * horizon_vol     # tilt the base case by conviction
    base_ret, bull_ret, bear_ret = drift, drift + horizon_vol, drift - horizon_vol
    # probabilities skewed by conviction
    skew = (score - 50) / 50.0 * 0.15
    p_bull = round(0.25 + skew, 4); p_bear = round(0.25 - skew, 4)
    p_base = round(1.0 - p_bull - p_bear, 4)

    def _sc(case, r, p):
        return Scenario(case=case, probability=p, target_return_pct=round(r, 4),
                        target_price=round(price * (1 + r), 4))

    scenarios = [_sc("bull", bull_ret, p_bull), _sc("base", base_ret, p_base), _sc("bear", bear_ret, p_bear)]

    return OutlookPrediction(symbol=symbol, stance=stance, score=round(score, 2),
        confidence=confidence, regime=regime, scenarios=scenarios,
        drivers=drivers, as_of=_now_iso())
```

- [ ] **Step 4: Run → pass. Commit**
```
git add app/predictors/outlook.py tests/test_outlook.py
git commit -m "feat(predict): add weeks-months outlook core (regime+momentum+rel-strength)"
```

---

## Task 5: Endpoints `/predict/{outlook,position,portfolio}`

**Files:** Modify `app/api.py`; Test `tests/test_phase3_api.py`

- [ ] **Step 1: Failing tests** — `tests/test_phase3_api.py`

```python
import numpy as np, pandas as pd
from fastapi.testclient import TestClient
from app.api import app, get_market_data
from app.models import Holding

client = TestClient(app)

class _FakeMD:
    def __init__(self, df): self._df = df
    def fetch_candles(self, symbol, interval, range_): return self._df

def _daily(close):
    close = np.asarray(close, float); n = len(close)
    return pd.DataFrame({"timestamp": 1_700_000_000 + np.arange(n)*86400,
        "open": close, "high": close+1, "low": close-1, "close": close, "volume": np.full(n,1e6)})

def test_outlook_endpoint():
    app.dependency_overrides[get_market_data] = lambda: _FakeMD(_daily(np.linspace(100,180,300)))
    try:
        r = client.get("/predict/outlook/AAPL")
        assert r.status_code == 200
        assert r.json()["stance"] in ("Constructive","Neutral","Cautious")
        assert r.json()["source"] == "quant"
    finally:
        app.dependency_overrides.clear()

def test_position_endpoint():
    r = client.get("/predict/position/AAPL",
                   params={"current_price":130,"cost_basis":100,"shares":100,"portfolio_value":50000})
    assert r.status_code == 200
    body = r.json()
    assert body["action"] in ("HOLD","TRIM","ADD","EXIT")
    assert round(body["unrealized_pnl_pct"],2) == 0.30

def test_portfolio_endpoint():
    r = client.post("/predict/portfolio", json={"holdings":[
        {"symbol":"AAPL","value":9000},{"symbol":"MSFT","value":1000}]})
    assert r.status_code == 200
    assert any("concentration" in f.lower() for f in r.json()["flags"])
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Extend `app/api.py`** (append; reuse existing `get_market_data`)

```python
from pydantic import BaseModel
from app.models import OutlookPrediction, PositionPrediction, PortfolioAssessment, Holding
from app.predictors.outlook import score_outlook
from app.predictors.position import assess_position
from app.predictors.portfolio import assess_portfolio


@app.get("/predict/outlook/{symbol}", response_model=OutlookPrediction)
def predict_outlook(symbol: str, benchmark: str = "SPY",
                    md: MarketData = Depends(get_market_data)):
    symbol = symbol.upper()
    df = md.fetch_candles(symbol, interval="1d", range_="2y")
    if df.empty or len(df) < 220:
        raise HTTPException(status_code=422, detail="insufficient daily history for outlook")
    bench_df = None
    try:
        bench_df = md.fetch_candles(benchmark.upper(), interval="1d", range_="2y")
    except Exception:
        bench_df = None
    return score_outlook(symbol, df, benchmark_df=bench_df)


@app.get("/predict/position/{symbol}", response_model=PositionPrediction)
def predict_position(symbol: str, current_price: float, cost_basis: float,
                     shares: float | None = None, portfolio_value: float | None = None,
                     intraday_bias: str | None = None, outlook_stance: str | None = None):
    return assess_position(symbol.upper(), current_price=current_price, cost_basis=cost_basis,
                           shares=shares, portfolio_value=portfolio_value,
                           intraday_bias=intraday_bias, outlook_stance=outlook_stance)


class PortfolioRequest(BaseModel):
    holdings: list[Holding]


@app.post("/predict/portfolio", response_model=PortfolioAssessment)
def predict_portfolio(req: PortfolioRequest):
    if not req.holdings:
        raise HTTPException(status_code=422, detail="no holdings provided")
    return assess_portfolio(req.holdings)
```

- [ ] **Step 4: Run the FULL suite → all green. Commit**
```
git add app/api.py tests/test_phase3_api.py
git commit -m "feat(predict): expose outlook/position/portfolio endpoints"
```

---

## Acceptance criteria
- [ ] `.venv\Scripts\python -m pytest -q` green across all phases.
- [ ] Outlook: uptrend→Constructive/risk_on, downtrend→Cautious/risk_off, scenarios bracket base and probabilities sum to 1.
- [ ] Position: +30%/overweight→TRIM, Cautious+profit→EXIT, loss+Constructive→ADD, else HOLD; weight None without portfolio_value.
- [ ] Portfolio: weights+HHI correct, single-name concentration & high-correlation flagged.
- [ ] Endpoints return validated `source=="quant"` bodies; outlook 422s on thin history.
- [ ] Branch `feat/phase-3-quant-cores` ready to merge; no secrets staged.

## Self-review notes
- **Spec coverage:** completes spec §"four quant cores → B/C/D". Outlook uses the research-backed signals (200-day regime gate, 12-1 momentum, relative strength, valuation tilt); position is P/L-aware; portfolio does concentration + correlation.
- **Type consistency:** new models in `app/models.py` reuse `Driver`; cores return exactly those models; endpoints mirror them. `score_outlook(symbol, daily_df, benchmark_df, fundamentals)`, `assess_position(...)`, `assess_portfolio(holdings)` signatures match across core/endpoint/tests.
- **Determinism:** all cores are pure over injected inputs; tests use synthetic frames; no live network.
- **No placeholders:** every step has complete code, tests, commands, commit messages.
