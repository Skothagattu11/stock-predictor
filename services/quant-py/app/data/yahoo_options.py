import math
from datetime import datetime, timezone
import httpx
from app.context.models import ImpliedMove

BASE_URL = "https://query1.finance.yahoo.com/v7/finance/options"


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _nearest_iv(legs: list, spot: float) -> float | None:
    best, best_dist = None, None
    for leg in legs:
        strike = leg.get("strike")
        iv = leg.get("impliedVolatility")
        if strike is None or iv is None:
            continue
        dist = abs(strike - spot)
        if best_dist is None or dist < best_dist:
            best, best_dist = float(iv), dist
    return best


class YahooOptions:
    name = "yahoo_options"

    def __init__(self, http: httpx.Client | None = None, base_url: str = BASE_URL,
                 now_epoch: int | None = None):
        self._http = http or httpx.Client(timeout=10.0, headers={"User-Agent": "Mozilla/5.0"})
        self._base = base_url
        self._now = now_epoch          # injectable for deterministic tests

    def fetch_implied_move(self, symbol: str) -> ImpliedMove:
        resp = self._http.get(f"{self._base}/{symbol}")
        resp.raise_for_status()
        result = resp.json()["optionChain"]["result"][0]
        spot = float(result["quote"]["regularMarketPrice"])
        chain = result["options"][0]
        expiry_epoch = int(chain["expirationDate"])
        call_iv = _nearest_iv(chain.get("calls", []), spot)
        put_iv = _nearest_iv(chain.get("puts", []), spot)
        ivs = [v for v in (call_iv, put_iv) if v is not None]
        atm_iv = sum(ivs) / len(ivs) if ivs else 0.0

        now = self._now if self._now is not None else int(datetime.now(tz=timezone.utc).timestamp())
        days = max(1, round((expiry_epoch - now) / 86400))
        move_pct = atm_iv * math.sqrt(days / 365)
        move_abs = spot * move_pct
        expiry = datetime.fromtimestamp(expiry_epoch, tz=timezone.utc).strftime("%Y-%m-%d")
        return ImpliedMove(
            symbol=symbol, spot=spot, atm_iv=round(atm_iv, 4), expiry=expiry,
            days_to_expiry=days, expected_move_pct=round(move_pct, 4),
            expected_move_abs=round(move_abs, 4),
            low=round(spot - move_abs, 4), high=round(spot + move_abs, 4), as_of=_now_iso())
