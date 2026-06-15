from app.store.calibration import CalibrationStore

def _setup(time, status, rr=2.0, typ="VWAP bounce"):
    return {"time": time, "type": typ, "direction": "long", "entry": 100.0,
            "target": 102.0, "stop": 99.0, "risk_reward": rr, "status": status}

def test_record_and_stats(tmp_path):
    db = CalibrationStore(str(tmp_path / "c.db"))
    db.record_setups("AAPL", [_setup("2026-06-15T14:00:00Z", "triggered_win"),
                              _setup("2026-06-15T14:05:00Z", "triggered_loss")])
    s = db.stats()
    g = next(x for x in s["groups"] if x["type"] == "VWAP bounce")
    assert g["win"] == 1 and g["loss"] == 1
    assert s["overall"]["n"] == 2

def test_upsert_updates_status(tmp_path):
    db = CalibrationStore(str(tmp_path / "c.db"))
    sid = "2026-06-15T14:00:00Z"
    db.record_setups("AAPL", [_setup(sid, "active")])
    db.record_setups("AAPL", [_setup(sid, "triggered_win")])   # same id -> update
    assert db.stats()["overall"]["win"] == 1
    assert db.stats()["overall"]["n"] == 1                      # not duplicated

def test_hit_rate_excludes_pending(tmp_path):
    db = CalibrationStore(str(tmp_path / "c.db"))
    db.record_setups("X", [_setup("t1", "triggered_win"), _setup("t2", "active")])
    o = db.stats()["overall"]
    assert o["win"] == 1 and o["pending"] == 1 and o["hit_rate"] == 1.0
