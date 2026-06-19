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
from app.context.models import MacroSnapshot, ImpliedMove, FundamentalsResult, SentimentSnapshot
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


from app.data.news_sentiment import NewsSentiment


def get_sentiment_provider():
    return NewsSentiment(api_key=config.FINNHUB_API_KEY) if config.FINNHUB_API_KEY else None


@app.get("/context/sentiment/{symbol}", response_model=SentimentSnapshot)
def context_sentiment(symbol: str, provider=Depends(get_sentiment_provider)):
    if provider is None:
        raise HTTPException(status_code=503, detail="FINNHUB_API_KEY not configured")
    return provider.fetch_sentiment(symbol.upper())


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
    result = assess_position(sym, current_price=price, cost_basis=cost_basis,
                             shares=shares, portfolio_value=portfolio_value,
                             intraday_bias=intraday_bias, outlook_stance=outlook_stance)
    # Attach an exit plan (scale-out + trail) anchored to live key levels (best-effort).
    try:
        from app.predictors.setups import _key_levels
        from app.predictors.exit_plan import build_exit_plan
        df1 = md.fetch_candles(sym, interval="1m", range_="1d")
        levels = []
        if not df1.empty:
            pdh, pdl = _prior_day_hilo(md, sym)
            levels = _key_levels(df1, float(price), pdh, pdl)
        result.exit_plan = build_exit_plan(sym, cost_basis, float(price), shares, levels,
                                           _daily_atr(md, sym), outlook_stance)
    except Exception:
        result.exit_plan = None
    return result


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


from app.predictors.statistical import forecast as statistical_forecast
from app.models import StatPrediction

@app.get("/predict/statistical/{symbol}", response_model=StatPrediction)
def predict_statistical(symbol: str, mode: str = "intraday", md: MarketData = Depends(get_market_data)):
    symbol = symbol.upper()
    if mode == "outlook":
        df = md.fetch_candles(symbol, interval="1d", range_="2y")
    else:
        df = md.fetch_candles(symbol, interval="5m", range_="1d")
    if df.empty or len(df) < 11:
        raise HTTPException(status_code=422, detail="insufficient history for statistical forecast")
    return statistical_forecast(symbol, df, mode=mode)


from app.predictors.setups import scan_setups
from app.models import SetupTimeline
from app.store.calibration import CalibrationStore
from app.store.history import HistoryStore
import os as _os

_calib = CalibrationStore(_os.path.join(config.DATA_DIR, "calibration.db"))
_history = HistoryStore(config.DATA_DIR)

from app.store.paper import PaperStore
from app.paper.engine import open_order, evaluate_exit, mark_to_market, portfolio_stats
from pydantic import BaseModel

_paper = PaperStore(_os.path.join(config.DATA_DIR, "paper.db"))


class PaperOrder(BaseModel):
    symbol: str
    budget: float = 200.0
    target: float | None = None
    stop: float | None = None


class PaperSettingsBody(BaseModel):
    auto_enabled: bool = False
    budget: float = 200.0
    target: float = 12.0
    risk: str = "balanced"


def _portfolio_payload(md) -> dict:
    acct = _paper.get_account()
    open_rows = _paper.list_positions(status="open")
    equity = acct["cash"]
    marked = []
    for p in open_rows:
        lp = _live_price(md, p["symbol"]) or p["entry"]
        m = mark_to_market(p, lp)
        equity += m["market_value"]
        marked.append({**p, **m})
    closed = _paper.list_positions(status="closed")
    return {"account": {**acct, "equity": round(equity, 2)},
            "open": marked, "stats": portfolio_stats(closed, acct["starting"])}


@app.post("/paper/order")
def paper_order(body: PaperOrder, md: MarketData = Depends(get_market_data)):
    sym = body.symbol.upper()
    if any(p["symbol"] == sym for p in _paper.list_positions(status="open")):
        raise HTTPException(status_code=400, detail="already holding an open position in " + sym)
    price = _live_price(md, sym)
    o = open_order(_paper.get_account()["cash"], sym, price, body.budget, body.target, body.stop)
    if "error" in o:
        raise HTTPException(status_code=400, detail=o["error"])
    pid = _paper.open_position(sym, o["shares"], o["entry"], body.target, body.stop, o["cost"], "manual")
    return {"id": pid, **o}


@app.post("/paper/close/{pid}")
def paper_close(pid: str, md: MarketData = Depends(get_market_data)):
    pos = next((p for p in _paper.list_positions(status="open") if p["id"] == pid), None)
    if pos is None:
        raise HTTPException(status_code=404, detail="no open position " + pid)
    price = _live_price(md, pos["symbol"]) or pos["entry"]
    _paper.close_position(pid, exit_price=price, exit_reason="manual")
    return {"id": pid, "exit_price": price, "exit_reason": "manual"}


