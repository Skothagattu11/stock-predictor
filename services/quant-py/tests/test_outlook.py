import numpy as np, pandas as pd
from app.predictors.outlook import score_outlook
from app.context.models import Fundamentals

def _daily(close):
    close = np.asarray(close, dtype=float); n = len(close)
    ts = 1_700_000_000 + np.arange(n) * 86400
    return pd.DataFrame({"timestamp": ts, "open": close, "high": close + 1,
                         "low": close - 1, "close": close, "volume": np.full(n, 1e6)})

def test_strong_uptrend_is_constructive():
    df = _daily(np.linspace(100, 200, 300))   # above rising 200d, strong 12-1 momentum
    o = score_outlook("AAPL", df)
    assert o.stance == "Constructive"
    assert o.regime == "risk_on"
    assert o.score > 60
    assert {s.case for s in o.scenarios} == {"bull", "base", "bear"}
    assert abs(sum(s.probability for s in o.scenarios) - 1.0) < 1e-6

def test_downtrend_is_cautious_risk_off():
    df = _daily(np.linspace(200, 100, 300))
    o = score_outlook("AAPL", df)
    assert o.stance == "Cautious"
    assert o.regime == "risk_off"

def test_relative_strength_vs_benchmark_lifts_score():
    sym = _daily(np.linspace(100, 160, 300))
    weak_bench = _daily(np.linspace(100, 105, 300))
    strong_bench = _daily(np.linspace(100, 200, 300))
    s_weak = score_outlook("AAPL", sym, benchmark_df=weak_bench).score
    s_strong = score_outlook("AAPL", sym, benchmark_df=strong_bench).score
    assert s_weak > s_strong   # outperforming a weak benchmark scores higher

def test_scenarios_bracket_base_and_use_volatility():
    df = _daily(np.linspace(100, 130, 300))
    o = score_outlook("AAPL", df)
    base = next(s for s in o.scenarios if s.case == "base")
    bull = next(s for s in o.scenarios if s.case == "bull")
    bear = next(s for s in o.scenarios if s.case == "bear")
    assert bear.target_price < base.target_price < bull.target_price

def test_bear_case_stays_realistic_even_when_constructive():
    # a strongly bullish read must still show a meaningful downside (drift is damped),
    # not a collapsed ~0% bear case.
    o = score_outlook("AAPL", _daily(np.linspace(100, 220, 300)))
    assert o.stance == "Constructive"
    bull = next(s for s in o.scenarios if s.case == "bull").target_return_pct
    bear = next(s for s in o.scenarios if s.case == "bear").target_return_pct
    assert bear < 0
    assert abs(bear) >= 0.3 * abs(bull)   # downside not swamped by the bullish tilt


def test_insufficient_history_raises():
    import pytest
    with pytest.raises(ValueError):
        score_outlook("AAPL", _daily(np.linspace(100, 110, 50)))   # <220 bars
