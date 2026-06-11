"""Weeks-to-months outlook: regime gate + 12-1 momentum + relative strength +
optional valuation tilt -> 0-100 score, stance, and bull/base/bear scenarios.
Deterministic; no LLM, no I/O."""
import math
from datetime import datetime, timezone
import numpy as np
import pandas as pd
from app.models import OutlookPrediction, Scenario, Driver
from app.context.models import Fundamentals

MIN_BARS = 220
HORIZON_DAYS = 63          # ~3 trading months
MOM_LOOKBACK = 252         # 12 months
MOM_SKIP = 21              # exclude most recent month (12-1 momentum)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _period_return(close: pd.Series, lookback: int, skip: int) -> float:
    if len(close) < lookback + 1:
        lookback = len(close) - 1
    start = close.iloc[-(lookback + 1)]
    end = close.iloc[-(skip + 1)] if skip < len(close) else close.iloc[-1]
    return (end - start) / start if start else 0.0


def score_outlook(symbol: str, daily_df: pd.DataFrame,
                  benchmark_df: pd.DataFrame | None = None,
                  fundamentals: Fundamentals | None = None) -> OutlookPrediction:
    close = daily_df["close"].reset_index(drop=True)
    if len(close) < MIN_BARS:
        raise ValueError(f"need >= {MIN_BARS} daily bars, got {len(close)}")

    price = float(close.iloc[-1])
    sma200 = float(close.rolling(200).mean().iloc[-1])
    sma200_prev = float(close.rolling(200).mean().iloc[-21])
    rising = sma200 >= sma200_prev
    risk_on = price > sma200 and rising
    regime = "risk_on" if risk_on else "risk_off"

    mom = _period_return(close, MOM_LOOKBACK, MOM_SKIP)

    drivers: list[Driver] = []
    score = 50.0

    # regime gate (multiplicative-ish, expressed additively for transparency)
    if risk_on:
        score += 12; drivers.append(Driver(name="Above rising 200-day", direction="up"))
    else:
        score -= 12; drivers.append(Driver(name="Below/!rising 200-day", direction="down"))

    # 12-1 momentum
    score += float(np.clip(mom * 60, -22, 22))
    drivers.append(Driver(name="12-1 momentum", direction="up" if mom > 0 else "down"))

    # relative strength vs benchmark
    if benchmark_df is not None and len(benchmark_df) >= MIN_BARS:
        bench_mom = _period_return(benchmark_df["close"].reset_index(drop=True), MOM_LOOKBACK, MOM_SKIP)
        rel = mom - bench_mom
        score += float(np.clip(rel * 50, -12, 12))
        drivers.append(Driver(name="Relative strength vs benchmark", direction="up" if rel > 0 else "down"))

    # optional valuation tilt (cheap PE = small positive; rich = small negative)
    if fundamentals is not None and fundamentals.pe is not None and fundamentals.pe > 0:
        tilt = float(np.clip((25.0 - fundamentals.pe) / 25.0, -1, 1)) * 6.0
        score += tilt
        drivers.append(Driver(name="Valuation vs ~25x", direction="up" if tilt > 0 else "down"))

    score = float(np.clip(score, 0.0, 100.0))
    if score >= 60:
        stance = "Constructive"
    elif score <= 40:
        stance = "Cautious"
    else:
        stance = "Neutral"
    confidence = round(abs(score - 50) / 50.0, 3)

    # scenarios from realized volatility over the horizon
    rets = close.pct_change().dropna()
    daily_vol = float(rets.tail(MOM_LOOKBACK).std()) if len(rets) else 0.02
    horizon_vol = daily_vol * math.sqrt(HORIZON_DAYS)
    drift = (score - 50) / 50.0 * horizon_vol     # tilt the base case by conviction
    base_ret, bull_ret, bear_ret = drift, drift + horizon_vol, drift - horizon_vol
    # probabilities skewed by conviction
    skew = (score - 50) / 50.0 * 0.15
    p_bull = round(0.25 + skew, 4); p_bear = round(0.25 - skew, 4)
    p_base = round(1.0 - p_bull - p_bear, 4)

    def _sc(case, r, p):
        return Scenario(case=case, probability=p, target_return_pct=round(r, 4),
                        target_price=round(price * (1 + r), 4))

    scenarios = [_sc("bull", bull_ret, p_bull), _sc("base", base_ret, p_base), _sc("bear", bear_ret, p_bear)]

    return OutlookPrediction(symbol=symbol, stance=stance, score=round(score, 2),
        confidence=confidence, regime=regime, scenarios=scenarios,
        drivers=drivers, as_of=_now_iso())
