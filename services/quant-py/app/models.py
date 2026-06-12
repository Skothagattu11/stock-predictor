from typing import Literal
from pydantic import BaseModel, Field



class Driver(BaseModel):
    name: str
    direction: Literal["up", "down", "neutral"]


class ExpectedMove(BaseModel):
    low: float
    base: float
    high: float
    unit: Literal["price"] = "price"


class TradeLevels(BaseModel):
    direction: Literal["long", "short"]
    entry: float                     # suggested buy (long) / short price
    target: float                    # take-profit price
    stop: float                      # invalidation / stop-loss price
    risk_reward: float               # MEASURED reward:risk = target_dist / risk
    move_pct: float = 0.0            # expected move to target, as a fraction of entry


class IntradayPrediction(BaseModel):
    symbol: str
    bias: Literal["Bullish", "Neutral", "Bearish"]
    probability_up: float = Field(ge=0.0, le=1.0)
    expected_move: ExpectedMove
    regime: str
    regime_confidence: float = Field(ge=0.0, le=1.0)
    invalidation: float
    conviction: float = Field(default=0.0, ge=0.0, le=1.0)   # how far from a coin-flip (0..1)
    drivers: list[Driver]
    levels: TradeLevels | None = None   # actionable entry/target/stop (None when no clean setup)
    as_of: str                       # ISO ts taken from the data, never wall-clock
    source: Literal["quant"] = "quant"
    horizon: Literal["intraday"] = "intraday"


class Scenario(BaseModel):
    case: Literal["bull", "base", "bear"]
    probability: float = Field(ge=0.0, le=1.0)
    target_return_pct: float
    target_price: float


class OutlookPrediction(BaseModel):
    symbol: str
    horizon: Literal["weeks_months"] = "weeks_months"
    stance: Literal["Constructive", "Neutral", "Cautious"]
    score: float = Field(ge=0.0, le=100.0)
    confidence: float = Field(ge=0.0, le=1.0)
    regime: str                       # 'risk_on' | 'risk_off'
    scenarios: list[Scenario]
    drivers: list[Driver]
    as_of: str
    source: Literal["quant"] = "quant"


class PositionPrediction(BaseModel):
    symbol: str
    action: Literal["HOLD", "TRIM", "ADD", "EXIT"]
    unrealized_pnl_pct: float
    unrealized_pnl_abs: float
    weight_pct: float | None = None
    drivers: list[Driver]
    as_of: str
    source: Literal["quant"] = "quant"


class Holding(BaseModel):
    symbol: str
    value: float
    returns: list[float] | None = None    # optional daily returns for correlation


class CorrelationPair(BaseModel):
    a: str
    b: str
    correlation: float


class PortfolioAssessment(BaseModel):
    holdings: list[Holding]
    weights: dict[str, float]
    concentration_hhi: float
    correlations: list[CorrelationPair]
    flags: list[str]
    as_of: str
    source: Literal["quant"] = "quant"
