# Phase 6: Extra Predictor Voices — Statistical Forecaster + News Sentiment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. `- [ ]` steps, strict TDD, one commit per task.

**Goal:** Add two independent, deploy-safe predictor voices so the consensus isn't quant+LLM only: a **statistical forecaster** (numpy EWMA-of-returns, no heavy deps) and a **news-sentiment** signal (finance lexicon over Finnhub headlines). Wire the statistical voice into the Node consensus; expose sentiment as context.

**Design note (deploy-safety):** deliberately **no `torch`/`transformers` (FinBERT)** and **no `numba`/StatsForecast** — those bloat the Docker image and slow Render builds. We get independent voices with pure numpy + a lexicon. FinBERT/StatsForecast remain documented optional upgrades behind the same interfaces.

**Tech Stack:** Python (sidecar) — no new deps; Node — no new deps.

**Builds on:** Phases 1–5.

---

## Task 1: Statistical forecaster (sidecar, no new deps)

**Files:** Create `app/predictors/statistical.py`; add `StatPrediction` to `app/models.py`; endpoint in `app/api.py`; Tests `tests/test_statistical.py`

- [ ] **Step 1: Failing tests** — `tests/test_statistical.py`
```python
import numpy as np, pandas as pd
from app.predictors.statistical import forecast

def _df(close):
    close = np.asarray(close, float); n = len(close)
    return pd.DataFrame({"timestamp": 1_700_000_000 + np.arange(n)*86400,
        "open": close, "high": close+1, "low": close-1, "close": close, "volume": np.full(n,1e6)})

def test_uptrend_forecasts_bullish():
    p = forecast("AAPL", _df(np.linspace(100, 130, 60)), mode="outlook")
    assert p.stance == "bullish" and p.confidence > 0
    assert p.source == "statistical"

def test_downtrend_forecasts_bearish():
    assert forecast("AAPL", _df(np.linspace(130, 100, 60)), mode="outlook").stance == "bearish"

def test_flat_is_neutral():
    assert forecast("AAPL", _df(np.full(60, 100.0)), mode="intraday").stance == "neutral"

def test_short_history_neutral_low_conf():
    p = forecast("AAPL", _df(np.linspace(100, 101, 5)), mode="intraday")
    assert p.stance == "neutral" and p.confidence == 0.0
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Add `StatPrediction` to `app/models.py`**
```python
class StatPrediction(BaseModel):
    symbol: str
    mode: str
    stance: Literal["bullish", "neutral", "bearish"]
    confidence: float = Field(ge=0.0, le=1.0)
    method: str = "ewma_returns"
    as_of: str
    source: Literal["statistical"] = "statistical"
```

- [ ] **Step 4: Create `app/predictors/statistical.py`**
```python
"""Lightweight statistical forecaster — an independent (non-rule, non-LLM) voice.
EWMA of recent returns normalized by volatility -> directional stance. numpy only."""
from datetime import datetime, timezone
import pandas as pd
from app.models import StatPrediction

SPAN = 10
NEUTRAL_Z = 0.10


def _now_iso():
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def forecast(symbol: str, df: pd.DataFrame, mode: str) -> StatPrediction:
    rets = df["close"].pct_change().dropna()
    if len(rets) < 10:
        return StatPrediction(symbol=symbol, mode=mode, stance="neutral", confidence=0.0, as_of=_now_iso())
    ewma = float(rets.ewm(span=SPAN, adjust=False).mean().iloc[-1])
    vol = float(rets.std()) or 1e-9
    z = ewma / vol
    if z > NEUTRAL_Z:
        stance = "bullish"
    elif z < -NEUTRAL_Z:
        stance = "bearish"
    else:
        stance = "neutral"
    confidence = min(1.0, abs(z))
    return StatPrediction(symbol=symbol, mode=mode, stance=stance,
                          confidence=round(confidence, 3), as_of=_now_iso())
```

- [ ] **Step 5: Add endpoint to `app/api.py`** (reuse `get_market_data`)
```python
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
```

- [ ] **Step 6: Run full sidecar suite → green. Commit**
```
git checkout -b feat/phase-6-extra-voices
git add app/predictors/statistical.py app/models.py app/api.py tests/test_statistical.py
git commit -m "feat(predict): add lightweight statistical forecaster voice"
```

---

## Task 2: News sentiment (sidecar, finance lexicon)

**Files:** Create `app/data/news_sentiment.py`; add `SentimentSnapshot` to `app/context/models.py`; endpoint in `app/api.py`; Tests `tests/test_sentiment.py`

Finnhub company-news shape: `GET https://finnhub.io/api/v1/company-news?symbol=AAPL&from=YYYY-MM-DD&to=YYYY-MM-DD&token=KEY` → `[{"headline":"...","summary":"...","datetime":1700000000,"url":"..."}, ...]`.

