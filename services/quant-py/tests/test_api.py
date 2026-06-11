from fastapi.testclient import TestClient
from app.api import app

client = TestClient(app)

def test_health_ok():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "quant-py"}


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
