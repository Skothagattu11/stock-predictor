"""Accumulating 1-minute bar history per symbol (CSV). The dataset the Phase 9
ML model will train on. Dedups by timestamp; append-only."""
import os
import pandas as pd

COLS = ["timestamp", "open", "high", "low", "close", "volume"]


class HistoryStore:
    def __init__(self, base_dir: str):
        self._dir = os.path.join(base_dir, "history")
        os.makedirs(self._dir, exist_ok=True)

    def _path(self, symbol: str) -> str:
        return os.path.join(self._dir, f"{symbol.upper()}.csv")

    def append(self, symbol: str, df: pd.DataFrame):
        if df is None or df.empty:
            return
        new = df[COLS].copy()
        path = self._path(symbol)
        if os.path.exists(path):
            old = pd.read_csv(path)
            merged = pd.concat([old, new], ignore_index=True)
        else:
            merged = new
        merged = merged.drop_duplicates(subset=["timestamp"]).sort_values("timestamp")
        merged.to_csv(path, index=False)

    def info(self, symbol: str) -> dict:
        path = self._path(symbol)
        if not os.path.exists(path):
            return {"symbol": symbol.upper(), "rows": 0, "first": None, "last": None}
        d = pd.read_csv(path)
        if d.empty:
            return {"symbol": symbol.upper(), "rows": 0, "first": None, "last": None}
        return {"symbol": symbol.upper(), "rows": int(len(d)),
                "first": int(d["timestamp"].min()), "last": int(d["timestamp"].max())}
