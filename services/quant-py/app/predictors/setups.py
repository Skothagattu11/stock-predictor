"""Intraday setup scanner: detects day-trade windows over a 1-minute session and
tags each with its time-of-day phase. Deterministic; no LLM, no I/O."""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import pandas as pd

from app import indicators as ind
from app.models import Setup, SetupTimeline, KeyLevel

ET = ZoneInfo("America/New_York")
OPENING_RANGE_BARS = 15
RELVOL_MIN = 1.3
STOP_ATR_FRACTION = 0.25
TARGET_ATR_FRACTION = 0.5
MAX_SETUPS = 8

_WATCH = {
    "pre": "Pre-market — wait for the 9:30 open.",
    "open_drive": "Opening range forming — watch for an ORB break on rising volume.",
    "morning": "Watch for the first VWAP / 9-EMA pullback in the trend.",
    "midday": "Midday lull — low volume and choppy. Best to stand aside.",
    "afternoon": "Watch for a VWAP reclaim/bounce as afternoon volume returns.",
    "power_hour": "Power hour — watch for momentum continuation into the close.",
    "closed": "Market closed — setups resume next session.",
}


def session_phase(epoch: int) -> tuple[str, str]:
    t = datetime.fromtimestamp(epoch, ET)
    hm = t.hour * 60 + t.minute
    if hm < 9 * 60 + 30:
        return ("pre", "none")
    if hm < 10 * 60 + 30:
        return ("open_drive", "high")
    if hm < 11 * 60 + 30:
        return ("morning", "medium")
    if hm < 13 * 60 + 30:
        return ("midday", "low")
    if hm < 15 * 60:
        return ("afternoon", "medium")
    if hm < 16 * 60:
        return ("power_hour", "high")
    return ("closed", "none")


