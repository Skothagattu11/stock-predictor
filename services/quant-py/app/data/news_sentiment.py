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
