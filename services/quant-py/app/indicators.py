"""Pure indicator functions. No I/O, no globals — fully unit-testable.

Computed directly with pandas/numpy (no pandas-ta dependency). EMA uses an
exponential moving average; RSI and ATR use Wilder's smoothing (ewm alpha=1/length).
"""
import pandas as pd


def ema(close: pd.Series, length: int) -> pd.Series:
    return close.ewm(span=length, adjust=False).mean()


def rsi(close: pd.Series, length: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()
    avg_loss = loss.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()
    rs = avg_gain / avg_loss
    out = 100.0 - (100.0 / (1.0 + rs))
    return out.where(avg_loss != 0, 100.0)   # all-gains (no losses) => RSI 100


def atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int = 14) -> pd.Series:
    prev_close = close.shift(1)
    true_range = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return true_range.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()


def session_vwap(df: pd.DataFrame) -> pd.Series:
    """Cumulative VWAP across the supplied (single-session) bars.
    Expects columns high, low, close, volume. Skips zero-volume division."""
    typical = (df["high"] + df["low"] + df["close"]) / 3.0
    cum_vol = df["volume"].cumsum()
    cum_pv = (typical * df["volume"]).cumsum()
    return cum_pv / cum_vol.where(cum_vol > 0)


def relative_volume(volume: pd.Series, lookback: int = 20) -> float:
    """Last bar volume vs the average of the `lookback` bars before it."""
    if len(volume) < lookback + 1:
        return float("nan")
    prior_avg = volume.iloc[-(lookback + 1):-1].mean()
    return float(volume.iloc[-1] / prior_avg) if prior_avg > 0 else float("nan")
