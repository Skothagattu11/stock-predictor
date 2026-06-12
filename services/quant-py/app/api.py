from fastapi import FastAPI, Depends, HTTPException
from app import indicators as ind
from app.data.base import MarketData
from app.data.yahoo import YahooMarketData
from app.predictors.intraday import score_intraday
from app.models import IntradayPrediction


def _daily_atr(md: MarketData, symbol: str) -> float | None:
    """Typical daily range (ATR-14 on daily bars) — anchors realistic intraday targets."""
    try:
        ddf = md.fetch_candles(symbol, interval="1d", range_="3mo")
        if ddf.empty or len(ddf) < 15:
            return None
        return float(ind.atr(ddf["high"], ddf["low"], ddf["close"], 14).iloc[-1])
    except Exception:
        return None

app = FastAPI(title="quant-py", version="0.1.0")

_INTERVAL_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1h": 60}


def get_market_data() -> MarketData:
    return YahooMarketData()


@app.get("/health")
def health():
    return {"status": "ok", "service": "quant-py"}


@app.get("/predict/intraday/{symbol}", response_model=IntradayPrediction)
def predict_intraday(symbol: str, interval: str = "1m",
                     md: MarketData = Depends(get_market_data)):
    # 1-minute bars so the read is live early in the session (usable ~15 min after
    # the open) and as_of tracks the current minute.
    sym = symbol.upper()
    df = md.fetch_candles(sym, interval=interval, range_="1d")
    if df.empty or len(df) < 15:
        raise HTTPException(status_code=422, detail="insufficient candles for intraday analysis")
    return score_intraday(sym, df, interval_minutes=_INTERVAL_MINUTES.get(interval, 1),
                          daily_atr=_daily_atr(md, sym))


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


from pydantic import BaseModel as _BaseModel
from app.models import OutlookPrediction, PositionPrediction, PortfolioAssessment, Holding
from app.predictors.outlook import score_outlook
from app.predictors.position import assess_position
from app.predictors.portfolio import assess_portfolio


@app.get("/predict/outlook/{symbol}", response_model=OutlookPrediction)
def predict_outlook(symbol: str, benchmark: str = "SPY",
                    md: MarketData = Depends(get_market_data)):
    symbol = symbol.upper()
    df = md.fetch_candles(symbol, interval="1d", range_="2y")
    if df.empty or len(df) < 220:
        raise HTTPException(status_code=422, detail="insufficient daily history for outlook")
    bench_df = None
    try:
        bench_df = md.fetch_candles(benchmark.upper(), interval="1d", range_="2y")
    except Exception:
        bench_df = None
    return score_outlook(symbol, df, benchmark_df=bench_df)


def _live_price(md: MarketData, symbol: str) -> float | None:
    try:
        df = md.fetch_candles(symbol, interval="1m", range_="1d")
        if not df.empty:
            return float(df["close"].iloc[-1])
    except Exception:
        pass
    return None


@app.get("/predict/position/{symbol}", response_model=PositionPrediction)
def predict_position(symbol: str, cost_basis: float, current_price: float | None = None,
                     shares: float | None = None, portfolio_value: float | None = None,
                     intraday_bias: str | None = None, outlook_stance: str | None = None,
                     md: MarketData = Depends(get_market_data)):
    sym = symbol.upper()
    # Source the live price server-side so P/L doesn't depend on the browser's chart feed.
    price = current_price if current_price is not None else _live_price(md, sym)
    if price is None:
        price = cost_basis
    return assess_position(sym, current_price=price, cost_basis=cost_basis,
                           shares=shares, portfolio_value=portfolio_value,
                           intraday_bias=intraday_bias, outlook_stance=outlook_stance)


from app.data.fmp_market import FmpMarket
from app.data.yahoo_screener import YahooScreener
from app.discovery.scanner import build_discover
from app.models import DiscoverResult

def get_discover_providers():
    fmp = FmpMarket(api_key=config.FMP_API_KEY) if config.FMP_API_KEY else None
    return fmp, YahooScreener()      # Yahoo always available as backup (keyless/crumb)

@app.get("/discover", response_model=DiscoverResult)
def discover(providers=Depends(get_discover_providers)):
    fmp, yahoo = providers
    if fmp is None and yahoo is None:
        raise HTTPException(status_code=503, detail="no screener provider configured")
    result = build_discover(fmp, yahoo=yahoo)
    if not (result.hot or result.penny or result.shine):
        raise HTTPException(status_code=503, detail="screener returned no data (rate-limited or no key)")
    return result


from app.predictors.setups import scan_setups
from app.models import SetupTimeline


def _prior_day_hilo(md: MarketData, symbol: str):
    try:
        ddf = md.fetch_candles(symbol, interval="1d", range_="1mo")
        if not ddf.empty and len(ddf) >= 2:        # [-1] is today's forming bar, [-2] = prior day
            return float(ddf["high"].iloc[-2]), float(ddf["low"].iloc[-2])
    except Exception:
        pass
    return None, None

@app.get("/predict/setups/{symbol}", response_model=SetupTimeline)
def predict_setups(symbol: str, interval: str = "1m", md: MarketData = Depends(get_market_data)):
    sym = symbol.upper()
    interval = interval if interval in ("1m", "5m") else "1m"
    df = md.fetch_candles(sym, interval=interval, range_="1d")
    if df.empty or len(df) < 20:
        raise HTTPException(status_code=422, detail="insufficient candles for setup scan")
    pdh, pdl = _prior_day_hilo(md, sym)
    return scan_setups(sym, df, daily_atr=_daily_atr(md, sym), prior_day_high=pdh, prior_day_low=pdl,
                       interval_minutes=_INTERVAL_MINUTES.get(interval, 1))


class PortfolioRequest(_BaseModel):
    holdings: list[Holding]


@app.post("/predict/portfolio", response_model=PortfolioAssessment)
def predict_portfolio(req: PortfolioRequest):
    if not req.holdings:
        raise HTTPException(status_code=422, detail="no holdings provided")
    return assess_portfolio(req.holdings)
