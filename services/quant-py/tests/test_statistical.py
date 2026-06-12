import numpy as np, pandas as pd
from app.predictors.statistical import forecast

def _df(close):
    close = np.asarray(close, float); n = len(close)
    return pd.DataFrame({"timestamp": 1_700_000_000 + np.arange(n)*86400,
        "open": close, "high": close+1, "low": close-1, "close": close, "volume": np.full(n,1e6)})

def test_uptrend_forecasts_bullish():
    p = forecast("AAPL", _df(np.linspace(100, 130, 60)), mode="outlook")
    assert p.stance == "bullish" and p.confidence > 0
    assert p.source == "statistical"

def test_downtrend_forecasts_bearish():
    assert forecast("AAPL", _df(np.linspace(130, 100, 60)), mode="outlook").stance == "bearish"

def test_flat_is_neutral():
    assert forecast("AAPL", _df(np.full(60, 100.0)), mode="intraday").stance == "neutral"

def test_short_history_neutral_low_conf():
    p = forecast("AAPL", _df(np.linspace(100, 101, 5)), mode="intraday")
    assert p.stance == "neutral" and p.confidence == 0.0
