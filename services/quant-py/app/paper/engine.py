# services/quant-py/app/paper/engine.py
"""Pure paper-trading math: order sizing, exit detection, mark-to-market, stats.
No I/O — callers supply prices/bars and persist via PaperStore."""
import math


def open_order(cash, symbol, price, budget, target, stop) -> dict:
    if price is None or price <= 0:
        return {"error": "no live price"}
    shares = int(budget // price)
    if shares < 1:
        return {"error": "budget too small for one share"}
    cost = round(shares * price, 4)
    if cost > cash + 1e-9:
        return {"error": "insufficient cash"}
    return {"symbol": symbol.upper(), "shares": shares, "cost": cost,
            "entry": price, "target": target, "stop": stop}


def evaluate_exit(position, bars):
    """Scan bars (each {'high','low'}) in order. First to touch target -> win,
    first to touch stop -> loss. A bar crossing both resolves to stop."""
    target, stop = position.get("target"), position.get("stop")
    if target is None and stop is None:
        return None
    for b in bars:
        hit_stop = stop is not None and b["low"] <= stop
        hit_target = target is not None and b["high"] >= target
        if hit_stop:                       # conservative when a bar spans both
            return ("stop", stop)
        if hit_target:
            return ("target", target)
    return None


def mark_to_market(position, last_price) -> dict:
    entry = position["entry"]; shares = position["shares"]
    pnl = (last_price - entry) * shares
    return {"last_price": last_price,
            "market_value": round(last_price * shares, 2),
            "unrealized_pnl_abs": round(pnl, 2),
            "unrealized_pnl_pct": round((last_price - entry) / entry, 6) if entry else 0.0}


def portfolio_stats(closed, starting) -> dict:
    wins = losses = 0
    win_sum = loss_sum = realized = 0.0
    for p in closed:
        pnl = (p["exit_price"] - p["entry"]) * p["shares"]
        realized += pnl
        if pnl >= 0:
            wins += 1; win_sum += pnl
        else:
            losses += 1; loss_sum += pnl
    decided = wins + losses
    return {
        "wins": wins, "losses": losses,
        "win_rate": round(wins / decided, 3) if decided else None,
        "avg_win": round(win_sum / wins, 2) if wins else None,
        "avg_loss": round(loss_sum / losses, 2) if losses else None,
        "realized_pnl": round(realized, 2),
        "total_return_pct": round(realized / starting, 4) if starting else 0.0,
    }
