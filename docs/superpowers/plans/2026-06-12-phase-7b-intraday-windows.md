# Phase 7b: Intraday Windows — Session-Aware Setup Playbook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. `- [ ]` steps, strict TDD, one commit per task.

**Goal:** Turn the single intraday call into a **timeline of trade windows**: a scanner that walks the session's 1-minute bars, detects classic day-trade setups (ORB break, VWAP reclaim/bounce/fade, 9-EMA pullback) each with entry/target/stop/measured-R:R + a trigger and a backtested same-session outcome, tagged by **time-of-day session phase** (open-drive / morning / midday-avoid / afternoon / power-hour). Exposed at `/predict/setups/{symbol}` and shown in a "Windows" UI panel.

**Architecture:** Pure scanner in the sidecar (`app/predictors/setups.py`) over a 1-min DataFrame + daily ATR; unit-tested on synthetic series. Session phase via `zoneinfo` (add `tzdata` dep for slim Docker). Node proxies it through the existing cache/route layer; the UI adds a panel that auto-refreshes with the others.

**Tech Stack:** Python (sidecar) + `tzdata`; Node (no new deps); vanilla JS UI.

**Builds on:** Phases 1–7 (indicators, market data, predict cache/routes, predictions.js).

---

## Task 1: `tzdata` dep + session-phase helper + models

**Files:** `services/quant-py/pyproject.toml` (add `tzdata`); create `app/predictors/setups.py` (phase helper + models live here); Test `tests/test_session_phase.py`

- [ ] **Step 1: Add `tzdata` to `pyproject.toml` dependencies** (slim Docker has no system zoneinfo):
```
  "tzdata>=2024.1",
```
Reinstall: `.venv\Scripts\python -m pip install -e ".[dev]"`

- [ ] **Step 2: Add models to `app/models.py`**
```python
class Setup(BaseModel):
    time: str
    type: str
    direction: Literal["long", "short"]
    entry: float
    target: float
    stop: float
    risk_reward: float
    trigger: str
    phase: str
    quality: Literal["high", "medium", "low", "none"]
    status: Literal["triggered_win", "triggered_loss", "active"]


class KeyLevel(BaseModel):
    price: float
    kind: Literal["support", "resistance"]
    label: str            # e.g. "prior-day high", "session low", "round number", "swing high"


class SetupTimeline(BaseModel):
    symbol: str
    phase: str
    phase_quality: Literal["high", "medium", "low", "none"]
    setups: list[Setup]
    levels: list[KeyLevel] = []     # support/resistance for buy-low / sell-high framing
    watch: str | None = None
    as_of: str
    source: Literal["quant"] = "quant"
```

`Setup.type` is a free string, so candlestick-pattern and level-interaction setups
(e.g. "Bullish engulfing", "Bounce at support") reuse the same `Setup` shape.

- [ ] **Step 3: Failing test** — `tests/test_session_phase.py`
```python
from datetime import datetime
from zoneinfo import ZoneInfo
from app.predictors.setups import session_phase

ET = ZoneInfo("America/New_York")
def _epoch(h, m): return int(datetime(2026, 6, 12, h, m, tzinfo=ET).timestamp())

def test_phases():
    assert session_phase(_epoch(9, 45)) == ("open_drive", "high")
    assert session_phase(_epoch(11, 0)) == ("morning", "medium")
    assert session_phase(_epoch(12, 30)) == ("midday", "low")
    assert session_phase(_epoch(14, 0)) == ("afternoon", "medium")
    assert session_phase(_epoch(15, 30)) == ("power_hour", "high")
    assert session_phase(_epoch(8, 0)) == ("pre", "none")
    assert session_phase(_epoch(16, 30)) == ("closed", "none")
```

