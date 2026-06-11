"""Intraday quant core: regime-gated confluence on session bars.

Deterministic and LLM-free. Input df columns:
timestamp (epoch s), open, high, low, close, volume — ascending by time.
"""
import math
from datetime import datetime, timezone
import pandas as pd

from app import indicators as ind
from app.regime import classify_regime
from app.models import IntradayPrediction, ExpectedMove, Driver

OPENING_RANGE_MINUTES = 15
MOMENTUM_WINDOW_MINUTES = 30
RELVOL_BREAKOUT_MIN = 1.3
BULLISH_PROB = 0.58
BEARISH_PROB = 0.42

# signal weights (centered at 0; positive => bullish)
W_VWAP, W_EMA, W_RSI, W_ORB, W_MOM = 1.4, 1.0, 0.6, 1.2, 0.8


def _logistic(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _bars(minutes: int, interval_minutes: int) -> int:
    return max(1, math.ceil(minutes / interval_minutes))


def score_intraday(symbol: str, df: pd.DataFrame, interval_minutes: int = 5) -> IntradayPrediction:
    close = df["close"]
    price = float(close.iloc[-1])
    atr_now = float(ind.atr(df["high"], df["low"], close, 14).iloc[-1])
    vwap = float(ind.session_vwap(df).iloc[-1])
    ema_fast = float(ind.ema(close, 9).iloc[-1])
    ema_slow = float(ind.ema(close, 20).iloc[-1])
    rsi_now = float(ind.rsi(close, 14).iloc[-1])
    relvol = ind.relative_volume(df["volume"], lookback=20)
    regime = classify_regime(df)

    orb_n = _bars(OPENING_RANGE_MINUTES, interval_minutes)
    or_high = float(df["high"].iloc[:orb_n].max())
    or_low = float(df["low"].iloc[:orb_n].min())

    mom_n = _bars(MOMENTUM_WINDOW_MINUTES, interval_minutes)
    first_close = float(close.iloc[min(mom_n, len(close)) - 1])
    open_px = float(df["open"].iloc[0])
    first_mom = (first_close - open_px) / open_px if open_px else 0.0

    score = 0.0
    drivers: list[tuple[str, str, float]] = []   # (name, dir, signed_contribution)

    if price != vwap:
        s = W_VWAP if price > vwap else -W_VWAP
        score += s; drivers.append(("VWAP", "up" if s > 0 else "down", s))

    if ema_fast != ema_slow:
        s = W_EMA if ema_fast > ema_slow else -W_EMA
        score += s; drivers.append(("EMA 9/20", "up" if s > 0 else "down", s))

    if rsi_now >= 55:
        score += W_RSI; drivers.append(("RSI", "up", W_RSI))
    elif rsi_now <= 45:
        score -= W_RSI; drivers.append(("RSI", "down", -W_RSI))

    has_vol = (relvol == relvol) and relvol >= RELVOL_BREAKOUT_MIN   # NaN-safe
    if price > or_high and has_vol:
        score += W_ORB; drivers.append(("ORB breakout", "up", W_ORB))
    elif price < or_low and has_vol:
        score -= W_ORB; drivers.append(("ORB breakdown", "down", -W_ORB))

    if first_mom != 0.0:
        mom_dir = W_MOM if first_mom > 0 else -W_MOM
        # range regime dampens momentum-style signals
        if regime.label == "range":
            mom_dir *= 0.4
        score += mom_dir; drivers.append(("Opening momentum", "up" if mom_dir > 0 else "down", mom_dir))

    probability_up = _logistic(score)
    if probability_up >= BULLISH_PROB:
        bias = "Bullish"
    elif probability_up <= BEARISH_PROB:
        bias = "Bearish"
    else:
        bias = "Neutral"

    k = 1.5 if regime.label == "high_vol" else 1.0
    move = k * atr_now
    expected_move = ExpectedMove(low=price - move, base=price, high=price + move)

    if bias == "Bullish":
        invalidation = or_low if or_low < price else price - move
        want = "up"
    elif bias == "Bearish":
        invalidation = or_high if or_high > price else price + move
        want = "down"
    else:
        invalidation = vwap
        want = None

    # only surface drivers that agree with the final bias (no contradictions)
    shown = [Driver(name=n, direction=d) for (n, d, c) in drivers
             if want is None or d == want]
    if want is None:
        shown = [Driver(name=n, direction=d) for (n, d, c) in drivers][:3]

    last_ts = int(df["timestamp"].iloc[-1])
    as_of = datetime.fromtimestamp(last_ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return IntradayPrediction(
        symbol=symbol, bias=bias, probability_up=round(probability_up, 4),
        expected_move=expected_move, regime=regime.label,
        regime_confidence=regime.confidence, invalidation=round(invalidation, 4),
        drivers=shown, as_of=as_of)
