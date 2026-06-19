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
