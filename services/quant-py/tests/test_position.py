from app.predictors.position import assess_position

def test_profit_and_overweight_trims():
    p = assess_position("AAPL", current_price=130.0, cost_basis=100.0, shares=100,
                        portfolio_value=50000.0)  # +30%, weight 26%
    assert p.action == "TRIM"
    assert round(p.unrealized_pnl_pct, 2) == 0.30
    assert p.unrealized_pnl_abs == 3000.0

def test_cautious_outlook_in_profit_exits():
    p = assess_position("AAPL", current_price=120.0, cost_basis=100.0, shares=10,
                        portfolio_value=100000.0, outlook_stance="Cautious")
    assert p.action == "EXIT"

def test_loss_with_constructive_outlook_adds():
    p = assess_position("AAPL", current_price=90.0, cost_basis=100.0, shares=10,
                        portfolio_value=100000.0, outlook_stance="Constructive")
    assert p.action == "ADD"
    assert p.unrealized_pnl_pct == -0.10

def test_default_hold():
    p = assess_position("AAPL", current_price=102.0, cost_basis=100.0, shares=10,
                        portfolio_value=100000.0)
    assert p.action == "HOLD"

def test_weight_none_when_no_portfolio_value():
    p = assess_position("AAPL", current_price=102.0, cost_basis=100.0, shares=10)
    assert p.weight_pct is None
