import httpx
from app.data.fred import FredMacro

def _client(value="4.35"):
    def handler(request):
        return httpx.Response(200, json={"observations": [{"date": "2026-06-10", "value": value}]})
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_fred_parses_latest_value():
    fred = FredMacro(api_key="k", http=_client("4.35"))
    m = fred.fetch_macro()
    assert m.ten_year_yield == 4.35
    assert "FRED" in m.sources

def test_fred_handles_missing_value_dot():
    fred = FredMacro(api_key="k", http=_client("."))
    m = fred.fetch_macro()
    assert m.ten_year_yield is None   # "." => None, no crash
