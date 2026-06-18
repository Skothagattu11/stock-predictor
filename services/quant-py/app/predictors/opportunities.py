"""Goal-driven opportunity scorer: budget+target -> achievable, timed, ranked
US-equity picks. Deterministic; composes the intraday + outlook engines.
No LLM, no I/O (the endpoint does the I/O)."""
import math
import pandas as pd

HORIZONS = [("intraday", 1), ("swing", 5), ("position", 21)]
RISK_TIERS = {
    "cautious":   (0.65, ("hot", "shine")),
    "balanced":   (0.55, ("hot", "shine", "penny")),
    "aggressive": (0.45, ("hot", "shine", "penny")),
}
DRIFT_FRACTION = 0.5
STOP_VOL_MULT = 1.0
MIN_STOP_FRAC = 0.02
MAX_STOP_FRAC = 0.20
ENTRY_BAND = 0.005
TOP_N = 12


def prob_hit_target_before_stop(r: float, s: float, mu: float, sigma: float) -> float:
    """P(price rises +r before falling -s) over one horizon, for a drifted random
    walk. r,s are positive fractions; mu,sigma are fractional drift/vol for the
    horizon. Two-barrier first-passage; driftless -> gambler's ruin s/(r+s)."""
    if r <= 0:
        return 1.0
    if sigma <= 0:
        return 1.0 if (mu > 0 and r <= mu) else 0.0
    if abs(mu) < 1e-9:
        return s / (r + s)
    k = 2.0 * mu / (sigma * sigma)
    p = (1.0 - math.exp(-k * s)) / (1.0 - math.exp(-k * (r + s)))
    return max(0.0, min(1.0, p))


def affordability(price: float, budget: float, target: float) -> dict | None:
    """Whole-share affordability + the % move needed to make `target`."""
    if price <= 0 or budget <= 0:
        return None
    shares = int(budget // price)
    if shares < 1:
        return None                       # can't buy one share within budget
    invested = round(shares * price, 4)
    return {"shares": shares, "invested": invested,
            "required_move": target / invested}


def pe_tag(pe: float | None) -> str:
    if pe is None or pe <= 0:
        return "n/a"
    if pe < 15:
        return "cheap"
    if pe <= 30:
        return "fair"
    return "rich"


def tier_config(risk: str) -> tuple[float, tuple[str, ...]]:
    return RISK_TIERS.get((risk or "").lower(), RISK_TIERS["balanced"])


def stop_fraction_for(horizon_vol: float) -> float:
    return max(MIN_STOP_FRAC, min(MAX_STOP_FRAC, STOP_VOL_MULT * horizon_vol))


def daily_vol(daily_df: pd.DataFrame, lookback: int = 60) -> float:
    rets = daily_df["close"].pct_change().dropna()
    v = float(rets.tail(lookback).std()) if len(rets) else 0.0
    return v if v == v else 0.0           # NaN-safe
