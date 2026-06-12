# Phase D: Market Discovery Scanner (Hot / Penny / Scope-to-shine) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. `- [ ]` steps, strict TDD, one commit per task.

**Goal:** Agents that scan the market and surface opportunities in three lanes — 🔥 **Hot/trending**, 🪙 **Penny movers**, 🌱 **Scope-to-shine** — fetched in parallel from **FMP (primary)** + **Yahoo screeners (backup)**, scored, ranked, cached, and shown in a **Discover** tab where each row loads that ticker into the dashboard.

**Architecture:** Sidecar gets injectable screener clients (FMP gainers/actives/screener; Yahoo predefined screeners with crumb) and a `build_discover()` scanner that **fans the calls out concurrently** (ThreadPoolExecutor), scores each lane, and returns a `DiscoverResult`. Node proxies it through the cache (10-min TTL — well within FMP's 250/day free limit). The UI adds a Discover panel that auto-refreshes and routes clicks to the existing `selectSymbol`. Degrades gracefully: FMP-only, Yahoo-only, or empty with a friendly note.

**Tech Stack:** Python (sidecar) httpx + concurrent.futures; Node (no new deps); vanilla JS.

**Builds on:** Phase 2 (`config.FMP_API_KEY`, httpx adapters), Phase 4 (cache/route), Phase 7 (predictions UI).

---

## Task 1: Discovery models + FMP market client

**Files:** add models to `app/models.py`; create `app/data/fmp_market.py`; Test `tests/test_fmp_market.py`

- [ ] **Step 1: Add models to `app/models.py`**
```python
class DiscoverItem(BaseModel):
    symbol: str
    name: str | None = None
    price: float | None = None
    change_pct: float | None = None
    volume: float | None = None
    score: float
    reason: str


class DiscoverResult(BaseModel):
    hot: list[DiscoverItem] = []
    penny: list[DiscoverItem] = []
    shine: list[DiscoverItem] = []
    sources: list[str] = []
    as_of: str
    source: Literal["quant"] = "quant"
```

- [ ] **Step 2: Failing test** — `tests/test_fmp_market.py`
```python
import httpx
from app.data.fmp_market import FmpMarket, _pct

def test_pct_parses_number_and_string():
    assert _pct(3.2) == 3.2
    assert _pct("3.2%") == 3.2
    assert _pct(None) is None

def _client(payload):
    def handler(request): return httpx.Response(200, json=payload)
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_gainers_normalized():
    fm = FmpMarket(api_key="k", http=_client([
        {"symbol": "AAA", "name": "Aaa Inc", "price": 12.5, "changesPercentage": 9.8, "change": 1.1}]))
    rows = fm.gainers()
    assert rows[0]["symbol"] == "AAA" and abs(rows[0]["change_pct"] - 9.8) < 1e-9

def test_screener_passes_filters():
    rec = {}
    def handler(request): rec["url"] = str(request.url); return httpx.Response(200, json=[])
    fm = FmpMarket(api_key="k", http=httpx.Client(transport=httpx.MockTransport(handler)))
    fm.screener(priceLowerThan=5, volumeMoreThan=1_000_000)
    assert "priceLowerThan=5" in rec["url"] and "apikey=k" in rec["url"]
```

- [ ] **Step 3: Create `app/data/fmp_market.py`**
```python
import httpx

BASE_URL = "https://financialmodelingprep.com/api/v3"


def _pct(v):
    if v is None:
        return None
    try:
        return float(str(v).replace("%", "").strip())
    except (TypeError, ValueError):
        return None


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _norm(row: dict) -> dict:
    return {
        "symbol": row.get("symbol"),
        "name": row.get("name") or row.get("companyName"),
        "price": _num(row.get("price")),
        "change_pct": _pct(row.get("changesPercentage")),
        "volume": _num(row.get("volume")),
        "market_cap": _num(row.get("marketCap")),
        "sector": row.get("sector"),
    }


class FmpMarket:
    name = "fmp"

    def __init__(self, api_key: str, http: httpx.Client | None = None, base_url: str = BASE_URL):
        self._key = api_key
        self._http = http or httpx.Client(timeout=12.0)
        self._base = base_url

    def _get(self, path: str, params: dict | None = None) -> list:
        params = dict(params or {})
        params["apikey"] = self._key
        r = self._http.get(f"{self._base}/{path}", params=params)
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []

    def gainers(self) -> list[dict]:
        return [_norm(x) for x in self._get("stock_market/gainers")]

    def actives(self) -> list[dict]:
        return [_norm(x) for x in self._get("stock_market/actives")]

    def screener(self, **filters) -> list[dict]:
        return [_norm(x) for x in self._get("stock-screener", filters)]
```

- [ ] **Step 4: Run → pass. Commit**
```
git checkout -b feat/phase-discovery
git add services/quant-py/app/models.py services/quant-py/app/data/fmp_market.py services/quant-py/tests/test_fmp_market.py
git commit -m "feat(discover): add discovery models + FMP market client"
```

---

## Task 2: Yahoo predefined-screener client (backup, crumb)

**Files:** create `app/data/yahoo_screener.py`; Test `tests/test_yahoo_screener.py`

- [ ] **Step 1: Failing test** — `tests/test_yahoo_screener.py` (tests the parser; live crumb is best-effort)
```python
import httpx
from app.data.yahoo_screener import YahooScreener, _parse_quotes

def test_parse_quotes():
    payload = {"finance": {"result": [{"quotes": [
        {"symbol": "BBB", "shortName": "Bbb Co", "regularMarketPrice": 3.1,
         "regularMarketChangePercent": 12.0, "regularMarketVolume": 5_000_000}]}]}}
    rows = _parse_quotes(payload)
    assert rows[0]["symbol"] == "BBB" and abs(rows[0]["change_pct"] - 12.0) < 1e-9

def test_screener_uses_crumb_and_parses():
    calls = {"crumb": 0}
    def handler(request):
        u = str(request.url)
        if "getcrumb" in u:
            calls["crumb"] += 1
            return httpx.Response(200, text="abc123")
        return httpx.Response(200, json={"finance": {"result": [{"quotes": [
            {"symbol": "CCC", "regularMarketPrice": 2.0, "regularMarketChangePercent": 8.0,
             "regularMarketVolume": 2_000_000}]}]}})
    ys = YahooScreener(http=httpx.Client(transport=httpx.MockTransport(handler)))
    rows = ys.screen("day_gainers", count=5)
    assert rows and rows[0]["symbol"] == "CCC"
```

- [ ] **Step 2: Create `app/data/yahoo_screener.py`**
```python
import httpx

CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb"
SCREEN_URL = "https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved"
UA = "Mozilla/5.0"


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _parse_quotes(payload: dict) -> list[dict]:
    try:
        quotes = payload["finance"]["result"][0]["quotes"]
    except (KeyError, IndexError, TypeError):
        return []
    out = []
    for q in quotes or []:
        out.append({
            "symbol": q.get("symbol"),
            "name": q.get("shortName") or q.get("longName"),
            "price": _num(q.get("regularMarketPrice")),
            "change_pct": _num(q.get("regularMarketChangePercent")),
            "volume": _num(q.get("regularMarketVolume")),
            "market_cap": _num(q.get("marketCap")),
            "sector": None,
        })
    return out


class YahooScreener:
    name = "yahoo"

    def __init__(self, http: httpx.Client | None = None):
        self._http = http or httpx.Client(timeout=12.0, headers={"User-Agent": UA})
        self._crumb = None

    def _get_crumb(self) -> str | None:
        if self._crumb:
            return self._crumb
        try:
            r = self._http.get(CRUMB_URL)
            if r.status_code == 200 and r.text and "<" not in r.text:
                self._crumb = r.text.strip()
        except Exception:
            self._crumb = None
        return self._crumb

    def screen(self, scr_id: str, count: int = 25) -> list[dict]:
        params = {"scrIds": scr_id, "count": count}
        crumb = self._get_crumb()
        if crumb:
            params["crumb"] = crumb
        r = self._http.get(SCREEN_URL, params=params)
        r.raise_for_status()
        return _parse_quotes(r.json())
```

- [ ] **Step 3: Run → pass. Commit**
```
git add services/quant-py/app/data/yahoo_screener.py services/quant-py/tests/test_yahoo_screener.py
git commit -m "feat(discover): add Yahoo predefined-screener client (crumb, backup)"
```

---

## Task 3: The parallel discovery scanner

**Files:** create `app/discovery/__init__.py` (empty), `app/discovery/scanner.py`; Test `tests/test_discover_scanner.py`

- [ ] **Step 1: Failing tests** — `tests/test_discover_scanner.py`
```python
from app.discovery.scanner import build_discover, _rank_hot, _rank_penny

class _FakeFmp:
    def gainers(self): return [
        {"symbol": "HOT", "name": "Hot", "price": 20.0, "change_pct": 14.0, "volume": 9_000_000, "market_cap": 3e9, "sector": "Tech"}]
    def actives(self): return [
        {"symbol": "ACT", "name": "Act", "price": 50.0, "change_pct": 2.0, "volume": 30_000_000, "market_cap": 8e9, "sector": "Energy"}]
    def screener(self, **f):
        if f.get("priceLowerThan") == 5:
            return [{"symbol": "PNY", "name": "Penny", "price": 2.3, "change_pct": 20.0, "volume": 4_000_000, "market_cap": 2e8, "sector": "Bio"}]
        return [{"symbol": "SHN", "name": "Shine", "price": 80.0, "change_pct": 1.0, "volume": 2_000_000, "market_cap": 5e10, "sector": "Tech"}]

def test_build_discover_three_lanes():
    r = build_discover(_FakeFmp(), yahoo=None)
    assert any(i.symbol == "HOT" for i in r.hot)
    assert any(i.symbol == "PNY" for i in r.penny)
    assert any(i.symbol == "SHN" for i in r.shine)
    assert "fmp" in r.sources
    assert all(i.reason for i in r.hot)   # every item explains itself

def test_rank_hot_orders_by_score():
    rows = [{"symbol": "A", "change_pct": 5, "volume": 1e6, "price": 10},
            {"symbol": "B", "change_pct": 12, "volume": 5e6, "price": 10}]
    ranked = _rank_hot(rows)
    assert ranked[0]["symbol"] == "B"

def test_penny_filters_price():
    rows = [{"symbol": "P", "price": 3.0, "change_pct": 10, "volume": 2e6}]
    assert _rank_penny(rows)[0]["symbol"] == "P"

def test_empty_when_no_providers():
    r = build_discover(None, yahoo=None)
    assert r.hot == [] and r.penny == [] and r.shine == [] and r.sources == []
```

- [ ] **Step 2: Create `app/discovery/scanner.py`**
```python
"""Parallel market-discovery scanner: fans screener calls out concurrently and
ranks three opportunity lanes. Deterministic given its inputs; FMP primary, Yahoo backup."""
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from app.models import DiscoverItem, DiscoverResult

MAX_PER_LANE = 8


def _now_iso():
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _score_traction(r):
    chg = abs(r.get("change_pct") or 0.0)
    vol = r.get("volume") or 0.0
    return chg * math.log10(vol + 10)        # move x participation


def _rank_hot(rows):
    return sorted(rows, key=_score_traction, reverse=True)


def _rank_penny(rows):
    pny = [r for r in rows if (r.get("price") or 0) <= 5 and (r.get("volume") or 0) >= 500_000]
    return sorted(pny, key=_score_traction, reverse=True)


def _rank_shine(rows):
    # liquid, real-cap names with at least mild positive momentum
    ok = [r for r in rows if (r.get("market_cap") or 0) >= 1e9 and (r.get("price") or 0) >= 10]
    return sorted(ok, key=lambda r: (r.get("change_pct") or 0) * math.log10((r.get("volume") or 0) + 10), reverse=True)


def _item(r, reason) -> DiscoverItem:
    return DiscoverItem(symbol=r.get("symbol"), name=r.get("name"), price=r.get("price"),
                        change_pct=r.get("change_pct"), volume=r.get("volume"),
                        score=round(_score_traction(r), 2), reason=reason)


def _vol_m(v):
    return f"{(v or 0) / 1e6:.1f}M vol"


def build_discover(fmp, yahoo=None, max_per_lane: int = MAX_PER_LANE) -> DiscoverResult:
    sources: list[str] = []
    gainers = actives = penny_rows = shine_rows = []

    if fmp is not None:
        with ThreadPoolExecutor(max_workers=4) as ex:
            f_g = ex.submit(fmp.gainers)
            f_a = ex.submit(fmp.actives)
            f_p = ex.submit(lambda: fmp.screener(priceLowerThan=5, volumeMoreThan=1_000_000,
                                                 isActivelyTrading=True, limit=40))
            f_s = ex.submit(lambda: fmp.screener(marketCapMoreThan=2_000_000_000, priceMoreThan=10,
                                                 volumeMoreThan=500_000, isEtf=False,
                                                 isActivelyTrading=True, limit=60))
            def _safe(f):
                try:
                    return f.result()
                except Exception:
                    return []
            gainers, actives, penny_rows, shine_rows = _safe(f_g), _safe(f_a), _safe(f_p), _safe(f_s)
        if gainers or actives or penny_rows or shine_rows:
            sources.append("fmp")

    # Yahoo backup: fill any empty lane
    if yahoo is not None and (not gainers and not actives):
        try:
            gainers = yahoo.screen("day_gainers", count=25)
            actives = yahoo.screen("most_actives", count=25)
            if gainers or actives:
                sources.append("yahoo")
        except Exception:
            pass
    if yahoo is not None and not penny_rows:
        try:
            penny_rows = yahoo.screen("small_cap_gainers", count=25)
            if penny_rows and "yahoo" not in sources:
                sources.append("yahoo")
        except Exception:
            pass

    hot = [_item(r, f"+{(r.get('change_pct') or 0):.1f}% today · {_vol_m(r.get('volume'))}")
           for r in _rank_hot((gainers or []) + (actives or []))][:max_per_lane]
    penny = [_item(r, f"${(r.get('price') or 0):.2f} · +{(r.get('change_pct') or 0):.1f}% · {_vol_m(r.get('volume'))}")
             for r in _rank_penny(penny_rows or [])][:max_per_lane]
    shine = [_item(r, f"{r.get('sector') or 'mkt'} · ${(r.get('market_cap') or 0)/1e9:.0f}B cap · {_vol_m(r.get('volume'))}")
             for r in _rank_shine(shine_rows or [])][:max_per_lane]

    # de-dup symbols already in hot out of shine/penny for variety
    seen = {i.symbol for i in hot}
    penny = [i for i in penny if i.symbol not in seen]
    shine = [i for i in shine if i.symbol not in seen][:max_per_lane]

    return DiscoverResult(hot=hot, penny=penny, shine=shine, sources=sources, as_of=_now_iso())
```

- [ ] **Step 3: Run → pass. Commit**
```
git add services/quant-py/app/discovery/__init__.py services/quant-py/app/discovery/scanner.py services/quant-py/tests/test_discover_scanner.py
git commit -m "feat(discover): add parallel three-lane discovery scanner"
```

---

## Task 4: `/discover` endpoint + Node wiring

**Files:** `app/api.py`; `src/sidecar.js`, `src/predict-service.js`, `src/predict-routes.js`; Tests `tests/test_discover_api.py`, append to `test/predict-service.test.js`

- [ ] **Step 1: Failing test** — `tests/test_discover_api.py`
```python
from fastapi.testclient import TestClient
from app.api import app, get_discover_providers

class _FakeFmp:
    def gainers(self): return [{"symbol": "HOT", "name": "H", "price": 20, "change_pct": 14, "volume": 9e6, "market_cap": 3e9, "sector": "Tech"}]
    def actives(self): return []
    def screener(self, **f): return []

client = TestClient(app)

def test_discover_endpoint():
    app.dependency_overrides[get_discover_providers] = lambda: (_FakeFmp(), None)
    try:
        r = client.get("/discover")
        assert r.status_code == 200
        assert any(i["symbol"] == "HOT" for i in r.json()["hot"])
    finally:
        app.dependency_overrides.clear()

def test_discover_503_when_no_providers():
    app.dependency_overrides[get_discover_providers] = lambda: (None, None)
    try:
        assert client.get("/discover").status_code == 503
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 2: Add to `app/api.py`**
```python
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
```

- [ ] **Step 3: Node — add `discover`** to `src/sidecar.js`:
```js
    discover: () => request('GET', '/discover'),
```
to `src/predict-service.js` (TTL + method):
```js
  discover: 10 * 60 * 1000,        // 10 min
// ...
    discover: () => cached('discover', 'ALL', () => sidecar.discover()),
```
to `src/predict-routes.js`:
```js
  router.get('/discover', wrap(() => service.discover()));
```
> Note: this makes the path `/api/predict/discover` (the predict router is mounted at `/api/predict`).

- [ ] **Step 4: predict-service test** — append to `test/predict-service.test.js`:
```js
test('discover is cached', async () => {
  const counts = {};
  const sidecar = { discover: async () => (counts.d = (counts.d || 0) + 1, { hot: [], penny: [], shine: [] }) };
  const { createPredictService } = require('../src/predict-service');
  const svc = createPredictService({ sidecar, cache: new (require('../src/cache').TtlCache)() });
  await svc.discover(); await svc.discover();
  assert.equal(counts.d, 1);
});
```

- [ ] **Step 5: Run sidecar `pytest` + `node --test` → green. Commit**
```
git add services/quant-py/app/api.py services/quant-py/tests/test_discover_api.py src/sidecar.js src/predict-service.js src/predict-routes.js test/predict-service.test.js
git commit -m "feat(discover): expose /discover endpoint + cached Node route"
```

---

## Task 5: Discover UI panel

**Files:** `public/index.html` (container + styles + nav), `public/app.js` (expose selectSymbol), `public/discover.js` (new)

- [ ] **Step 1: Expose the symbol selector in `app.js`** — find the existing `selectSymbol` function and, right after it's defined, add (additive):
```js
  window.selectSymbol = selectSymbol;   // let the Discover panel route clicks here
```
> If `selectSymbol` isn't a named function, expose whatever the app uses to switch the active ticker; the goal is a global the Discover panel can call with a symbol.

- [ ] **Step 2: Add the container to `index.html`** — a full-width card above the predictions section (implementer picks a clean spot):
```html
<div class="card" id="discoverCard" style="margin-top:18px"><div class="cardBody" id="discoverBody"></div></div>
<script src="discover.js"></script>
```

- [ ] **Step 3: Create `public/discover.js`**
```js
/* Market discovery: Hot / Penny / Scope-to-shine. Clicking a row loads that ticker. */
(function () {
  'use strict';
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function money(x){ return x==null?'—':'$'+Number(x).toFixed(2); }

  var LANES = [
    { key: 'hot', label: '🔥 Hot / trending' },
    { key: 'penny', label: '🪙 Penny movers' },
    { key: 'shine', label: '🌱 Scope to shine' },
  ];

  function row(it) {
    var chg = it.change_pct == null ? '' : '<span class="' + (it.change_pct >= 0 ? 'd-up' : 'd-dn') + '">' +
      (it.change_pct >= 0 ? '+' : '') + it.change_pct.toFixed(1) + '%</span>';
    return '<button class="dvrow" data-sym="' + esc(it.symbol) + '">' +
      '<span class="dv-sym">' + esc(it.symbol) + '</span>' +
      '<span class="dv-name">' + esc(it.name || '') + '</span>' +
      '<span class="dv-px">' + money(it.price) + ' ' + chg + '</span>' +
      '<span class="dv-why">' + esc(it.reason || '') + '</span></button>';
  }
  function render(node, data) {
    var lanes = LANES.map(function (l) {
      var items = (data[l.key] || []);
      var body = items.length ? items.map(row).join('') : '<div class="pmuted">Nothing notable right now.</div>';
      return '<div class="dvlane"><div class="dvlane-h">' + l.label + '</div>' + body + '</div>';
    }).join('');
    var t = data.as_of ? new Date(data.as_of) : null;
    var ts = (t && !isNaN(t)) ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    node.innerHTML = '<div class="dvhead"><b>Discover</b><span class="pmuted">scanned ' + ts +
      ' · ' + esc((data.sources || []).join(', ') || 'no source') + '</span></div>' +
      '<div class="dvgrid">' + lanes + '</div>' +
      '<div class="pmuted" style="margin-top:8px">Descriptive screen, not advice. Penny names are high-risk.</div>';
  }
  function load() {
    var node = document.getElementById('discoverBody');
    if (!node) return;
    if (!node.innerHTML) node.innerHTML = '<div class="pmuted">Scanning the market…</div>';
    fetch('/api/predict/discover').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
    }).then(function (d) { render(node, d); })
      .catch(function () { node.innerHTML = '<div class="pmuted">Discovery unavailable (screener key/rate-limit). Add FMP_API_KEY on the sidecar.</div>'; });
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('.dvrow');
    if (b && b.getAttribute('data-sym') && window.selectSymbol) window.selectSymbol(b.getAttribute('data-sym'));
  });
  load();
  setInterval(function () { if (document.visibilityState !== 'hidden') load(); }, 5 * 60 * 1000);
  window.Discover = { load: load };
})();
```

- [ ] **Step 4: Styles in `index.html`**
```css
    .dvhead { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px; }
    .dvgrid { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
    @media (max-width:900px){ .dvgrid { grid-template-columns:1fr; } }
    .dvlane-h { font-size:13px; font-weight:700; margin-bottom:8px; }
    .dvrow { display:grid; grid-template-columns:60px 1fr auto; grid-template-areas:'sym name px' 'sym why why';
      gap:2px 8px; width:100%; text-align:left; background:var(--panel2,#111b2d); border:1px solid var(--line,#243149);
      border-radius:10px; padding:8px 10px; margin-bottom:6px; cursor:pointer; color:var(--text,#e8eef8); }
    .dvrow:hover { border-color:var(--blue,#5aa7ff); }
    .dv-sym { grid-area:sym; font-weight:700; align-self:center; }
    .dv-name { grid-area:name; color:var(--muted,#95a3b8); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .dv-px { grid-area:px; font-size:12px; } .dv-why { grid-area:why; color:var(--muted,#95a3b8); font-size:11px; }
```

- [ ] **Step 5: Verify** — `node --check public/discover.js`; `node --test`; sidecar `pytest`. Start server; `/api/predict/discover` returns lanes (or the friendly no-key message). Commit.
```
git add public/index.html public/app.js public/discover.js
git commit -m "feat(discover): add Discover panel (3 lanes, click to load ticker)"
```

---

## Acceptance criteria
- [ ] Sidecar `pytest` + Node `node --test` green.
- [ ] FMP client normalizes gainers/actives/screener (handles `changesPercentage` number or "x%"); Yahoo client parses predefined-screener quotes (crumb best-effort).
- [ ] `build_discover` fans calls out concurrently, returns Hot/Penny/Scope lanes each scored with a human reason; FMP primary, Yahoo backup; empty/none → graceful.
- [ ] `/discover` (→ `/api/predict/discover`) returns a `DiscoverResult`, 503 when no data; cached 10 min in Node.
- [ ] Discover panel renders the 3 lanes; clicking a row loads that ticker via `selectSymbol`; auto-refresh 5 min; friendly no-key/rate-limit message; penny-risk disclaimer.
- [ ] Needs `FMP_API_KEY` on the sidecar for the rich lanes (Yahoo backup keyless). `.env` never staged. Branch `feat/phase-discovery` ready to merge.

## Self-review notes
- **Spec coverage:** the three requested lanes (trending/hot, penny traction, scope-to-shine), **parallel** fetch (ThreadPoolExecutor), background-ish freshness via 10-min cache + 5-min UI poll, FMP primary + Yahoo backup, click-through into the dashboard.
- **Honesty:** descriptive screen (not predictive) with a penny-risk disclaimer; each row states *why* it surfaced; graceful degradation when keys/rate-limits bite.
- **Determinism:** scanner is pure over injected clients; clients have injectable http; tests use fixtures/fakes (no live network/keys).
- **Cost:** 10-min cache keeps FMP calls ≈ 4/scan × 6/hr ≈ within the 250/day free limit even with the scheduler off.

## Follow-ups
- Enrich Scope-to-shine by running the outlook core on its top few (heavier; gate by cache).
- Optional: a background pre-warm of `/discover` in the scheduler so the first open is instant.