def _iso(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _candle_pattern(o, h, l, c, i):
    if i < 1:
        return None
    body = abs(c.iloc[i] - o.iloc[i])
    upper = h.iloc[i] - max(c.iloc[i], o.iloc[i])
    lower = min(c.iloc[i], o.iloc[i]) - l.iloc[i]
    cur_bull, cur_bear = c.iloc[i] > o.iloc[i], c.iloc[i] < o.iloc[i]
    prev_bull, prev_bear = c.iloc[i - 1] > o.iloc[i - 1], c.iloc[i - 1] < o.iloc[i - 1]
    if cur_bull and prev_bear and c.iloc[i] >= o.iloc[i - 1] and o.iloc[i] <= c.iloc[i - 1]:
        return ("Bullish engulfing", "long", "Bullish engulfing candle")
    if cur_bear and prev_bull and o.iloc[i] >= c.iloc[i - 1] and c.iloc[i] <= o.iloc[i - 1]:
        return ("Bearish engulfing", "short", "Bearish engulfing candle")
    if body > 0 and lower >= 2 * body and upper <= body:
        return ("Hammer", "long", "Hammer — long lower wick, buyers stepped in")
    if body > 0 and upper >= 2 * body and lower <= body:
        return ("Shooting star", "short", "Shooting star — long upper wick, sellers stepped in")
    return None


def _key_levels(df, price, prior_day_high=None, prior_day_low=None, swing_window=10):
    high, low = df["high"], df["low"]
    n = len(df)
    cand = []
    if prior_day_high:
        cand.append((float(prior_day_high), "prior-day high"))
    if prior_day_low:
        cand.append((float(prior_day_low), "prior-day low"))
    cand.append((float(high.max()), "session high"))
    cand.append((float(low.min()), "session low"))
    w = swing_window
    for i in range(w, n - w):
        if high.iloc[i] == high.iloc[i - w:i + w + 1].max():
            cand.append((float(high.iloc[i]), "swing high"))
        if low.iloc[i] == low.iloc[i - w:i + w + 1].min():
            cand.append((float(low.iloc[i]), "swing low"))
    step = 1.0 if price < 100 else 5.0 if price < 1000 else 10.0
    cand.append((round(price / step) * step, "round number"))

    levels, seen = [], []
    for p, label in cand:
        if p <= 0 or any(abs(p - s) / price < 0.001 for s in seen):
            continue
        seen.append(p)
        levels.append(KeyLevel(price=round(p, 2),
                               kind="resistance" if p >= price else "support", label=label))
    res = sorted([x for x in levels if x.kind == "resistance"], key=lambda x: x.price)[:3]
    sup = sorted([x for x in levels if x.kind == "support"], key=lambda x: -x.price)[:3]
    return sup + res


def _resolve(direction: str, entry: float, target: float, stop: float,
             high: pd.Series, low: pd.Series, i: int, n: int) -> str:
    for j in range(i + 1, n):
        if direction == "long":
            if low.iloc[j] <= stop:
                return "triggered_loss"
            if high.iloc[j] >= target:
                return "triggered_win"
        else:
            if high.iloc[j] >= stop:
                return "triggered_loss"
            if low.iloc[j] <= target:
                return "triggered_win"
    return "active"


def scan_setups(symbol: str, df: pd.DataFrame, daily_atr: float | None = None,
                prior_day_high: float | None = None, prior_day_low: float | None = None,
                max_setups: int = MAX_SETUPS) -> SetupTimeline:
    d = df.reset_index(drop=True)
    close, open_, high, low = d["close"], d["open"], d["high"], d["low"]
    vol, ts = d["volume"], d["timestamp"]
    n = len(close)

    vwap = ind.session_vwap(d)
    ema9, ema20 = ind.ema(close, 9), ind.ema(close, 20)
    relvol = vol / vol.rolling(20).mean()
    atr_day = daily_atr if (daily_atr and daily_atr > 0) else float(ind.atr(high, low, close, 14).iloc[-1])
    if not atr_day or atr_day != atr_day:      # NaN/0 guard
        atr_day = float(close.iloc[-1]) * 0.01
    stop_dist = STOP_ATR_FRACTION * atr_day
    tgt_dist = TARGET_ATR_FRACTION * atr_day

    or_high = float(high.iloc[:OPENING_RANGE_BARS].max())
    or_low = float(low.iloc[:OPENING_RANGE_BARS].min())

    setups: list[Setup] = []
    orb_long = orb_short = False
    start = max(OPENING_RANGE_BARS, 20)
    for i in range(start, n):
        if pd.isna(vwap.iloc[i]) or pd.isna(ema9.iloc[i]) or pd.isna(ema20.iloc[i]):
            continue
        c, o, hi, lo = close.iloc[i], open_.iloc[i], high.iloc[i], low.iloc[i]
        v, vp = vwap.iloc[i], vwap.iloc[i - 1]
        rv = relvol.iloc[i]
        e9, e20 = ema9.iloc[i], ema20.iloc[i]
        up = c > v and e9 > e20
        down = c < v and e9 < e20

        evt = None
        if not orb_long and c > or_high and rv >= RELVOL_MIN:
            evt = ("ORB breakout", "long", "Break of the opening-range high on rising volume"); orb_long = True
        elif not orb_short and c < or_low and rv >= RELVOL_MIN:
            evt = ("ORB breakdown", "short", "Break of the opening-range low on rising volume"); orb_short = True
        elif close.iloc[i - 1] < vp and c > v and c > o:
            evt = ("VWAP reclaim", "long", "Reclaimed VWAP with a green candle")
        elif up and lo <= v:
            evt = ("VWAP bounce", "long", "Pullback to VWAP in an uptrend held")
        elif down and hi >= v and c < o:
            evt = ("VWAP fade", "short", "Rejected at VWAP in a downtrend")
        elif up and lo <= e9 and c > e9:
            evt = ("9-EMA pullback", "long", "Pullback to the 9-EMA in an uptrend held")
        if evt is None:
            evt = _candle_pattern(open_, high, low, close, i)   # pattern-based window
        if not evt:
            continue

        typ, direction, trigger = evt
        entry = float(c)
        if direction == "long":
            stop, target = entry - stop_dist, entry + tgt_dist
        else:
            stop, target = entry + stop_dist, entry - tgt_dist
        risk = abs(entry - stop)
        if risk <= 0:
            continue
        phase, quality = session_phase(int(ts.iloc[i]))
        setups.append(Setup(
            time=_iso(int(ts.iloc[i])), type=typ, direction=direction,
            entry=round(entry, 4), target=round(target, 4), stop=round(stop, 4),
            risk_reward=round(abs(target - entry) / risk, 2),
            trigger=trigger, phase=phase, quality=quality,
            status=_resolve(direction, entry, target, stop, high, low, i, n)))

    levels = _key_levels(d, float(close.iloc[-1]), prior_day_high, prior_day_low)
    setups = setups[-max_setups:]
    cur_phase, cur_q = session_phase(int(ts.iloc[-1]))
    return SetupTimeline(symbol=symbol, phase=cur_phase, phase_quality=cur_q,
                         setups=setups, levels=levels, watch=_WATCH.get(cur_phase),
                         as_of=_iso(int(ts.iloc[-1])))
