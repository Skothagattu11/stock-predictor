import httpx
import pandas as pd

BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart"
# Yahoo serves data to browser-like agents; datacenter IPs with a non-browser UA get
# blocked/edge-paged. Match the Node client's UA so the sidecar behaves the same on Render.
USER_AGENT = "Mozilla/5.0"


class YahooMarketData:
    def __init__(self, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._http = http or httpx.Client(timeout=10.0, headers={"User-Agent": USER_AGENT})
        self._base = base_url

    def fetch_candles(self, symbol: str, interval: str = "5m", range_: str = "1d") -> pd.DataFrame:
        url = f"{self._base}/{symbol}"
        params = {"interval": interval, "range": range_, "includePrePost": "false"}
        resp = self._http.get(url, params=params)
        resp.raise_for_status()
        body = resp.json()
        results = (body.get("chart") or {}).get("result") or []
        if not results:
            return _empty()
        result = results[0]
        ts = result.get("timestamp")
        quotes = ((result.get("indicators") or {}).get("quote")) or [{}]
        q = quotes[0] or {}
        # Markets closed / no intraday data => Yahoo omits these; return empty, let caller 422.
        if not ts or "close" not in q:
            return _empty()
        df = pd.DataFrame({
            "timestamp": ts,
            "open": q.get("open"), "high": q.get("high"), "low": q.get("low"),
            "close": q.get("close"), "volume": q.get("volume"),
        })
        return df.dropna(subset=["open", "high", "low", "close"]).reset_index(drop=True)


def _empty() -> pd.DataFrame:
    return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])
