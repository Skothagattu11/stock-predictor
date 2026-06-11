import numpy as np
import pandas as pd
from app import indicators as ind

def test_ema_of_constant_series_is_the_constant():
    s = pd.Series([10.0] * 30)
    assert abs(ind.ema(s, 9).iloc[-1] - 10.0) < 1e-6

def test_rsi_of_strictly_increasing_series_approaches_100():
    s = pd.Series(np.arange(1, 31, dtype=float))
    assert ind.rsi(s, 14).iloc[-1] > 99.0

def test_atr_is_positive_and_finite():
    n = 30
    high = pd.Series(np.full(n, 11.0))
    low = pd.Series(np.full(n, 9.0))
    close = pd.Series(np.full(n, 10.0))
    val = ind.atr(high, low, close, 14).iloc[-1]
    assert np.isfinite(val) and val > 0

def test_session_vwap_of_constant_price_equals_price():
    df = pd.DataFrame({"high":[10.0]*5,"low":[10.0]*5,"close":[10.0]*5,"volume":[100.0]*5})
    assert abs(ind.session_vwap(df).iloc[-1] - 10.0) < 1e-9

def test_session_vwap_within_price_range():
    df = pd.DataFrame({
        "high":[11,12,13,12,11], "low":[9,10,11,10,9],
        "close":[10,11,12,11,10], "volume":[100,200,150,120,180]})
    v = ind.session_vwap(df).iloc[-1]
    assert df["low"].min() <= v <= df["high"].max()

def test_relative_volume_ratio():
    vol = pd.Series([100.0]*5 + [300.0])   # 5 prior bars avg 100, last 300
    assert abs(ind.relative_volume(vol, lookback=5) - 3.0) < 1e-9
