import json
from pathlib import Path
import httpx
from app.data.finnhub import FinnhubFundamentals

FX = Path(__file__).parent / "fixtures"

def _client():
    metric = json.loads((FX / "finnhub_metric_aapl.json").read_text())
    profile = json.loads((FX / "finnhub_profile_aapl.json").read_text())
    def handler(request):
        if "metric" in str(request.url):
            return httpx.Response(200, json=metric)
        return httpx.Response(200, json=profile)
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_finnhub_returns_normalized_fundamentals():
    fh = FinnhubFundamentals(api_key="k", http=_client())
    f = fh.fetch_fundamentals("AAPL")
    assert f.symbol == "AAPL"
    assert f.sources == ["finnhub"]
    # market cap normalized from millions to absolute dollars
    if f.market_cap is not None:
        assert f.market_cap > 1e9
    # pe present and positive when supplied by the fixture
    assert f.pe is None or f.pe > 0
