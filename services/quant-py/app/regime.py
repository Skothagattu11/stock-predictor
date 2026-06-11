"""Regime classifier — gates which intraday signals are trusted."""
from dataclasses import dataclass
import pandas as pd
from app import indicators as ind

HIGH_VOL_ATR_PCT = 0.03   # ATR > 3% of price => volatility regime
TREND_EPS = 1e-3          # min normalized EMA spread to call a trend


@dataclass
class Regime:
    label: str          # 'trend_up' | 'trend_down' | 'range' | 'high_vol'
    confidence: float   # 0..1


def classify_regime(df: pd.DataFrame) -> Regime:
    close = df["close"]
    price = float(close.iloc[-1])
    atr_now = float(ind.atr(df["high"], df["low"], close, 14).iloc[-1])
    atr_pct = atr_now / price if price else 0.0

    if atr_pct > HIGH_VOL_ATR_PCT:
        conf = min(1.0, atr_pct / (HIGH_VOL_ATR_PCT * 2))
        return Regime("high_vol", round(conf, 3))

    ema_fast = float(ind.ema(close, 9).iloc[-1])
    ema_slow = float(ind.ema(close, 20).iloc[-1])
    spread = (ema_fast - ema_slow) / price if price else 0.0
    conf = min(1.0, abs(spread) / 0.01)   # 1% spread => full confidence

    if spread > TREND_EPS:
        return Regime("trend_up", round(conf, 3))
    if spread < -TREND_EPS:
        return Regime("trend_down", round(conf, 3))
    return Regime("range", round(1.0 - conf, 3))
