# Phase 2: Data Layer — Providers, Cross-Check & Context Endpoints — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Python sidecar a real data layer so fundamentals/macro stop coming from an LLM — a provider abstraction with FRED (macro), Finnhub + FMP (fundamentals), and Yahoo options (implied move) adapters, normalized into shared context models, **cross-checked across sources**, and exposed via `/context/*` endpoints.

**Architecture:** Each provider is an injectable adapter that returns a *partial* normalized model. A pure `merge_fundamentals` function combines partials from multiple sources, takes the median per numeric field, and flags fields where sources disagree beyond a threshold. Endpoints degrade gracefully: they use whatever provider keys are configured and return 503 only when none are. External-API adapters are TDD'd by recording one real response into `tests/fixtures/` and asserting the parser's normalized output against it — no live network in the test run.

**Tech Stack:** Python 3.13, FastAPI, httpx, pydantic v2, pytest (all already in the sidecar from Phase 1).

**Builds on:** Phase 1 (`services/quant-py/`). **Deferred to Phase 2b:** OpenBB aggregator adapter (heavy dependency; isolated).

---

## File structure (this phase)

```
services/quant-py/
  app/
    config.py                       # NEW: env-driven keys (FRED/FMP/FINNHUB)
    context/
      __init__.py                   # NEW
      models.py                     # NEW: Fundamentals, MacroSnapshot, ImpliedMove, FundamentalsResult, FieldDiscrepancy
      crosscheck.py                 # NEW: merge_fundamentals() (pure)
    data/
      base.py                       # MODIFY: add FundamentalsProvider, MacroProvider, OptionsProvider protocols
      fred.py                       # NEW: FRED macro adapter
      finnhub.py                    # NEW: Finnhub fundamentals adapter
      fmp.py                        # NEW: FMP fundamentals adapter
      yahoo_options.py              # NEW: Yahoo options implied-move adapter
    api.py                          # MODIFY: add /context/macro, /context/fundamentals/{symbol}, /context/implied-move/{symbol}
  tests/
    test_context_models.py          # NEW
    test_crosscheck.py              # NEW
    test_fred.py                    # NEW
    test_finnhub.py                 # NEW
    test_fmp.py                     # NEW
    test_yahoo_options.py           # NEW
    test_context_api.py             # NEW
    fixtures/
      fred_dgs10.json               # NEW (recorded)
      finnhub_metric_aapl.json      # NEW (recorded)
      finnhub_profile_aapl.json     # NEW (recorded)
      fmp_ratios_aapl.json          # NEW (recorded or sample)
      fmp_profile_aapl.json         # NEW (recorded or sample)
      yahoo_options_aapl.json       # NEW (recorded)
  .env.example                      # NEW: documents the data keys
  README.md                         # MODIFY: env + endpoints
```

---

## Task 1: Normalized context models + provider protocols

**Files:**
- Create: `app/context/__init__.py` (empty), `app/context/models.py`
- Modify: `app/data/base.py`
- Test: `tests/test_context_models.py`

- [ ] **Step 1: Write the failing test** — `tests/test_context_models.py`

```python
from app.context.models import (
    Fundamentals, MacroSnapshot, ImpliedMove, FundamentalsResult, FieldDiscrepancy)

def test_fundamentals_defaults_are_none_and_sources_list():
    f = Fundamentals(symbol="AAPL", as_of="2026-06-11T00:00:00Z")
    assert f.sector is None and f.pe is None
    assert f.sources == []

def test_macro_snapshot_holds_yields():
    m = MacroSnapshot(as_of="2026-06-11T00:00:00Z", ten_year_yield=4.3,
                      two_year_yield=4.0, yield_curve_2s10s=0.3, vix=15.2,
                      unemployment=3.9, sources=["FRED"])
    assert m.yield_curve_2s10s == 0.3

def test_implied_move_roundtrip():
    im = ImpliedMove(symbol="AAPL", spot=200.0, atm_iv=0.25, expiry="2026-06-20",
                     days_to_expiry=9, expected_move_pct=0.039, expected_move_abs=7.8,
                     low=192.2, high=207.8, as_of="2026-06-11T00:00:00Z")
    assert im.high > im.spot > im.low

def test_fundamentals_result_carries_discrepancies():
    f = Fundamentals(symbol="AAPL", as_of="2026-06-11T00:00:00Z")
    r = FundamentalsResult(merged=f, discrepancies=[
        FieldDiscrepancy(field="pe", values={"finnhub": 25.0, "fmp": 30.0}, spread_pct=0.2)])
    assert r.discrepancies[0].field == "pe"
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_context_models.py`
Expected: FAIL — `ModuleNotFoundError: app.context.models`.

