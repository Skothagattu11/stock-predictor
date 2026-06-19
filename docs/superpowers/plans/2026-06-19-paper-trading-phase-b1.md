# Paper Trading (Phase B-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-simulated US-equity paper-trading book that fills Goal Planner picks at live prices, auto-closes at target/stop, and reports a durable win-rate/return track record.

**Architecture:** Engine + SQLite store + a 60s background tick live in the always-on Python sidecar (persistent disk); Node proxies `/api/paper/*`; the frontend adds a Paper Trading panel and a "Paper Trade" button on each pick.

**Tech Stack:** Python 3.13 / FastAPI / sqlite3 / pytest (sidecar); Node 22 / Express / node:test; vanilla JS.

**Spec:** `docs/superpowers/specs/2026-06-19-paper-trading-design.md`

---

## File Structure

**Create:**
- `services/quant-py/app/store/paper.py` — `PaperStore` (SQLite account/positions/settings).
- `services/quant-py/app/paper/__init__.py` — empty package marker.
- `services/quant-py/app/paper/engine.py` — pure logic (open/exit/mark/stats).
- `services/quant-py/tests/test_paper_store.py`, `tests/test_paper_engine.py`, `tests/test_paper_api.py`.
- `src/paper-routes.js` — Node `/api/paper/*` proxy.
- `public/paper.js` — Paper Trading panel.
- `test/paper-routes.test.js`.

**Modify:**
- `services/quant-py/app/api.py` — `scan_opportunities` refactor, `_paper` singleton, paper endpoints, lifespan tick.
- `src/sidecar.js` — paper client methods.
- `src/server.js` — mount the paper router.
- `public/opportunities.js` — "Paper Trade" button per pick.
- `public/index.html` — Paper Trading panel + script include.

---

### Task 1: `PaperStore` (SQLite)

**Files:**
- Create: `services/quant-py/app/store/paper.py`
- Test: `services/quant-py/tests/test_paper_store.py`

- [ ] **Step 1: Write the failing test**

```python
# services/quant-py/tests/test_paper_store.py
import os
from app.store.paper import PaperStore

def _store(tmp_path):
    return PaperStore(os.path.join(tmp_path, "paper.db"))

def test_seeds_account_with_starting_cash(tmp_path):
    s = _store(tmp_path)
    acct = s.get_account()
    assert acct["cash"] == 10000.0 and acct["starting"] == 10000.0

def test_open_position_debits_cash_and_lists_open(tmp_path):
    s = _store(tmp_path)
    pid = s.open_position("AAPL", shares=5, entry=40.0, target=42.0, stop=38.0, cost=200.0, source="manual")
    assert isinstance(pid, str)
    assert s.get_account()["cash"] == 9800.0
    opens = s.list_positions(status="open")
    assert len(opens) == 1 and opens[0]["symbol"] == "AAPL" and opens[0]["shares"] == 5

def test_close_position_credits_cash_and_moves_to_closed(tmp_path):
    s = _store(tmp_path)
    pid = s.open_position("AAPL", 5, 40.0, 42.0, 38.0, 200.0, "manual")
    s.close_position(pid, exit_price=42.0, exit_reason="target")
    assert s.get_account()["cash"] == 9800.0 + 5 * 42.0
    assert s.list_positions(status="open") == []
    closed = s.list_positions(status="closed")
    assert closed[0]["exit_reason"] == "target" and closed[0]["status"] == "closed"

def test_settings_roundtrip_and_reset(tmp_path):
    s = _store(tmp_path)
    assert s.get_settings()["auto_enabled"] == 0
    s.set_settings(auto_enabled=1, budget=200.0, target=12.0, risk="balanced")
    assert s.get_settings()["budget"] == 200.0 and s.get_settings()["auto_enabled"] == 1
    s.open_position("AAPL", 5, 40.0, 42.0, 38.0, 200.0, "manual")
    s.reset(starting=10000.0)
    assert s.get_account()["cash"] == 10000.0 and s.list_positions() == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/quant-py && ./.venv/Scripts/python.exe -m pytest tests/test_paper_store.py -v`
Expected: FAIL — `ModuleNotFoundError: app.store.paper`.

- [ ] **Step 3: Write minimal implementation**

