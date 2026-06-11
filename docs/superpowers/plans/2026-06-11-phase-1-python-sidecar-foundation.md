# Phase 1: Python Sidecar Foundation + Intraday Quant Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Python FastAPI quant sidecar and ship one end-to-end vertical slice — Yahoo candles → pandas-ta indicators → regime classifier → intraday quant core → `/predict/intraday/{symbol}` returning a calibrated, **LLM-free** prediction.

**Architecture:** A standalone FastAPI service in `services/quant-py/`. Pure-function indicators and a deterministic scoring core, all unit-tested on synthetic data with no network. The market-data client is injected so the endpoint is testable with fixtures. This service is the foundation every later phase builds on.

**Tech Stack:** Python 3.11, FastAPI, uvicorn, pandas, pandas-ta, numpy (<2 — pandas-ta requirement), httpx, pydantic v2, pytest.

---

## File structure (this phase)

```
services/quant-py/
  pyproject.toml                  # deps + pytest config
  README.md                       # run + deploy notes
  Dockerfile                      # Render deploy
  app/
    __init__.py
    models.py                     # pydantic response schemas
    indicators.py                 # pure indicator functions (pandas-ta + manual VWAP)
    regime.py                     # regime classifier
    data/
      __init__.py
      base.py                     # MarketData protocol
      yahoo.py                    # Yahoo chart-API client (httpx, injectable)
    predictors/
      __init__.py
      intraday.py                 # score_intraday() core
    api.py                        # FastAPI app + dependency wiring
  tests/
    conftest.py                   # synthetic-data fixtures
    test_indicators.py
    test_regime.py
    test_yahoo_client.py
    test_intraday.py
    test_api.py
    fixtures/yahoo_aapl_5m.json    # canned Yahoo response
```

---

## Task 1: Scaffold the service + health endpoint

**Files:**
- Create: `services/quant-py/pyproject.toml`
- Create: `services/quant-py/app/__init__.py` (empty)
- Create: `services/quant-py/app/api.py`
- Create: `services/quant-py/tests/__init__.py` (empty)
- Test: `services/quant-py/tests/test_api.py`

- [ ] **Step 1: Create `pyproject.toml`**

```toml
[project]
name = "quant-py"
version = "0.1.0"
description = "Quant/ML sidecar for the prediction dashboard"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.111",
  "uvicorn[standard]>=0.30",
  "pandas>=2.0,<2.2",
  "numpy>=1.23,<2.0",
  "pandas-ta==0.3.14b0",
  "httpx>=0.27",
  "pydantic>=2.6",
]

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-q"
```

- [ ] **Step 2: Create the virtualenv and install**

Run (from `services/quant-py/`):
```
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
```
Expected: install completes; `pandas_ta` imports without error (numpy pinned <2 avoids the `from numpy import NaN` break).

- [ ] **Step 3: Write the failing test** — `tests/test_api.py`

```python
from fastapi.testclient import TestClient
from app.api import app

client = TestClient(app)

def test_health_ok():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "quant-py"}
```

- [ ] **Step 4: Run it, verify it fails**

Run: `.venv\Scripts\python -m pytest tests/test_api.py::test_health_ok`
Expected: FAIL — `ModuleNotFoundError: app.api` (not created yet).

- [ ] **Step 5: Create `app/api.py`**

```python
from fastapi import FastAPI

app = FastAPI(title="quant-py", version="0.1.0")

@app.get("/health")
def health():
    return {"status": "ok", "service": "quant-py"}
```

- [ ] **Step 6: Run it, verify it passes**

Run: `.venv\Scripts\python -m pytest tests/test_api.py::test_health_ok`
Expected: PASS.

- [ ] **Step 7: Commit**

```
git checkout -b feat/phase-1-sidecar
git add services/quant-py/pyproject.toml services/quant-py/app/__init__.py services/quant-py/app/api.py services/quant-py/tests/__init__.py services/quant-py/tests/test_api.py
git commit -m "feat(sidecar): scaffold FastAPI quant-py service with health endpoint"
```

---

## Task 2: Indicator functions

