from app.models import IntradayPrediction, ExpectedMove, Driver

def test_intraday_prediction_validates():
    p = IntradayPrediction(
        symbol="AAPL", bias="Bullish", probability_up=0.61,
        expected_move=ExpectedMove(low=99.0, base=100.0, high=101.0),
        regime="trend_up", regime_confidence=0.7, invalidation=98.5,
        drivers=[Driver(name="VWAP", direction="up")],
        as_of="2026-06-11T15:30:00Z")
    assert p.source == "quant"
    assert p.bias == "Bullish"

def test_probability_must_be_within_unit_interval():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        IntradayPrediction(
            symbol="AAPL", bias="Bullish", probability_up=1.5,
            expected_move=ExpectedMove(low=1, base=2, high=3),
            regime="range", regime_confidence=0.1, invalidation=1.0,
            drivers=[], as_of="2026-06-11T15:30:00Z")
