"""Combine partial Fundamentals from multiple providers; flag disagreements.

Numeric fields: merged value = median across sources that supplied it; a field is
flagged when >=2 sources supplied it and the relative spread exceeds the threshold.
Non-numeric fields: first non-null wins.
"""
from statistics import median
from app.context.models import Fundamentals, FundamentalsResult, FieldDiscrepancy

NUMERIC_FIELDS = [
    "market_cap", "pe", "pe_forward", "peg", "ev_ebitda",
    "profit_margin", "revenue_growth_yoy", "eps_growth_yoy",
]
NON_NUMERIC_FIELDS = ["sector", "next_earnings_date"]
DISCREPANCY_THRESHOLD = 0.10   # 10% relative spread


def merge_fundamentals(symbol: str, partials: list[Fundamentals]) -> FundamentalsResult:
    as_of = partials[0].as_of if partials else ""
    merged = Fundamentals(symbol=symbol, as_of=as_of)
    discrepancies: list[FieldDiscrepancy] = []

    sources: list[str] = []
    for p in partials:
        for s in p.sources:
            if s not in sources:
                sources.append(s)
    merged.sources = sources

    for field in NUMERIC_FIELDS:
        by_source: dict[str, float] = {}
        for p in partials:
            v = getattr(p, field)
            if v is not None:
                src = p.sources[0] if p.sources else "unknown"
                by_source[src] = float(v)
        if not by_source:
            continue
        values = list(by_source.values())
        med = median(values)
        setattr(merged, field, med)
        if len(values) >= 2 and med != 0:
            spread = (max(values) - min(values)) / abs(med)
            if spread > DISCREPANCY_THRESHOLD:
                discrepancies.append(FieldDiscrepancy(
                    field=field, values=by_source, spread_pct=round(spread, 4)))

    for field in NON_NUMERIC_FIELDS:
        for p in partials:
            v = getattr(p, field)
            if v is not None:
                setattr(merged, field, v)
                break

    return FundamentalsResult(merged=merged, discrepancies=discrepancies)
