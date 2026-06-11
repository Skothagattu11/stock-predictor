import httpx
import pandas as pd

BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart"


class YahooMarketData:
    def __init__(self, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._http = http or httpx.Client(timeout=10.0, headers={"User-Agent": "quant-py/0.1"})
        self._base = base_url

    def fetch_candles(self, symbol: str, interval: str = "5m", range_: str = "1d") -> pd.DataFrame:
        url = f"{self._base}/{symbol}"
        params = {"interval": interval, "range": range_, "includePrePost": "false"}
        resp = self._http.get(url, params=params)
        resp.raise_for_status()
        result = resp.json()["chart"]["result"][0]
        ts = result["timestamp"]
        q = result["indicators"]["quote"][0]
        df = pd.DataFrame({
            "timestamp": ts,
            "open": q["open"], "high": q["high"], "low": q["low"],
            "close": q["close"], "volume": q["volume"],
        })
        df = df.dropna(subset=["open", "high", "low", "close"]).reset_index(drop=True)
        return df