**Files:**
- Create: `services/quant-py/app/indicators.py`
- Test: `services/quant-py/tests/test_indicators.py`

- [ ] **Step 1: Write the failing tests** — `tests/test_indicators.py`

```python
import numpy as np
import pandas as pd
from app import indicators as ind

def test_ema_of_constant_series_is_the_constant():
    s = pd.Series([10.0] * 30)
    assert abs(ind.ema(s, 9).iloc[-1] - 10.0) < 1e-6

def test_rsi_of_strictly_increasing_series_approaches_100():
    s = pd.Series(np.arange(1, 31, dtype=float))
    assert ind.rsi(s, 14).iloc[-1] > 99.0

def test_atr_is_positive_and_finite():
    n = 30
    high = pd.Series(np.full(n, 11.0))
    low = pd.Series(np.full(n, 9.0))
    close = pd.Series(np.full(n, 10.0))
    val = ind.atr(high, low, close, 14).iloc[-1]
    assert np.isfinite(val) and val > 0

def test_session_vwap_of_constant_price_equals_price():
    df = pd.DataFrame({"high":[10.0]*5,"low":[10.0]*5,"close":[10.0]*5,"volume":[100.0]*5})
    assert abs(ind.session_vwap(df).iloc[-1] - 10.0) < 1e-9

def test_session_vwap_within_price_range():
    df = pd.DataFrame({
        "high":[11,12,13,12,11], "low":[9,10,11,10,9],
        "close":[10,11,12,11,10], "volume":[100,200,150,120,180]})
    v = ind.session_vwap(df).iloc[-1]
    assert df["low"].min() <= v <= df["high"].max()

def test_relative_volume_ratio():
    vol = pd.Series([100.0]*5 + [300.0])   # 5 prior bars avg 100, last 300
    assert abs(ind.relative_volume(vol, lookback=5) - 3.0) < 1e-9
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_indicators.py`
Expected: FAIL — `ModuleNotFoundError: app.indicators`.

- [ ] **Step 3: Create `app/indicators.py`**

```python
"""Pure indicator functions. No I/O, no globals — fully unit-testable."""
import pandas as pd
import pandas_ta as ta


def ema(close: pd.Series, length: int) -> pd.Series:
    return ta.ema(close, length=length)


def rsi(close: pd.Series, length: int = 14) -> pd.Series:
    return ta.rsi(close, length=length)


def atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int = 14) -> pd.Series:
    return ta.atr(high=high, low=low, close=close, length=length)


def session_vwap(df: pd.DataFrame) -> pd.Series:
    """Cumulative VWAP across the supplied (single-session) bars.
    Expects columns high, low, close, volume. Skips zero-volume division."""
    typical = (df["high"] + df["low"] + df["close"]) / 3.0
    cum_vol = df["volume"].cumsum()
    cum_pv = (typical * df["volume"]).cumsum()
    return cum_pv / cum_vol.where(cum_vol > 0)


def relative_volume(volume: pd.Series, lookback: int = 20) -> float:
    """Last bar volume vs the average of the `lookback` bars before it."""
    if len(volume) < lookback + 1:
        return float("nan")
    prior_avg = volume.iloc[-(lookback + 1):-1].mean()
    return float(volume.iloc[-1] / prior_avg) if prior_avg > 0 else float("nan")
```

- [ ] **Step 4: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_indicators.py`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```
git add services/quant-py/app/indicators.py services/quant-py/tests/test_indicators.py
git commit -m "feat(sidecar): add pure indicator functions (ema/rsi/atr/vwap/relvol)"
```

---

## Task 3: Regime classifier

**Files:**
- Create: `services/quant-py/app/regime.py`
- Test: `services/quant-py/tests/test_regime.py`

- [ ] **Step 1: Write the failing tests** — `tests/test_regime.py`

```python
import numpy as np
import pandas as pd
from app import indicators as ind
from app.regime import classify_regime

def _frame(close):
    close = pd.Series(close, dtype=float)
    high = close + 0.5
    low = close - 0.5
    vol = pd.Series(np.full(len(close), 100.0))
    return pd.DataFrame({"high": high, "low": low, "close": close, "volume": vol})

