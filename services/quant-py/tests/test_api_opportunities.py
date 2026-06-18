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
