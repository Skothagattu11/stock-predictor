from app.context.models import Fundamentals
from app.context.crosscheck import merge_fundamentals

AS_OF = "2026-06-11T00:00:00Z"

def _f(source, **kw):
    return Fundamentals(symbol="AAPL", as_of=AS_OF, sources=[source], **kw)

def test_median_merge_no_discrepancy_when_close():
    r = merge_fundamentals("AAPL", [_f("finnhub", pe=25.0), _f("fmp", pe=25.5)])
    assert abs(r.merged.pe - 25.25) < 1e-9
    assert r.discrepancies == []
    assert set(r.merged.sources) == {"finnhub", "fmp"}

def test_discrepancy_flagged_when_sources_disagree():
    r = merge_fundamentals("AAPL", [_f("finnhub", pe=25.0), _f("fmp", pe=30.0)])
    assert len(r.discrepancies) == 1
    d = r.discrepancies[0]
    assert d.field == "pe"
    assert d.values == {"finnhub": 25.0, "fmp": 30.0}
    assert d.spread_pct > 0.10

def test_non_numeric_fields_take_first_non_null():
    r = merge_fundamentals("AAPL", [
        _f("finnhub", sector=None, next_earnings_date="2026-07-30"),
        _f("fmp", sector="Technology")])
    assert r.merged.sector == "Technology"
    assert r.merged.next_earnings_date == "2026-07-30"

def test_single_source_never_flags_discrepancy():
    r = merge_fundamentals("AAPL", [_f("finnhub", pe=25.0)])
    assert r.discrepancies == []
    assert r.merged.pe == 25.0

def test_missing_values_ignored():
    r = merge_fundamentals("AAPL", [_f("finnhub", pe=None), _f("fmp", pe=20.0)])
    assert r.merged.pe == 20.0
    assert r.discrepancies == []
