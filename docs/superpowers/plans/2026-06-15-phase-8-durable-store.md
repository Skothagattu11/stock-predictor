# Phase 8: Durable Store — Calibration Track-Record + 1-Minute History (ML prep) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. `- [ ]` steps, strict TDD, one commit per task.

**Goal:** Add durable, server-side storage on the sidecar (a Render Persistent Disk): a **calibration track-record** (every setup + its outcome, aggregated across days/devices) and a **1-minute history accumulator** (daily bars per symbol) that becomes the **training dataset for the Phase 9 ML model**.

**Architecture:** A tiny storage layer under `$DATA_DIR` (default `./data` locally, `/data` on Render). Calibration uses **SQLite** (stdlib, durable, queryable); history uses **per-symbol CSV** (pandas-friendly for ML). Both are populated by **piggybacking on the existing `/predict/setups` scan** (no extra fetches) and exposed read-only via `/calibration/stats` and `/history/{symbol}/info`. Node proxies `/calibration/stats`; the UI track-record panel prefers the durable server stats, falling back to its localStorage journal.

**Tech Stack:** Python stdlib `sqlite3` + pandas (already present); no new deps. Render Persistent Disk (paid instance — already on starter).

**Builds on:** Phase 7b (setups), Phase 4 (Node route/cache), Phase 2 (config).

---

## Task 1: `DATA_DIR` config + calibration SQLite store

**Files:** modify `app/config.py`; create `app/store/__init__.py` (empty), `app/store/calibration.py`; Test `tests/test_calibration_store.py`

- [ ] **Step 1: Add `DATA_DIR` to `app/config.py`**
```python
import os  # (already imported)
DATA_DIR = (os.environ.get("DATA_DIR", "").strip() or os.path.join(os.getcwd(), "data"))
```

- [ ] **Step 2: Failing tests** — `tests/test_calibration_store.py`
```python
from app.store.calibration import CalibrationStore

def _setup(time, status, rr=2.0, typ="VWAP bounce"):
    return {"time": time, "type": typ, "direction": "long", "entry": 100.0,
            "target": 102.0, "stop": 99.0, "risk_reward": rr, "status": status}

def test_record_and_stats(tmp_path):
    db = CalibrationStore(str(tmp_path / "c.db"))
    db.record_setups("AAPL", [_setup("2026-06-15T14:00:00Z", "triggered_win"),
                              _setup("2026-06-15T14:05:00Z", "triggered_loss")])
    s = db.stats()
    g = next(x for x in s["groups"] if x["type"] == "VWAP bounce")
    assert g["win"] == 1 and g["loss"] == 1
    assert s["overall"]["n"] == 2

def test_upsert_updates_status(tmp_path):
    db = CalibrationStore(str(tmp_path / "c.db"))
    sid = "2026-06-15T14:00:00Z"
    db.record_setups("AAPL", [_setup(sid, "active")])
    db.record_setups("AAPL", [_setup(sid, "triggered_win")])   # same id -> update
    assert db.stats()["overall"]["win"] == 1
    assert db.stats()["overall"]["n"] == 1                      # not duplicated

def test_hit_rate_excludes_pending(tmp_path):
    db = CalibrationStore(str(tmp_path / "c.db"))
    db.record_setups("X", [_setup("t1", "triggered_win"), _setup("t2", "active")])
    o = db.stats()["overall"]
    assert o["win"] == 1 and o["pending"] == 1 and o["hit_rate"] == 1.0
```

