"""Exit plan for long holdings: a protective stop + scale-out targets at key
levels + trail the remainder. Deterministic; uses key support/resistance + daily ATR."""
from app.models import ExitPlan, ExitTarget, ExitStop

SCALE_PORTIONS = [0.34, 0.33]   # sell at T1, T2; the rest trails
STOP_ATR = 1.0                  # initial protective stop distance (× daily ATR)
TRAIL_ATR = 1.0                 # trail distance once in profit (× daily ATR)


def build_exit_plan(symbol, cost_basis, price, shares, levels, daily_atr, outlook_stance=None) -> ExitPlan:
    cb = cost_basis or price
    atr = daily_atr if (daily_atr and daily_atr > 0) else price * 0.01
    in_profit = price > cb
    res = sorted(l.price for l in levels if l.kind == "resistance" and l.price > price)
    sup = sorted((l.price for l in levels if l.kind == "support" and l.price < price), reverse=True)

    # ---- protective stop ----
    if in_profit:
        cands = [cb]                                   # breakeven
        if sup:
            cands.append(sup[0])                       # just below nearest support
        cands.append(price - TRAIL_ATR * atr)          # ATR trail
        below = [c for c in cands if c < price]
        stop_price = max(below) if below else price - TRAIL_ATR * atr
        if abs(stop_price - cb) < 1e-6:
            basis = "breakeven"
        elif sup and abs(stop_price - sup[0]) < 1e-6:
            basis = "support"
        else:
            basis = "atr-trail"
    else:
        cands = [price - STOP_ATR * atr]
        if sup:
            cands.append(sup[0])
        stop_price = max(cands)
        basis = "support" if (sup and abs(stop_price - sup[0]) < 1e-6) else "atr"
    stop = ExitStop(price=round(stop_price, 2), pct=round((stop_price - price) / price, 4), basis=basis)

    # ---- scale-out targets (prefer resistance levels; pad with R-multiples to 2, ordered) ----
    risk = max(price - stop_price, 0.01)
    tps = [(p, "resistance") for p in res[:2]]      # (price, basis)
    last = tps[-1][0] if tps else price
    while len(tps) < 2:
        nxt = round((price + 1.5 * risk) if not tps else (last + 1.0 * risk), 4)
        tps.append((nxt, "R-multiple"))
        last = nxt
    targets = []
    for i, (tp, b) in enumerate(tps):
        portion = SCALE_PORTIONS[i] if i < len(SCALE_PORTIONS) else SCALE_PORTIONS[-1]
        targets.append(ExitTarget(
            label=f"T{i + 1}", price=round(tp, 2), pct_move=round((tp - price) / price, 4),
            sell_portion=portion, shares=round(shares * portion, 2) if shares else None, basis=b))
    trail_remainder = round(max(0.0, 1.0 - sum(t.sell_portion for t in targets)), 2)
    tbasis = targets[0].basis

    trail_note = (f"After T1, trail the remaining {int(trail_remainder * 100)}% with a stop "
                  f"~{TRAIL_ATR:.0f}×ATR (≈${TRAIL_ATR * atr:.2f}) under price.")
    if in_profit:
        lead = f"Up {(price - cb) / cb * 100:.1f}% — protect with a {basis.replace('-', ' ')} stop; "
    else:
        lead = f"Down {(cb - price) / cb * 100:.1f}% — cap risk with a {basis} stop; "
    rationale = (lead + f"scale out {int(SCALE_PORTIONS[0] * 100)}% near {tbasis} ${targets[0].price}, "
                 f"more near ${targets[1].price}, trail the rest."
                 + (" Outlook cautious — consider exiting sooner." if outlook_stance == "Cautious" else ""))

    return ExitPlan(in_profit=in_profit, stop=stop, targets=targets,
                    trail_remainder=trail_remainder, trail_note=trail_note, rationale=rationale)
