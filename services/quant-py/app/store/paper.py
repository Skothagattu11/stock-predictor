# services/quant-py/app/store/paper.py
"""Durable paper-trading book (SQLite): one cash account, open/closed positions,
and the auto-mode settings. Mirrors CalibrationStore; lives on the /data disk."""
import os
import sqlite3
import uuid
from datetime import datetime, timezone


def _now():
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class PaperStore:
    def __init__(self, path: str, starting: float = 10000.0):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._path = path
        self._init(starting)

    def _conn(self):
        c = sqlite3.connect(self._path)
        c.row_factory = sqlite3.Row
        return c

    def _init(self, starting):
        with self._conn() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS account (
                id INTEGER PRIMARY KEY CHECK (id=1), cash REAL, starting REAL, created_at TEXT)""")
            c.execute("""CREATE TABLE IF NOT EXISTS positions (
                id TEXT PRIMARY KEY, symbol TEXT, shares REAL, entry REAL, target REAL, stop REAL,
                opened_at TEXT, status TEXT, exit_price REAL, exit_reason TEXT, closed_at TEXT, source TEXT)""")
            c.execute("""CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id=1), auto_enabled INTEGER, budget REAL, target REAL, risk TEXT)""")
            if c.execute("SELECT COUNT(*) FROM account").fetchone()[0] == 0:
                c.execute("INSERT INTO account (id, cash, starting, created_at) VALUES (1,?,?,?)",
                          (starting, starting, _now()))
            if c.execute("SELECT COUNT(*) FROM settings").fetchone()[0] == 0:
                c.execute("INSERT INTO settings (id, auto_enabled, budget, target, risk) VALUES (1,0,200.0,12.0,'balanced')")

    def get_account(self) -> dict:
        with self._conn() as c:
            return dict(c.execute("SELECT cash, starting, created_at FROM account WHERE id=1").fetchone())

    def open_position(self, symbol, shares, entry, target, stop, cost, source) -> str:
        pid = uuid.uuid4().hex
        with self._conn() as c:
            c.execute("""INSERT INTO positions
                (id, symbol, shares, entry, target, stop, opened_at, status, source)
                VALUES (?,?,?,?,?,?,?, 'open', ?)""",
                      (pid, symbol.upper(), shares, entry, target, stop, _now(), source))
            c.execute("UPDATE account SET cash = cash - ? WHERE id=1", (cost,))
        return pid

    def close_position(self, pid, exit_price, exit_reason):
        with self._conn() as c:
            row = c.execute("SELECT shares, status FROM positions WHERE id=?", (pid,)).fetchone()
            if not row or row["status"] != "open":
                return
            c.execute("""UPDATE positions SET status='closed', exit_price=?, exit_reason=?, closed_at=?
                WHERE id=?""", (exit_price, exit_reason, _now(), pid))
            c.execute("UPDATE account SET cash = cash + ? WHERE id=1", (row["shares"] * exit_price,))

    def list_positions(self, status: str | None = None) -> list[dict]:
        q = "SELECT * FROM positions"
        args = ()
        if status:
            q += " WHERE status=?"; args = (status,)
        q += " ORDER BY opened_at DESC"
        with self._conn() as c:
            return [dict(r) for r in c.execute(q, args).fetchall()]

    def get_settings(self) -> dict:
        with self._conn() as c:
            return dict(c.execute("SELECT auto_enabled, budget, target, risk FROM settings WHERE id=1").fetchone())

    def set_settings(self, auto_enabled, budget, target, risk):
        with self._conn() as c:
            c.execute("UPDATE settings SET auto_enabled=?, budget=?, target=?, risk=? WHERE id=1",
                      (1 if auto_enabled else 0, budget, target, risk))

    def reset(self, starting: float = 10000.0):
        with self._conn() as c:
            c.execute("DELETE FROM positions")
            c.execute("UPDATE account SET cash=?, starting=?, created_at=? WHERE id=1",
                      (starting, starting, _now()))
