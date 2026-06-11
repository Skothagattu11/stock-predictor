from fastapi.testclient import TestClient
from app.api import app

client = TestClient(app)

def test_health_ok():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "quant-py"}


import numpy as np
import pandas as pd
from app.api import app, get_market_data

class _FakeMarketData:
    def __init__(self, df): self._df = df
    def fetch_candles(self, symbol, interval, range_): return self._df

def _synthetic_df(n=40):
    """Enough bars (>=20) for the indicators to be defined — the endpoint guard
    requires 20, and a 3-row fixture would (correctly) 422."""
    close = np.linspace(100.0, 104.0, n)
    ts = 1_749_652_200 + np.arange(n) * 300
    return pd.DataFrame({
        "timestamp": ts, "open": close, "high": close + 0.3,
        "low": close - 0.3, "close": close,
        "volume": np.concatenate([np.full(n - 13, 100.0), np.full(13, 300.0)])})

def test_predict_intraday_returns_prediction():
    app.dependency_overrides[get_market_data] = lambda: _FakeMarketData(_synthetic_df())
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
