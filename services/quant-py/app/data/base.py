from typing import Protocol
import pandas as pd


class MarketData(Protocol):
    def fetch_candles(self, symbol: str, interval: str, range_: str) -> pd.DataFrame:
        """Return columns: timestamp, open, high, low, close, volume (ascending)."""
        ...


from app.context.models import Fundamentals, MacroSnapshot, ImpliedMove


class FundamentalsProvider(Protocol):
    name: str
    def fetch_fundamentals(self, symbol: str) -> Fundamentals: ...


class MacroProvider(Protocol):
    name: str
    def fetch_macro(self) -> MacroSnapshot: ...


class OptionsProvider(Protocol):
    name: str
    def fetch_implied_move(self, symbol: str) -> ImpliedMove: ...