def test_strong_uptrend_classified_trend_up():
    df = _frame(np.linspace(100, 120, 40))
    r = classify_regime(df)
    assert r.label == "trend_up"
    assert 0.0 <= r.confidence <= 1.0

def test_strong_downtrend_classified_trend_down():
    df = _frame(np.linspace(120, 100, 40))
    assert classify_regime(df).label == "trend_down"

def test_flat_series_classified_range():
    df = _frame(np.full(40, 100.0))
    assert classify_regime(df).label == "range"

def test_large_atr_classified_high_vol():
    close = np.full(40, 100.0)
    df = pd.DataFrame({
        "high": close + 5.0, "low": close - 5.0,   # ~10% ATR
        "close": close, "volume": np.full(40, 100.0)})
    assert classify_regime(df).label == "high_vol"
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_regime.py`
Expected: FAIL — `ModuleNotFoundError: app.regime`.

- [ ] **Step 3: Create `app/regime.py`**

```python
"""Regime classifier — gates which intraday signals are trusted."""
from dataclasses import dataclass
import pandas as pd
from app import indicators as ind

HIGH_VOL_ATR_PCT = 0.03   # ATR > 3% of price => volatility regime
TREND_EPS = 1e-3          # min normalized EMA spread to call a trend


@dataclass
class Regime:
    label: str          # 'trend_up' | 'trend_down' | 'range' | 'high_vol'
    confidence: float   # 0..1


def classify_regime(df: pd.DataFrame) -> Regime:
    close = df["close"]
    price = float(close.iloc[-1])
    atr_now = float(ind.atr(df["high"], df["low"], close, 14).iloc[-1])
    atr_pct = atr_now / price if price else 0.0

    if atr_pct > HIGH_VOL_ATR_PCT:
        conf = min(1.0, atr_pct / (HIGH_VOL_ATR_PCT * 2))
        return Regime("high_vol", round(conf, 3))

    ema_fast = float(ind.ema(close, 9).iloc[-1])
    ema_slow = float(ind.ema(close, 20).iloc[-1])
    spread = (ema_fast - ema_slow) / price if price else 0.0
    conf = min(1.0, abs(spread) / 0.01)   # 1% spread => full confidence

    if spread > TREND_EPS:
        return Regime("trend_up", round(conf, 3))
    if spread < -TREND_EPS:
        return Regime("trend_down", round(conf, 3))
    return Regime("range", round(1.0 - conf, 3))
```

- [ ] **Step 4: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_regime.py`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```
git add services/quant-py/app/regime.py services/quant-py/tests/test_regime.py
git commit -m "feat(sidecar): add regime classifier (trend/range/high-vol)"
```

---

## Task 4: Response schemas

**Files:**
- Create: `services/quant-py/app/models.py`
- Test: covered indirectly by Task 5/6; add a direct schema test.
- Test: `services/quant-py/tests/test_models.py`

- [ ] **Step 1: Write the failing test** — `tests/test_models.py`

```python
from app.models import IntradayPrediction, ExpectedMove, Driver

def test_intraday_prediction_validates():
    p = IntradayPrediction(
        symbol="AAPL", bias="Bullish", probability_up=0.61,
        expected_move=ExpectedMove(low=99.0, base=100.0, high=101.0),
        regime="trend_up", regime_confidence=0.7, invalidation=98.5,
        drivers=[Driver(name="VWAP", direction="up")],
        as_of="2026-06-11T15:30:00Z")
    assert p.source == "quant"
    assert p.bias == "Bullish"

def test_probability_must_be_within_unit_interval():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        IntradayPrediction(
            symbol="AAPL", bias="Bullish", probability_up=1.5,
            expected_move=ExpectedMove(low=1, base=2, high=3),
            regime="range", regime_confidence=0.1, invalidation=1.0,
            drivers=[], as_of="2026-06-11T15:30:00Z")
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_models.py`
Expected: FAIL — `ModuleNotFoundError: app.models`.

- [ ] **Step 3: Create `app/models.py`**

