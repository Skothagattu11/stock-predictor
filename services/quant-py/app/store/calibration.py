"""Durable calibration track-record (SQLite). Records each setup the scanner
surfaces and its outcome; aggregates hit-rate / avg R:R across days."""
import os
import sqlite3
from datetime import datetime, timezone


def _now():
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class CalibrationStore:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._path = path
        self._init()

    def _conn(self):
        return sqlite3.connect(self._path)

    def _init(self):
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS predictions (
                id TEXT PRIMARY KEY, symbol TEXT, type TEXT, direction TEXT,
                entry REAL, target REAL, stop REAL, rr REAL, status TEXT,
                created_at TEXT, updated_at TEXT)""")

    def record_setups(self, symbol: str, setups: list[dict]):
        if not setups:
            return
        now = _now()
        with self._conn() as c:
            for s in setups:
                sid = f"{symbol}|{s.get('time')}|{s.get('type')}|{s.get('direction')}"
                c.execute("""INSERT INTO predictions
                    (id, symbol, type, direction, entry, target, stop, rr, status, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at""",
                          (sid, symbol, s.get("type"), s.get("direction"), s.get("entry"),
                           s.get("target"), s.get("stop"), s.get("risk_reward"),
                           s.get("status"), now, now))

    def stats(self) -> dict:
        with self._conn() as c:
            rows = c.execute("SELECT type, status, rr FROM predictions").fetchall()
        groups: dict = {}
        overall = {"type": "All", "n": 0, "win": 0, "loss": 0, "pending": 0, "rr_sum": 0.0}
        for typ, status, rr in rows:
            g = groups.setdefault(typ, {"type": typ, "n": 0, "win": 0, "loss": 0, "pending": 0, "rr_sum": 0.0})
            for d in (g, overall):
                d["n"] += 1
                d["rr_sum"] += rr or 0.0
            if status == "triggered_win":
                g["win"] += 1; overall["win"] += 1
            elif status == "triggered_loss":
                g["loss"] += 1; overall["loss"] += 1
            else:
                g["pending"] += 1; overall["pending"] += 1

        def finish(d):
            res = d["win"] + d["loss"]
            d["hit_rate"] = round(d["win"] / res, 3) if res else None
            d["avg_rr"] = round(d["rr_sum"] / d["n"], 2) if d["n"] else None
            d.pop("rr_sum", None)
            return d

        return {"groups": [finish(g) for g in groups.values()], "overall": finish(overall)}
