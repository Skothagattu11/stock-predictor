import os


def _env(key: str) -> str:
    return os.environ.get(key, "").strip()


FRED_API_KEY = _env("FRED_API_KEY")
FMP_API_KEY = _env("FMP_API_KEY")
FINNHUB_API_KEY = _env("FINNHUB_API_KEY")