```python
# services/quant-py/app/store/paper.py
"""Durable paper-trading book (SQLite): one cash account, open/closed positions,
and the auto-mode settings. Mirrors CalibrationStore; lives on the /data disk."""
import os
import sqlite3
import uuid
from datetime import datetime, timezone


def _now():
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class PaperStore:
    def __init__(self, path: str, starting: float = 10000.0):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._path = path
        self._init(starting)

    def _conn(self):
        c = sqlite3.connect(self._path)
        c.row_factory = sqlite3.Row
        return c

    def _init(self, starting):
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS account (
                id INTEGER PRIMARY KEY CHECK (id=1), cash REAL, starting REAL, created_at TEXT)""")
            c.execute("""CREATE TABLE IF NOT EXISTS positions (
                id TEXT PRIMARY KEY, symbol TEXT, shares REAL, entry REAL, target REAL, stop REAL,
                opened_at TEXT, status TEXT, exit_price REAL, exit_reason TEXT, closed_at TEXT, source TEXT)""")
            c.execute("""CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id=1), auto_enabled INTEGER, budget REAL, target REAL, risk TEXT)""")
            if c.execute("SELECT COUNT(*) FROM account").fetchone()[0] == 0:
                c.execute("INSERT INTO account (id, cash, starting, created_at) VALUES (1,?,?,?)",
                          (starting, starting, _now()))
            if c.execute("SELECT COUNT(*) FROM settings").fetchone()[0] == 0:
                c.execute("INSERT INTO settings (id, auto_enabled, budget, target, risk) VALUES (1,0,200.0,12.0,'balanced')")

    def get_account(self) -> dict:
        with self._conn() as c:
            return dict(c.execute("SELECT cash, starting, created_at FROM account WHERE id=1").fetchone())

    def open_position(self, symbol, shares, entry, target, stop, cost, source) -> str:
        pid = uuid.uuid4().hex
        with self._conn() as c:
            c.execute("""INSERT INTO positions
                (id, symbol, shares, entry, target, stop, opened_at, status, source)
                VALUES (?,?,?,?,?,?,?, 'open', ?)""",
                      (pid, symbol.upper(), shares, entry, target, stop, _now(), source))
            c.execute("UPDATE account SET cash = cash - ? WHERE id=1", (cost,))
        return pid

    def close_position(self, pid, exit_price, exit_reason):
        with self._conn() as c:
            row = c.execute("SELECT shares, status FROM positions WHERE id=?", (pid,)).fetchone()
            if not row or row["status"] != "open":
                return
            c.execute("""UPDATE positions SET status='closed', exit_price=?, exit_reason=?, closed_at=?
                WHERE id=?""", (exit_price, exit_reason, _now(), pid))
            c.execute("UPDATE account SET cash = cash + ? WHERE id=1", (row["shares"] * exit_price,))

    def list_positions(self, status: str | None = None) -> list[dict]:
        q = "SELECT * FROM positions"
        args = ()
        if status:
            q += " WHERE status=?"; args = (status,)
        q += " ORDER BY opened_at DESC"
        with self._conn() as c:
            return [dict(r) for r in c.execute(q, args).fetchall()]

    def get_settings(self) -> dict:
        with self._conn() as c:
            return dict(c.execute("SELECT auto_enabled, budget, target, risk FROM settings WHERE id=1").fetchone())

    def set_settings(self, auto_enabled, budget, target, risk):
        with self._conn() as c:
            c.execute("UPDATE settings SET auto_enabled=?, budget=?, target=?, risk=? WHERE id=1",
                      (1 if auto_enabled else 0, budget, target, risk))

    def reset(self, starting: float = 10000.0):
        with self._conn() as c:
            c.execute("DELETE FROM positions")
            c.execute("UPDATE account SET cash=?, starting=?, created_at=? WHERE id=1",
                      (starting, starting, _now()))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/quant-py && ./.venv/Scripts/python.exe -m pytest tests/test_paper_store.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add services/quant-py/app/store/paper.py services/quant-py/tests/test_paper_store.py
git commit -m "feat(paper): SQLite PaperStore (account/positions/settings)"
```

---

### Task 2: Paper engine (pure logic)

**Files:**
- Create: `services/quant-py/app/paper/__init__.py` (empty), `services/quant-py/app/paper/engine.py`
- Test: `services/quant-py/tests/test_paper_engine.py`

- [ ] **Step 1: Write the failing test**

```python
# services/quant-py/tests/test_paper_engine.py
from app.paper.engine import open_order, evaluate_exit, mark_to_market, portfolio_stats

def test_open_order_computes_shares_and_cost():
    o = open_order(cash=10000.0, symbol="AAPL", price=40.0, budget=200.0, target=42.0, stop=38.0)
    assert "error" not in o
    assert o["shares"] == 5 and o["cost"] == 200.0 and o["entry"] == 40.0

def test_open_order_rejects_when_unaffordable_or_no_cash():
    assert "error" in open_order(10000.0, "BRK", 300.0, 200.0, 320.0, 280.0)   # shares < 1
    assert "error" in open_order(100.0, "AAPL", 40.0, 200.0, 42.0, 38.0)       # cost > cash

def test_evaluate_exit_target_then_stop_and_none():
    pos = {"target": 42.0, "stop": 38.0}
    assert evaluate_exit(pos, [{"high": 41, "low": 39}, {"high": 42.5, "low": 40}]) == ("target", 42.0)
    assert evaluate_exit(pos, [{"high": 41, "low": 37.5}]) == ("stop", 38.0)
    assert evaluate_exit(pos, [{"high": 41, "low": 39}]) is None
    # both in one bar -> conservative stop
    assert evaluate_exit(pos, [{"high": 43, "low": 37}]) == ("stop", 38.0)
    # chronology: target bar first -> target wins
    assert evaluate_exit(pos, [{"high": 42, "low": 39}, {"high": 41, "low": 37}]) == ("target", 42.0)

def test_evaluate_exit_skips_when_no_levels():
    assert evaluate_exit({"target": None, "stop": None}, [{"high": 99, "low": 1}]) is None

def test_mark_to_market():
    m = mark_to_market({"shares": 5, "entry": 40.0}, last_price=44.0)
    assert m["unrealized_pnl_abs"] == 20.0 and round(m["unrealized_pnl_pct"], 4) == 0.1

def test_portfolio_stats():
    closed = [
        {"shares": 5, "entry": 40.0, "exit_price": 42.0},   # +10
        {"shares": 5, "entry": 40.0, "exit_price": 38.0},   # -10
        {"shares": 2, "entry": 50.0, "exit_price": 55.0},   # +10
    ]
    st = portfolio_stats(closed, starting=10000.0)
    assert st["wins"] == 2 and st["losses"] == 1
    assert round(st["win_rate"], 3) == 0.667
    assert st["realized_pnl"] == 10.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/quant-py && ./.venv/Scripts/python.exe -m pytest tests/test_paper_engine.py -v`