- [ ] **Step 3: Create `app/context/models.py`**

```python
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
```

- [ ] **Step 4: Add provider protocols to `app/data/base.py`** (append; keep existing `MarketData`)

```python
from typing import Protocol
from app.context.models import Fundamentals, MacroSnapshot, ImpliedMove


class FundamentalsProvider(Protocol):
    name: str
    def fetch_fundamentals(self, symbol: str) -> Fundamentals: ...


class MacroProvider(Protocol):
    name: str
    def fetch_macro(self) -> MacroSnapshot: ...


class OptionsProvider(Protocol):
    name: str
    def fetch_implied_move(self, symbol: str) -> ImpliedMove: ...
```

- [ ] **Step 5: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_context_models.py`
Expected: PASS (4 passed).

- [ ] **Step 6: Commit**

```
git add app/context/__init__.py app/context/models.py app/data/base.py tests/test_context_models.py
git commit -m "feat(data): add normalized context models + provider protocols"
```

---

## Task 2: Cross-check merge (pure function — the core logic)

**Files:**
- Create: `app/context/crosscheck.py`
- Test: `tests/test_crosscheck.py`

- [ ] **Step 1: Write the failing tests** — `tests/test_crosscheck.py`

```python
from app.context.models import Fundamentals
from app.context.crosscheck import merge_fundamentals

AS_OF = "2026-06-11T00:00:00Z"

def _f(source, **kw):
    return Fundamentals(symbol="AAPL", as_of=AS_OF, sources=[source], **kw)

def test_median_merge_no_discrepancy_when_close():
    r = merge_fundamentals("AAPL", [_f("finnhub", pe=25.0), _f("fmp", pe=25.5)])
    assert abs(r.merged.pe - 25.25) < 1e-9
    assert r.discrepancies == []
    assert set(r.merged.sources) == {"finnhub", "fmp"}

def test_discrepancy_flagged_when_sources_disagree():
    r = merge_fundamentals("AAPL", [_f("finnhub", pe=25.0), _f("fmp", pe=30.0)])
    assert len(r.discrepancies) == 1
    d = r.discrepancies[0]
    assert d.field == "pe"
    assert d.values == {"finnhub": 25.0, "fmp": 30.0}
    assert d.spread_pct > 0.10

def test_non_numeric_fields_take_first_non_null():
    r = merge_fundamentals("AAPL", [
        _f("finnhub", sector=None, next_earnings_date="2026-07-30"),
        _f("fmp", sector="Technology")])
    assert r.merged.sector == "Technology"
    assert r.merged.next_earnings_date == "2026-07-30"

def test_single_source_never_flags_discrepancy():
    r = merge_fundamentals("AAPL", [_f("finnhub", pe=25.0)])
    assert r.discrepancies == []
    assert r.merged.pe == 25.0

def test_missing_values_ignored():
    r = merge_fundamentals("AAPL", [_f("finnhub", pe=None), _f("fmp", pe=20.0)])
    assert r.merged.pe == 20.0
    assert r.discrepancies == []
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_crosscheck.py`
Expected: FAIL — `ModuleNotFoundError: app.context.crosscheck`.

- [ ] **Step 3: Create `app/context/crosscheck.py`**

```python
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
```

- [ ] **Step 4: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_crosscheck.py`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```
git add app/context/crosscheck.py tests/test_crosscheck.py
git commit -m "feat(data): add cross-source fundamentals merge with discrepancy flags"
```

---

## Task 3: Config module (env-driven keys)

**Files:**
- Create: `app/config.py`
- Test: `tests/test_config.py`

- [ ] **Step 1: Write the failing test** — `tests/test_config.py`

```python
import importlib

def test_config_reads_env(monkeypatch):
    monkeypatch.setenv("FRED_API_KEY", "abc")
    monkeypatch.setenv("FMP_API_KEY", "def")
    import app.config as cfg
    importlib.reload(cfg)
    assert cfg.FRED_API_KEY == "abc"
    assert cfg.FMP_API_KEY == "def"

def test_config_missing_keys_default_empty(monkeypatch):
    monkeypatch.delenv("FRED_API_KEY", raising=False)
    import app.config as cfg
    importlib.reload(cfg)
    assert cfg.FRED_API_KEY == ""
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_config.py`
Expected: FAIL — `ModuleNotFoundError: app.config`.