- [ ] **Step 4: Create `app/predictors/setups.py` (phase helper portion)**
```python
"""Intraday setup scanner: detects day-trade windows over a 1-minute session and
tags each with its time-of-day phase. Deterministic; no LLM, no I/O."""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import pandas as pd

from app import indicators as ind
from app.models import Setup, SetupTimeline

ET = ZoneInfo("America/New_York")
OPENING_RANGE_BARS = 15
RELVOL_MIN = 1.3
STOP_ATR_FRACTION = 0.25
TARGET_ATR_FRACTION = 0.5
MAX_SETUPS = 8

_WATCH = {
    "pre": "Pre-market — wait for the 9:30 open.",
    "open_drive": "Opening range forming — watch for an ORB break on rising volume.",
    "morning": "Watch for the first VWAP / 9-EMA pullback in the trend.",
    "midday": "Midday lull — low volume and choppy. Best to stand aside.",
    "afternoon": "Watch for a VWAP reclaim/bounce as afternoon volume returns.",
    "power_hour": "Power hour — watch for momentum continuation into the close.",
    "closed": "Market closed — setups resume next session.",
}


def session_phase(epoch: int) -> tuple[str, str]:
    t = datetime.fromtimestamp(epoch, ET)
    hm = t.hour * 60 + t.minute
    if hm < 9 * 60 + 30:
        return ("pre", "none")
    if hm < 10 * 60 + 30:
        return ("open_drive", "high")
    if hm < 11 * 60 + 30:
        return ("morning", "medium")
    if hm < 13 * 60 + 30:
        return ("midday", "low")
    if hm < 15 * 60:
        return ("afternoon", "medium")
    if hm < 16 * 60:
        return ("power_hour", "high")
    return ("closed", "none")


def _iso(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
```

- [ ] **Step 5: Run → pass. Commit**
```
git checkout -b feat/phase-7b-windows
git add services/quant-py/pyproject.toml services/quant-py/app/models.py services/quant-py/app/predictors/setups.py services/quant-py/tests/test_session_phase.py
git commit -m "feat(setups): add tzdata, session-phase helper, setup models"
```

---

## Task 2: The setup scanner

**Files:** extend `app/predictors/setups.py`; Test `tests/test_setups.py`

- [ ] **Step 1: Failing tests** — `tests/test_setups.py`
```python
import numpy as np, pandas as pd
from app.predictors.setups import scan_setups

def _session(close, highs=None, lows=None, vols=None, start_epoch=1_749_652_200):
    close = np.asarray(close, float); n = len(close)
    return pd.DataFrame({
        "timestamp": start_epoch + np.arange(n) * 60,   # 1-min bars
        "open": close,
        "high": close + (0.3 if highs is None else 0),
        "low": close - (0.3 if lows is None else 0),
        "close": close,
        "volume": np.full(n, 100.0) if vols is None else np.asarray(vols, float),
    })

def test_orb_breakout_detected_in_uptrend():
    # flat opening range then a volume breakout up
    close = np.concatenate([np.full(15, 100.0), np.linspace(100.5, 108, 45)])
    vols = np.concatenate([np.full(15, 100.0), np.full(45, 400.0)])
    tl = scan_setups("AAPL", _session(close, vols=vols), daily_atr=8.0)
    kinds = [s.type for s in tl.setups]
    assert any("ORB" in k for k in kinds)
    long_setup = next(s for s in tl.setups if s.direction == "long")
    assert long_setup.target > long_setup.entry > long_setup.stop
    assert long_setup.risk_reward > 0

def test_setup_outcome_backtested_win():
    # breakout that then runs well past target => triggered_win on the earliest setup
    close = np.concatenate([np.full(15, 100.0), np.linspace(101, 120, 45)])
    vols = np.concatenate([np.full(15, 100.0), np.full(45, 400.0)])
    tl = scan_setups("AAPL", _session(close, vols=vols), daily_atr=5.0)
    assert any(s.status == "triggered_win" for s in tl.setups)

def test_phase_and_watch_present():
    close = np.linspace(100, 105, 60)
    tl = scan_setups("AAPL", _session(close), daily_atr=5.0)
    assert tl.phase in ("pre","open_drive","morning","midday","afternoon","power_hour","closed")
    assert isinstance(tl.watch, str)

def test_no_setups_when_quiet_and_flat():
    tl = scan_setups("AAPL", _session(np.full(60, 100.0)), daily_atr=5.0)
    # a dead-flat tape triggers no ORB/VWAP/EMA events
    assert tl.setups == []
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Append the scanner to `app/predictors/setups.py`**
```python
def _resolve(direction: str, entry: float, target: float, stop: float,
             high: pd.Series, low: pd.Series, i: int, n: int) -> str:
    for j in range(i + 1, n):
        if direction == "long":
            if low.iloc[j] <= stop:
                return "triggered_loss"
            if high.iloc[j] >= target:
                return "triggered_win"
        else:
            if high.iloc[j] >= stop:
                return "triggered_loss"
            if low.iloc[j] <= target:
                return "triggered_win"
    return "active"


