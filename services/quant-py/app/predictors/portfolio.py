"""Portfolio concentration + correlation assessment. Deterministic."""
from datetime import datetime, timezone
from itertools import combinations
import numpy as np
from app.models import Holding, CorrelationPair, PortfolioAssessment

CONCENTRATION_WEIGHT = 0.35     # any single name above this is flagged
HIGH_CORRELATION = 0.80


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def assess_portfolio(holdings: list[Holding]) -> PortfolioAssessment:
    total = sum(h.value for h in holdings) or 1.0
    weights = {h.symbol: h.value / total for h in holdings}
    hhi = sum(w * w for w in weights.values())

    flags: list[str] = []
    top = max(weights, key=weights.get) if weights else None
    if top and weights[top] > CONCENTRATION_WEIGHT:
        flags.append(f"single-name concentration: {top} {weights[top]*100:.0f}%")

    correlations: list[CorrelationPair] = []
    series = {h.symbol: h.returns for h in holdings if h.returns}
    for a, b in combinations(series.keys(), 2):
        ra, rb = series[a], series[b]
        n = min(len(ra), len(rb))
        if n < 2:
            continue
        corr = float(np.corrcoef(ra[:n], rb[:n])[0, 1])
        if np.isnan(corr):
            continue
        correlations.append(CorrelationPair(a=a, b=b, correlation=round(corr, 4)))
        if corr > HIGH_CORRELATION:
            flags.append(f"high correlation: {a}/{b} {corr:.2f}")

    return PortfolioAssessment(
        holdings=holdings, weights={k: round(v, 4) for k, v in weights.items()},
        concentration_hhi=round(hhi, 4), correlations=correlations,
        flags=flags, as_of=_now_iso())
