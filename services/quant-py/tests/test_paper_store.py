# services/quant-py/tests/test_paper_store.py
import os
from app.store.paper import PaperStore

def _store(tmp_path):
    return PaperStore(os.path.join(tmp_path, "paper.db"))

def test_seeds_account_with_starting_cash(tmp_path):
    s = _store(tmp_path)
    acct = s.get_account()
    assert acct["cash"] == 10000.0 and acct["starting"] == 10000.0

def test_open_position_debits_cash_and_lists_open(tmp_path):
    s = _store(tmp_path)
    pid = s.open_position("AAPL", shares=5, entry=40.0, target=42.0, stop=38.0, cost=200.0, source="manual")
    assert isinstance(pid, str)
    assert s.get_account()["cash"] == 9800.0
    opens = s.list_positions(status="open")
    assert len(opens) == 1 and opens[0]["symbol"] == "AAPL" and opens[0]["shares"] == 5

def test_close_position_credits_cash_and_moves_to_closed(tmp_path):
    s = _store(tmp_path)
    pid = s.open_position("AAPL", 5, 40.0, 42.0, 38.0, 200.0, "manual")
    s.close_position(pid, exit_price=42.0, exit_reason="target")
    assert s.get_account()["cash"] == 9800.0 + 5 * 42.0
    assert s.list_positions(status="open") == []
    closed = s.list_positions(status="closed")
    assert closed[0]["exit_reason"] == "target" and closed[0]["status"] == "closed"

def test_settings_roundtrip_and_reset(tmp_path):
    s = _store(tmp_path)
    assert s.get_settings()["auto_enabled"] == 0
    s.set_settings(auto_enabled=1, budget=200.0, target=12.0, risk="balanced")
    assert s.get_settings()["budget"] == 200.0 and s.get_settings()["auto_enabled"] == 1
    s.open_position("AAPL", 5, 40.0, 42.0, 38.0, 200.0, "manual")
    s.reset(starting=10000.0)
    assert s.get_account()["cash"] == 10000.0 and s.list_positions() == []
