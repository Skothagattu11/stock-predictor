from app.discovery.scanner import build_discover, _rank_hot, _rank_penny

class _FakeFmp:
    def gainers(self): return [
        {"symbol": "HOT", "name": "Hot", "price": 20.0, "change_pct": 14.0, "volume": 9_000_000, "market_cap": 3e9, "sector": "Tech"}]
    def actives(self): return [
        {"symbol": "ACT", "name": "Act", "price": 50.0, "change_pct": 2.0, "volume": 30_000_000, "market_cap": 8e9, "sector": "Energy"}]
    def screener(self, **f):
        if f.get("priceLowerThan") == 5:
            return [{"symbol": "PNY", "name": "Penny", "price": 2.3, "change_pct": 20.0, "volume": 4_000_000, "market_cap": 2e8, "sector": "Bio"}]
        return [{"symbol": "SHN", "name": "Shine", "price": 80.0, "change_pct": 1.0, "volume": 2_000_000, "market_cap": 5e10, "sector": "Tech"}]

def test_build_discover_three_lanes():
    r = build_discover(_FakeFmp(), yahoo=None)
    assert any(i.symbol == "HOT" for i in r.hot)
    assert any(i.symbol == "PNY" for i in r.penny)
    assert any(i.symbol == "SHN" for i in r.shine)
    assert "fmp" in r.sources
    assert all(i.reason for i in r.hot)   # every item explains itself

def test_rank_hot_orders_by_score():
    rows = [{"symbol": "A", "change_pct": 5, "volume": 1e6, "price": 10},
            {"symbol": "B", "change_pct": 12, "volume": 5e6, "price": 10}]
    ranked = _rank_hot(rows)
    assert ranked[0]["symbol"] == "B"

def test_penny_filters_price():
    rows = [{"symbol": "P", "price": 3.0, "change_pct": 10, "volume": 2e6}]
    assert _rank_penny(rows)[0]["symbol"] == "P"

def test_empty_when_no_providers():
    r = build_discover(None, yahoo=None)
    assert r.hot == [] and r.penny == [] and r.shine == [] and r.sources == []