def scan_setups(symbol: str, df: pd.DataFrame, daily_atr: float | None = None,
                max_setups: int = MAX_SETUPS) -> SetupTimeline:
    d = df.reset_index(drop=True)
    close, open_, high, low = d["close"], d["open"], d["high"], d["low"]
    vol, ts = d["volume"], d["timestamp"]
    n = len(close)

    vwap = ind.session_vwap(d)
    ema9, ema20 = ind.ema(close, 9), ind.ema(close, 20)
    relvol = vol / vol.rolling(20).mean()
    atr_day = daily_atr if (daily_atr and daily_atr > 0) else float(ind.atr(high, low, close, 14).iloc[-1])
    if not atr_day or atr_day != atr_day:      # NaN/0 guard
        atr_day = float(close.iloc[-1]) * 0.01
    stop_dist = STOP_ATR_FRACTION * atr_day
    tgt_dist = TARGET_ATR_FRACTION * atr_day

    or_high = float(high.iloc[:OPENING_RANGE_BARS].max())
    or_low = float(low.iloc[:OPENING_RANGE_BARS].min())

    setups: list[Setup] = []
    orb_long = orb_short = False
    start = max(OPENING_RANGE_BARS, 20)
    for i in range(start, n):
        if pd.isna(vwap.iloc[i]) or pd.isna(ema9.iloc[i]) or pd.isna(ema20.iloc[i]):
            continue
        c, o, hi, lo = close.iloc[i], open_.iloc[i], high.iloc[i], low.iloc[i]
        v, vp = vwap.iloc[i], vwap.iloc[i - 1]
        rv = relvol.iloc[i]
        e9, e20 = ema9.iloc[i], ema20.iloc[i]
        up = c > v and e9 > e20
        down = c < v and e9 < e20

        evt = None
        if not orb_long and c > or_high and rv >= RELVOL_MIN:
            evt = ("ORB breakout", "long", "Break of the opening-range high on rising volume"); orb_long = True
        elif not orb_short and c < or_low and rv >= RELVOL_MIN:
            evt = ("ORB breakdown", "short", "Break of the opening-range low on rising volume"); orb_short = True
        elif close.iloc[i - 1] < vp and c > v and c > o:
            evt = ("VWAP reclaim", "long", "Reclaimed VWAP with a green candle")
        elif up and lo <= v:
            evt = ("VWAP bounce", "long", "Pullback to VWAP in an uptrend held")
        elif down and hi >= v and c < o:
            evt = ("VWAP fade", "short", "Rejected at VWAP in a downtrend")
        elif up and lo <= e9 and c > e9:
            evt = ("9-EMA pullback", "long", "Pullback to the 9-EMA in an uptrend held")
        if not evt:
            continue

        typ, direction, trigger = evt
        entry = float(c)
        if direction == "long":
            stop, target = entry - stop_dist, entry + tgt_dist
        else:
            stop, target = entry + stop_dist, entry - tgt_dist
        risk = abs(entry - stop)
        if risk <= 0:
            continue
        phase, quality = session_phase(int(ts.iloc[i]))
        setups.append(Setup(
            time=_iso(int(ts.iloc[i])), type=typ, direction=direction,
            entry=round(entry, 4), target=round(target, 4), stop=round(stop, 4),
            risk_reward=round(abs(target - entry) / risk, 2),
            trigger=trigger, phase=phase, quality=quality,
            status=_resolve(direction, entry, target, stop, high, low, i, n)))

    setups = setups[-max_setups:]
    cur_phase, cur_q = session_phase(int(ts.iloc[-1]))
    return SetupTimeline(symbol=symbol, phase=cur_phase, phase_quality=cur_q,
                         setups=setups, watch=_WATCH.get(cur_phase), as_of=_iso(int(ts.iloc[-1])))