- [ ] **Step 3: Create `app/store/calibration.py`**
```python
"""Durable calibration track-record (SQLite). Records each setup the scanner
surfaces and its outcome; aggregates hit-rate / avg R:R across days."""
import os
import sqlite3
from datetime import datetime, timezone


def _now():
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class CalibrationStore:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._path = path
        self._init()

    def _conn(self):
        return sqlite3.connect(self._path)

    def _init(self):
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS predictions (
                id TEXT PRIMARY KEY, symbol TEXT, type TEXT, direction TEXT,
                entry REAL, target REAL, stop REAL, rr REAL, status TEXT,
                created_at TEXT, updated_at TEXT)""")

    def record_setups(self, symbol: str, setups: list[dict]):
        if not setups:
            return
        now = _now()
        with self._conn() as c:
            for s in setups:
                sid = f"{symbol}|{s.get('time')}|{s.get('type')}|{s.get('direction')}"
                c.execute("""INSERT INTO predictions
                    (id, symbol, type, direction, entry, target, stop, rr, status, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at""",
                          (sid, symbol, s.get("type"), s.get("direction"), s.get("entry"),
                           s.get("target"), s.get("stop"), s.get("risk_reward"),
                           s.get("status"), now, now))

    def stats(self) -> dict:
        with self._conn() as c:
            rows = c.execute("SELECT type, status, rr FROM predictions").fetchall()
        groups: dict = {}
        overall = {"type": "All", "n": 0, "win": 0, "loss": 0, "pending": 0, "rr_sum": 0.0}
        for typ, status, rr in rows:
            g = groups.setdefault(typ, {"type": typ, "n": 0, "win": 0, "loss": 0, "pending": 0, "rr_sum": 0.0})
            for d in (g, overall):
                d["n"] += 1
                d["rr_sum"] += rr or 0.0
            if status == "triggered_win":
                g["win"] += 1; overall["win"] += 1
            elif status == "triggered_loss":
                g["loss"] += 1; overall["loss"] += 1
            else:
                g["pending"] += 1; overall["pending"] += 1

        def finish(d):
            res = d["win"] + d["loss"]
            d["hit_rate"] = round(d["win"] / res, 3) if res else None
            d["avg_rr"] = round(d["rr_sum"] / d["n"], 2) if d["n"] else None
            d.pop("rr_sum", None)
            return d

        return {"groups": [finish(g) for g in groups.values()], "overall": finish(overall)}
```

- [ ] **Step 4: Run → pass. Commit**
```
git checkout -b feat/phase-8-store
git add services/quant-py/app/config.py services/quant-py/app/store/__init__.py services/quant-py/app/store/calibration.py services/quant-py/tests/test_calibration_store.py
git commit -m "feat(store): add DATA_DIR + durable SQLite calibration track-record"
```

---

## Task 2: 1-minute history accumulator (CSV)

**Files:** create `app/store/history.py`; Test `tests/test_history_store.py`

- [ ] **Step 1: Failing tests** — `tests/test_history_store.py`
```python
import pandas as pd
from app.store.history import HistoryStore

def _bars(ts):
    return pd.DataFrame({"timestamp": ts, "open": [1.0]*len(ts), "high": [1.0]*len(ts),
                         "low": [1.0]*len(ts), "close": [1.0]*len(ts), "volume": [10.0]*len(ts)})

def test_append_and_info(tmp_path):
    h = HistoryStore(str(tmp_path))
    h.append("AAPL", _bars([1, 2, 3]))
    info = h.info("AAPL")
    assert info["rows"] == 3

def test_append_dedups_by_timestamp(tmp_path):
    h = HistoryStore(str(tmp_path))
    h.append("AAPL", _bars([1, 2, 3]))
    h.append("AAPL", _bars([3, 4, 5]))     # 3 overlaps
    assert h.info("AAPL")["rows"] == 5      # 1,2,3,4,5

def test_info_empty_symbol(tmp_path):
    assert HistoryStore(str(tmp_path)).info("NONE")["rows"] == 0
```

- [ ] **Step 2: Create `app/store/history.py`**
```python
"""Accumulating 1-minute bar history per symbol (CSV). The dataset the Phase 9
ML model will train on. Dedups by timestamp; append-only."""
import os
import pandas as pd

COLS = ["timestamp", "open", "high", "low", "close", "volume"]


class HistoryStore:
    def __init__(self, base_dir: str):
        self._dir = os.path.join(base_dir, "history")
        os.makedirs(self._dir, exist_ok=True)

    def _path(self, symbol: str) -> str:
        return os.path.join(self._dir, f"{symbol.upper()}.csv")

    def append(self, symbol: str, df: pd.DataFrame):
        if df is None or df.empty:
            return
        new = df[COLS].copy()
        path = self._path(symbol)
        if os.path.exists(path):
            old = pd.read_csv(path)
            merged = pd.concat([old, new], ignore_index=True)
        else:
            merged = new
        merged = merged.drop_duplicates(subset=["timestamp"]).sort_values("timestamp")
        merged.to_csv(path, index=False)

    def info(self, symbol: str) -> dict:
        path = self._path(symbol)
        if not os.path.exists(path):
            return {"symbol": symbol.upper(), "rows": 0, "first": None, "last": None}
        d = pd.read_csv(path)
        if d.empty:
            return {"symbol": symbol.upper(), "rows": 0, "first": None, "last": None}
        return {"symbol": symbol.upper(), "rows": int(len(d)),
                "first": int(d["timestamp"].min()), "last": int(d["timestamp"].max())}
```

