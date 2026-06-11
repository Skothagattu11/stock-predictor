import numpy as np
import pandas as pd
import pytest

BASE_TS = 1_749_652_200   # fixed epoch seconds — deterministic, no wall-clock

def _candles(close, vol):
    close = np.asarray(close, dtype=float)
    n = len(close)
    ts = BASE_TS + np.arange(n) * 300   # 5-min bars
    return pd.DataFrame({
        "timestamp": ts,
        "open": close,
        "high": close + 0.3,
        "low": close - 0.3,
        "close": close,
        "volume": np.asarray(vol, dtype=float),
    })

@pytest.fixture
def bullish_df():
    # rising, with a breakout and rising volume in the last third
    close = np.linspace(100, 106, 40)
    vol = np.concatenate([np.full(27, 100.0), np.full(13, 400.0)])
    return _candles(close, vol)

@pytest.fixture
def bearish_df():
    close = np.linspace(106, 100, 40)
    vol = np.concatenate([np.full(27, 100.0), np.full(13, 400.0)])
    return _candles(close, vol)

@pytest.fixture
def flat_df():
    close = np.full(40, 100.0)
    return _candles(close, np.full(40, 100.0))
