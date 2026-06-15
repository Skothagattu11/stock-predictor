from app.models import KeyLevel
from app.predictors.exit_plan import build_exit_plan


def _levels(sup, res):
    return ([KeyLevel(price=p, kind="support", label="s") for p in sup] +
            [KeyLevel(price=p, kind="resistance", label="r") for p in res])


def test_profit_plan_scales_out_at_resistance():
    p = build_exit_plan("AAPL", cost_basis=100, price=110, shares=90,
                        levels=_levels([105, 95], [115, 120]), daily_atr=8)
    assert p.in_profit
    assert 100 <= p.stop.price < 110            # protected at breakeven/support, below price
    assert [t.price for t in p.targets] == [115, 120]
    assert p.targets[0].basis == "resistance"
    assert 0 < p.trail_remainder < 1
    assert p.targets[0].shares == round(90 * 0.34, 2)


def test_loss_plan_stops_below_price():
    p = build_exit_plan("AAPL", cost_basis=100, price=92, shares=10,
                        levels=_levels([90], [105]), daily_atr=8)
    assert not p.in_profit
    assert p.stop.price < 92


def test_no_resistance_falls_back_to_r_multiple():
    p = build_exit_plan("AAPL", cost_basis=100, price=110, shares=10,
                        levels=_levels([105], []), daily_atr=8)
    assert p.targets[0].basis == "R-multiple"
    assert p.targets[0].price > 110 and p.targets[1].price > p.targets[0].price


def test_shares_none_when_not_provided():
    p = build_exit_plan("AAPL", cost_basis=100, price=110, shares=None,
                        levels=_levels([105], [115, 120]), daily_atr=8)
    assert p.targets[0].shares is None
