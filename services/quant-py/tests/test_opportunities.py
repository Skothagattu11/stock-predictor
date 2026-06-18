import math
import numpy as np, pandas as pd
from app.predictors.opportunities import prob_hit_target_before_stop
from app.predictors.opportunities import (
    affordability, pe_tag, tier_config, stop_fraction_for)
from app.predictors.opportunities import MIN_STOP_FRAC, MAX_STOP_FRAC

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

def test_affordability_whole_shares_and_required_move():
    a = affordability(price=40.0, budget=200.0, target=10.0)
    assert a["shares"] == 5 and a["invested"] == 200.0
    assert abs(a["required_move"] - 0.05) < 1e-9
    b = affordability(price=150.0, budget=200.0, target=10.0)
    assert b["shares"] == 1 and abs(b["required_move"] - (10.0 / 150.0)) < 1e-9

def test_affordability_unaffordable_returns_none():
    assert affordability(price=300.0, budget=200.0, target=10.0) is None

def test_pe_tag_buckets():
    assert pe_tag(None) == "n/a"
    assert pe_tag(12.0) == "cheap"
    assert pe_tag(22.0) == "fair"
    assert pe_tag(45.0) == "rich"

def test_tier_config_maps_risk():
    thr, lanes = tier_config("cautious")
    assert thr == 0.65 and "penny" not in lanes
    thr2, lanes2 = tier_config("aggressive")
    assert thr2 == 0.45 and "penny" in lanes2
    assert tier_config("unknown")[0] == 0.55   # defaults to balanced

def test_stop_fraction_is_bounded():
    assert stop_fraction_for(0.0) == MIN_STOP_FRAC
    assert stop_fraction_for(10.0) == MAX_STOP_FRAC