```python
from typing import Literal
from pydantic import BaseModel, Field


class Driver(BaseModel):
    name: str
    direction: Literal["up", "down", "neutral"]


class ExpectedMove(BaseModel):
    low: float
    base: float
    high: float
    unit: Literal["price"] = "price"


class IntradayPrediction(BaseModel):
    symbol: str
    bias: Literal["Bullish", "Neutral", "Bearish"]
    probability_up: float = Field(ge=0.0, le=1.0)
    expected_move: ExpectedMove
    regime: str
    regime_confidence: float = Field(ge=0.0, le=1.0)
    invalidation: float
    drivers: list[Driver]
    as_of: str                       # ISO ts taken from the data, never wall-clock
    source: Literal["quant"] = "quant"
    horizon: Literal["intraday"] = "intraday"
```

- [ ] **Step 4: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_models.py`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```
git add services/quant-py/app/models.py services/quant-py/tests/test_models.py
git commit -m "feat(sidecar): add pydantic prediction schemas"
```

---

## Task 5: Intraday quant core

**Files:**
- Create: `services/quant-py/app/predictors/__init__.py` (empty)
- Create: `services/quant-py/app/predictors/intraday.py`
- Create: `services/quant-py/tests/conftest.py`
- Test: `services/quant-py/tests/test_intraday.py`

- [ ] **Step 1: Add synthetic-candle fixtures** — `tests/conftest.py`

```python
import numpy as np
import pandas as pd
import pytest

BASE_TS = 1_749_652_200   # fixed epoch seconds — deterministic, no wall-clock

def _candles(close, vol):
    close = np.asarray(close, dtype=float)
    n = len(close)
    ts = BASE_TS + np.arange(n) * 300   # 5-min bars
    return pd.DataFrame({
        "timestamp": ts,
        "open": close,
        "high": close + 0.3,
        "low": close - 0.3,
        "close": close,
        "volume": np.asarray(vol, dtype=float),
    })

@pytest.fixture
def bullish_df():
    # rising, with a breakout and rising volume in the last third
    close = np.linspace(100, 106, 40)
    vol = np.concatenate([np.full(27, 100.0), np.full(13, 400.0)])
    return _candles(close, vol)

@pytest.fixture
def bearish_df():
    close = np.linspace(106, 100, 40)
    vol = np.concatenate([np.full(27, 100.0), np.full(13, 400.0)])
    return _candles(close, vol)

@pytest.fixture
def flat_df():
    close = np.full(40, 100.0)
    return _candles(close, np.full(40, 100.0))
```

- [ ] **Step 2: Write the failing tests** — `tests/test_intraday.py`

```python
from app.predictors.intraday import score_intraday

def test_bullish_series_scores_bullish(bullish_df):
    p = score_intraday("AAPL", bullish_df, interval_minutes=5)
    assert p.bias == "Bullish"
    assert p.probability_up > 0.5
    assert p.invalidation < p.expected_move.base          # stop sits below price
    assert any(d.direction == "up" for d in p.drivers)
    assert p.as_of.endswith("Z")                          # ISO from last candle ts

def test_bearish_series_scores_bearish(bearish_df):
    p = score_intraday("AAPL", bearish_df, interval_minutes=5)
    assert p.bias == "Bearish"
    assert p.probability_up < 0.5
    assert p.invalidation > p.expected_move.base          # stop sits above price

def test_flat_series_is_neutral(flat_df):
    p = score_intraday("AAPL", flat_df, interval_minutes=5)
    assert p.bias == "Neutral"
    assert 0.4 <= p.probability_up <= 0.6

def test_expected_move_widens_in_high_vol():
    import numpy as np, pandas as pd
    from tests.conftest import BASE_TS
    close = np.full(40, 100.0)
    n = len(close)
    df = pd.DataFrame({
        "timestamp": BASE_TS + np.arange(n) * 300,
        "open": close, "high": close + 5.0, "low": close - 5.0,
        "close": close, "volume": np.full(n, 100.0)})
    p = score_intraday("AAPL", df, interval_minutes=5)
    assert p.regime == "high_vol"
    assert (p.expected_move.high - p.expected_move.low) > 10.0   # ~1.5x ATR each side