```

- [ ] **Step 4: Run → pass. Commit**
```
git add services/quant-py/app/predictors/setups.py services/quant-py/tests/test_setups.py
git commit -m "feat(setups): add intraday setup scanner (ORB/VWAP/EMA) with backtested outcomes"
```

---

## Task 2b: Candlestick patterns + key support/resistance levels

**Files:** extend `app/predictors/setups.py`; Test `tests/test_patterns_levels.py`

- [ ] **Step 1: Failing tests** — `tests/test_patterns_levels.py`
```python
import numpy as np, pandas as pd
from app.predictors.setups import _candle_pattern, _key_levels, scan_setups
from app.models import KeyLevel

def _df(rows):  # rows: list of (o,h,l,c)
    rows = np.array(rows, float); n = len(rows)
    return pd.DataFrame({"timestamp": 1_749_652_200 + np.arange(n)*60,
        "open": rows[:,0], "high": rows[:,1], "low": rows[:,2], "close": rows[:,3],
        "volume": np.full(n, 100.0)})

def test_bullish_engulfing_detected():
    d = _df([(100, 100.2, 99, 99.2), (99.1, 101.5, 99.0, 101.3)])  # red then engulfing green
    assert _candle_pattern(d["open"], d["high"], d["low"], d["close"], 1)[:2] == ("Bullish engulfing", "long")

def test_hammer_detected():
    d = _df([(100, 100.1, 100, 100.05), (100, 100.2, 98.5, 100.1)])  # long lower wick, small body
    assert _candle_pattern(d["open"], d["high"], d["low"], d["close"], 1)[:2] == ("Hammer", "long")

def test_key_levels_classified_around_price():
    close = np.linspace(100, 110, 80)
    d = _df([(c, c + 0.3, c - 0.3, c) for c in close])
    levels = _key_levels(d, price=float(close[-1]), prior_day_high=115.0, prior_day_low=95.0)
    assert any(l.label == "prior-day high" and l.kind == "resistance" for l in levels)
    assert any(l.label == "prior-day low" and l.kind == "support" for l in levels)
    assert all(l.kind == "resistance" for l in levels if l.price >= close[-1])

def test_scan_returns_levels():
    close = np.concatenate([np.full(15, 100.0), np.linspace(101, 110, 45)])
    d = _df([(c, c + 0.3, c - 0.3, c) for c in close])
    tl = scan_setups("AAPL", d, daily_atr=8.0, prior_day_high=112.0, prior_day_low=96.0)
    assert len(tl.levels) > 0
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Add the helpers to `app/predictors/setups.py`** (above `scan_setups`)
```python
from app.models import KeyLevel   # add to the existing models import

def _candle_pattern(o, h, l, c, i):
    if i < 1:
        return None
    body = abs(c.iloc[i] - o.iloc[i])
    upper = h.iloc[i] - max(c.iloc[i], o.iloc[i])
    lower = min(c.iloc[i], o.iloc[i]) - l.iloc[i]
    cur_bull, cur_bear = c.iloc[i] > o.iloc[i], c.iloc[i] < o.iloc[i]
    prev_bull, prev_bear = c.iloc[i - 1] > o.iloc[i - 1], c.iloc[i - 1] < o.iloc[i - 1]
    if cur_bull and prev_bear and c.iloc[i] >= o.iloc[i - 1] and o.iloc[i] <= c.iloc[i - 1]:
        return ("Bullish engulfing", "long", "Bullish engulfing candle")
    if cur_bear and prev_bull and o.iloc[i] >= c.iloc[i - 1] and c.iloc[i] <= o.iloc[i - 1]:
        return ("Bearish engulfing", "short", "Bearish engulfing candle")
    if body > 0 and lower >= 2 * body and upper <= body:
        return ("Hammer", "long", "Hammer — long lower wick, buyers stepped in")
    if body > 0 and upper >= 2 * body and lower <= body:
        return ("Shooting star", "short", "Shooting star — long upper wick, sellers stepped in")
    return None


def _key_levels(df, price, prior_day_high=None, prior_day_low=None, swing_window=10):
    high, low = df["high"], df["low"]
    n = len(df)
    cand = []
    if prior_day_high:
        cand.append((float(prior_day_high), "prior-day high"))
    if prior_day_low:
        cand.append((float(prior_day_low), "prior-day low"))
    cand.append((float(high.max()), "session high"))
    cand.append((float(low.min()), "session low"))
    w = swing_window
    for i in range(w, n - w):
        if high.iloc[i] == high.iloc[i - w:i + w + 1].max():
            cand.append((float(high.iloc[i]), "swing high"))
        if low.iloc[i] == low.iloc[i - w:i + w + 1].min():
            cand.append((float(low.iloc[i]), "swing low"))
    step = 1.0 if price < 100 else 5.0 if price < 1000 else 10.0
    cand.append((round(price / step) * step, "round number"))

    levels, seen = [], []
    for p, label in cand:
        if p <= 0 or any(abs(p - s) / price < 0.001 for s in seen):
            continue
        seen.append(p)
        levels.append(KeyLevel(price=round(p, 2),
                               kind="resistance" if p >= price else "support", label=label))
    res = sorted([x for x in levels if x.kind == "resistance"], key=lambda x: x.price)[:3]
    sup = sorted([x for x in levels if x.kind == "support"], key=lambda x: -x.price)[:3]
    return sup + res
```

