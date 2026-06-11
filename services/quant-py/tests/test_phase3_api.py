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
