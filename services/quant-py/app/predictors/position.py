"""P/L-aware position action. Deterministic; no LLM, no I/O."""
from datetime import datetime, timezone
from app.models import PositionPrediction, Driver

OVERWEIGHT = 0.20          # >20% of portfolio is overweight
BIG_GAIN = 0.25            # +25% unrealized
STOP_LOSS = -0.15          # -15% unrealized


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def assess_position(symbol: str, current_price: float, cost_basis: float,
                    shares: float | None = None, portfolio_value: float | None = None,
                    intraday_bias: str | None = None,
                    outlook_stance: str | None = None) -> PositionPrediction:
    pnl_pct = (current_price - cost_basis) / cost_basis if cost_basis else 0.0
    pnl_abs = (current_price - cost_basis) * (shares if shares else 1.0)
    weight = None
    if shares and portfolio_value:
        weight = (current_price * shares) / portfolio_value

    drivers: list[Driver] = []
    action = "HOLD"

    if pnl_pct > 0:
        drivers.append(Driver(name=f"Up {pnl_pct*100:.0f}% vs entry", direction="up"))
    elif pnl_pct < 0:
        drivers.append(Driver(name=f"Down {abs(pnl_pct)*100:.0f}% vs entry", direction="down"))

    # decision precedence: protect on downside / trim risk, then add on conviction
    if outlook_stance == "Cautious" and pnl_pct > 0:
        action = "EXIT"
        drivers.append(Driver(name="Cautious outlook — take profit", direction="down"))
    elif pnl_pct <= STOP_LOSS and outlook_stance != "Constructive":
        action = "EXIT"
        drivers.append(Driver(name="Below stop, no constructive outlook", direction="down"))
    elif weight is not None and weight > OVERWEIGHT and pnl_pct > 0:
        action = "TRIM"
        drivers.append(Driver(name=f"Overweight ({weight*100:.0f}% of book)", direction="down"))
    elif pnl_pct >= BIG_GAIN:
        action = "TRIM"
        drivers.append(Driver(name="Large gain — lock some in", direction="down"))
    elif pnl_pct < 0 and outlook_stance == "Constructive":
        action = "ADD"
        drivers.append(Driver(name="Weakness + constructive outlook", direction="up"))
    elif intraday_bias == "Bearish" and pnl_pct > 0:
        action = "TRIM"
        drivers.append(Driver(name="Intraday bearish — reduce", direction="down"))

    return PositionPrediction(
        symbol=symbol, action=action, unrealized_pnl_pct=round(pnl_pct, 4),
        unrealized_pnl_abs=round(pnl_abs, 4),
        weight_pct=round(weight, 4) if weight is not None else None,
        drivers=drivers, as_of=_now_iso())
