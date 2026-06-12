import httpx
from app.data.fmp_market import FmpMarket, _pct

def test_pct_parses_number_and_string():
    assert _pct(3.2) == 3.2
    assert _pct("3.2%") == 3.2
    assert _pct(None) is None

def _client(payload):
    def handler(request): return httpx.Response(200, json=payload)
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_gainers_normalized():
    fm = FmpMarket(api_key="k", http=_client([
        {"symbol": "AAA", "name": "Aaa Inc", "price": 12.5, "changesPercentage": 9.8, "change": 1.1}]))
    rows = fm.gainers()
    assert rows[0]["symbol"] == "AAA" and abs(rows[0]["change_pct"] - 9.8) < 1e-9

def test_screener_passes_filters():
    rec = {}
    def handler(request): rec["url"] = str(request.url); return httpx.Response(200, json=[])
    fm = FmpMarket(api_key="k", http=httpx.Client(transport=httpx.MockTransport(handler)))
    fm.screener(priceLowerThan=5, volumeMoreThan=1_000_000)
    assert "priceLowerThan=5" in rec["url"] and "apikey=k" in rec["url"]