- [ ] **Step 1: Add `SentimentSnapshot` to `app/context/models.py`**
```python
class SentimentSnapshot(BaseModel):
    symbol: str
    score: float            # -1..1
    label: str              # 'positive' | 'neutral' | 'negative'
    headline_count: int
    as_of: str
    sources: list[str] = Field(default_factory=list)
```

- [ ] **Step 2: Failing tests** — `tests/test_sentiment.py`
```python
import httpx
from app.data.news_sentiment import NewsSentiment

def _client(items):
    def handler(request): return httpx.Response(200, json=items)
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_positive_headlines_score_positive():
    items = [{"headline": "Company beats earnings, record growth and upgrade",
              "summary": "strong rally", "url": "u1"},
             {"headline": "Analysts raise target on strong demand", "summary": "", "url": "u2"}]
    s = NewsSentiment(api_key="k", http=_client(items)).fetch_sentiment("AAPL")
    assert s.label == "positive" and s.score > 0 and s.headline_count == 2

def test_negative_headlines_score_negative():
    items = [{"headline": "Stock plunges on earnings miss and downgrade", "summary": "weak", "url": "u"}]
    s = NewsSentiment(api_key="k", http=_client(items)).fetch_sentiment("AAPL")
    assert s.label == "negative" and s.score < 0

def test_no_news_is_neutral():
    s = NewsSentiment(api_key="k", http=_client([])).fetch_sentiment("AAPL")
    assert s.label == "neutral" and s.score == 0.0 and s.headline_count == 0
```

- [ ] **Step 3: Create `app/data/news_sentiment.py`**
```python
"""Finance-lexicon news sentiment over Finnhub headlines. No ML deps."""
from datetime import datetime, timezone, timedelta
import httpx
from app.context.models import SentimentSnapshot

BASE_URL = "https://finnhub.io/api/v1/company-news"
POS = {"beat", "beats", "surge", "surges", "record", "upgrade", "upgraded", "growth",
       "strong", "rally", "rallies", "outperform", "raise", "raises", "raised", "gain",
       "gains", "bullish", "demand", "profit", "wins", "soars", "tops"}
NEG = {"miss", "misses", "plunge", "plunges", "downgrade", "downgraded", "lawsuit", "probe",
       "weak", "cut", "cuts", "recall", "fraud", "fall", "falls", "drop", "drops", "loss",
       "losses", "bearish", "warning", "warns", "slump", "sinks", "halts", "delay"}


def _now_iso():
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _score_text(text: str) -> int:
    words = set((text or "").lower().replace(",", " ").replace(".", " ").split())
    return len(words & POS) - len(words & NEG)


class NewsSentiment:
    name = "news_sentiment"

    def __init__(self, api_key: str, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._key = api_key
        self._http = http or httpx.Client(timeout=10.0)
        self._base = base_url

    def fetch_sentiment(self, symbol: str) -> SentimentSnapshot:
        today = datetime.now(tz=timezone.utc).date()
        params = {"symbol": symbol, "from": str(today - timedelta(days=7)), "to": str(today), "token": self._key}
        resp = self._http.get(self._base, params=params)
        resp.raise_for_status()
        items = resp.json() or []
        if not items:
            return SentimentSnapshot(symbol=symbol, score=0.0, label="neutral",
                                     headline_count=0, as_of=_now_iso(), sources=["finnhub"])
        raw = sum(_score_text(f"{it.get('headline','')} {it.get('summary','')}") for it in items)
        norm = max(-1.0, min(1.0, raw / max(1, len(items))))
        label = "positive" if norm > 0.1 else "negative" if norm < -0.1 else "neutral"
        return SentimentSnapshot(symbol=symbol, score=round(norm, 3), label=label,
                                 headline_count=len(items), as_of=_now_iso(), sources=["finnhub"])
```

- [ ] **Step 4: Add endpoint to `app/api.py`**
```python
from app.data.news_sentiment import NewsSentiment
from app.context.models import SentimentSnapshot

def get_sentiment_provider():
    return NewsSentiment(api_key=config.FINNHUB_API_KEY) if config.FINNHUB_API_KEY else None

@app.get("/context/sentiment/{symbol}", response_model=SentimentSnapshot)
def context_sentiment(symbol: str, provider=Depends(get_sentiment_provider)):
    if provider is None:
        raise HTTPException(status_code=503, detail="FINNHUB_API_KEY not configured")
    return provider.fetch_sentiment(symbol.upper())
```

