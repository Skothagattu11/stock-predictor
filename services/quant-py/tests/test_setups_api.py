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