- [ ] **Step 4: Integrate into `scan_setups`** — three small changes:
  1. Change the signature to accept prior-day levels:
```python
def scan_setups(symbol: str, df: pd.DataFrame, daily_atr: float | None = None,
                prior_day_high: float | None = None, prior_day_low: float | None = None,
                max_setups: int = MAX_SETUPS) -> SetupTimeline:
```
  2. In the per-bar event chain, after the `9-EMA pullback` branch and before `if not evt: continue`, add a candlestick-pattern fallback:
```python
        if evt is None:
            evt = _candle_pattern(open_, high, low, close, i)   # pattern-based window
```
  3. Compute levels and include them in the returned `SetupTimeline`:
```python
    levels = _key_levels(d, float(close.iloc[-1]), prior_day_high, prior_day_low)
    setups = setups[-max_setups:]
    cur_phase, cur_q = session_phase(int(ts.iloc[-1]))
    return SetupTimeline(symbol=symbol, phase=cur_phase, phase_quality=cur_q,
                         setups=setups, levels=levels, watch=_WATCH.get(cur_phase),
                         as_of=_iso(int(ts.iloc[-1])))
```
(Replace the existing `setups = setups[-max_setups:]` / return block with the version above.)

- [ ] **Step 5: Run → pass. Commit**
```
git add services/quant-py/app/predictors/setups.py services/quant-py/tests/test_patterns_levels.py
git commit -m "feat(setups): add candlestick patterns + key support/resistance levels"
```

---

## Task 3: Endpoint + Node wiring

**Files:** `app/api.py` (endpoint); `src/sidecar.js`, `src/predict-service.js`, `src/predict-routes.js`; Tests `tests/test_setups_api.py`, append to `test/predict-service.test.js`

- [ ] **Step 1: Failing test** — `tests/test_setups_api.py`
```python
import numpy as np, pandas as pd
from fastapi.testclient import TestClient
from app.api import app, get_market_data

client = TestClient(app)

class _FakeMD:
    def __init__(self, df): self._df = df
    def fetch_candles(self, symbol, interval, range_): return self._df

def _session():
    close = np.concatenate([np.full(15, 100.0), np.linspace(101, 112, 45)])
    n = len(close)
    return pd.DataFrame({"timestamp": 1_749_652_200 + np.arange(n)*60,
        "open": close, "high": close+0.3, "low": close-0.3, "close": close,
        "volume": np.concatenate([np.full(15,100.0), np.full(45,400.0)])})

def test_setups_endpoint():
    app.dependency_overrides[get_market_data] = lambda: _FakeMD(_session())
    try:
        r = client.get("/predict/setups/AAPL")
        assert r.status_code == 200
        body = r.json()
        assert body["symbol"] == "AAPL"
        assert "setups" in body and "phase" in body
    finally:
        app.dependency_overrides.clear()

def test_setups_422_on_thin_data():
    app.dependency_overrides[get_market_data] = lambda: _FakeMD(_session().head(5))
    try:
        assert client.get("/predict/setups/AAPL").status_code == 422
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 2: Add endpoint to `app/api.py`**
```python
from app.predictors.setups import scan_setups
from app.models import SetupTimeline

