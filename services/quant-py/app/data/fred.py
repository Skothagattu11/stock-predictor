from datetime import datetime, timezone
import httpx
from app.context.models import MacroSnapshot

BASE_URL = "https://api.stlouisfed.org/fred/series/observations"
# FRED series ids for the macro snapshot
SERIES = {
    "ten_year_yield": "DGS10",
    "two_year_yield": "DGS2",
    "vix": "VIXCLS",
    "unemployment": "UNRATE",
}


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class FredMacro:
    name = "FRED"

    def __init__(self, api_key: str, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._key = api_key
        self._http = http or httpx.Client(timeout=10.0)
        self._base = base_url

    def _latest(self, series_id: str) -> float | None:
        params = {"series_id": series_id, "api_key": self._key, "file_type": "json",
                  "sort_order": "desc", "limit": 1}
        resp = self._http.get(self._base, params=params)
        resp.raise_for_status()
        obs = resp.json().get("observations", [])
        if not obs:
            return None
        raw = obs[0].get("value", ".")
        if raw in (".", "", None):
            return None
        return float(raw)

    def fetch_macro(self) -> MacroSnapshot:
        vals = {k: self._latest(sid) for k, sid in SERIES.items()}
        curve = None
        if vals["ten_year_yield"] is not None and vals["two_year_yield"] is not None:
            curve = round(vals["ten_year_yield"] - vals["two_year_yield"], 4)
        return MacroSnapshot(as_of=_now_iso(), yield_curve_2s10s=curve, sources=["FRED"], **vals)
