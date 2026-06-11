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


class IntradayPrediction(BaseModel):
    symbol: str
    bias: Literal["Bullish", "Neutral", "Bearish"]
    probability_up: float = Field(ge=0.0, le=1.0)
    expected_move: ExpectedMove
    regime: str
    regime_confidence: float = Field(ge=0.0, le=1.0)
    invalidation: float
    drivers: list[Driver]
    as_of: str                       # ISO ts taken from the data, never wall-clock
    source: Literal["quant"] = "quant"
    horizon: Literal["intraday"] = "intraday"
