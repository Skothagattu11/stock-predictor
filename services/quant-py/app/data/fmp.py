from datetime import datetime, timezone
import httpx
from app.context.models import Fundamentals

BASE_URL = "https://financialmodelingprep.com/api/v3"


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _first(arr):
    return arr[0] if isinstance(arr, list) and arr else {}


def _num(d: dict, *keys):
    for k in keys:
        v = d.get(k)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return None


class FmpFundamentals:
    name = "fmp"

    def __init__(self, api_key: str, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._key = api_key
        self._http = http or httpx.Client(timeout=10.0)
        self._base = base_url

    def _get(self, path: str) -> list:
        resp = self._http.get(f"{self._base}/{path}", params={"apikey": self._key})
        resp.raise_for_status()
        return resp.json()

    def fetch_fundamentals(self, symbol: str) -> Fundamentals:
        profile = _first(self._get(f"profile/{symbol}"))
        ratios = _first(self._get(f"ratios-ttm/{symbol}"))
        return Fundamentals(
            symbol=symbol, as_of=_now_iso(), sources=["fmp"],
            sector=profile.get("sector") or None,
            market_cap=_num(profile, "mktCap", "marketCap"),
            pe=_num(ratios, "peRatioTTM") or _num(profile, "pe"),
            peg=_num(ratios, "pegRatioTTM"),
            ev_ebitda=_num(ratios, "enterpriseValueMultipleTTM"),
            profit_margin=_num(ratios, "netProfitMarginTTM"),
        )