```

- [ ] **Step 3: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_intraday.py`
Expected: FAIL — `ModuleNotFoundError: app.predictors.intraday`.

- [ ] **Step 4: Create `app/predictors/intraday.py`**

```python
"""Intraday quant core: regime-gated confluence on session bars.

Deterministic and LLM-free. Input df columns:
timestamp (epoch s), open, high, low, close, volume — ascending by time.
"""
import math
from datetime import datetime, timezone
import pandas as pd

from app import indicators as ind
from app.regime import classify_regime
from app.models import IntradayPrediction, ExpectedMove, Driver

OPENING_RANGE_MINUTES = 15
MOMENTUM_WINDOW_MINUTES = 30
RELVOL_BREAKOUT_MIN = 1.3
BULLISH_PROB = 0.58
BEARISH_PROB = 0.42

# signal weights (centered at 0; positive => bullish)
W_VWAP, W_EMA, W_RSI, W_ORB, W_MOM = 1.4, 1.0, 0.6, 1.2, 0.8


def _logistic(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _bars(minutes: int, interval_minutes: int) -> int:
    return max(1, math.ceil(minutes / interval_minutes))


def score_intraday(symbol: str, df: pd.DataFrame, interval_minutes: int = 5) -> IntradayPrediction:
    close = df["close"]
    price = float(close.iloc[-1])
    atr_now = float(ind.atr(df["high"], df["low"], close, 14).iloc[-1])
    vwap = float(ind.session_vwap(df).iloc[-1])
    ema_fast = float(ind.ema(close, 9).iloc[-1])
    ema_slow = float(ind.ema(close, 20).iloc[-1])
    rsi_now = float(ind.rsi(close, 14).iloc[-1])
    relvol = ind.relative_volume(df["volume"], lookback=20)
    regime = classify_regime(df)

    orb_n = _bars(OPENING_RANGE_MINUTES, interval_minutes)
    or_high = float(df["high"].iloc[:orb_n].max())
    or_low = float(df["low"].iloc[:orb_n].min())

    mom_n = _bars(MOMENTUM_WINDOW_MINUTES, interval_minutes)
    first_close = float(close.iloc[min(mom_n, len(close)) - 1])
    open_px = float(df["open"].iloc[0])
    first_mom = (first_close - open_px) / open_px if open_px else 0.0

    score = 0.0
    drivers: list[tuple[str, str, float]] = []   # (name, dir, signed_contribution)

    s = W_VWAP if price > vwap else -W_VWAP
    score += s; drivers.append(("VWAP", "up" if s > 0 else "down", s))

    s = W_EMA if ema_fast > ema_slow else -W_EMA
    score += s; drivers.append(("EMA 9/20", "up" if s > 0 else "down", s))

    if rsi_now >= 55:
        score += W_RSI; drivers.append(("RSI", "up", W_RSI))
    elif rsi_now <= 45:
        score -= W_RSI; drivers.append(("RSI", "down", -W_RSI))

    has_vol = (relvol == relvol) and relvol >= RELVOL_BREAKOUT_MIN   # NaN-safe
    if price > or_high and has_vol:
        score += W_ORB; drivers.append(("ORB breakout", "up", W_ORB))
    elif price < or_low and has_vol:
        score -= W_ORB; drivers.append(("ORB breakdown", "down", -W_ORB))

    mom_dir = W_MOM if first_mom > 0 else -W_MOM
    # range regime dampens momentum-style signals
    if regime.label == "range":
        mom_dir *= 0.4
    score += mom_dir; drivers.append(("Opening momentum", "up" if mom_dir > 0 else "down", mom_dir))

    probability_up = _logistic(score)
    if probability_up >= BULLISH_PROB:
        bias = "Bullish"
    elif probability_up <= BEARISH_PROB:
        bias = "Bearish"
    else:
        bias = "Neutral"

    k = 1.5 if regime.label == "high_vol" else 1.0
    move = k * atr_now
    expected_move = ExpectedMove(low=price - move, base=price, high=price + move)

    if bias == "Bullish":
        invalidation = or_low if or_low < price else price - move
        want = "up"
    elif bias == "Bearish":
        invalidation = or_high if or_high > price else price + move
        want = "down"
    else:
        invalidation = vwap
        want = None

    # only surface drivers that agree with the final bias (no contradictions)
    shown = [Driver(name=n, direction=d) for (n, d, c) in drivers
             if want is None or d == want]
    if want is None:
        shown = [Driver(name=n, direction=d) for (n, d, c) in drivers][:3]

    last_ts = int(df["timestamp"].iloc[-1])
    as_of = datetime.fromtimestamp(last_ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return IntradayPrediction(
        symbol=symbol, bias=bias, probability_up=round(probability_up, 4),
        expected_move=expected_move, regime=regime.label,
        regime_confidence=regime.confidence, invalidation=round(invalidation, 4),
        drivers=shown, as_of=as_of)
```

