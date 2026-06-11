from app.models import (Scenario, OutlookPrediction, PositionPrediction,
                        Holding, CorrelationPair, PortfolioAssessment, Driver)

def test_outlook_model():
    o = OutlookPrediction(symbol="AAPL", stance="Constructive", score=68.0, confidence=0.6,
        regime="risk_on", scenarios=[Scenario(case="base", probability=0.5,
        target_return_pct=0.04, target_price=208.0)], drivers=[Driver(name="12-1 momentum", direction="up")],
        as_of="2026-06-11T00:00:00Z")
    assert o.source == "quant" and o.horizon == "weeks_months"

def test_position_model():
    p = PositionPrediction(symbol="AAPL", action="HOLD", unrealized_pnl_pct=0.14,
        unrealized_pnl_abs=140.0, weight_pct=0.08, drivers=[], as_of="2026-06-11T00:00:00Z")
    assert p.action == "HOLD" and p.source == "quant"

def test_portfolio_model():
    pa = PortfolioAssessment(holdings=[Holding(symbol="AAPL", value=1000.0)],
        weights={"AAPL": 1.0}, concentration_hhi=1.0,
        correlations=[CorrelationPair(a="AAPL", b="MSFT", correlation=0.8)],
        flags=["single-name concentration"], as_of="2026-06-11T00:00:00Z")
    assert pa.concentration_hhi == 1.0