def _prior_day_hilo(md: MarketData, symbol: str):
    try:
        ddf = md.fetch_candles(symbol, interval="1d", range_="1mo")
        if not ddf.empty and len(ddf) >= 2:        # [-1] is today's forming bar, [-2] = prior day
            return float(ddf["high"].iloc[-2]), float(ddf["low"].iloc[-2])
    except Exception:
        pass
    return None, None

@app.get("/predict/setups/{symbol}", response_model=SetupTimeline)
def predict_setups(symbol: str, md: MarketData = Depends(get_market_data)):
    sym = symbol.upper()
    df = md.fetch_candles(sym, interval="1m", range_="1d")
    if df.empty or len(df) < 20:
        raise HTTPException(status_code=422, detail="insufficient candles for setup scan")
    pdh, pdl = _prior_day_hilo(md, sym)
    return scan_setups(sym, df, daily_atr=_daily_atr(md, sym), prior_day_high=pdh, prior_day_low=pdl)
```

- [ ] **Step 3: Run sidecar test → pass.**

- [ ] **Step 4: Add to `src/sidecar.js`** (with the other methods):
```js
    setups: (s) => request('GET', `/predict/setups/${encodeURIComponent(s)}`),
```

- [ ] **Step 5: Add to `src/predict-service.js`** — TTL entry + method:
```js
// in TTL:
  setups: 60 * 1000,
// in returned object:
    setups: (s) => cached('setups', s, () => sidecar.setups(s)),
```

- [ ] **Step 6: Add route in `src/predict-routes.js`** (with the others):
```js
  router.get('/setups/:symbol', wrap((req) => service.setups(req.params.symbol.toUpperCase())));
