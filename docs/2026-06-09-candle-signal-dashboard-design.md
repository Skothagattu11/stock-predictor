# Live Candle Pattern Signal Dashboard — Design Spec

**Date:** 2026-06-09
**Status:** Approved (brainstorm complete)

## 1. Purpose

Evolve the static `mrvl_candle_signal_dashboard.html` reference into a **live**,
multi-ticker candlestick **pattern-signal dashboard**. It streams real market data
from **Finnhub over WebSocket**, builds candles, runs an **enhanced, explainable
rules engine** (candlestick patterns + indicators), and outputs a transparent
**BUY / SELL / WAIT** decision with entry/stop/target levels.

It is a probability/risk helper for studying candle patterns — **not financial advice**.

## 2. Locked Decisions

| Decision | Choice |
|---|---|
| Data source | **Finnhub** free tier (real-time trade WebSocket + REST quote/search) |
| Live mechanism | **WebSocket streaming** (no outbound alert webhooks in scope) |
| Tickers | **Any US symbol via search** |
| Architecture | **Node.js backend (Express + ws) + browser UI** |
| Backend stack | **Node.js** |
| Algorithm depth | **Enhanced rules engine** (more patterns, ATR stops, MACD/Bollinger, multi-factor score). No ML. |
| Off-hours | Show **last data + simulated mode** with a clear "market closed" badge |
| API key | Real Finnhub key via `.env`; runs in **simulated mode** until a key is added |

## 3. Architecture

Three layers, each independently testable:

### A. Node backend (`src/`)
- Keeps the Finnhub API key in `.env` — **never sent to the browser**.
- Single upstream connection to `wss://ws.finnhub.io`; subscribes/unsubscribes to
  symbols on demand with reconnect-and-backoff.
- **Candle aggregator** buckets trade ticks into OHLCV candles per symbol per
  timeframe (1m/5m/15m/1h).
- Runs the analytics engine and pushes `analysis` + `candle` messages to browsers.
- REST: `GET /api/search?q=`, `GET /api/quote/:symbol`; serves static `public/`.
- **Simulator** generates candles off-hours / when no key is present.

### B. Analytics engine (`engine/`) — pure, framework-free JS
- `indicators.js`: EMA 9/20/50, RSI 14, MACD(12/26/9), Bollinger(20,2), ATR 14, VWAP, avg volume.
- `patterns.js`: doji, hammer, inverted hammer, hanging man, shooting star,
  bullish/bearish engulfing, harami, piercing/dark-cloud, tweezers, morning/evening
  star, three white soldiers / three black crows, marubozu.
- `scorer.js`: multi-factor weighted score (0–100), confidence, signal, reasons, ATR levels.
- `index.js`: `analyze(candles)` facade returning the full analysis object.

### C. Frontend (`public/`)
- Same dark aesthetic + TradingView Lightweight Charts as the reference.
- Ticker search, live **connection** + **market-status** badges, timeframe selector.
- Live-updating candles with EMA + Bollinger overlays and a volume pane.
- Signal box, entry/exit plan, indicator snapshot, detected-patterns table,
  rolling **signal-history log**, simulated-mode toggle, CSV backfill.

## 4. Data Constraint (handled honestly in the UI)

**Verified during build:** Finnhub's **free** tier does **NOT** stream US-stock
trades over WebSocket (a 15s probe returned 0 stock trades; only `BINANCE:BTCUSDT`
crypto streamed). Real-time US-stock data comes from the **`/quote` REST endpoint**,
which is live; the historical-candle endpoint is paid. Therefore:
- **Live US-stock mode polls `/quote` every ~5s** and feeds the real current price
  into the candle aggregator, so the latest candle tracks the real market price.
  The WebSocket path stays wired for crypto/forex and paid stock plans.
- The chart **seeds ~60 simulated candles around the real quote price** for visual
  history (no free historical candles); `/quote` has no intraday volume, so live
  volume is approximate (price is real).
- **CSV paste** (kept from reference) allows visual backfill; a paid key behind the
  same `analyze()` engine gives true history.
- **Off-hours** → no ticks → UI badges "Market closed / last data" and offers the
  **simulator** so the dashboard is never blank.

## 4b. Timezone

Market-open detection uses **America/New_York** (Eastern). Candle timestamps are
UTC unix-seconds; the chart **x-axis and crosshair are formatted in the viewer's
local timezone** via `Intl` (Lightweight Charts renders UTC by default and has no
built-in timezone support).

## 5. Error Handling

- Upstream WS: reconnect with exponential backoff; surface connection state to UI.
- Invalid/unknown symbol: graceful error message, no crash.
- Subscription cap + de-dupe to respect Finnhub rate limits.
- Missing API key: auto-fallback to simulated mode with a clear banner.

## 6. Testing

The engine is pure functions → unit-tested with hand-computed fixtures
(`node --test`). Each indicator verified against known values; each pattern verified
against a constructed candle set. Backend wiring smoke-tested in simulated mode.

## 7. Non-Goals (YAGNI)

- No ML / predictive model. No order execution / broker integration.
- No outbound alert webhooks (can be added later behind the same engine).
- No multi-timeframe confirmation in v1 (engine is structured to add it later).
- No auth / multi-user accounts.