- [ ] **Step 5: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_intraday.py`
Expected: PASS (4 passed).

- [ ] **Step 6: Commit**

```
git add services/quant-py/app/predictors/__init__.py services/quant-py/app/predictors/intraday.py services/quant-py/tests/conftest.py services/quant-py/tests/test_intraday.py
git commit -m "feat(sidecar): add regime-gated intraday quant core"
```

---

## Task 6: Yahoo market-data client (injectable)

**Files:**
- Create: `services/quant-py/app/data/__init__.py` (empty)
- Create: `services/quant-py/app/data/base.py`
- Create: `services/quant-py/app/data/yahoo.py`
- Create: `services/quant-py/tests/fixtures/yahoo_aapl_5m.json`
- Test: `services/quant-py/tests/test_yahoo_client.py`

- [ ] **Step 1: Create the fixture** — `tests/fixtures/yahoo_aapl_5m.json`

```json
{
  "chart": {
    "result": [
      {
        "meta": {"symbol": "AAPL"},
        "timestamp": [1749652200, 1749652500, 1749652800],
        "indicators": {
          "quote": [
            {
              "open":  [100.0, 100.5, 101.0],
              "high":  [100.6, 101.1, 101.6],
              "low":   [99.5, 100.1, 100.7],
              "close": [100.5, 101.0, 101.4],
              "volume":[1000, 1200, 900]
            }
          ]
        }
      }
    ],
    "error": null
  }
}
```

- [ ] **Step 2: Write the failing test** — `tests/test_yahoo_client.py`

```python
import json
from pathlib import Path
import httpx
from app.data.yahoo import YahooMarketData

FIXTURE = Path(__file__).parent / "fixtures" / "yahoo_aapl_5m.json"

def _client_returning_fixture():
    payload = json.loads(FIXTURE.read_text())
    def handler(request):
        return httpx.Response(200, json=payload)
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_fetch_candles_parses_into_dataframe():
    md = YahooMarketData(http=_client_returning_fixture())
    df = md.fetch_candles("AAPL", interval="5m", range_="1d")
    assert list(df.columns) == ["timestamp", "open", "high", "low", "close", "volume"]
    assert len(df) == 3
    assert df["close"].iloc[-1] == 101.4
    assert df["timestamp"].iloc[0] == 1749652200

def test_fetch_candles_drops_null_rows():
    payload = json.loads(FIXTURE.read_text())
    payload["chart"]["result"][0]["indicators"]["quote"][0]["close"][1] = None
    def handler(request): return httpx.Response(200, json=payload)
    md = YahooMarketData(http=httpx.Client(transport=httpx.MockTransport(handler)))
    df = md.fetch_candles("AAPL", interval="5m", range_="1d")
    assert len(df) == 2   # the null-close row is dropped
```

- [ ] **Step 3: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_yahoo_client.py`
Expected: FAIL — `ModuleNotFoundError: app.data.yahoo`.

- [ ] **Step 4: Create `app/data/base.py`**

```python
from typing import Protocol
import pandas as pd


class MarketData(Protocol):
    def fetch_candles(self, symbol: str, interval: str, range_: str) -> pd.DataFrame:
        """Return columns: timestamp, open, high, low, close, volume (ascending)."""
        ...
```