- [ ] **Step 3: Run → pass. Commit**
```
git add services/quant-py/app/store/history.py services/quant-py/tests/test_history_store.py
git commit -m "feat(store): add 1-minute history accumulator (CSV, dedup) for ML"
```

---

## Task 3: Wire stores into the sidecar (record on scan + read endpoints)

**Files:** modify `app/api.py`; Test `tests/test_store_api.py`

- [ ] **Step 1: Failing tests** — `tests/test_store_api.py`
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

def test_setups_scan_records_calibration_and_history(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import importlib, app.config, app.api
    importlib.reload(app.config); importlib.reload(app.api)
    from app.api import app as app2, get_market_data as gmd2
    c2 = TestClient(app2)
    app2.dependency_overrides[gmd2] = lambda: _FakeMD(_session())
    try:
        assert c2.get("/predict/setups/AAPL").status_code == 200
        stats = c2.get("/calibration/stats")
        assert stats.status_code == 200 and stats.json()["overall"]["n"] >= 0
        info = c2.get("/history/AAPL/info")
        assert info.status_code == 200 and info.json()["rows"] >= 1
    finally:
        app2.dependency_overrides.clear()
```
> Note: the reload pattern is needed so `DATA_DIR` points at the tmp dir. If reload proves flaky, an acceptable alternative is to construct the stores from `config.DATA_DIR` inside the endpoint (so monkeypatching env + reload of config suffices) — keep stores per-call cheap.

- [ ] **Step 2: Wire into `app/api.py`** — add singletons + record on the setups scan + read endpoints. After the imports, add:
```python
from app.store.calibration import CalibrationStore
from app.store.history import HistoryStore

_calib = CalibrationStore(__import__("os").path.join(config.DATA_DIR, "calibration.db"))
_history = HistoryStore(config.DATA_DIR)
```
In `predict_setups`, after `df = md.fetch_candles(...)` succeeds and before returning, persist (best-effort — never break the response):
```python
    try:
        _history.append(sym, df)
    except Exception:
        pass
    result = scan_setups(sym, df, daily_atr=_daily_atr(md, sym), prior_day_high=pdh, prior_day_low=pdl,
                         interval_minutes=_INTERVAL_MINUTES.get(interval, 1))
    try:
        _calib.record_setups(sym, [s.model_dump() for s in result.setups])
    except Exception:
        pass
    return result
```
(Replace the existing `return scan_setups(...)` with the block above; keep `pdh, pdl` as already computed.)

Add read endpoints:
```python
@app.get("/calibration/stats")
def calibration_stats():
    return _calib.stats()

@app.get("/history/{symbol}/info")
def history_info(symbol: str):
    return _history.info(symbol.upper())
```

- [ ] **Step 3: Run sidecar `pytest` → green. Commit**
```
git add services/quant-py/app/api.py services/quant-py/tests/test_store_api.py
git commit -m "feat(store): record setups + 1-min history on scan; expose stats/info"
```

---

## Task 4: Node route + UI prefers durable stats

**Files:** `src/sidecar.js`, `src/predict-service.js`, `src/predict-routes.js`; `public/predictions.js`

- [ ] **Step 1: Add to `src/sidecar.js`**
```js
    calibrationStats: () => request('GET', '/calibration/stats'),
```
- [ ] **Step 2: Add to `src/predict-service.js`** (TTL + method)
```js
  calibrationStats: 60 * 1000,
// ...
    calibrationStats: () => cached('calibrationStats', 'ALL', () => sidecar.calibrationStats()),
```
- [ ] **Step 3: Add to `src/predict-routes.js`**
```js
  router.get('/calibration/stats', wrap(() => service.calibrationStats()));
```
- [ ] **Step 4: UI — prefer durable server stats in `public/predictions.js`** — change `renderTrack` to try the server first, fall back to the localStorage journal. Replace the body of `renderTrack` so it fetches `/api/predict/calibration/stats`; on success render those groups/overall (server, durable, cross-device) with a "durable" tag; on failure render the existing localStorage aggregation. Keep the existing `trackStats()` (localStorage) as the fallback path. Concretely, wrap the current render logic in a `renderTrackFrom(st, durable)` helper that both paths call, where `st` has the shape `{groups:[{type,n,win,loss,pending,hit_rate,avg_rr}], overall:{...}}`:
```js
  function renderTrack() {
    var node = el('predTrack'); if (!node) return;
    fetch('/api/predict/calibration/stats').then(function (r) {
      if (!r.ok) throw new Error('no'); return r.json();
    }).then(function (st) {
      if (st && st.overall && st.overall.n > 0) renderTrackFrom(node, st, true);
      else renderTrackFrom(node, _localStats(), false);
    }).catch(function () { renderTrackFrom(node, _localStats(), false); });
  }
```
Add `_localStats()` that returns the existing localStorage aggregation in the SAME shape (`hit_rate` 0..1, `avg_rr`), and `renderTrackFrom(node, st, durable)` that renders the table (reuse the existing markup; show "· durable" in the header when `durable`, else "· this browser"). Keep `logSetups` running (harmless; it feeds the fallback).

- [ ] **Step 5: Verify** — `node --check public/predictions.js`; `node --test`; sidecar `pytest`. Commit.
```
git add src/sidecar.js src/predict-service.js src/predict-routes.js public/predictions.js
git commit -m "feat(store): durable calibration stats endpoint + UI prefers it over localStorage"
```

---

## Task 5: Render Persistent Disk

**Files:** `render.yaml`

- [ ] **Step 1: Add a disk + DATA_DIR to the `quant-py` service** (keep existing fields/envVars):
```yaml
  - type: web
    name: quant-py
    runtime: docker
    plan: starter
    rootDir: services/quant-py
    dockerfilePath: ./Dockerfile
    healthCheckPath: /health
    autoDeploy: true
    disk:
      name: quant-data
      mountPath: /data
      sizeGB: 1
    envVars:
      - key: DATA_DIR
        value: /data
      - key: FRED_API_KEY
        sync: false
      - key: FMP_API_KEY
        sync: false
      - key: FINNHUB_API_KEY
        sync: false
```

- [ ] **Step 2: Commit**
```
git add render.yaml
git commit -m "ci(render): add persistent disk + DATA_DIR for the durable store"
```

---

## Acceptance criteria
- [ ] Sidecar `pytest` + Node `node --test` green.
- [ ] `CalibrationStore` records/upserts setups by id and aggregates hit-rate/avg-R:R per type + overall (pending excluded from hit-rate).
- [ ] `HistoryStore` appends 1-min bars deduped by timestamp; `info` reports row count + range.
- [ ] `/predict/setups` scan persists calibration + history (best-effort, never breaks the response); `/calibration/stats` and `/history/{symbol}/info` read them back.
- [ ] `/api/predict/calibration/stats` proxied + cached; UI track-record shows **durable** server stats when present, localStorage fallback otherwise.
- [ ] `render.yaml` mounts a 1 GB disk at `/data` with `DATA_DIR=/data`. `.env` never staged.
- [ ] Branch `feat/phase-8-store` ready to merge.

## Self-review notes
- **Spec coverage:** durable cross-device calibration track-record (the "was R:R met over time" answer) + the 1-min history accumulation that is the **prerequisite for the Phase 9 ML model** — both on a Render disk, populated by piggybacking the existing scan (no extra fetches/cost).
- **Honesty:** hit-rate excludes pending; stats are real recorded outcomes; history is append-only deduped fact.
- **Determinism/safety:** stores take an injectable path; tests use `tmp_path`; persistence is best-effort and never breaks a prediction response.
- **No new deps:** stdlib `sqlite3` + pandas (already present).

## Enables Phase 9
Once a few weeks of `history/{symbol}.csv` accumulate, the qlib pipeline trains on them (features from the existing quant cores, triple-barrier labels), and the trained model joins the consensus as one more voice — benchmarked against the durable track-record built here.
