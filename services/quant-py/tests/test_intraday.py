from app.predictors.intraday import score_intraday

def test_bullish_series_scores_bullish(bullish_df):
    p = score_intraday("AAPL", bullish_df, interval_minutes=5)
    assert p.bias == "Bullish"
    assert p.probability_up > 0.5
    assert p.invalidation < p.expected_move.base          # stop sits below price
    assert any(d.direction == "up" for d in p.drivers)
    assert p.as_of.endswith("Z")                          # ISO from last candle ts

def test_bearish_series_scores_bearish(bearish_df):
    p = score_intraday("AAPL", bearish_df, interval_minutes=5)
    assert p.bias == "Bearish"
    assert p.probability_up < 0.5
    assert p.invalidation > p.expected_move.base          # stop sits above price

def test_flat_series_is_neutral(flat_df):
    p = score_intraday("AAPL", flat_df, interval_minutes=5)
    assert p.bias == "Neutral"
    assert 0.4 <= p.probability_up <= 0.6
    assert p.drivers == []

def test_bullish_levels_long_target_above_entry_above_stop(bullish_df):
    p = score_intraday("AAPL", bullish_df, interval_minutes=5)
    assert p.levels is not None and p.levels.direction == "long"
    assert p.levels.target > p.levels.entry > p.levels.stop
    assert abs(p.levels.risk_reward - 1.8) < 1e-9

def test_bearish_levels_short_target_below_entry_below_stop(bearish_df):
    p = score_intraday("AAPL", bearish_df, interval_minutes=5)
    assert p.levels is not None and p.levels.direction == "short"
    assert p.levels.target < p.levels.entry < p.levels.stop

def test_neutral_has_no_levels(flat_df):
    assert score_intraday("AAPL", flat_df, interval_minutes=5).levels is None

def test_expected_move_widens_in_high_vol():
    import numpy as np, pandas as pd
    from tests.conftest import BASE_TS
    close = np.full(40, 100.0)
    n = len(close)
    df = pd.DataFrame({
        "timestamp": BASE_TS + np.arange(n) * 300,
        "open": close, "high": close + 5.0, "low": close - 5.0,
        "close": close, "volume": np.full(n, 100.0)})
    p = score_intraday("AAPL", df, interval_minutes=5)
    assert p.regime == "high_vol"
    assert (p.expected_move.high - p.expected_move.low) > 10.0   # ~1.5x ATR each side
