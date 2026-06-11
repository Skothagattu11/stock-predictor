import json
from pathlib import Path
import httpx
from app.data.fmp import FmpFundamentals

FX = Path(__file__).parent / "fixtures"

def _client():
    profile = json.loads((FX / "fmp_profile_aapl.json").read_text())
    ratios = json.loads((FX / "fmp_ratios_aapl.json").read_text())
    def handler(request):
        if "ratios-ttm" in str(request.url):
            return httpx.Response(200, json=ratios)
        return httpx.Response(200, json=profile)
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_fmp_returns_normalized_fundamentals():
    fmp = FmpFundamentals(api_key="k", http=_client())
    f = fmp.fetch_fundamentals("AAPL")
    assert f.symbol == "AAPL" and f.sources == ["fmp"]
    assert f.sector == "Technology"
    assert f.pe is not None and f.pe > 0

def test_fmp_empty_array_yields_partial_without_crash():
    def handler(request): return httpx.Response(200, json=[])
    fmp = FmpFundamentals(api_key="k", http=httpx.Client(transport=httpx.MockTransport(handler)))
    f = fmp.fetch_fundamentals("AAPL")
    assert f.symbol == "AAPL" and f.pe is None