- [ ] **Step 3: Create `app/config.py`**

```python
import os


def _env(key: str) -> str:
    return os.environ.get(key, "").strip()


FRED_API_KEY = _env("FRED_API_KEY")
FMP_API_KEY = _env("FMP_API_KEY")
FINNHUB_API_KEY = _env("FINNHUB_API_KEY")
```

- [ ] **Step 4: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_config.py`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```
git add app/config.py tests/test_config.py
git commit -m "feat(data): add env-driven config for provider keys"
```

---

## Task 4: FRED macro adapter

**Files:**
- Create: `app/data/fred.py`, `tests/fixtures/fred_dgs10.json`
- Test: `tests/test_fred.py`

FRED observations API shape (per series): `GET https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=KEY&file_type=json&sort_order=desc&limit=1` →
`{"observations":[{"date":"2026-06-10","value":"4.35"}]}`. A missing value is the string `"."`.

- [ ] **Step 1: Record a real fixture** (needs a free FRED key in env as `FRED_API_KEY`)

Run (PowerShell): `curl "https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=$env:FRED_API_KEY&file_type=json&sort_order=desc&limit=1" -o tests/fixtures/fred_dgs10.json`
If no FRED key yet, hand-create `tests/fixtures/fred_dgs10.json` with: `{"observations":[{"date":"2026-06-10","value":"4.35"}]}`

- [ ] **Step 2: Write the failing test** — `tests/test_fred.py`

```python
import httpx
from app.data.fred import FredMacro

def _client(value="4.35"):
    def handler(request):
        return httpx.Response(200, json={"observations": [{"date": "2026-06-10", "value": value}]})
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_fred_parses_latest_value():
    fred = FredMacro(api_key="k", http=_client("4.35"))
    m = fred.fetch_macro()
    assert m.ten_year_yield == 4.35
    assert "FRED" in m.sources

def test_fred_handles_missing_value_dot():
    fred = FredMacro(api_key="k", http=_client("."))
    m = fred.fetch_macro()
    assert m.ten_year_yield is None   # "." => None, no crash
```

- [ ] **Step 3: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_fred.py`
Expected: FAIL — `ModuleNotFoundError: app.data.fred`.

- [ ] **Step 4: Create `app/data/fred.py`**

```python
from datetime import datetime, timezone
import httpx
from app.context.models import MacroSnapshot

BASE_URL = "https://api.stlouisfed.org/fred/series/observations"
# FRED series ids for the macro snapshot
SERIES = {
    "ten_year_yield": "DGS10",
    "two_year_yield": "DGS2",
    "vix": "VIXCLS",
    "unemployment": "UNRATE",
}


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class FredMacro:
    name = "FRED"

    def __init__(self, api_key: str, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._key = api_key
        self._http = http or httpx.Client(timeout=10.0)
        self._base = base_url

    def _latest(self, series_id: str) -> float | None:
        params = {"series_id": series_id, "api_key": self._key, "file_type": "json",
                  "sort_order": "desc", "limit": 1}
        resp = self._http.get(self._base, params=params)
        resp.raise_for_status()
        obs = resp.json().get("observations", [])
        if not obs:
            return None
        raw = obs[0].get("value", ".")
        if raw in (".", "", None):
            return None
        return float(raw)

    def fetch_macro(self) -> MacroSnapshot:
        vals = {k: self._latest(sid) for k, sid in SERIES.items()}
        curve = None
        if vals["ten_year_yield"] is not None and vals["two_year_yield"] is not None:
            curve = round(vals["ten_year_yield"] - vals["two_year_yield"], 4)
        return MacroSnapshot(as_of=_now_iso(), yield_curve_2s10s=curve, sources=["FRED"], **vals)
```

- [ ] **Step 5: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_fred.py`
Expected: PASS (2 passed).

- [ ] **Step 6: Commit**

```
git add app/data/fred.py tests/test_fred.py tests/fixtures/fred_dgs10.json
git commit -m "feat(data): add FRED macro adapter (yields, VIX, unemployment)"
```

---

## Task 5: Finnhub fundamentals adapter

**Files:**
- Create: `app/data/finnhub.py`, `tests/fixtures/finnhub_metric_aapl.json`, `tests/fixtures/finnhub_profile_aapl.json`
- Test: `tests/test_finnhub.py`

Finnhub shapes:
- `GET https://finnhub.io/api/v1/stock/metric?symbol=AAPL&metric=all&token=KEY` → `{"metric": {"peTTM": 30.1, "peNormalizedAnnual": 28.0, "pfcfShareTTM": ..., "netProfitMarginTTM": 25.3, "revenueGrowthTTMYoy": 8.1, "epsGrowthTTMYoy": 7.2, "currentEv/freeCashFlowTTM": ...}}` (keys vary; access defensively with `.get`).
- `GET https://finnhub.io/api/v1/stock/profile2?symbol=AAPL&token=KEY` → `{"finnhubIndustry": "Technology", "marketCapitalization": 3100000.0, "name": "Apple Inc"}` (market cap in **millions**).

