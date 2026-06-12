import httpx

CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb"
SCREEN_URL = "https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved"
UA = "Mozilla/5.0"


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _parse_quotes(payload: dict) -> list[dict]:
    try:
        quotes = payload["finance"]["result"][0]["quotes"]
    except (KeyError, IndexError, TypeError):
        return []
    out = []
    for q in quotes or []:
        out.append({
            "symbol": q.get("symbol"),
            "name": q.get("shortName") or q.get("longName"),
            "price": _num(q.get("regularMarketPrice")),
            "change_pct": _num(q.get("regularMarketChangePercent")),
            "volume": _num(q.get("regularMarketVolume")),
            "market_cap": _num(q.get("marketCap")),
            "sector": None,
        })
    return out


class YahooScreener:
    name = "yahoo"

    def __init__(self, http: httpx.Client | None = None):
        self._http = http or httpx.Client(timeout=12.0, headers={"User-Agent": UA})
        self._crumb = None

    def _get_crumb(self) -> str | None:
        if self._crumb:
            return self._crumb
        try:
            r = self._http.get(CRUMB_URL)
            if r.status_code == 200 and r.text and "<" not in r.text:
                self._crumb = r.text.strip()
        except Exception:
            self._crumb = None
        return self._crumb

    def screen(self, scr_id: str, count: int = 25) -> list[dict]:
        params = {"scrIds": scr_id, "count": count}
        crumb = self._get_crumb()
        if crumb:
            params["crumb"] = crumb
        r = self._http.get(SCREEN_URL, params=params)
        r.raise_for_status()
        return _parse_quotes(r.json())
