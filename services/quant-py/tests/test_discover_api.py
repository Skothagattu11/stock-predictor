from fastapi.testclient import TestClient
from app.api import app, get_discover_providers

class _FakeFmp:
    def gainers(self): return [{"symbol": "HOT", "name": "H", "price": 20, "change_pct": 14, "volume": 9e6, "market_cap": 3e9, "sector": "Tech"}]
    def actives(self): return []
    def screener(self, **f): return []

client = TestClient(app)

def test_discover_endpoint():
    app.dependency_overrides[get_discover_providers] = lambda: (_FakeFmp(), None)
    try:
        r = client.get("/discover")
        assert r.status_code == 200
        assert any(i["symbol"] == "HOT" for i in r.json()["hot"])
    finally:
        app.dependency_overrides.clear()

def test_discover_503_when_no_providers():
    app.dependency_overrides[get_discover_providers] = lambda: (None, None)
    try:
        assert client.get("/discover").status_code == 503
    finally:
        app.dependency_overrides.clear()