```

- [ ] **Step 7: Failing test → pass** — append to `test/predict-service.test.js`:
```js
test('setups is cached', async () => {
  const counts = {};
  const sidecar = { setups: async (s) => (counts.s = (counts.s || 0) + 1, { symbol: s, setups: [] }) };
  const { createPredictService } = require('../src/predict-service');
  const svc = createPredictService({ sidecar, cache: new (require('../src/cache').TtlCache)() });
  await svc.setups('AAPL'); await svc.setups('AAPL');
  assert.equal(counts.s, 1);
});
```

- [ ] **Step 8: Run `node --test` + sidecar `pytest` → green. Commit**
```
git add services/quant-py/app/api.py services/quant-py/tests/test_setups_api.py src/sidecar.js src/predict-service.js src/predict-routes.js test/predict-service.test.js
git commit -m "feat(setups): expose /predict/setups endpoint + Node cache/route"
```

---

## Task 4: "Windows" UI panel

**Files:** `public/predictions.js` (fetch + render + wire into load); `public/index.html` (container + styles)

- [ ] **Step 1: Add container to `index.html`** — inside the Market-view area, after the Intraday/Outlook grid (implementer picks the spot; keep the id):
```html
<div class="pcard" id="predWindows" style="grid-column:1 / -1"></div>
```
(Place it so it spans full width under the two market cards; if the grid makes that awkward, put it directly after the `.pgrid` that holds `predIntraday`/`predOutlook`.)

- [ ] **Step 2: Add rendering + fetch to `public/predictions.js`** — add these functions and call `loadWindows(symbol)` inside `load()`:
```js
  var PHASE_LABEL = { pre: 'Pre-market', open_drive: 'Open drive', morning: 'Morning trend',
    midday: 'Midday (avoid)', afternoon: 'Afternoon', power_hour: 'Power hour', closed: 'Closed' };
  var PHASES = ['open_drive', 'morning', 'midday', 'afternoon', 'power_hour'];

  function phaseStrip(current) {
    return '<div class="pwphase">' + PHASES.map(function (p) {
      var cls = p === current ? ' pwp-now' : ''; cls += (p === 'midday' ? ' pwp-bad' : '');
      return '<span class="pwp' + cls + '">' + PHASE_LABEL[p] + '</span>';
    }).join('<span class="pwp-sep">›</span>') + '</div>';
  }
  function setupRow(s) {
    var dirCls = s.direction === 'long' ? 'd-up' : 'd-dn';
    var statusMap = { triggered_win: '✓ hit target', triggered_loss: '✗ stopped', active: '● live' };
    var t = new Date(s.time);
    var hhmm = isNaN(t) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var qcls = s.quality === 'high' ? 'pq-high' : s.quality === 'low' ? 'pq-low' : 'pq-med';
    return '<div class="pwrow ' + (s.status === 'active' ? 'pwrow-active' : '') + '">' +
      '<span class="pw-t">' + hhmm + '</span>' +
      '<span class="pw-type">' + esc(s.type) + ' <i class="' + dirCls + '">' + (s.direction === 'long' ? 'LONG' : 'SHORT') + '</i></span>' +
      '<span class="pw-lv">' + money(s.entry) + ' → <b class="d-up">' + money(s.target) + '</b> / <b class="d-dn">' + money(s.stop) + '</b></span>' +
      '<span class="pw-rr">' + s.risk_reward.toFixed(1) + '×</span>' +
      '<span class="pw-st ' + qcls + '">' + (statusMap[s.status] || s.status) + '</span></div>';
  }
  function keyLevels(levels) {
    if (!levels || !levels.length) return '';
    var res = levels.filter(function (l) { return l.kind === 'resistance'; });
    var sup = levels.filter(function (l) { return l.kind === 'support'; });
    function chips(arr, cls) {
      return arr.map(function (l) {
        return '<span class="pkl ' + cls + '" title="' + esc(l.label) + '">' + money(l.price) + '</span>';
      }).join('');
    }
    return '<div class="pkeylv">' +
      '<div class="pkl-row"><span>Sell / resistance</span>' + chips(res, 'pkl-res') + '</div>' +
      '<div class="pkl-row"><span>Buy / support</span>' + chips(sup, 'pkl-sup') + '</div></div>';
  }
  function windowsCard(node, data) {
    var head = '<div class="pcard-head"><span class="phbadge">Intraday windows</span>' + freshnessTag(data.as_of) + '</div>';
    var strip = phaseStrip(data.phase);
    var watch = data.watch ? '<div class="pwwatch">' + esc(data.watch) + '</div>' : '';
    var levels = keyLevels(data.levels);
    var rows = (data.setups && data.setups.length)
      ? '<div class="pwrows">' + data.setups.slice().reverse().map(setupRow).join('') + '</div>'
      : '<div class="pmuted">No setups triggered yet this session.</div>';
    node.innerHTML = head + strip + watch + levels + rows + '<div class="pcard-foot">' + aiBadge([]) + '</div>';
  }
  function loadWindows(symbol) {
    var node = el('predWindows');
    if (!node) return;
    loadingCard(node, 'Intraday windows');
    getJSON('/api/predict/setups/' + encodeURIComponent(symbol))
      .then(function (d) { windowsCard(node, d); })
      .catch(function (e) { errorCard(node, 'Intraday windows', e); });
  }
