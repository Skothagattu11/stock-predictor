import numpy as np
import pandas as pd
from app import indicators as ind
from app.regime import classify_regime

def _frame(close):
    close = pd.Series(close, dtype=float)
    high = close + 0.5
    low = close - 0.5
    vol = pd.Series(np.full(len(close), 100.0))
    return pd.DataFrame({"high": high, "low": low, "close": close, "volume": vol})

def test_strong_uptrend_classified_trend_up():
    df = _frame(np.linspace(100, 120, 40))
    r = classify_regime(df)
    assert r.label == "trend_up"
    assert 0.0 <= r.confidence <= 1.0

def test_strong_downtrend_classified_trend_down():
    df = _frame(np.linspace(120, 100, 40))
    assert classify_regime(df).label == "trend_down"

def test_flat_series_classified_range():
    df = _frame(np.full(40, 100.0))
    assert classify_regime(df).label == "range"

def test_large_atr_classified_high_vol():
    close = np.full(40, 100.0)
    df = pd.DataFrame({
        "high": close + 5.0, "low": close - 5.0,   # ~10% ATR
        "close": close, "volume": np.full(40, 100.0)})
    assert classify_regime(df).label == "high_vol"
