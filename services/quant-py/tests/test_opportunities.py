import math
from app.predictors.opportunities import prob_hit_target_before_stop

def test_driftless_is_gamblers_ruin():
    # no drift: P(up first) = s / (r + s)
    p = prob_hit_target_before_stop(r=0.05, s=0.05, mu=0.0, sigma=0.10)
    assert abs(p - 0.5) < 1e-9
    p2 = prob_hit_target_before_stop(r=0.05, s=0.15, mu=0.0, sigma=0.10)
    assert abs(p2 - 0.75) < 1e-9   # 0.15 / 0.20

def test_positive_drift_raises_probability():
    base = prob_hit_target_before_stop(r=0.05, s=0.05, mu=0.0, sigma=0.10)
    up = prob_hit_target_before_stop(r=0.05, s=0.05, mu=0.03, sigma=0.10)
    assert up > base

def test_probability_is_bounded():
    for mu in (-0.2, 0.0, 0.2):
        p = prob_hit_target_before_stop(r=0.05, s=0.05, mu=mu, sigma=0.10)
        assert 0.0 <= p <= 1.0
