# quant-py — Quant/ML sidecar

FastAPI service that computes deterministic, LLM-free market predictions consumed by the Node app.

## Run locally
    python -m venv .venv
    .venv\Scripts\python -m pip install -e ".[dev]"
    .venv\Scripts\python -m pytest
    .venv\Scripts\python -m uvicorn app.api:app --reload --port 8500

## Endpoints
- `GET /health`
- `GET /predict/intraday/{symbol}?interval=5m` → `IntradayPrediction`

## Deploy (Render)
- New **Web Service** from this repo, root dir `services/quant-py`, Docker runtime.
- No public secrets needed for Phase 1 (Yahoo is keyless). Later phases read
  `FINNHUB_API_KEY`, `FMP_API_KEY`, `FRED_API_KEY`, `ALPACA_KEY/SECRET`, `OPENBB_PAT` from env.
- The Node service reaches this one via an internal URL set as `QUANT_SIDECAR_URL` on the Node service.

### Phase 2 endpoints
- `GET /context/macro` → MacroSnapshot (needs FRED_API_KEY)
- `GET /context/fundamentals/{symbol}` → FundamentalsResult (Finnhub and/or FMP)
- `GET /context/implied-move/{symbol}` → ImpliedMove (keyless, Yahoo options)

### Data env vars (set on the quant-py Render service)
FRED_API_KEY, FMP_API_KEY, FINNHUB_API_KEY — all optional; endpoints degrade gracefully.