- [ ] **Step 1: Record real fixtures** (uses your existing `FINNHUB_API_KEY`)

Run (PowerShell):
```
curl "https://finnhub.io/api/v1/stock/metric?symbol=AAPL&metric=all&token=$env:FINNHUB_API_KEY" -o tests/fixtures/finnhub_metric_aapl.json
curl "https://finnhub.io/api/v1/stock/profile2?symbol=AAPL&token=$env:FINNHUB_API_KEY" -o tests/fixtures/finnhub_profile_aapl.json
```
Open both files and note the exact key names present (Finnhub renames fields periodically) so the parser uses real keys.

- [ ] **Step 2: Write the failing test** — `tests/test_finnhub.py`

```python
import json
from pathlib import Path
import httpx
from app.data.finnhub import FinnhubFundamentals

FX = Path(__file__).parent / "fixtures"

def _client():
    metric = json.loads((FX / "finnhub_metric_aapl.json").read_text())
    profile = json.loads((FX / "finnhub_profile_aapl.json").read_text())
    def handler(request):
        if "metric" in str(request.url):
            return httpx.Response(200, json=metric)
        return httpx.Response(200, json=profile)
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_finnhub_returns_normalized_fundamentals():
    fh = FinnhubFundamentals(api_key="k", http=_client())
    f = fh.fetch_fundamentals("AAPL")
    assert f.symbol == "AAPL"
    assert f.sources == ["finnhub"]
    # market cap normalized from millions to absolute dollars
    if f.market_cap is not None:
        assert f.market_cap > 1e9
    # pe present and positive when supplied by the fixture
    assert f.pe is None or f.pe > 0
```

- [ ] **Step 3: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_finnhub.py`
Expected: FAIL — `ModuleNotFoundError: app.data.finnhub`.

- [ ] **Step 4: Create `app/data/finnhub.py`** — parse the recorded fixtures' actual keys; start from this skeleton and adjust key names to what the recorded JSON shows:

```python
from datetime import datetime, timezone
import httpx
from app.context.models import Fundamentals

BASE_URL = "https://finnhub.io/api/v1"


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _num(d: dict, *keys):
    """First present, non-null numeric among the candidate keys."""
    for k in keys:
        v = d.get(k)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return None


