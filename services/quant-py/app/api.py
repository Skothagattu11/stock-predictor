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


from app import config
from app.context.models import MacroSnapshot, ImpliedMove, FundamentalsResult
from app.context.crosscheck import merge_fundamentals
from app.data.base import FundamentalsProvider, MacroProvider, OptionsProvider
from app.data.fred import FredMacro
from app.data.finnhub import FinnhubFundamentals
from app.data.fmp import FmpFundamentals
from app.data.yahoo_options import YahooOptions


def get_fundamentals_providers() -> list[FundamentalsProvider]:
    providers: list[FundamentalsProvider] = []
    if config.FINNHUB_API_KEY:
        providers.append(FinnhubFundamentals(api_key=config.FINNHUB_API_KEY))
    if config.FMP_API_KEY:
        providers.append(FmpFundamentals(api_key=config.FMP_API_KEY))
    return providers


def get_macro_provider() -> MacroProvider | None:
    return FredMacro(api_key=config.FRED_API_KEY) if config.FRED_API_KEY else None


def get_options_provider() -> OptionsProvider:
    return YahooOptions()


@app.get("/context/fundamentals/{symbol}", response_model=FundamentalsResult)
def context_fundamentals(symbol: str,
                         providers: list = Depends(get_fundamentals_providers)):
    if not providers:
        raise HTTPException(status_code=503, detail="no fundamentals provider configured")
    symbol = symbol.upper()
    partials = []
    for p in providers:
        try:
            partials.append(p.fetch_fundamentals(symbol))
        except Exception:
            continue   # a failing provider must not sink the others
    if not partials:
        raise HTTPException(status_code=502, detail="all fundamentals providers failed")
    return merge_fundamentals(symbol, partials)


@app.get("/context/macro", response_model=MacroSnapshot)
def context_macro(provider: MacroProvider | None = Depends(get_macro_provider)):
    if provider is None:
        raise HTTPException(status_code=503, detail="FRED_API_KEY not configured")
    return provider.fetch_macro()


@app.get("/context/implied-move/{symbol}", response_model=ImpliedMove)
def context_implied_move(symbol: str, provider: OptionsProvider = Depends(get_options_provider)):
    return provider.fetch_implied_move(symbol.upper())