```
Then inside `load(symbol, ctx)`, add a call near the intraday/outlook fetches: `loadWindows(symbol);`

- [ ] **Step 3: Add styles to `index.html`** (reuse existing vars):
```css
    .pwphase { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin:4px 0 10px; font-size:11px; }
    .pwp { padding:2px 8px; border-radius:999px; border:1px solid var(--line,#243149); color:var(--muted,#95a3b8); }
    .pwp-now { color:var(--text,#e8eef8); border-color:var(--blue,#3a7bd5); background:#16203a; }
    .pwp-bad { color:#ff6b6b; } .pwp-sep { color:var(--muted,#5f6c86); }
    .pwwatch { font-size:12px; color:var(--muted,#95a3b8); margin-bottom:8px; }
    .pwrows { display:flex; flex-direction:column; gap:4px; }
    .pwrow { display:grid; grid-template-columns:52px 1.4fr 1.6fr 44px 84px; gap:8px; align-items:center;
      font-size:12px; padding:4px 6px; border-radius:6px; background:var(--panel2,#111b2d); }
    .pwrow-active { border:1px solid var(--blue,#3a7bd5); }
    .pw-type i { font-style:normal; font-size:10px; } .pw-rr { text-align:right; }
    .pw-st { text-align:right; } .pq-high { color:#39d98a; } .pq-low { color:#ff6b6b; } .pq-med { color:var(--muted,#95a3b8); }
    .pkeylv { margin:8px 0; display:flex; flex-direction:column; gap:4px; }
    .pkl-row { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--muted,#95a3b8); flex-wrap:wrap; }
    .pkl-row > span:first-child { min-width:118px; }
    .pkl { padding:2px 8px; border-radius:6px; font-weight:600; }
    .pkl-res { background:#2a1414; color:#ff8585; } .pkl-sup { background:#10241b; color:#39d98a; }
    @media (max-width:760px){ .pwrow { grid-template-columns:44px 1fr 1fr; } .pw-rr,.pw-st { display:none; } }
```

- [ ] **Step 4: Verify** — `node --check public/predictions.js`; start server, confirm `/api/predict/setups/AAPL` proxies and the panel renders (or shows the friendly 422 "forming" pre-enough-data).

- [ ] **Step 5: Commit**
```
git add public/predictions.js public/index.html
git commit -m "feat(ui): add Intraday Windows panel (session phases + setup timeline)"
```

---

## Acceptance criteria
- [ ] Sidecar `pytest` + Node `node --test` green.
- [ ] `session_phase` maps ET times to open_drive/morning/midday/afternoon/power_hour/pre/closed with correct quality.
- [ ] Scanner detects ORB/VWAP/EMA **and candlestick-pattern** setups with entry/target/stop, measured R:R, a trigger string, phase tag, and a backtested status (win/loss/active); flat-quiet tape → no setups.
- [ ] Scanner returns **key support/resistance levels** (prior-day H/L, session H/L, swings, round number) classified relative to price.
- [ ] `/predict/setups/{symbol}` returns a `SetupTimeline` (422 on thin data); cached in Node; proxied at `/api/predict/setups/:symbol`.
- [ ] UI "Windows" panel shows the session-phase strip (midday flagged red, current highlighted), a what-to-watch line, the **buy/support & sell/resistance level chips**, and the setup rows (time · type · LONG/SHORT · entry→target/stop · R:R · status); auto-refreshes; friendly states on 422/503.
- [ ] `tzdata` added; `.env` never staged. Branch `feat/phase-7b-windows` ready to merge.

## Self-review notes
- **Spec/research coverage:** implements the time-of-day windows (open-drive/midday-avoid/power-hour) and the setup playbook (ORB, VWAP reclaim/bounce/fade, 9-EMA pullback) from the research, each as an actionable window with measured R:R; midday is visibly flagged "avoid".
- **Honesty:** statuses are *same-session backtested* outcomes (win/loss/active), not promises; 1-min bar granularity is acknowledged (decision-support, not execution). Targets/stops reuse the daily-ATR logic so they're consistent with the Today card.
- **Determinism:** scanner is pure over injected data; `session_phase` uses `zoneinfo`+`tzdata` (no system tz dependency); tests use synthetic sessions.
- **Type consistency:** `scan_setups(symbol, df, daily_atr)` → `SetupTimeline{phase, phase_quality, setups[Setup], watch, as_of}`; Node `service.setups(symbol)`; route `/api/predict/setups/:symbol`; UI `loadWindows(symbol)`.

## Follow-ups
- Optional: persist setup outcomes across the day to show a live hit-rate (ties into Phase 8 calibration logging).
- Optional: gate "active" setups by phase quality (suppress new longs during midday).