- [ ] **Step 5: Run → green. Commit**
```
git add app/data/news_sentiment.py app/context/models.py app/api.py tests/test_sentiment.py
git commit -m "feat(data): add finance-lexicon news sentiment"
```

---

## Task 3: Wire statistical voice into the Node consensus

**Files:** Modify `src/sidecar.js`, `src/predict-service.js`, `src/insight-service.js`; Tests update

- [ ] **Step 1: Failing test** — append to `test/insight-service.test.js`
```js
test('statistical voice joins consensus when available', async () => {
  const predictService = {
    intraday: async (s) => ({ symbol: s, bias: 'Bullish', probability_up: 0.7 }),
    statistical: async () => ({ stance: 'bullish', confidence: 0.5 }),
  };
  const router = { size: 0, ensemble: async () => [] };
  const { createInsightService } = require('../src/insight-service');
  const svc = createInsightService({ predictService, router });
  const out = await svc.insight('intraday', 'AAPL');
  const names = out.consensus.votes.map((v) => v.name);
  assert.ok(names.includes('quant'));
  assert.ok(names.includes('statistical'));
});

test('missing statistical method is skipped gracefully', async () => {
  const predictService = { intraday: async (s) => ({ symbol: s, bias: 'Bullish', probability_up: 0.7 }) };
  const router = { size: 0, ensemble: async () => [] };
  const { createInsightService } = require('../src/insight-service');
  const out = await createInsightService({ predictService, router }).insight('intraday', 'AAPL');
  assert.deepEqual(out.consensus.votes.map((v) => v.name), ['quant']);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Add `statistical` to `src/sidecar.js`** (alongside the other methods)
```js
    statistical: (s, mode) => request('GET', `/predict/statistical/${encodeURIComponent(s)}?mode=${encodeURIComponent(mode)}`),
```

- [ ] **Step 4: Add to `src/predict-service.js`** — add a TTL entry and method:
```js
// in TTL object:
  statistical: 120 * 1000,
// in returned object:
    statistical: (s, mode) => cached('statistical', `${s}:${mode}`, () => sidecar.statistical(s, mode)),
```

- [ ] **Step 5: Update `src/insight-service.js`** — after building `models`, add the statistical voice when the method exists:
```js
    // statistical voice (independent, non-LLM) — optional
    let statVote = null;
    if (typeof predictService.statistical === 'function') {
      try {
        const stat = await predictService.statistical(symbol, mode);
        if (stat && stat.stance) statVote = { name: 'statistical', stance: stat.stance, confidence: stat.confidence };
      } catch (e) { /* skip voice */ }
    }

    const votes = [quantVote,
      ...(statVote ? [statVote] : []),
      ...models.map((m) => ({ name: m.name, stance: m.stance, confidence: m.confidence }))];
```
(Replace the existing `votes` construction with this.)

- [ ] **Step 6: Run `node --test` → green. Commit**
```
git add src/sidecar.js src/predict-service.js src/insight-service.js test/insight-service.test.js
git commit -m "feat(llm): add statistical voice to the multi-predictor consensus"
```

---

## Acceptance criteria
- [ ] Sidecar `pytest` + Node `node --test` both green.
- [ ] `/predict/statistical/{symbol}?mode=` returns a stance/confidence; uptrend→bullish, downtrend→bearish, flat→neutral.
- [ ] `/context/sentiment/{symbol}` returns lexicon sentiment (503 without Finnhub key); positive/negative/neutral correct.
- [ ] Node consensus includes the `statistical` voice when available, skips it gracefully when not.
- [ ] No new deps (no torch/transformers/numba); `.env` never staged.
- [ ] Branch `feat/phase-6-extra-voices` ready to merge.

## Self-review notes
- **Spec coverage:** adds the independent non-LLM voices the spec's multi-predictor consensus calls for; sentiment as a context signal. Heavy-lib variants (FinBERT, StatsForecast, MAPIE) are deferred for deploy-safety and documented as upgrades.
- **Independence:** the statistical voice uses a different method (EWMA/vol) than the rule-based cores, so it fails independently — the point of adding it.
- **Graceful:** sentiment 503s without a key; statistical voice is skipped if the method/endpoint is absent; consensus still forms from quant + whatever voices exist.

## Deferred (documented upgrades)
- **FinBERT** sentiment (transformers+torch) behind the same `fetch_sentiment` interface — only if image size/build time is acceptable.
- **StatsForecast/MAPIE** — a heavier statistical model + conformal calibration, once 1-min history accumulates (see Phase 8 log).
