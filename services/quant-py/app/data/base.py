from typing import Protocol
import pandas as pd


class MarketData(Protocol):
    def fetch_candles(self, symbol: str, interval: str, range_: str) -> pd.DataFrame:
        """Return columns: timestamp, open, high, low, close, volume (ascending)."""
        ...