Expected: FAIL — `ModuleNotFoundError: app.paper.engine`.

- [ ] **Step 3: Write minimal implementation**

```python
# services/quant-py/app/paper/__init__.py
```
(empty file)

```python
# services/quant-py/app/paper/engine.py
"""Pure paper-trading math: order sizing, exit detection, mark-to-market, stats.
No I/O — callers supply prices/bars and persist via PaperStore."""
import math


def open_order(cash, symbol, price, budget, target, stop) -> dict:
    if price is None or price <= 0:
        return {"error": "no live price"}
    shares = int(min(budget, cash) // price)
    if shares < 1:
        return {"error": "budget too small for one share"}
    cost = round(shares * price, 4)
    if cost > cash + 1e-9:
        return {"error": "insufficient cash"}
    return {"symbol": symbol.upper(), "shares": shares, "cost": cost,
            "entry": price, "target": target, "stop": stop}


def evaluate_exit(position, bars):
    """Scan bars (each {'high','low'}) in order. First to touch target -> win,
    first to touch stop -> loss. A bar crossing both resolves to stop."""
    target, stop = position.get("target"), position.get("stop")
    if target is None and stop is None:
        return None
    for b in bars:
        hit_stop = stop is not None and b["low"] <= stop
        hit_target = target is not None and b["high"] >= target
        if hit_stop:                       # conservative when a bar spans both
            return ("stop", stop)
        if hit_target:
            return ("target", target)
    return None


def mark_to_market(position, last_price) -> dict:
    entry = position["entry"]; shares = position["shares"]
    pnl = (last_price - entry) * shares
    return {"last_price": last_price,
            "market_value": round(last_price * shares, 2),
            "unrealized_pnl_abs": round(pnl, 2),
            "unrealized_pnl_pct": round((last_price - entry) / entry, 6) if entry else 0.0}


def portfolio_stats(closed, starting) -> dict:
    wins = losses = 0
    win_sum = loss_sum = realized = 0.0
    for p in closed:
        pnl = (p["exit_price"] - p["entry"]) * p["shares"]
        realized += pnl
        if pnl >= 0:
            wins += 1; win_sum += pnl
        else:
            losses += 1; loss_sum += pnl
    decided = wins + losses
    return {
        "wins": wins, "losses": losses,
        "win_rate": round(wins / decided, 3) if decided else None,
        "avg_win": round(win_sum / wins, 2) if wins else None,
        "avg_loss": round(loss_sum / losses, 2) if losses else None,
        "realized_pnl": round(realized, 2),
        "total_return_pct": round(realized / starting, 4) if starting else 0.0,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/quant-py && ./.venv/Scripts/python.exe -m pytest tests/test_paper_engine.py -v`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add services/quant-py/app/paper/__init__.py services/quant-py/app/paper/engine.py services/quant-py/tests/test_paper_engine.py
git commit -m "feat(paper): pure engine (order sizing, exit detection, mark, stats)"
```

---

### Task 3: Factor out `scan_opportunities` (refactor, keep tests green)

**Files:**
- Modify: `services/quant-py/app/api.py` (the `/opportunities` endpoint, ~lines 292-332)

This extracts the candidate-build + score loop into a reusable function so both
the endpoint and the paper tick share one code path. No behavior change.

- [ ] **Step 1: Add `scan_opportunities` and call it from the endpoint**

Replace the body of the `opportunities` endpoint. Add this function immediately
above the `@app.get("/opportunities" ...)` decorator:

```python
def scan_opportunities(md, providers, budget: float, target: float, risk: str) -> list[dict]:
    """Build the candidate universe (lane-filtered by risk) and score each into an
    OpportunityPick dict, ranked by expected value. Shared by the endpoint and the
    paper auto-tick."""
    fmp, yahoo = providers
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
            datr = (float(ind.atr(ddf["high"], ddf["low"], ddf["close"], 14).iloc[-1])
                    if len(ddf) >= 15 else None)
            return score_opportunity(sym, idf, ddf, pe=_pe_for(md, sym), daily_atr=datr,
                                     budget=budget, target=target, threshold=threshold)
        except Exception:
            return None

    picks = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for res in ex.map(_score, candidates):
            if res:
                picks.append(res)
    def _ev(p):
        return p["probability"] * p["target_dollars"] - (1 - p["probability"]) * p["risk_dollars"]
    picks.sort(key=lambda p: (_ev(p), p["reward_risk"]), reverse=True)
    return picks
