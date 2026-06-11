from app.models import Holding
from app.predictors.portfolio import assess_portfolio

def test_weights_and_hhi():
    pa = assess_portfolio([Holding(symbol="AAPL", value=6000.0),
                           Holding(symbol="MSFT", value=4000.0)])
    assert abs(pa.weights["AAPL"] - 0.6) < 1e-9
    assert abs(pa.concentration_hhi - (0.6**2 + 0.4**2)) < 1e-9

def test_single_name_concentration_flagged():
    pa = assess_portfolio([Holding(symbol="AAPL", value=9000.0),
                           Holding(symbol="MSFT", value=1000.0)])
    assert any("concentration" in f.lower() for f in pa.flags)

def test_high_correlation_pair_detected():
    up = [0.01, 0.02, -0.01, 0.03, 0.01]
    pa = assess_portfolio([
        Holding(symbol="AAPL", value=5000.0, returns=up),
        Holding(symbol="MSFT", value=5000.0, returns=up)])   # identical => corr 1.0
    pair = next(c for c in pa.correlations if {c.a, c.b} == {"AAPL", "MSFT"})
    assert pair.correlation > 0.95
    assert any("correlat" in f.lower() for f in pa.flags)

def test_no_returns_means_no_correlations():
    pa = assess_portfolio([Holding(symbol="AAPL", value=5000.0),
                           Holding(symbol="MSFT", value=5000.0)])
    assert pa.correlations == []