@app.get("/paper/portfolio")
def paper_portfolio(md: MarketData = Depends(get_market_data)):
    return _portfolio_payload(md)


@app.get("/paper/history")
def paper_history():
    closed = _paper.list_positions(status="closed")
    return {"closed": closed, "stats": portfolio_stats(closed, _paper.get_account()["starting"])}


@app.get("/paper/settings")
def paper_settings():
    return _paper.get_settings()


@app.post("/paper/settings")
def paper_set_settings(body: PaperSettingsBody):
    _paper.set_settings(body.auto_enabled, body.budget, body.target, body.risk)
    return _paper.get_settings()


@app.post("/paper/reset")
def paper_reset():
    _paper.reset()
    return _paper.get_account()


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
    try:
        _history.append(sym, df)
    except Exception:
        pass
    result = scan_setups(sym, df, daily_atr=_daily_atr(md, sym), prior_day_high=pdh, prior_day_low=pdl,
                         interval_minutes=_INTERVAL_MINUTES.get(interval, 1))
    try:
        _calib.record_setups(sym, [s.model_dump() for s in result.setups])
    except Exception:
        pass
    return result


@app.get("/calibration/stats")
def calibration_stats():
    return _calib.stats()


@app.get("/history/{symbol}/info")
def history_info(symbol: str):
    return _history.info(symbol.upper())


class PortfolioRequest(_BaseModel):
    holdings: list[Holding]


@app.post("/predict/portfolio", response_model=PortfolioAssessment)
def predict_portfolio(req: PortfolioRequest):
    if not req.holdings:
        raise HTTPException(status_code=422, detail="no holdings provided")
    return assess_portfolio(req.holdings)


from concurrent.futures import ThreadPoolExecutor
from app.predictors.opportunities import score_opportunity, tier_config, TOP_N
from app.models import OpportunitiesResult, OpportunityPick
from datetime import datetime, timezone


def _pe_for(md: MarketData, symbol: str) -> float | None:
    """Best-effort PE via the configured fundamentals providers (None on failure)."""
    try:
        providers = get_fundamentals_providers()
        for p in providers:
            f = p.fetch_fundamentals(symbol)
            if f and f.pe:
                return float(f.pe)
    except Exception:
        pass
    return None


def scan_opportunities(md, providers, budget: float, target: float, risk: str) -> list[dict]:
    """Build the candidate universe (lane-filtered by risk) and score each into an
    OpportunityPick dict, ranked by expected value. Shared by the endpoint and the
    paper auto-tick."""
    fmp, yahoo = providers
    threshold, lanes = tier_config(risk)
    disc = build_discover(fmp, yahoo=yahoo)
    seen, candidates = set(), []
    for lane in lanes:
        for item in getattr(disc, lane, []):
            if item.symbol not in seen:
                seen.add(item.symbol); candidates.append(item.symbol)

    def _score(sym):
        try:
            idf = md.fetch_candles(sym, interval="1m", range_="1d")
            ddf = md.fetch_candles(sym, interval="1d", range_="2y")
            if ddf.empty:
                return None
            datr = (float(ind.atr(ddf["high"], ddf["low"], ddf["close"], 14).iloc[-1])
                    if len(ddf) >= 15 else None)
            return score_opportunity(sym, idf, ddf, pe=_pe_for(md, sym), daily_atr=datr,
                                     budget=budget, target=target, threshold=threshold)
        except Exception:
            return None

    picks = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for res in ex.map(_score, candidates):
            if res:
                picks.append(res)
    def _ev(p):
        return p["probability"] * p["target_dollars"] - (1 - p["probability"]) * p["risk_dollars"]
    picks.sort(key=lambda p: (_ev(p), p["reward_risk"]), reverse=True)
    return picks


@app.get("/opportunities", response_model=OpportunitiesResult)
def opportunities(budget: float = 150.0, target: float = 12.0, risk: str = "balanced",
                  md: MarketData = Depends(get_market_data),
                  providers=Depends(get_discover_providers)):
    fmp, yahoo = providers
    if fmp is None and yahoo is None:
        raise HTTPException(status_code=503, detail="no screener provider configured")
    _, lanes = tier_config(risk)
    disc = build_discover(fmp, yahoo=yahoo)
    if not any(getattr(disc, lane, []) for lane in lanes):
        raise HTTPException(status_code=503, detail="screener returned no candidates")
    picks = scan_opportunities(md, providers, budget, target, risk)[:TOP_N]
    return OpportunitiesResult(
        budget=budget, target=target, risk=risk,
        picks=[OpportunityPick(**p) for p in picks], scanned=len(picks),
        as_of=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
