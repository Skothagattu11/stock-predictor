import httpx

BASE_URL = "https://financialmodelingprep.com/api/v3"


def _pct(v):
    if v is None:
        return None
    try:
        return float(str(v).replace("%", "").strip())
    except (TypeError, ValueError):
        return None


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _norm(row: dict) -> dict:
    return {
        "symbol": row.get("symbol"),
        "name": row.get("name") or row.get("companyName"),
        "price": _num(row.get("price")),
        "change_pct": _pct(row.get("changesPercentage")),
        "volume": _num(row.get("volume")),
        "market_cap": _num(row.get("marketCap")),
        "sector": row.get("sector"),
    }


class FmpMarket:
    name = "fmp"

    def __init__(self, api_key: str, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._key = api_key
        self._http = http or httpx.Client(timeout=12.0)
        self._base = base_url

    def _get(self, path: str, params: dict | None = None) -> list:
        params = dict(params or {})
        params["apikey"] = self._key
        r = self._http.get(f"{self._base}/{path}", params=params)
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []

    def gainers(self) -> list[dict]:
        return [_norm(x) for x in self._get("stock_market/gainers")]

    def actives(self) -> list[dict]:
        return [_norm(x) for x in self._get("stock_market/actives")]

    def screener(self, **filters) -> list[dict]:
        return [_norm(x) for x in self._get("stock-screener", filters)]
