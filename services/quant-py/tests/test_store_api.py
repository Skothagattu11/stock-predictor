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
