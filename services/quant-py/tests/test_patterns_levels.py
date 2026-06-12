import numpy as np, pandas as pd
from app.predictors.setups import _candle_pattern, _key_levels, scan_setups
from app.models import KeyLevel

def _df(rows):  # rows: list of (o,h,l,c)
    rows = np.array(rows, float); n = len(rows)
    return pd.DataFrame({"timestamp": 1_749_652_200 + np.arange(n)*60,
        "open": rows[:,0], "high": rows[:,1], "low": rows[:,2], "close": rows[:,3],
        "volume": np.full(n, 100.0)})

def test_bullish_engulfing_detected():
    d = _df([(100, 100.2, 99, 99.2), (99.1, 101.5, 99.0, 101.3)])  # red then engulfing green
    assert _candle_pattern(d["open"], d["high"], d["low"], d["close"], 1)[:2] == ("Bullish engulfing", "long")

def test_hammer_detected():
    d = _df([(100, 100.1, 100, 100.05), (100, 100.2, 98.5, 100.1)])  # long lower wick, small body
    assert _candle_pattern(d["open"], d["high"], d["low"], d["close"], 1)[:2] == ("Hammer", "long")

def test_key_levels_classified_around_price():
    close = np.linspace(100, 110, 80)
    d = _df([(c, c + 0.3, c - 0.3, c) for c in close])
    levels = _key_levels(d, price=float(close[-1]), prior_day_high=115.0, prior_day_low=95.0)
    assert any(l.label == "prior-day high" and l.kind == "resistance" for l in levels)
    assert any(l.label == "prior-day low" and l.kind == "support" for l in levels)
    assert all(l.kind == "resistance" for l in levels if l.price >= close[-1])

def test_scan_returns_levels():
    close = np.concatenate([np.full(15, 100.0), np.linspace(101, 110, 45)])
    d = _df([(c, c + 0.3, c - 0.3, c) for c in close])
    tl = scan_setups("AAPL", d, daily_atr=8.0, prior_day_high=112.0, prior_day_low=96.0)
    assert len(tl.levels) > 0
