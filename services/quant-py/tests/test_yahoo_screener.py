import httpx
from app.data.yahoo_screener import YahooScreener, _parse_quotes

def test_parse_quotes():
    payload = {"finance": {"result": [{"quotes": [
        {"symbol": "BBB", "shortName": "Bbb Co", "regularMarketPrice": 3.1,
         "regularMarketChangePercent": 12.0, "regularMarketVolume": 5_000_000}]}]}}
    rows = _parse_quotes(payload)
    assert rows[0]["symbol"] == "BBB" and abs(rows[0]["change_pct"] - 12.0) < 1e-9

def test_screener_uses_crumb_and_parses():
    calls = {"crumb": 0}
    def handler(request):
        u = str(request.url)
        if "getcrumb" in u:
            calls["crumb"] += 1
            return httpx.Response(200, text="abc123")
        return httpx.Response(200, json={"finance": {"result": [{"quotes": [
            {"symbol": "CCC", "regularMarketPrice": 2.0, "regularMarketChangePercent": 8.0,
             "regularMarketVolume": 2_000_000}]}]}})
    ys = YahooScreener(http=httpx.Client(transport=httpx.MockTransport(handler)))
    rows = ys.screen("day_gainers", count=5)
    assert rows and rows[0]["symbol"] == "CCC"