class FinnhubFundamentals:
    name = "finnhub"

    def __init__(self, api_key: str, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._key = api_key
        self._http = http or httpx.Client(timeout=10.0)
        self._base = base_url

    def _get(self, path: str, symbol: str) -> dict:
        resp = self._http.get(f"{self._base}/{path}", params={"symbol": symbol, "token": self._key,
                                                               **({"metric": "all"} if path == "stock/metric" else {})})
        resp.raise_for_status()
        return resp.json()

    def fetch_fundamentals(self, symbol: str) -> Fundamentals:
        metric = self._get("stock/metric", symbol).get("metric", {}) or {}
        profile = self._get("stock/profile2", symbol) or {}
        mcap_millions = _num(profile, "marketCapitalization")
        return Fundamentals(
            symbol=symbol, as_of=_now_iso(), sources=["finnhub"],
            sector=profile.get("finnhubIndustry"),
            market_cap=(mcap_millions * 1e6) if mcap_millions is not None else None,
            pe=_num(metric, "peTTM", "peNormalizedAnnual"),
            pe_forward=_num(metric, "peForward", "forwardPE"),
            ev_ebitda=_num(metric, "currentEv/freeCashFlowTTM", "evEbitdaTTM"),
            profit_margin=_num(metric, "netProfitMarginTTM"),
            revenue_growth_yoy=_num(metric, "revenueGrowthTTMYoy"),
            eps_growth_yoy=_num(metric, "epsGrowthTTMYoy"),
        )
```

> **Implementer note:** open the recorded `finnhub_metric_aapl.json` and replace the candidate key names above with the exact keys present (Finnhub's metric keys drift). The test only asserts shape/sign, so it stays green; correctness of the field mapping is your responsibility against the real fixture.

- [ ] **Step 5: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_finnhub.py`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add app/data/finnhub.py tests/test_finnhub.py tests/fixtures/finnhub_metric_aapl.json tests/fixtures/finnhub_profile_aapl.json
git commit -m "feat(data): add Finnhub fundamentals adapter"
```

---

## Task 6: FMP fundamentals adapter

**Files:**
- Create: `app/data/fmp.py`, `tests/fixtures/fmp_ratios_aapl.json`, `tests/fixtures/fmp_profile_aapl.json`
- Test: `tests/test_fmp.py`

FMP shapes (v3):
- `GET https://financialmodelingprep.com/api/v3/profile/AAPL?apikey=KEY` → `[{"sector":"Technology","mktCap":3100000000000,"pe":30.1,...}]`
- `GET https://financialmodelingprep.com/api/v3/ratios-ttm/AAPL?apikey=KEY` → `[{"peRatioTTM":30.1,"pegRatioTTM":2.1,"enterpriseValueMultipleTTM":22.0,"netProfitMarginTTM":0.25}]`

- [ ] **Step 1: Record/sample fixtures** — if you have an `FMP_API_KEY`, record real responses:
```
curl "https://financialmodelingprep.com/api/v3/profile/AAPL?apikey=$env:FMP_API_KEY" -o tests/fixtures/fmp_profile_aapl.json
curl "https://financialmodelingprep.com/api/v3/ratios-ttm/AAPL?apikey=$env:FMP_API_KEY" -o tests/fixtures/fmp_ratios_aapl.json
```
If no key yet, hand-create the two fixtures from the documented shapes above (a single-object array each).

- [ ] **Step 2: Write the failing test** — `tests/test_fmp.py`

```python
import json
from pathlib import Path
import httpx
from app.data.fmp import FmpFundamentals

FX = Path(__file__).parent / "fixtures"

def _client():
    profile = json.loads((FX / "fmp_profile_aapl.json").read_text())
    ratios = json.loads((FX / "fmp_ratios_aapl.json").read_text())
    def handler(request):
        if "ratios-ttm" in str(request.url):
            return httpx.Response(200, json=ratios)
        return httpx.Response(200, json=profile)
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_fmp_returns_normalized_fundamentals():
    fmp = FmpFundamentals(api_key="k", http=_client())
    f = fmp.fetch_fundamentals("AAPL")
    assert f.symbol == "AAPL" and f.sources == ["fmp"]
    assert f.sector == "Technology"
    assert f.pe is not None and f.pe > 0

def test_fmp_empty_array_yields_partial_without_crash():
    def handler(request): return httpx.Response(200, json=[])
    fmp = FmpFundamentals(api_key="k", http=httpx.Client(transport=httpx.MockTransport(handler)))
    f = fmp.fetch_fundamentals("AAPL")
    assert f.symbol == "AAPL" and f.pe is None
```

- [ ] **Step 3: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_fmp.py`
Expected: FAIL — `ModuleNotFoundError: app.data.fmp`.

- [ ] **Step 4: Create `app/data/fmp.py`**

```python
from datetime import datetime, timezone
import httpx
from app.context.models import Fundamentals

BASE_URL = "https://financialmodelingprep.com/api/v3"


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _first(arr):
    return arr[0] if isinstance(arr, list) and arr else {}


def _num(d: dict, *keys):
    for k in keys:
        v = d.get(k)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return None


class FmpFundamentals:
    name = "fmp"

    def __init__(self, api_key: str, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._key = api_key
        self._http = http or httpx.Client(timeout=10.0)
        self._base = base_url

    def _get(self, path: str) -> list:
        resp = self._http.get(f"{self._base}/{path}", params={"apikey": self._key})
        resp.raise_for_status()
        return resp.json()

    def fetch_fundamentals(self, symbol: str) -> Fundamentals:
        profile = _first(self._get(f"profile/{symbol}"))
        ratios = _first(self._get(f"ratios-ttm/{symbol}"))
        return Fundamentals(
            symbol=symbol, as_of=_now_iso(), sources=["fmp"],
            sector=profile.get("sector") or None,
            market_cap=_num(profile, "mktCap", "marketCap"),
            pe=_num(ratios, "peRatioTTM") or _num(profile, "pe"),
            peg=_num(ratios, "pegRatioTTM"),
            ev_ebitda=_num(ratios, "enterpriseValueMultipleTTM"),
            profit_margin=_num(ratios, "netProfitMarginTTM"),
        )
```

- [ ] **Step 5: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_fmp.py`
Expected: PASS (2 passed).

- [ ] **Step 6: Commit**

```
git add app/data/fmp.py tests/test_fmp.py tests/fixtures/fmp_profile_aapl.json tests/fixtures/fmp_ratios_aapl.json
git commit -m "feat(data): add FMP fundamentals adapter"
```

---

## Task 7: Yahoo options implied-move adapter

**Files:**
- Create: `app/data/yahoo_options.py`, `tests/fixtures/yahoo_options_aapl.json`
- Test: `tests/test_yahoo_options.py`

Yahoo options shape: `GET https://query1.finance.yahoo.com/v7/finance/options/AAPL` →
`{"optionChain":{"result":[{"quote":{"regularMarketPrice":200.0},"expirationDates":[1750464000,...],"options":[{"expirationDate":1750464000,"calls":[{"strike":200.0,"impliedVolatility":0.25},...],"puts":[...]}]}]}}`.
Implied move ≈ `spot * atm_iv * sqrt(days_to_expiry / 365)`, where `atm_iv` is the IV of the call+put nearest the spot strike for the nearest expiry.

- [ ] **Step 1: Record a real fixture** (keyless)

Run (PowerShell): `curl "https://query1.finance.yahoo.com/v7/finance/options/AAPL" -H "User-Agent: Mozilla/5.0" -o tests/fixtures/yahoo_options_aapl.json`

- [ ] **Step 2: Write the failing test** — `tests/test_yahoo_options.py`

```python
import math
import httpx
from app.data.yahoo_options import YahooOptions

def _payload():
    return {"optionChain": {"result": [{
        "quote": {"regularMarketPrice": 200.0},
        "expirationDates": [1750464000],
        "options": [{
            "expirationDate": 1750464000,
            "calls": [{"strike": 195.0, "impliedVolatility": 0.30},
                      {"strike": 200.0, "impliedVolatility": 0.25},
                      {"strike": 205.0, "impliedVolatility": 0.28}],
            "puts":  [{"strike": 200.0, "impliedVolatility": 0.27}],
        }],
    }]}}

def _client():
    def handler(request): return httpx.Response(200, json=_payload())
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_implied_move_uses_atm_iv_and_brackets_spot():
    opt = YahooOptions(http=_client(), now_epoch=1750464000 - 9 * 86400)  # 9 days out
    im = opt.fetch_implied_move("AAPL")
    assert im.spot == 200.0
    assert 0.24 <= im.atm_iv <= 0.27          # avg of nearest-strike call/put IV
    assert im.days_to_expiry == 9
    expected = 200.0 * im.atm_iv * math.sqrt(9 / 365)
    assert abs(im.expected_move_abs - expected) < 0.5
    assert im.low < 200.0 < im.high
```

- [ ] **Step 3: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_yahoo_options.py`
Expected: FAIL — `ModuleNotFoundError: app.data.yahoo_options`.

- [ ] **Step 4: Create `app/data/yahoo_options.py`**

```python
import math
from datetime import datetime, timezone
import httpx
from app.context.models import ImpliedMove

BASE_URL = "https://query1.finance.yahoo.com/v7/finance/options"


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _nearest_iv(legs: list, spot: float) -> float | None:
    best, best_dist = None, None
    for leg in legs:
        strike = leg.get("strike")
        iv = leg.get("impliedVolatility")
        if strike is None or iv is None:
            continue
        dist = abs(strike - spot)
        if best_dist is None or dist < best_dist:
            best, best_dist = float(iv), dist
    return best


class YahooOptions:
    name = "yahoo_options"

    def __init__(self, http: httpx.Client | None = None, base_url: str = BASE_URL,
                 now_epoch: int | None = None):
        self._http = http or httpx.Client(timeout=10.0, headers={"User-Agent": "Mozilla/5.0"})
        self._base = base_url
        self._now = now_epoch          # injectable for deterministic tests

    def fetch_implied_move(self, symbol: str) -> ImpliedMove:
        resp = self._http.get(f"{self._base}/{symbol}")
        resp.raise_for_status()
        result = resp.json()["optionChain"]["result"][0]
        spot = float(result["quote"]["regularMarketPrice"])
        chain = result["options"][0]
        expiry_epoch = int(chain["expirationDate"])
        call_iv = _nearest_iv(chain.get("calls", []), spot)
        put_iv = _nearest_iv(chain.get("puts", []), spot)
        ivs = [v for v in (call_iv, put_iv) if v is not None]
        atm_iv = sum(ivs) / len(ivs) if ivs else 0.0

        now = self._now if self._now is not None else int(datetime.now(tz=timezone.utc).timestamp())
        days = max(1, round((expiry_epoch - now) / 86400))
        move_pct = atm_iv * math.sqrt(days / 365)
        move_abs = spot * move_pct
        expiry = datetime.fromtimestamp(expiry_epoch, tz=timezone.utc).strftime("%Y-%m-%d")
        return ImpliedMove(
            symbol=symbol, spot=spot, atm_iv=round(atm_iv, 4), expiry=expiry,
            days_to_expiry=days, expected_move_pct=round(move_pct, 4),
            expected_move_abs=round(move_abs, 4),
            low=round(spot - move_abs, 4), high=round(spot + move_abs, 4), as_of=_now_iso())
```

- [ ] **Step 5: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_yahoo_options.py`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add app/data/yahoo_options.py tests/test_yahoo_options.py tests/fixtures/yahoo_options_aapl.json
git commit -m "feat(data): add Yahoo options implied-move adapter"
```

---

## Task 8: `/context/*` endpoints (graceful degradation by configured keys)

**Files:**
- Modify: `app/api.py`
- Test: `tests/test_context_api.py`

- [ ] **Step 1: Write the failing tests** — `tests/test_context_api.py`

```python
from fastapi.testclient import TestClient
from app.api import app, get_fundamentals_providers, get_macro_provider, get_options_provider
from app.context.models import Fundamentals, MacroSnapshot, ImpliedMove

client = TestClient(app)
AS_OF = "2026-06-11T00:00:00Z"

class _FakeFund:
    def __init__(self, name, **kw): self._n = name; self._kw = kw
    def fetch_fundamentals(self, symbol):
        return Fundamentals(symbol=symbol, as_of=AS_OF, sources=[self._n], **self._kw)

class _FakeMacro:
    def fetch_macro(self): return MacroSnapshot(as_of=AS_OF, ten_year_yield=4.3, sources=["FRED"])

class _FakeOptions:
    def fetch_implied_move(self, symbol):
        return ImpliedMove(symbol=symbol, spot=200.0, atm_iv=0.25, expiry="2026-06-20",
                           days_to_expiry=9, expected_move_pct=0.039, expected_move_abs=7.8,
                           low=192.2, high=207.8, as_of=AS_OF)

def test_fundamentals_endpoint_merges_and_flags():
    app.dependency_overrides[get_fundamentals_providers] = lambda: [
        _FakeFund("finnhub", pe=25.0), _FakeFund("fmp", pe=30.0)]
    try:
        r = client.get("/context/fundamentals/AAPL")
        assert r.status_code == 200
        body = r.json()
        assert body["merged"]["symbol"] == "AAPL"
        assert len(body["discrepancies"]) == 1
    finally:
        app.dependency_overrides.clear()

def test_fundamentals_503_when_no_providers_configured():
    app.dependency_overrides[get_fundamentals_providers] = lambda: []
    try:
        assert client.get("/context/fundamentals/AAPL").status_code == 503
    finally:
        app.dependency_overrides.clear()

def test_macro_endpoint_returns_snapshot():
    app.dependency_overrides[get_macro_provider] = lambda: _FakeMacro()
    try:
        r = client.get("/context/macro")
        assert r.status_code == 200 and r.json()["ten_year_yield"] == 4.3
    finally:
        app.dependency_overrides.clear()

def test_macro_503_when_unconfigured():
    app.dependency_overrides[get_macro_provider] = lambda: None
    try:
        assert client.get("/context/macro").status_code == 503
    finally:
        app.dependency_overrides.clear()

def test_implied_move_endpoint():
    app.dependency_overrides[get_options_provider] = lambda: _FakeOptions()
    try:
        r = client.get("/context/implied-move/AAPL")
        assert r.status_code == 200 and r.json()["high"] > r.json()["spot"]
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 2: Run, verify fail**

Run: `.venv\Scripts\python -m pytest tests/test_context_api.py`
Expected: FAIL — endpoints / providers not defined.

- [ ] **Step 3: Extend `app/api.py`** — add provider factories (driven by configured keys) and the three endpoints. Append the imports and code below to the existing `api.py`:

```python
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
```

- [ ] **Step 4: Run, verify pass**

Run: `.venv\Scripts\python -m pytest tests/test_context_api.py`
Expected: PASS (5 passed).

- [ ] **Step 5: Run the FULL suite**

Run: `.venv\Scripts\python -m pytest -q`
Expected: all Phase 1 + Phase 2 tests green.

- [ ] **Step 6: Commit**

```
git add app/api.py tests/test_context_api.py
git commit -m "feat(data): expose /context macro, fundamentals, implied-move endpoints"
```

---

## Task 9: Document env keys (.env.example, README, render.yaml declarations)

**Files:**
- Create: `services/quant-py/.env.example`
- Modify: `services/quant-py/README.md`
- Modify: `render.yaml`

- [ ] **Step 1: Create `services/quant-py/.env.example`**

```
# Quant sidecar data keys. Copy to .env locally; set in Render (quant-py service) for prod.
# All optional — endpoints degrade to 503/partial when a key is absent.
FRED_API_KEY=        # https://fred.stlouisfed.org  (instant free key) — macro
FMP_API_KEY=         # https://financialmodelingprep.com  (free tier) — fundamentals
FINNHUB_API_KEY=     # https://finnhub.io  — fundamentals (you already have this)
```

- [ ] **Step 2: Append endpoints + keys to `README.md`** (under the existing Endpoints/Deploy sections):

```markdown
### Phase 2 endpoints
- `GET /context/macro` → MacroSnapshot (needs FRED_API_KEY)
- `GET /context/fundamentals/{symbol}` → FundamentalsResult (Finnhub and/or FMP)
- `GET /context/implied-move/{symbol}` → ImpliedMove (keyless, Yahoo options)

### Data env vars (set on the quant-py Render service)
FRED_API_KEY, FMP_API_KEY, FINNHUB_API_KEY — all optional; endpoints degrade gracefully.
```

- [ ] **Step 3: Declare the sidecar's secret keys in `render.yaml`** — add an `envVars` block to the `quant-py` service so Render prompts for them:

```yaml
  - type: web
    name: quant-py
    runtime: docker
    plan: starter
    rootDir: services/quant-py
    dockerfilePath: ./Dockerfile
    healthCheckPath: /health
    autoDeploy: true
    envVars:
      - key: FRED_API_KEY
        sync: false
      - key: FMP_API_KEY
        sync: false
      - key: FINNHUB_API_KEY
        sync: false
```

- [ ] **Step 4: Commit**

```
git add services/quant-py/.env.example services/quant-py/README.md render.yaml
git commit -m "docs(data): document Phase 2 env keys + declare them in the blueprint"
```

---

## Phase 2 acceptance criteria

- [ ] `.venv\Scripts\python -m pytest` green across all Phase 1 + Phase 2 test files.
- [ ] `merge_fundamentals` returns median values and flags >10% cross-source spreads (unit-tested).
- [ ] `/context/fundamentals/{symbol}` merges configured providers and 503s when none configured; a single failing provider does not sink the response.
- [ ] `/context/macro` returns yields/VIX/curve from FRED (503 without a key); `/context/implied-move/{symbol}` returns a keyless options-implied range.
- [ ] `.env`/`.venv` never staged; only `.env.example` (no real keys) committed.
- [ ] Branch `feat/phase-2-data-layer` ready to merge.

## Self-review notes

- **Spec coverage:** implements spec §"Data sources (use OpenBB AND direct providers)" for the direct providers + the cross-check; OpenBB is split to Phase 2b by design (heavy dependency).
- **No placeholders:** models, cross-check, config, options math, and endpoints have complete code; external-adapter field-mapping is pinned to recorded real fixtures (the correct way to TDD an integration), with explicit implementer notes to verify keys against the recorded JSON.
- **Type consistency:** `Fundamentals`/`MacroSnapshot`/`ImpliedMove`/`FundamentalsResult`/`FieldDiscrepancy` fields are identical across models, adapters, cross-check, endpoints, and tests. Adapters expose `name` + `fetch_*` matching the protocols in `data/base.py`.
- **Determinism:** options `now_epoch` and all http clients are injectable; unit tests use fixtures/synthetic payloads with no live network. (`as_of` uses wall-clock here because these are point-in-time data snapshots, not reproducible-prediction outputs — acceptable and not asserted in tests.)

## Deferred to Phase 2b (separate plan)

- **OpenBB aggregator adapter** — add the `openbb` package, wrap `obb.equity.fundamental.*` and `obb.economy.*` behind the same `FundamentalsProvider`/`MacroProvider` protocols, and feed it into the same cross-check as another source. Isolated because the dependency is large and lengthens the Docker build.