- [ ] **Step 5: Create `app/data/yahoo.py`**

```python
import httpx
import pandas as pd

BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart"


class YahooMarketData:
    def __init__(self, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._http = http or httpx.Client(timeout=10.0, headers={"User-Agent": "quant-py/0.1"})
        self._base = base_url

    def fetch_candles(self, symbol: str, interval: str = "5m", range_: str = "1d") -> pd.DataFrame:
        url = f"{self._base}/{symbol}"
        params = {"interval": interval, "range": range_, "includePrePost": "false"}
        resp = self._http.get(url, params=params)
        resp.raise_for_status()
        result = resp.json()["chart"]["result"][0]
        ts = result["timestamp"]
        q = result["indicators"]["quote"][0]
        df = pd.DataFrame({
            "timestamp": ts,
            "open": q["open"], "high": q["high"], "low": q["low"],
            "close": q["close"], "volume": q["volume"],
        })
        df = df.dropna(subset=["open", "high", "low", "close"]).reset_index(drop=True)
        return df
```

- [ ] **Step 6: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_yahoo_client.py`
Expected: PASS (2 passed).

- [ ] **Step 7: Commit**

```
git add services/quant-py/app/data/__init__.py services/quant-py/app/data/base.py services/quant-py/app/data/yahoo.py services/quant-py/tests/fixtures/yahoo_aapl_5m.json services/quant-py/tests/test_yahoo_client.py
git commit -m "feat(sidecar): add injectable Yahoo candle client"
```

---

## Task 7: Wire the `/predict/intraday/{symbol}` endpoint

**Files:**
- Modify: `services/quant-py/app/api.py`
- Test: `services/quant-py/tests/test_api.py` (add endpoint tests)

- [ ] **Step 1: Write the failing tests** — append to `tests/test_api.py`

```python
import json
from pathlib import Path
import pandas as pd
from app.api import app, get_market_data

FIXTURE = Path(__file__).parent / "fixtures" / "yahoo_aapl_5m.json"

class _FakeMarketData:
    def __init__(self, df): self._df = df
    def fetch_candles(self, symbol, interval, range_): return self._df

def _df_from_fixture():
    r = json.loads(FIXTURE.read_text())["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    return pd.DataFrame({
        "timestamp": r["timestamp"], "open": q["open"], "high": q["high"],
        "low": q["low"], "close": q["close"], "volume": q["volume"]})

def test_predict_intraday_returns_prediction():
    app.dependency_overrides[get_market_data] = lambda: _FakeMarketData(_df_from_fixture())
    try:
        r = client.get("/predict/intraday/AAPL")
        assert r.status_code == 200
        body = r.json()
        assert body["symbol"] == "AAPL"
        assert body["source"] == "quant"
        assert body["bias"] in ("Bullish", "Neutral", "Bearish")
        assert 0.0 <= body["probability_up"] <= 1.0
        assert {"low", "base", "high"} <= set(body["expected_move"])
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_api.py::test_predict_intraday_returns_prediction`
Expected: FAIL — `ImportError: cannot import name 'get_market_data'`.

- [ ] **Step 3: Replace `app/api.py`**

```python
from fastapi import FastAPI, Depends, HTTPException
from app.data.base import MarketData
from app.data.yahoo import YahooMarketData
from app.predictors.intraday import score_intraday
from app.models import IntradayPrediction

app = FastAPI(title="quant-py", version="0.1.0")

_INTERVAL_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1h": 60}


def get_market_data() -> MarketData:
    return YahooMarketData()


@app.get("/health")
def health():
    return {"status": "ok", "service": "quant-py"}


@app.get("/predict/intraday/{symbol}", response_model=IntradayPrediction)
def predict_intraday(symbol: str, interval: str = "5m",
                     md: MarketData = Depends(get_market_data)):
    df = md.fetch_candles(symbol.upper(), interval=interval, range_="1d")
    if df.empty or len(df) < 20:
        raise HTTPException(status_code=422, detail="insufficient candles for intraday analysis")
    return score_intraday(symbol.upper(), df, interval_minutes=_INTERVAL_MINUTES.get(interval, 5))
