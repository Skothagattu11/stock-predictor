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
