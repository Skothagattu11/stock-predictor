import numpy as np, pandas as pd
from app.predictors.setups import scan_setups

def _session(close, highs=None, lows=None, vols=None, start_epoch=1_749_652_200):
    close = np.asarray(close, float); n = len(close)
    return pd.DataFrame({
        "timestamp": start_epoch + np.arange(n) * 60,   # 1-min bars
        "open": close,
        "high": close + (0.3 if highs is None else 0),
        "low": close - (0.3 if lows is None else 0),
        "close": close,
        "volume": np.full(n, 100.0) if vols is None else np.asarray(vols, float),
    })

def test_orb_breakout_detected_in_uptrend():
    # flat opening range then a volume breakout up
    close = np.concatenate([np.full(15, 100.0), np.linspace(100.5, 108, 45)])
    vols = np.concatenate([np.full(15, 100.0), np.full(45, 400.0)])
    tl = scan_setups("AAPL", _session(close, vols=vols), daily_atr=8.0)
    kinds = [s.type for s in tl.setups]
    assert any("ORB" in k for k in kinds)
    long_setup = next(s for s in tl.setups if s.direction == "long")
    assert long_setup.target > long_setup.entry > long_setup.stop
    assert long_setup.risk_reward > 0

def test_setup_outcome_backtested_win():
    # breakout that then runs well past target => triggered_win on the earliest setup
    close = np.concatenate([np.full(15, 100.0), np.linspace(101, 120, 45)])
    vols = np.concatenate([np.full(15, 100.0), np.full(45, 400.0)])
    tl = scan_setups("AAPL", _session(close, vols=vols), daily_atr=5.0)
    assert any(s.status == "triggered_win" for s in tl.setups)

def test_phase_and_watch_present():
    close = np.linspace(100, 105, 60)
    tl = scan_setups("AAPL", _session(close), daily_atr=5.0)
    assert tl.phase in ("pre","open_drive","morning","midday","afternoon","power_hour","closed")
    assert isinstance(tl.watch, str)

def test_no_setups_when_quiet_and_flat():
    tl = scan_setups("AAPL", _session(np.full(60, 100.0)), daily_atr=5.0)
    # a dead-flat tape triggers no ORB/VWAP/EMA events
    assert tl.setups == []
