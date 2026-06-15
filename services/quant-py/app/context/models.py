from pydantic import BaseModel, Field


class Fundamentals(BaseModel):
    symbol: str
    sector: str | None = None
    market_cap: float | None = None
    pe: float | None = None
    pe_forward: float | None = None
    peg: float | None = None
    ev_ebitda: float | None = None
    profit_margin: float | None = None
    revenue_growth_yoy: float | None = None
    eps_growth_yoy: float | None = None
    next_earnings_date: str | None = None
    sources: list[str] = Field(default_factory=list)
    as_of: str


class MacroSnapshot(BaseModel):
    as_of: str
    ten_year_yield: float | None = None
    two_year_yield: float | None = None
    yield_curve_2s10s: float | None = None
    vix: float | None = None
    unemployment: float | None = None
    sources: list[str] = Field(default_factory=list)


class ImpliedMove(BaseModel):
    symbol: str
    spot: float
    atm_iv: float                 # annualized implied volatility
    expiry: str
    days_to_expiry: int
    expected_move_pct: float
    expected_move_abs: float
    low: float
    high: float
    as_of: str


class FieldDiscrepancy(BaseModel):
    field: str
    values: dict[str, float]      # source -> value
    spread_pct: float             # (max - min) / |median|


class FundamentalsResult(BaseModel):
    merged: Fundamentals
    discrepancies: list[FieldDiscrepancy] = Field(default_factory=list)


class SentimentSnapshot(BaseModel):
    symbol: str
    score: float            # -1..1
    label: str              # 'positive' | 'neutral' | 'negative'
    headline_count: int
    as_of: str
    sources: list[str] = Field(default_factory=list)
