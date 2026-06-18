"""Goal-driven opportunity scorer: budget+target -> achievable, timed, ranked
US-equity picks. Deterministic; composes the intraday + outlook engines.
No LLM, no I/O (the endpoint does the I/O)."""
import math
import pandas as pd

HORIZONS = [("intraday", 1), ("swing", 5), ("position", 21)]
RISK_TIERS = {
    "cautious":   (0.65, ("hot", "shine")),
    "balanced":   (0.55, ("hot", "shine")),            # established/mover names; no penny
    "aggressive": (0.45, ("hot", "shine", "penny")),   # penny/movers only when aggressive
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


from datetime import datetime, timezone
from app.predictors.intraday import score_intraday
from app.predictors.outlook import score_outlook, MIN_BARS


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _direction_and_conviction(intraday, outlook):
    """Blend the two deterministic engines into a long-side bias (+conviction)."""
    bull = 0.0
    voices = []
    if intraday and intraday.bias == "Bullish":
        bull += intraday.conviction; voices.append("intraday")
    elif intraday and intraday.bias == "Bearish":
        bull -= intraday.conviction
    if outlook and outlook.stance == "Constructive":
        bull += outlook.confidence; voices.append("outlook")
    elif outlook and outlook.stance == "Cautious":
        bull -= outlook.confidence
    conviction = min(1.0, abs(bull) / 2.0)
    return (1 if bull > 0 else -1 if bull < 0 else 0), conviction, voices


def score_opportunity(symbol, intraday_df, daily_df, *, pe, daily_atr,
                      budget, target, threshold) -> dict | None:
    price = float(intraday_df["close"].iloc[-1]) if len(intraday_df) else \
        float(daily_df["close"].iloc[-1])
    aff = affordability(price, budget, target)
    if aff is None:
        return None

    intraday = None
    if len(intraday_df) >= 15:
        try:
            intraday = score_intraday(symbol, intraday_df, interval_minutes=1, daily_atr=daily_atr)
        except Exception:
            intraday = None
    outlook = None
    if len(daily_df) >= MIN_BARS:
        try:
            outlook = score_outlook(symbol, daily_df)
        except Exception:
            outlook = None

    sign, conviction, voices = _direction_and_conviction(intraday, outlook)
    if sign <= 0:                      # long-only: need a non-bearish, non-flat read
        return None

    dvol = daily_vol(daily_df)
    r = aff["required_move"]

    best = None
    for label, days in HORIZONS:
        hv = dvol * math.sqrt(days)
        if hv <= 0:
            continue
        mu = sign * DRIFT_FRACTION * conviction * hv
        s = stop_fraction_for(hv)
        prob = prob_hit_target_before_stop(r, s, mu, hv)
        if prob >= threshold:
            best = (label, days, prob, s)
            break                       # HORIZONS is shortest-first
    if best is None:
        return None
    label, days, prob, s = best

    # entry zone: a small band above recent intraday support (wait for the dip)
    if len(intraday_df) >= 20:
        support = float(intraday_df["low"].tail(20).min())
    else:
        support = price * (1 - ENTRY_BAND)
    entry_low = round(support, 4)
    entry_high = round(support * (1 + ENTRY_BAND), 4)
    entry_status = "buy_now" if price <= entry_high else "wait"

    risk_dollars = round(aff["shares"] * s * price, 2)
    return {
        "symbol": symbol, "price": round(price, 4), "pe": pe, "pe_tag": pe_tag(pe),
        "shares": aff["shares"], "invested": aff["invested"],
        "required_move_pct": round(r, 4),
        "horizon": label, "horizon_days": days, "probability": round(prob, 4),
        "entry_low": entry_low, "entry_high": entry_high, "entry_status": entry_status,
        "target_dollars": round(target, 2), "risk_dollars": risk_dollars,
        "reward_risk": round(target / risk_dollars, 2) if risk_dollars > 0 else 0.0,
        "conviction": round(conviction, 3), "voices_agree": voices, "as_of": _now_iso(),
    }
