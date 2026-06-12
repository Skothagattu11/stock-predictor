"""Lightweight statistical forecaster — an independent (non-rule, non-LLM) voice.
EWMA of recent returns normalized by volatility -> directional stance. numpy only."""
from datetime import datetime, timezone
import pandas as pd
from app.models import StatPrediction

SPAN = 10
NEUTRAL_Z = 0.10


def _now_iso():
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def forecast(symbol: str, df: pd.DataFrame, mode: str) -> StatPrediction:
    rets = df["close"].pct_change().dropna()
    if len(rets) < 10:
        return StatPrediction(symbol=symbol, mode=mode, stance="neutral", confidence=0.0, as_of=_now_iso())
    ewma = float(rets.ewm(span=SPAN, adjust=False).mean().iloc[-1])
    vol = float(rets.std()) or 1e-9
    z = ewma / vol
    if z > NEUTRAL_Z:
        stance = "bullish"
    elif z < -NEUTRAL_Z:
        stance = "bearish"
    else:
        stance = "neutral"
    confidence = min(1.0, abs(z))
    return StatPrediction(symbol=symbol, mode=mode, stance=stance,
                          confidence=round(confidence, 3), as_of=_now_iso())