```

- [ ] **Step 4: Run the full suite, verify all pass**

Run: `.venv\Scripts\python -m pytest`
Expected: PASS (all tests green across the 6 test files).

- [ ] **Step 5: Manual smoke test (optional, live network)**

Run: `.venv\Scripts\python -m uvicorn app.api:app --port 8500`
Then in another shell: `curl http://localhost:8500/predict/intraday/AAPL`
Expected: a JSON `IntradayPrediction` (markets-open hours give the richest result).

- [ ] **Step 6: Commit**

```
git add services/quant-py/app/api.py services/quant-py/tests/test_api.py
git commit -m "feat(sidecar): expose /predict/intraday endpoint (LLM-free)"
```

---

## Task 8: Containerize + document

**Files:**
- Create: `services/quant-py/Dockerfile`
- Create: `services/quant-py/README.md`
- Create/Modify: `services/quant-py/.dockerignore`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e .
COPY app ./app
EXPOSE 8000
CMD ["uvicorn", "app.api:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 2: Create `.dockerignore`**

```
.venv
tests
__pycache__
*.pyc
```

- [ ] **Step 3: Create `README.md`**

```markdown
# quant-py — Quant/ML sidecar

FastAPI service that computes deterministic, LLM-free market predictions consumed by the Node app.

## Run locally
    python -m venv .venv
    .venv\Scripts\python -m pip install -e ".[dev]"
    .venv\Scripts\python -m pytest
    .venv\Scripts\python -m uvicorn app.api:app --reload --port 8500

## Endpoints
- `GET /health`
- `GET /predict/intraday/{symbol}?interval=5m` → `IntradayPrediction`

## Deploy (Render)
- New **Web Service** from this repo, root dir `services/quant-py`, Docker runtime.
- No public secrets needed for Phase 1 (Yahoo is keyless). Later phases read
  `FINNHUB_API_KEY`, `FMP_API_KEY`, `FRED_API_KEY`, `ALPACA_KEY/SECRET`, `OPENBB_PAT` from env.
- The Node service reaches this one via an internal URL set as `QUANT_SIDECAR_URL` on the Node service.
```

- [ ] **Step 4: Verify the build (optional, requires Docker)**

Run: `docker build -t quant-py services/quant-py`
Expected: image builds; `docker run -p 8000:8000 quant-py` then `curl localhost:8000/health` → `{"status":"ok",...}`.

- [ ] **Step 5: Commit**

```
git add services/quant-py/Dockerfile services/quant-py/.dockerignore services/quant-py/README.md
git commit -m "chore(sidecar): containerize quant-py + docs"
```

---

## Phase 1 acceptance criteria

- [ ] `.venv\Scripts\python -m pytest` is green (all test files).
- [ ] `uvicorn app.api:app` serves `/health` → 200 and `/predict/intraday/AAPL` → a valid `IntradayPrediction`.
- [ ] The prediction is computed with **zero LLM calls** and `source == "quant"`.
- [ ] `.env` was never staged (verify `git status --short`); Phase 1 needs no secrets.
- [ ] Branch `feat/phase-1-sidecar` ready to merge to `main`.

## Self-review notes

- **Spec coverage:** delivers the intraday quant core (spec §"four quant cores → A") and the Python-sidecar
  foundation (spec §"Backend architecture"). Honest output (bias + probability + expected-move range +
  regime + invalidation, no single-price target) matches spec §"honesty".
- **No placeholders:** every step has complete, runnable code and exact commands.
- **Type consistency:** `score_intraday(symbol, df, interval_minutes)`; `IntradayPrediction` fields
  (`bias`, `probability_up`, `expected_move{low,base,high}`, `regime`, `regime_confidence`, `invalidation`,
  `drivers[{name,direction}]`, `as_of`, `source`) are identical across models, core, endpoint, and tests.
- **Determinism:** `as_of` is derived from the last candle timestamp, not wall-clock; all unit tests use
  synthetic/fixture data with no network.
