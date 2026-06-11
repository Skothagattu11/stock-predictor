from app.context.models import (
    Fundamentals, MacroSnapshot, ImpliedMove, FundamentalsResult, FieldDiscrepancy)

def test_fundamentals_defaults_are_none_and_sources_list():
    f = Fundamentals(symbol="AAPL", as_of="2026-06-11T00:00:00Z")
    assert f.sector is None and f.pe is None
    assert f.sources == []

def test_macro_snapshot_holds_yields():
    m = MacroSnapshot(as_of="2026-06-11T00:00:00Z", ten_year_yield=4.3,
                      two_year_yield=4.0, yield_curve_2s10s=0.3, vix=15.2,
                      unemployment=3.9, sources=["FRED"])
    assert m.yield_curve_2s10s == 0.3

def test_implied_move_roundtrip():
    im = ImpliedMove(symbol="AAPL", spot=200.0, atm_iv=0.25, expiry="2026-06-20",
                     days_to_expiry=9, expected_move_pct=0.039, expected_move_abs=7.8,
                     low=192.2, high=207.8, as_of="2026-06-11T00:00:00Z")
    assert im.high > im.spot > im.low

def test_fundamentals_result_carries_discrepancies():
    f = Fundamentals(symbol="AAPL", as_of="2026-06-11T00:00:00Z")
    r = FundamentalsResult(merged=f, discrepancies=[
        FieldDiscrepancy(field="pe", values={"finnhub": 25.0, "fmp": 30.0}, spread_pct=0.2)])
    assert r.discrepancies[0].field == "pe"
