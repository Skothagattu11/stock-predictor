# services/quant-py/tests/test_paper_engine.py
from app.paper.engine import open_order, evaluate_exit, mark_to_market, portfolio_stats

def test_open_order_computes_shares_and_cost():
    o = open_order(cash=10000.0, symbol="AAPL", price=40.0, budget=200.0, target=42.0, stop=38.0)
    assert "error" not in o
    assert o["shares"] == 5 and o["cost"] == 200.0 and o["entry"] == 40.0

def test_open_order_rejects_when_unaffordable_or_no_cash():
    assert "error" in open_order(10000.0, "BRK", 300.0, 200.0, 320.0, 280.0)   # shares < 1
    assert "error" in open_order(100.0, "AAPL", 40.0, 200.0, 42.0, 38.0)       # cost > cash

def test_evaluate_exit_target_then_stop_and_none():
    pos = {"target": 42.0, "stop": 38.0}
    assert evaluate_exit(pos, [{"high": 41, "low": 39}, {"high": 42.5, "low": 40}]) == ("target", 42.0)
    assert evaluate_exit(pos, [{"high": 41, "low": 37.5}]) == ("stop", 38.0)
    assert evaluate_exit(pos, [{"high": 41, "low": 39}]) is None
    # both in one bar -> conservative stop
    assert evaluate_exit(pos, [{"high": 43, "low": 37}]) == ("stop", 38.0)
    # chronology: target bar first -> target wins
    assert evaluate_exit(pos, [{"high": 42, "low": 39}, {"high": 41, "low": 37}]) == ("target", 42.0)

def test_evaluate_exit_skips_when_no_levels():
    assert evaluate_exit({"target": None, "stop": None}, [{"high": 99, "low": 1}]) is None

def test_mark_to_market():
    m = mark_to_market({"shares": 5, "entry": 40.0}, last_price=44.0)
    assert m["unrealized_pnl_abs"] == 20.0 and round(m["unrealized_pnl_pct"], 4) == 0.1

def test_portfolio_stats():
    closed = [
        {"shares": 5, "entry": 40.0, "exit_price": 42.0},   # +10
        {"shares": 5, "entry": 40.0, "exit_price": 38.0},   # -10
        {"shares": 2, "entry": 50.0, "exit_price": 55.0},   # +10
    ]
    st = portfolio_stats(closed, starting=10000.0)
    assert st["wins"] == 2 and st["losses"] == 1
    assert round(st["win_rate"], 3) == 0.667
    assert st["realized_pnl"] == 10.0

def test_portfolio_stats_excludes_breakeven():
    closed = [
        {"shares": 5, "entry": 40.0, "exit_price": 42.0},   # +10 win
        {"shares": 5, "entry": 40.0, "exit_price": 40.0},   # break-even -> neither
    ]
    st = portfolio_stats(closed, starting=10000.0)
    assert st["wins"] == 1 and st["losses"] == 0
    assert st["win_rate"] == 1.0
    assert st["realized_pnl"] == 10.0
