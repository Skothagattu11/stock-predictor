from datetime import datetime, timezone
import httpx
from app.context.models import Fundamentals

BASE_URL = "https://finnhub.io/api/v1"


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _num(d: dict, *keys):
    """First present, non-null numeric among the candidate keys."""
    for k in keys:
        v = d.get(k)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return None


class FinnhubFundamentals:
    name = "finnhub"

    def __init__(self, api_key: str, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._key = api_key
        self._http = http or httpx.Client(timeout=10.0)
        self._base = base_url

    def _get(self, path: str, symbol: str) -> dict:
        resp = self._http.get(f"{self._base}/{path}", params={"symbol": symbol, "token": self._key,
                                                               **({"metric": "all"} if path == "stock/metric" else {})})
        resp.raise_for_status()
        return resp.json()

    def fetch_fundamentals(self, symbol: str) -> Fundamentals:
        metric = self._get("stock/metric", symbol).get("metric", {}) or {}
        profile = self._get("stock/profile2", symbol) or {}
        mcap_millions = _num(profile, "marketCapitalization")
        return Fundamentals(
            symbol=symbol, as_of=_now_iso(), sources=["finnhub"],
            sector=profile.get("finnhubIndustry"),
            market_cap=(mcap_millions * 1e6) if mcap_millions is not None else None,
            pe=_num(metric, "peTTM", "peNormalizedAnnual"),
            pe_forward=_num(metric, "forwardPE", "peForward"),
            ev_ebitda=_num(metric, "evEbitdaTTM", "currentEv/freeCashFlowTTM"),
            profit_margin=_num(metric, "netProfitMarginTTM"),
            revenue_growth_yoy=_num(metric, "revenueGrowthTTMYoy"),
            eps_growth_yoy=_num(metric, "epsGrowthTTMYoy"),
        )
