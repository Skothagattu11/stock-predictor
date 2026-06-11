from fastapi import FastAPI, Depends, HTTPException
from app.data.base import MarketData
from app.data.yahoo import YahooMarketData
from app.predictors.intraday import score_intraday
from app.models import IntradayPrediction

app = FastAPI(title="quant-py", version="0.1.0")

_INTERVAL_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1h": 60}


def get_market_data() -> MarketData:
    return YahooMarketData()


@app.get("/health")
def health():
    return {"status": "ok", "service": "quant-py"}


@app.get("/predict/intraday/{symbol}", response_model=IntradayPrediction)
def predict_intraday(symbol: str, interval: str = "5m",
                     md: MarketData = Depends(get_market_data)):
    df = md.fetch_candles(symbol.upper(), interval=interval, range_="1d")
    if df.empty or len(df) < 20:
        raise HTTPException(status_code=422, detail="insufficient candles for intraday analysis")
    return score_intraday(symbol.upper(), df, interval_minutes=_INTERVAL_MINUTES.get(interval, 5))
