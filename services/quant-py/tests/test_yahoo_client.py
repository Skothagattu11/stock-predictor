import json
from pathlib import Path
import httpx
from app.data.yahoo import YahooMarketData

FIXTURE = Path(__file__).parent / "fixtures" / "yahoo_aapl_5m.json"

def _client_returning_fixture():
    payload = json.loads(FIXTURE.read_text())
    def handler(request):
        return httpx.Response(200, json=payload)
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_fetch_candles_parses_into_dataframe():
    md = YahooMarketData(http=_client_returning_fixture())
    df = md.fetch_candles("AAPL", interval="5m", range_="1d")
    assert list(df.columns) == ["timestamp", "open", "high", "low", "close", "volume"]
    assert len(df) == 3
    assert df["close"].iloc[-1] == 101.4
    assert df["timestamp"].iloc[0] == 1749652200

def test_fetch_candles_drops_null_rows():
    payload = json.loads(FIXTURE.read_text())
    payload["chart"]["result"][0]["indicators"]["quote"][0]["close"][1] = None
    def handler(request): return httpx.Response(200, json=payload)
    md = YahooMarketData(http=httpx.Client(transport=httpx.MockTransport(handler)))
    df = md.fetch_candles("AAPL", interval="5m", range_="1d")
    assert len(df) == 2   # the null-close row is dropped

def test_fetch_candles_empty_when_market_closed():
    # Yahoo omits timestamp/indicators when there's no session data -> empty, not a crash
    payload = {"chart": {"result": [{"meta": {"symbol": "AAPL"}}], "error": None}}
    def handler(request): return httpx.Response(200, json=payload)
    md = YahooMarketData(http=httpx.Client(transport=httpx.MockTransport(handler)))
    df = md.fetch_candles("AAPL", interval="5m", range_="1d")
    assert df.empty
    assert list(df.columns) == ["timestamp", "open", "high", "low", "close", "volume"]
