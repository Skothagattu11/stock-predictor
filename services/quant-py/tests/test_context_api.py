from fastapi.testclient import TestClient
from app.api import app, get_fundamentals_providers, get_macro_provider, get_options_provider
from app.context.models import Fundamentals, MacroSnapshot, ImpliedMove

client = TestClient(app)
AS_OF = "2026-06-11T00:00:00Z"

class _FakeFund:
    def __init__(self, name, **kw): self._n = name; self._kw = kw
    def fetch_fundamentals(self, symbol):
        return Fundamentals(symbol=symbol, as_of=AS_OF, sources=[self._n], **self._kw)

class _FakeMacro:
    def fetch_macro(self): return MacroSnapshot(as_of=AS_OF, ten_year_yield=4.3, sources=["FRED"])

class _FakeOptions:
    def fetch_implied_move(self, symbol):
        return ImpliedMove(symbol=symbol, spot=200.0, atm_iv=0.25, expiry="2026-06-20",
                           days_to_expiry=9, expected_move_pct=0.039, expected_move_abs=7.8,
                           low=192.2, high=207.8, as_of=AS_OF)

def test_fundamentals_endpoint_merges_and_flags():
    app.dependency_overrides[get_fundamentals_providers] = lambda: [
        _FakeFund("finnhub", pe=25.0), _FakeFund("fmp", pe=30.0)]
    try:
        r = client.get("/context/fundamentals/AAPL")
        assert r.status_code == 200
        body = r.json()
        assert body["merged"]["symbol"] == "AAPL"
        assert len(body["discrepancies"]) == 1
    finally:
        app.dependency_overrides.clear()

def test_fundamentals_503_when_no_providers_configured():
    app.dependency_overrides[get_fundamentals_providers] = lambda: []
    try:
        assert client.get("/context/fundamentals/AAPL").status_code == 503
    finally:
        app.dependency_overrides.clear()

def test_macro_endpoint_returns_snapshot():
    app.dependency_overrides[get_macro_provider] = lambda: _FakeMacro()
    try:
        r = client.get("/context/macro")
        assert r.status_code == 200 and r.json()["ten_year_yield"] == 4.3
    finally:
        app.dependency_overrides.clear()

def test_macro_503_when_unconfigured():
    app.dependency_overrides[get_macro_provider] = lambda: None
    try:
        assert client.get("/context/macro").status_code == 503
    finally:
        app.dependency_overrides.clear()

def test_implied_move_endpoint():
    app.dependency_overrides[get_options_provider] = lambda: _FakeOptions()
    try:
        r = client.get("/context/implied-move/AAPL")
        assert r.status_code == 200 and r.json()["high"] > r.json()["spot"]
    finally:
        app.dependency_overrides.clear()