```

Then make the endpoint use it (keep the 503 guards):

```python
@app.get("/opportunities", response_model=OpportunitiesResult)
def opportunities(budget: float = 150.0, target: float = 12.0, risk: str = "balanced",
                  md: MarketData = Depends(get_market_data),
                  providers=Depends(get_discover_providers)):
    fmp, yahoo = providers
    if fmp is None and yahoo is None:
        raise HTTPException(status_code=503, detail="no screener provider configured")
    picks = scan_opportunities(md, providers, budget, target, risk)
    if not picks and not (build_discover(fmp, yahoo=yahoo).hot or
                          build_discover(fmp, yahoo=yahoo).penny or
                          build_discover(fmp, yahoo=yahoo).shine):
        raise HTTPException(status_code=503, detail="screener returned no candidates")
    picks = picks[:TOP_N]
    return OpportunitiesResult(
        budget=budget, target=target, risk=risk,
        picks=[OpportunityPick(**p) for p in picks], scanned=len(picks),
        as_of=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
```

Note: to avoid the double `build_discover` call above, prefer keeping the original
empty-universe guard structure — build the candidate list once. Cleaner final form:

```python
@app.get("/opportunities", response_model=OpportunitiesResult)
def opportunities(budget: float = 150.0, target: float = 12.0, risk: str = "balanced",
                  md: MarketData = Depends(get_market_data),
                  providers=Depends(get_discover_providers)):
    fmp, yahoo = providers
    if fmp is None and yahoo is None:
        raise HTTPException(status_code=503, detail="no screener provider configured")
    _, lanes = tier_config(risk)
    disc = build_discover(fmp, yahoo=yahoo)
    if not any(getattr(disc, lane, []) for lane in lanes):
        raise HTTPException(status_code=503, detail="screener returned no candidates")
    picks = scan_opportunities(md, providers, budget, target, risk)[:TOP_N]
    return OpportunitiesResult(
        budget=budget, target=target, risk=risk,
        picks=[OpportunityPick(**p) for p in picks], scanned=len(picks),
        as_of=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
```

Use this final form. `scanned` now reflects returned picks; that's acceptable.

- [ ] **Step 2: Run the existing opportunities tests**

Run: `cd services/quant-py && ./.venv/Scripts/python.exe -m pytest tests/test_api_opportunities.py -v`
Expected: PASS (the empty-lanes and ranking tests still pass; `scan_opportunities`
references the same monkeypatched module names).

- [ ] **Step 3: Commit**

```bash
git add services/quant-py/app/api.py
git commit -m "refactor(opportunities): extract scan_opportunities for reuse by paper tick"
```

---

### Task 4: Paper endpoints + store singleton

**Files:**
- Modify: `services/quant-py/app/api.py`
- Test: `services/quant-py/tests/test_paper_api.py`

- [ ] **Step 1: Write the failing test**

```python
# services/quant-py/tests/test_paper_api.py
import os
from fastapi.testclient import TestClient
import app.api as api
from app.api import app, get_market_data
from app.store.paper import PaperStore

class _MD:
    def __init__(self, price): self.price = price
    def fetch_candles(self, symbol, interval="1m", range_="1d"):
        import pandas as pd, numpy as np
        n = 5; ts = 1_700_000_000 + np.arange(n) * 60
        c = np.full(n, self.price)
        return pd.DataFrame({"timestamp": ts, "open": c, "high": c, "low": c, "close": c, "volume": np.full(n, 1e6)})

def _fresh(tmp_path):
    api._paper = PaperStore(os.path.join(tmp_path, "paper.db"))   # isolated store per test

def test_order_opens_position_and_debits_cash(tmp_path):
    _fresh(tmp_path)
    app.dependency_overrides[get_market_data] = lambda: _MD(40.0)
    try:
        r = TestClient(app).post("/paper/order", json={"symbol": "AAPL", "budget": 200, "target": 42, "stop": 38})
        assert r.status_code == 200
        p = TestClient(app).get("/paper/portfolio").json()
        assert p["account"]["cash"] == 9800.0
        assert len(p["open"]) == 1 and p["open"][0]["symbol"] == "AAPL"
    finally:
        app.dependency_overrides.clear()

def test_order_budget_too_small_is_400(tmp_path):
    _fresh(tmp_path)
    app.dependency_overrides[get_market_data] = lambda: _MD(500.0)   # 1 share = $500 > $200 budget
    try:
        r = TestClient(app).post("/paper/order", json={"symbol": "PRICEY", "budget": 200, "target": 520, "stop": 480})
        assert r.status_code == 400
    finally:
        app.dependency_overrides.clear()

def test_close_credits_cash(tmp_path):
    _fresh(tmp_path)
    app.dependency_overrides[get_market_data] = lambda: _MD(40.0)
    try:
        TestClient(app).post("/paper/order", json={"symbol": "AAPL", "budget": 200, "target": 42, "stop": 38})
        pid = TestClient(app).get("/paper/portfolio").json()["open"][0]["id"]
        api_md = _MD(44.0); app.dependency_overrides[get_market_data] = lambda: api_md
        r = TestClient(app).post(f"/paper/close/{pid}")
        assert r.status_code == 200
        cash = TestClient(app).get("/paper/portfolio").json()["account"]["cash"]
        assert cash == 9800.0 + 5 * 44.0
    finally:
        app.dependency_overrides.clear()

def test_reset_restores(tmp_path):
    _fresh(tmp_path)
    app.dependency_overrides[get_market_data] = lambda: _MD(40.0)
    try:
        TestClient(app).post("/paper/order", json={"symbol": "AAPL", "budget": 200, "target": 42, "stop": 38})
        TestClient(app).post("/paper/reset")
        p = TestClient(app).get("/paper/portfolio").json()
        assert p["account"]["cash"] == 10000.0 and p["open"] == []
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/quant-py && ./.venv/Scripts/python.exe -m pytest tests/test_paper_api.py -v`
Expected: FAIL — 404 (routes not defined).

- [ ] **Step 3: Implement the store singleton + endpoints**

Add the singleton next to `_calib`/`_history` (after their definitions ~line 219):

```python
from app.store.paper import PaperStore
from app.paper.engine import open_order, evaluate_exit, mark_to_market, portfolio_stats
from pydantic import BaseModel

_paper = PaperStore(_os.path.join(config.DATA_DIR, "paper.db"))


class PaperOrder(BaseModel):
    symbol: str
    budget: float = 200.0
    target: float | None = None
    stop: float | None = None


class PaperSettingsBody(BaseModel):
    auto_enabled: bool = False
    budget: float = 200.0
    target: float = 12.0
    risk: str = "balanced"


def _portfolio_payload(md) -> dict:
    acct = _paper.get_account()
    open_rows = _paper.list_positions(status="open")
    equity = acct["cash"]
    marked = []
    for p in open_rows:
        lp = _live_price(md, p["symbol"]) or p["entry"]
        m = mark_to_market(p, lp)
        equity += m["market_value"]
        marked.append({**p, **m})
    closed = _paper.list_positions(status="closed")
    return {"account": {**acct, "equity": round(equity, 2)},
            "open": marked, "stats": portfolio_stats(closed, acct["starting"])}


@app.post("/paper/order")
def paper_order(body: PaperOrder, md: MarketData = Depends(get_market_data)):
    sym = body.symbol.upper()
    if any(p["symbol"] == sym for p in _paper.list_positions(status="open")):
        raise HTTPException(status_code=400, detail="already holding an open position in " + sym)
    price = _live_price(md, sym)
    o = open_order(_paper.get_account()["cash"], sym, price, body.budget, body.target, body.stop)
    if "error" in o:
        raise HTTPException(status_code=400, detail=o["error"])
    pid = _paper.open_position(sym, o["shares"], o["entry"], body.target, body.stop, o["cost"], "manual")
    return {"id": pid, **o}


@app.post("/paper/close/{pid}")
def paper_close(pid: str, md: MarketData = Depends(get_market_data)):
    pos = next((p for p in _paper.list_positions(status="open") if p["id"] == pid), None)
    if pos is None:
        raise HTTPException(status_code=404, detail="no open position " + pid)
    price = _live_price(md, pos["symbol"]) or pos["entry"]
    _paper.close_position(pid, exit_price=price, exit_reason="manual")
    return {"id": pid, "exit_price": price, "exit_reason": "manual"}


@app.get("/paper/portfolio")
def paper_portfolio(md: MarketData = Depends(get_market_data)):
    return _portfolio_payload(md)


@app.get("/paper/history")
def paper_history():
    closed = _paper.list_positions(status="closed")
    return {"closed": closed, "stats": portfolio_stats(closed, _paper.get_account()["starting"])}


@app.get("/paper/settings")
def paper_settings():
    return _paper.get_settings()


@app.post("/paper/settings")
def paper_set_settings(body: PaperSettingsBody):
    _paper.set_settings(body.auto_enabled, body.budget, body.target, body.risk)
    return _paper.get_settings()


@app.post("/paper/reset")
def paper_reset():
    _paper.reset()
    return _paper.get_account()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/quant-py && ./.venv/Scripts/python.exe -m pytest tests/test_paper_api.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Run the full sidecar suite**

Run: `cd services/quant-py && ./.venv/Scripts/python.exe -m pytest -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add services/quant-py/app/api.py services/quant-py/tests/test_paper_api.py
git commit -m "feat(paper): order/close/portfolio/history/settings/reset endpoints"
```

---

### Task 5: Background tick (auto-exit + auto-take)

**Files:**
- Modify: `services/quant-py/app/api.py` (top: lifespan; helpers)

The tick runs only under the app lifespan (not on import), so the test suite
(which uses `TestClient(app)` without a context manager) never starts it.

- [ ] **Step 1: Implement the tick helpers and lifespan**

Add helpers near the paper endpoints:

```python
def _bars_since(df, opened_at_iso) -> list[dict]:
    """Today's 1-min bars at/after the position's open time, oldest first."""
    if df is None or df.empty:
        return []
    import calendar, time
    try:
        t = time.strptime(opened_at_iso, "%Y-%m-%dT%H:%M:%SZ")
        epoch = calendar.timegm(t)
    except Exception:
        epoch = 0
    out = []
    for _, row in df.iterrows():
        if int(row["timestamp"]) >= epoch:
            out.append({"high": float(row["high"]), "low": float(row["low"])})
    return out


def paper_tick(md):
    """One mark/exit + auto-take pass. Best-effort: never raises."""
    # 1. exits
    for p in _paper.list_positions(status="open"):
        if p["target"] is None and p["stop"] is None:
            continue
        try:
            df = md.fetch_candles(p["symbol"], interval="1m", range_="1d")
        except Exception:
            continue
        ex = evaluate_exit(p, _bars_since(df, p["opened_at"]))
        if ex:
            _paper.close_position(p["id"], exit_price=ex[1], exit_reason=ex[0])
    # 2. auto-take
    s = _paper.get_settings()
    if not s.get("auto_enabled"):
        return
    try:
        picks = scan_opportunities(md, get_discover_providers(), s["budget"], s["target"], s["risk"])
    except Exception:
        return
    held = {p["symbol"] for p in _paper.list_positions(status="open")}
    for pick in picks:
        sym = pick["symbol"]
        if sym in held:
            continue
        entry = pick["price"]
        target = round(entry * (1 + pick["required_move_pct"]), 4)
        stop_frac = pick["risk_dollars"] / pick["invested"] if pick["invested"] else 0.0
        stop = round(entry * (1 - stop_frac), 4)
        o = open_order(_paper.get_account()["cash"], sym, entry, s["budget"], target, stop)
        if "error" in o:
            continue
        _paper.open_position(sym, o["shares"], o["entry"], target, stop, o["cost"], "auto")
        held.add(sym)
```

Add the lifespan at the top of `api.py` (replace the bare `app = FastAPI(...)`):

```python
import asyncio
from contextlib import asynccontextmanager

PAPER_TICK_SECONDS = 60


@asynccontextmanager
async def lifespan(app):
    async def _loop():
        while True:
            await asyncio.sleep(PAPER_TICK_SECONDS)
            try:
                await asyncio.to_thread(paper_tick, YahooMarketData())
            except Exception:
                pass
    task = asyncio.create_task(_loop())
    try:
        yield
    finally:
        task.cancel()

app = FastAPI(title="quant-py", version="0.1.0", lifespan=lifespan)
```

Because `paper_tick` and `_paper` are defined far below `app = FastAPI(...)`, the
`_loop` closure references them by name at call time (after module import
completes), so the forward reference is fine.

- [ ] **Step 2: Add a direct unit test for the tick**

```python
# append to services/quant-py/tests/test_paper_api.py
def test_paper_tick_closes_on_target(tmp_path, monkeypatch):
    _fresh(tmp_path)
    # open a position at $40 with target $42 via the engine/store directly
    pid = api._paper.open_position("AAPL", 5, 40.0, 42.0, 38.0, 200.0, "manual")
    import pandas as pd, numpy as np
    class _MDhit:
        def fetch_candles(self, symbol, interval="1m", range_="1d"):
            ts = np.array([2_000_000_000, 2_000_000_060])   # >= opened_at epoch
            return pd.DataFrame({"timestamp": ts, "open": [40, 41], "high": [41, 42.5],
                                 "low": [39, 40], "close": [41, 42], "volume": [1e6, 1e6]})
    api._paper.set_settings(auto_enabled=0, budget=200, target=12, risk="balanced")
    api.paper_tick(_MDhit())
    closed = api._paper.list_positions(status="closed")
    assert len(closed) == 1 and closed[0]["exit_reason"] == "target"
```

- [ ] **Step 3: Run tests**

Run: `cd services/quant-py && ./.venv/Scripts/python.exe -m pytest tests/test_paper_api.py -v && ./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS (all).

- [ ] **Step 4: Commit**

```bash
git add services/quant-py/app/api.py services/quant-py/tests/test_paper_api.py
git commit -m "feat(paper): 60s background tick — auto-exit at target/stop + auto-take"
```

---

### Task 6: Node proxy (client + routes + mount)

**Files:**
- Modify: `src/sidecar.js`, `src/server.js`
- Create: `src/paper-routes.js`
- Test: `test/paper-routes.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/paper-routes.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { createPaperRouter } = require('../src/paper-routes');

function appWith(sidecar) {
  const app = express();
  app.use(express.json());
  app.use('/api/paper', createPaperRouter({ sidecar }));
  return app;
}
async function listen(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('GET /api/paper/portfolio proxies to sidecar', async () => {
  const sidecar = { paperPortfolio: async () => ({ account: { cash: 10000 }, open: [], stats: {} }) };
  const { server, base } = await listen(appWith(sidecar));
  try {
    const r = await fetch(`${base}/api/paper/portfolio`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).account.cash, 10000);
  } finally { server.close(); }
});

test('POST /api/paper/order forwards the body', async () => {
  let got;
  const sidecar = { paperOrder: async (b) => (got = b, { id: 'x', shares: 5 }) };
  const { server, base } = await listen(appWith(sidecar));
  try {
    const r = await fetch(`${base}/api/paper/order`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', budget: 200, target: 42, stop: 38 }),
    });
    assert.equal((await r.json()).shares, 5);
    assert.equal(got.symbol, 'AAPL');
  } finally { server.close(); }
});

test('upstream 400 (rejected order) is forwarded', async () => {
  const err = new Error('sidecar /paper/order -> 400'); err.status = 400;
  const sidecar = { paperOrder: async () => { throw err; } };
  const { server, base } = await listen(appWith(sidecar));
  try {
    const r = await fetch(`${base}/api/paper/order`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/paper-routes.test.js`
Expected: FAIL — cannot find `../src/paper-routes`.

- [ ] **Step 3: Implement client, router, mount**

Add to the returned object in `src/sidecar.js` (after `opportunities`):

```javascript
    paperOrder: (body) => request('POST', '/paper/order', body),
    paperClose: (id) => request('POST', `/paper/close/${encodeURIComponent(id)}`),
    paperPortfolio: () => request('GET', '/paper/portfolio'),
    paperHistory: () => request('GET', '/paper/history'),
    paperSettings: () => request('GET', '/paper/settings'),
    paperSetSettings: (body) => request('POST', '/paper/settings', body),
    paperReset: () => request('POST', '/paper/reset'),
```

Create `src/paper-routes.js`:

```javascript
'use strict';
const express = require('express');

// Paper-trading proxy. State is live (positions/cash), so nothing is cached.
function createPaperRouter({ sidecar }) {
  const router = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      const up = e && Number.isInteger(e.status) ? e.status : null;
      res.status(up && up >= 400 && up < 500 ? up : 503)
        .json({ error: 'paper service unavailable', detail: e.message });
    }
  };
  router.get('/portfolio', wrap(() => sidecar.paperPortfolio()));
  router.get('/history', wrap(() => sidecar.paperHistory()));
  router.get('/settings', wrap(() => sidecar.paperSettings()));
  router.post('/settings', wrap((req) => sidecar.paperSetSettings(req.body || {})));
  router.post('/order', wrap((req) => sidecar.paperOrder(req.body || {})));
  router.post('/close/:id', wrap((req) => sidecar.paperClose(req.params.id)));
  router.post('/reset', wrap(() => sidecar.paperReset()));
  return router;
}
module.exports = { createPaperRouter };
```

Mount it in `src/server.js` (next to the other routers, after the predict router ~line 106):

```javascript
const { createPaperRouter } = require('./paper-routes');
app.use('/api/paper', createPaperRouter({ sidecar }));
```

- [ ] **Step 4: Run tests + full Node suite**

Run: `node --test test/paper-routes.test.js && node --test`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/sidecar.js src/paper-routes.js src/server.js test/paper-routes.test.js
git commit -m "feat(paper): Node /api/paper proxy (client + routes + mount)"
```

---

### Task 7: Frontend — Paper Trading panel + "Paper Trade" buttons

**Files:**
- Create: `public/paper.js`
- Modify: `public/index.html`, `public/opportunities.js`

- [ ] **Step 1: Add the panel markup + script include to `index.html`**

READ `index.html` first to match the existing `card`/`cardBody` structure and the
color vars. Add a panel near the Goal Planner section:

```html
<section id="paperPanel" class="card">
  <div class="cardBody">
    <div class="pcard-head"><span class="phbadge">Paper Trading</span>
      <span class="pmuted">Simulated trades at live prices — proof before real money.</span></div>
    <div id="paperAccount" class="pmuted">Loading…</div>
    <div class="gp-controls">
      <label><input type="checkbox" id="paperAuto"> Auto-take every pick</label>
      <label>Budget $ <input id="paperBudget" type="number" value="200" min="50"></label>
      <label>Target $ <input id="paperTarget" type="number" value="12" min="1"></label>
      <label>Risk
        <select id="paperRisk"><option value="cautious">Cautious</option>
          <option value="balanced" selected>Balanced</option>
          <option value="aggressive">Aggressive</option></select></label>
      <button id="paperReset">Reset account</button>
    </div>
    <div id="paperOpen"></div>
    <div id="paperHistory"></div>
  </div>
</section>
<script src="paper.js"></script>
```

Reuse the existing `.gp-controls` / `.gp-row` CSS; add minimal extra CSS in the
`<style>` block:

```html
<style>
  .pp-row{display:flex;justify-content:space-between;gap:8px;border:1px solid var(--line);border-radius:6px;padding:8px;margin:6px 0;background:var(--panel2)}
  .pp-up{color:var(--green)} .pp-down{color:var(--red)}
  #paperReset{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 10px;cursor:pointer}
</style>
```

- [ ] **Step 2: Implement `public/paper.js`**

```javascript
// public/paper.js — Paper Trading panel: account, open positions, history, auto-mode.
(function () {
  function el(id) { return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function money(x){ return '$' + Number(x).toFixed(2); }
  function signMoney(x){ return (x>=0?'+':'') + money(x); }

  function render(d) {
    var a = d.account, st = d.stats || {};
    el('paperAccount').innerHTML =
      'Equity <b>' + money(a.equity) + '</b> · Cash ' + money(a.cash) +
      ' · Realized <b class="' + (st.realized_pnl>=0?'pp-up':'pp-down') + '">' + signMoney(st.realized_pnl||0) + '</b>' +
      ' · Win rate <b>' + (st.win_rate!=null ? Math.round(st.win_rate*100)+'%' : '—') + '</b>' +
      ' (' + (st.wins||0) + 'W / ' + (st.losses||0) + 'L)';
    el('paperOpen').innerHTML = (d.open && d.open.length)
      ? '<div class="pmuted">Open positions</div>' + d.open.map(function(p){
          var cls = p.unrealized_pnl_abs>=0?'pp-up':'pp-down';
          return '<div class="pp-row"><span><b>'+esc(p.symbol)+'</b> '+p.shares+' sh @ '+money(p.entry)+
            ' → '+money(p.last_price)+'</span>'+
            '<span class="'+cls+'">'+signMoney(p.unrealized_pnl_abs)+'</span>'+
            '<button data-close="'+esc(p.id)+'">Close</button></div>';
        }).join('')
      : '<div class="pmuted">No open paper positions.</div>';
    Array.prototype.forEach.call(el('paperOpen').querySelectorAll('button[data-close]'), function(b){
      b.addEventListener('click', function(){
        fetch('/api/paper/close/'+encodeURIComponent(b.getAttribute('data-close')),{method:'POST'})
          .then(load); });
    });
  }

  function load() {
    fetch('/api/paper/portfolio').then(function(r){return r.json();}).then(render)
      .catch(function(){ el('paperAccount').textContent = 'Paper service unavailable.'; });
  }

  function init() {
    if (!el('paperPanel')) return;
    fetch('/api/paper/settings').then(function(r){return r.json();}).then(function(s){
      el('paperAuto').checked = !!s.auto_enabled;
      el('paperBudget').value = s.budget; el('paperTarget').value = s.target; el('paperRisk').value = s.risk;
    }).catch(function(){});
    function saveSettings(){
      fetch('/api/paper/settings',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({auto_enabled:el('paperAuto').checked,budget:Number(el('paperBudget').value),
          target:Number(el('paperTarget').value),risk:el('paperRisk').value})});
    }
    ['paperAuto','paperBudget','paperTarget','paperRisk'].forEach(function(id){
      el(id).addEventListener('change', saveSettings); });
    el('paperReset').addEventListener('click', function(){
      if (confirm('Reset paper account to $10,000 and clear positions?'))
        fetch('/api/paper/reset',{method:'POST'}).then(load); });
    load();
    setInterval(function(){ if (!document.hidden) load(); }, 30000);
  }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
  window.Paper = { reload: load };
})();
```

- [ ] **Step 3: Add a "Paper Trade" button to each pick in `public/opportunities.js`**

In the `row(p)` function, add a button to the last line, and a click handler in
`render`. The target/stop prices derive from the pick:

```javascript
// in row(p), append inside the last <div> (the +target/-risk line), before its closing tag:
'  <button class="gp-paper" data-sym="' + esc(p.symbol) +
  '" data-budget="' + p.invested.toFixed(2) +
  '" data-target="' + (p.price * (1 + p.required_move_pct)).toFixed(4) +
  '" data-stop="' + (p.price * (1 - (p.risk_dollars / p.invested))).toFixed(4) +
  '">Paper Trade</button>'
```

In `render`, after wiring the row click handlers, add (and stop the button click
from also triggering the row's deep-dive via `stopPropagation`):

```javascript
Array.prototype.forEach.call(node.querySelectorAll('.gp-paper'), function (b) {
  b.addEventListener('click', function (ev) {
    ev.stopPropagation();
    fetch('/api/paper/order', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: b.getAttribute('data-sym'),
        budget: Number(b.getAttribute('data-budget')),
        target: Number(b.getAttribute('data-target')),
        stop: Number(b.getAttribute('data-stop')) }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        b.textContent = res.ok ? '✓ Paper traded' : (res.j.detail || 'rejected');
        if (res.ok && window.Paper) window.Paper.reload();
      })
      .catch(function () { b.textContent = 'error'; });
  });
});
```

Add minimal CSS for `.gp-paper` in `index.html` (reuse `#gpScan` styling):

```html
<style>.gp-paper{background:var(--blue);color:#fff;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;margin-left:8px;font-size:12px}</style>
```

- [ ] **Step 4: Syntax-check + manual smoke**

Run: `node --check public/paper.js && node --check public/opportunities.js`
Expected: both OK.
Then (sidecar running, `QUANT_SIDECAR_URL` set): open the app, Scan, click
**Paper Trade** on a pick → it shows "✓ Paper traded" and the Paper Trading panel
updates with the open position; the per-row **Close** button closes it; **Reset**
restores $10,000.

- [ ] **Step 5: Commit**

```bash
git add public/paper.js public/opportunities.js public/index.html
git commit -m "feat(paper): Paper Trading panel + Paper Trade button on picks"
```

---

## Final Review

After all tasks: run `cd services/quant-py && ./.venv/Scripts/python.exe -m pytest -q`
and `node --test` (both green), dispatch a final code review over the diff, verify
`.env` unstaged, then merge to `main` and push (Render auto-deploys; the sidecar's
disk persists the paper book).

No new env vars are required for paper trading.
